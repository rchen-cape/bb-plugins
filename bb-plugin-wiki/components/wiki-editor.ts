import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSet,
  StateField,
  Transaction,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { MARKER_LINE, UNSORTED_MARKER, hasValidFrontmatter, headingAnchors } from "../lib/markdown-doc";
import { mediaKindOf } from "../lib/wiki";
import {
  HiddenBlockWidget,
  HintWidget,
  ImageWidget,
  codeHighlighting,
  editorBasics,
  externalChange,
  findFrontmatter,
  formattingToolbar,
  isRevealed,
  livePreview,
  livePreviewTheme,
  previewStateField,
  previewValue,
  slashCommandSource,
  type CodeTheme,
} from "../lib/live-preview/index.js";
import {
  describeWikiEmbed,
  describeWikiLink,
  htmlMediaLine,
  htmlMediaUrl,
  leadingTitleSpan,
  markdownImageUrl,
  mediaUrl,
  parseMarkerAttributes,
  sourceMarkerLabel,
  type LinkTarget,
  type SourceMarkerLabel,
} from "./doc-render";

export const EMPTY_DOC_HINT = "Start writing…";

const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const BANG = 33;
const NEWLINE = 10;
const CODE_NODES = new Set(["FencedCode", "CodeBlock"]);
const CONTAINER_NODES = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

export interface WikiEditorContext {
  readonly pluginId: string;
  readonly slug: string;
  readonly title: string;
  readonly resolve: (target: string) => LinkTarget | null;
}

export const wikiContext = Facet.define<WikiEditorContext, WikiEditorContext | null>({
  combine: (values) => values[0] ?? null,
});

export const WikiLinkSyntax: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }, { name: "WikiEmbed" }, { name: "WikiLinkMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        const embed = next === BANG;
        const open = embed ? pos + 1 : pos;
        if ((!embed && next !== OPEN_BRACKET) || cx.char(open) !== OPEN_BRACKET || cx.char(open + 1) !== OPEN_BRACKET) return -1;
        let close = open + 2;
        while (close < cx.end) {
          const char = cx.char(close);
          if (char === OPEN_BRACKET || char === NEWLINE) return -1;
          if (char === CLOSE_BRACKET) break;
          close += 1;
        }
        if (close === open + 2 || cx.char(close) !== CLOSE_BRACKET || cx.char(close + 1) !== CLOSE_BRACKET) return -1;
        const end = close + 2;
        return cx.addElement(cx.elt(embed ? "WikiEmbed" : "WikiLink", pos, end, [cx.elt("WikiLinkMark", pos, open + 2), cx.elt("WikiLinkMark", close, end)]));
      },
    },
  ],
};

export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly href: string | null,
    readonly missing: string | null,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return other.label === this.label && other.href === this.href && other.missing === this.missing;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = this.label;
    if (this.href === null) {
      span.className = "cm-wiki-link cm-wiki-link-missing";
      if (this.missing !== null) span.title = this.missing;
      return span;
    }
    span.className = "cm-lp-link cm-wiki-link";
    span.setAttribute("role", "link");
    span.setAttribute("data-href", this.href);
    span.setAttribute("data-lp-rendered", "true");
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function sameLabel(a: SourceMarkerLabel, b: SourceMarkerLabel): boolean {
  return (
    a.title === b.title &&
    a.parts.length === b.parts.length &&
    a.parts.every((part, index) => part.text === b.parts[index]?.text && part.threadLink === b.parts[index]?.threadLink)
  );
}

export class SourceMarkerWidget extends WidgetType {
  constructor(readonly label: SourceMarkerLabel) {
    super();
  }

  override eq(other: SourceMarkerWidget): boolean {
    return sameLabel(other.label, this.label);
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-wiki-source";
    if (this.label.title !== null) span.title = this.label.title;
    for (const part of this.label.parts) {
      if (part.threadLink === undefined) {
        span.append(part.text);
        continue;
      }
      const link = document.createElement("span");
      link.className = "cm-lp-link cm-wiki-source-link";
      link.setAttribute("role", "link");
      link.setAttribute("data-href", part.threadLink);
      link.setAttribute("data-lp-rendered", "true");
      link.textContent = part.text;
      span.append(link);
    }
    return span;
  }

  override ignoreEvent(event: Event): boolean {
    return !(event.target instanceof Element && event.target.closest("[data-href]") !== null);
  }
}

const ownHeadingCache = new WeakMap<Text, readonly string[]>();

function ownHeadings(doc: Text): readonly string[] {
  let known = ownHeadingCache.get(doc);
  if (known === undefined) {
    known = headingAnchors(doc.toString()).map((heading) => heading.text);
    ownHeadingCache.set(doc, known);
  }
  return known;
}

function insideNode(state: EditorState, pos: number, side: -1 | 1, names: ReadonlySet<string>): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node !== null; node = node.parent) {
    if (names.has(node.name)) return true;
  }
  return false;
}

const COMMENT_NODES = new Set(["CommentBlock"]);
const MEDIA_BLOCKERS = new Set(["FencedCode", "CodeBlock", "CommentBlock"]);

export type ProtectedKind = "source" | "unsorted";

export function protectedLineKind(state: EditorState, lineFrom: number): ProtectedKind | null {
  const line = state.doc.lineAt(lineFrom);
  const text = line.text;
  const kind = text.trim() === UNSORTED_MARKER ? "unsorted" : MARKER_LINE.test(text) ? "source" : null;
  if (kind === null || !insideNode(state, line.to, -1, COMMENT_NODES)) return null;
  return kind;
}

export interface WikiHead {
  readonly from: number;
  readonly to: number;
  readonly bare: boolean;
  readonly hideTo: number;
}

let lastBlock: string | null = null;
let lastValid = true;

export function wikiAcceptsFrontmatter(block: string): boolean {
  if (block !== lastBlock) {
    lastValid = hasValidFrontmatter(block);
    lastBlock = block;
  }
  return lastValid;
}

function frontmatterFloor(doc: Text): number | null {
  const bounds = findFrontmatter((from, to) => doc.sliceString(from, to), doc.length);
  if (bounds === null || !wikiAcceptsFrontmatter(doc.sliceString(0, bounds.to))) return null;
  return Math.min(doc.length, bounds.to + 1);
}

export function wikiHead(state: EditorState, title: string): WikiHead | null {
  const doc = state.doc;
  const floor = frontmatterFloor(doc);
  const from = floor ?? 0;
  const firstLine = doc.lineAt(from).number;
  const lineText = (index: number) => (firstLine + index > doc.lines ? null : doc.line(firstLine + index).text);
  const span = leadingTitleSpan(lineText, title);
  let end: number;
  if (span !== null) {
    end = span.end;
  } else if (floor !== null) {
    end = 0;
    for (let text = lineText(end); text !== null && text.trim() === "" && firstLine + end < doc.lines; text = lineText(end)) end += 1;
  } else {
    return null;
  }
  const to = firstLine + end > doc.lines ? doc.length : doc.line(firstLine + end).from;
  if (to <= from) return null;
  const bare = to === doc.length && doc.sliceString(to - 1, to) !== "\n";
  return { from, to, bare, hideTo: to === doc.length && !bare ? to - 1 : to };
}

export function wikiBodyStart(state: EditorState): number {
  const context = state.facet(wikiContext);
  const head = context === null ? null : wikiHead(state, context.title);
  return head?.to ?? frontmatterFloor(state.doc) ?? 0;
}

function bodyIsBlank(doc: Text, from: number): boolean {
  for (let number = doc.lineAt(from).number; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (doc.sliceString(Math.max(from, line.from), line.to).trim() !== "") return false;
  }
  return true;
}

function collectUnsorted(state: EditorState): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "CommentBlock") {
        const line = doc.lineAt(ref.from);
        if (line.text.trim() === UNSORTED_MARKER) found.push({ from: line.from, to: line.to + 1 < doc.length ? line.to + 1 : line.to });
        return false;
      }
      return CONTAINER_NODES.has(ref.name);
    },
  });
  return found;
}

export interface WikiBlocks {
  readonly decorations: DecorationSet;
  readonly atomic: RangeSet<Decoration>;
  readonly head: WikiHead | null;
}

const hiddenBlock = Decoration.replace({ widget: new HiddenBlockWidget(), block: true });
const atomicMark = Decoration.mark({});

export function buildWikiBlocks(state: EditorState): WikiBlocks {
  const context = state.facet(wikiContext);
  const head = context === null ? null : wikiHead(state, context.title);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  if (head !== null && head.hideTo > head.from) {
    decorations.push(hiddenBlock.range(head.from, head.hideTo));
    atomic.push(atomicMark.range(head.from, head.hideTo));
  }
  for (const range of collectUnsorted(state)) {
    if (head !== null && range.from < head.to) continue;
    decorations.push(hiddenBlock.range(range.from, range.to));
    atomic.push(atomicMark.range(range.from, range.to));
  }
  const start = wikiBodyStart(state);
  if (!previewValue(state).focused && bodyIsBlank(state.doc, start)) {
    const hint = new HintWidget(EMPTY_DOC_HINT);
    decorations.push(Decoration.widget({ widget: hint, side: 1, block: head?.bare === true }).range(head?.bare === true ? state.doc.length : start));
  }
  return { decorations: Decoration.set(decorations, true), atomic: RangeSet.of(atomic, true), head };
}

const wikiBlockField = StateField.define<WikiBlocks>({
  create: buildWikiBlocks,
  update(value, tr) {
    const changed =
      tr.docChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.facet(wikiContext) !== tr.startState.facet(wikiContext) ||
      tr.state.field(previewStateField, false)?.focused !== tr.startState.field(previewStateField, false)?.focused;
    return changed ? buildWikiBlocks(tr.state) : value;
  },
  provide: (field) => [EditorView.decorations.from(field, (value) => value.decorations), EditorView.atomicRanges.of((view) => view.state.field(field).atomic)],
});

export type WikiInlineRange =
  | { readonly kind: "replace"; readonly from: number; readonly to: number; readonly widget: WidgetType }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly className: string; readonly attributes: Readonly<Record<string, string>> }
  | { readonly kind: "line"; readonly from: number; readonly className: string };

function linkRanges(state: EditorState, context: WikiEditorContext, node: SyntaxNode, embed: boolean): WikiInlineRange[] {
  const doc = state.doc;
  const inner = doc.sliceString(node.from + (embed ? 3 : 2), node.to - 2);
  const revealed = isRevealed(state, node.from, node.to);
  if (embed) {
    const media = describeWikiEmbed(inner, context.slug);
    const url = mediaUrl(context.pluginId, media.relPath);
    const kind = mediaKindOf(media.relPath);
    if (revealed) return [{ kind: "mark", from: node.from, to: node.to, className: "cm-lp-link cm-wiki-link-source", attributes: { "data-href": url } }];
    const widget = kind === "image" || kind === "video" ? new ImageWidget(url, media.alt, kind === "video") : new WikiLinkWidget(media.alt, url, null);
    return [{ kind: "replace", from: node.from, to: node.to, widget }];
  }
  const link = describeWikiLink(inner, { resolve: context.resolve, docSlug: context.slug, ownHeadings: () => ownHeadings(doc) });
  if (revealed) {
    const attributes: Record<string, string> = link.href === null ? { title: link.missing ?? "" } : { "data-href": link.href };
    const className = link.href === null ? "cm-wiki-link-source cm-wiki-link-missing" : "cm-lp-link cm-wiki-link-source";
    return [{ kind: "mark", from: node.from, to: node.to, className, attributes }];
  }
  return [{ kind: "replace", from: node.from, to: node.to, widget: new WikiLinkWidget(link.label, link.href, link.missing) }];
}

function markerRanges(state: EditorState, node: SyntaxNode, from: number, to: number): WikiInlineRange[] {
  const doc = state.doc;
  const ranges: WikiInlineRange[] = [];
  const first = doc.lineAt(Math.max(node.from, from)).number;
  const last = doc.lineAt(Math.min(node.to, to)).number;
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    const match = MARKER_LINE.exec(line.text);
    if (match === null) continue;
    ranges.push({ kind: "line", from: line.from, className: "cm-lp-source-line" });
    ranges.push({ kind: "replace", from: line.from, to: line.to, widget: new SourceMarkerWidget(sourceMarkerLabel(parseMarkerAttributes(match[1] ?? ""))) });
  }
  return ranges;
}

function mediaRanges(state: EditorState, context: WikiEditorContext, from: number, to: number): WikiInlineRange[] {
  const doc = state.doc;
  const ranges: WikiInlineRange[] = [];
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    pos = line.to + 1;
    if (!line.text.includes("<")) continue;
    const media = htmlMediaLine(line.text);
    if (media === null || insideNode(state, line.to, -1, MEDIA_BLOCKERS) || isRevealed(state, line.from, line.to)) continue;
    const url = htmlMediaUrl(context.pluginId, media.src, context.slug);
    if (url === null) continue;
    ranges.push({ kind: "replace", from: line.from, to: line.to, widget: new ImageWidget(url, media.alt, media.video) });
  }
  return ranges;
}

export function buildWikiInline(state: EditorState, visible: readonly { from: number; to: number }[]): WikiInlineRange[] {
  const context = state.facet(wikiContext);
  if (context === null) return [];
  const ranges: WikiInlineRange[] = [];
  const seen = new Set<number>();
  for (const { from, to } of visible) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(ref) {
        if (CODE_NODES.has(ref.name)) return false;
        if (ref.name === "WikiLink" || ref.name === "WikiEmbed") {
          if (!seen.has(ref.from)) ranges.push(...linkRanges(state, context, ref.node, ref.name === "WikiEmbed"));
          seen.add(ref.from);
          return false;
        }
        if (ref.name === "CommentBlock") {
          if (!seen.has(ref.from)) ranges.push(...markerRanges(state, ref.node, from, to));
          seen.add(ref.from);
          return false;
        }
        return undefined;
      },
    });
    ranges.push(...mediaRanges(state, context, from, to));
  }
  return ranges;
}

function toInlineSet(ranges: readonly WikiInlineRange[]): { decorations: DecorationSet; atomic: RangeSet<Decoration> } {
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const range of ranges) {
    if (range.kind === "line") {
      decorations.push(Decoration.line({ class: range.className }).range(range.from));
    } else if (range.kind === "mark") {
      decorations.push(Decoration.mark({ class: range.className, attributes: { ...range.attributes } }).range(range.from, range.to));
    } else {
      decorations.push(Decoration.replace({ widget: range.widget }).range(range.from, range.to));
      if (range.widget instanceof SourceMarkerWidget) atomic.push(atomicMark.range(range.from, range.to));
    }
  }
  return { decorations: Decoration.set(decorations, true), atomic: RangeSet.of(atomic, true) };
}

const wikiInlinePlugin = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;
    atomic: RangeSet<Decoration>;

    constructor(view: EditorView) {
      const built = toInlineSet(buildWikiInline(view.state, view.visibleRanges));
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.state.facet(wikiContext) !== update.startState.facet(wikiContext) ||
        update.state.field(previewStateField, false) !== update.startState.field(previewStateField, false)
      ) {
        const built = toInlineSet(buildWikiInline(update.state, update.view.visibleRanges));
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? RangeSet.empty),
  },
);

function guardedEdit(tr: Transaction): boolean {
  return tr.docChanged && tr.annotation(externalChange) !== true && tr.annotation(Transaction.userEvent) !== undefined && !tr.isUserEvent("undo") && !tr.isUserEvent("redo");
}

interface Span {
  readonly from: number;
  readonly to: number;
}

interface GuardedChange {
  readonly changes: readonly { from: number; to: number; insert: string }[];
  readonly cursor: number | null;
}

function overlaps(from: number, to: number, hidden: readonly Span[]): boolean {
  return hidden.some((range) => range.from < to && range.to > from);
}

function outside(from: number, to: number, hidden: readonly Span[]): Span[] {
  const parts: Span[] = [];
  let start = from;
  for (const range of hidden) {
    if (range.to <= start || range.from >= to) continue;
    if (range.from > start) parts.push({ from: start, to: range.from });
    start = Math.max(start, range.to);
  }
  if (start < to) parts.push({ from: start, to });
  return parts;
}

function blankBeside(doc: Text, range: Span, floor: number): Span | null {
  if (range.from - 1 >= floor && doc.lineAt(range.from - 1).length === 0) return { from: range.from - 1, to: range.from };
  if (range.to < doc.length && doc.lineAt(range.to).length === 0) return { from: range.to, to: range.to + 1 };
  return null;
}

function keepUnsorted(state: EditorState, from: number, to: number, insert: string, unsorted: readonly Span[], floor: number): GuardedChange | null {
  if (!overlaps(from, to, unsorted)) return null;
  const parts = outside(from, to, unsorted);
  if (parts.length > 0) {
    const doc = state.doc;
    const changes = parts.map((part, index) => {
      const text = index === 0 ? insert : "";
      const lineStart = text === "" ? part.from === 0 || doc.sliceString(part.from - 1, part.from) === "\n" : text.endsWith("\n");
      const beforeHidden = unsorted.some((range) => range.from === part.to);
      return { from: part.from, to: part.to, insert: beforeHidden && !lineStart ? `${text}\n` : text };
    });
    return { changes, cursor: (parts[0]?.from ?? from) + insert.length };
  }
  const range = unsorted.find((candidate) => candidate.from <= from && candidate.to >= to);
  if (insert !== "") {
    const at = range === undefined || from === range.from ? from : range.to;
    const text = at === range?.to && state.doc.sliceString(at - 1, at) !== "\n" ? `\n${insert}` : insert;
    return { changes: [{ from: at, to: at, insert: from === range?.from && !text.endsWith("\n") ? `${text}\n` : text }], cursor: at + text.length };
  }
  const blank = range === undefined ? null : blankBeside(state.doc, range, floor);
  return { changes: blank === null ? [] : [{ ...blank, insert: "" }], cursor: null };
}

function guardChange(state: EditorState, head: WikiHead | null, unsorted: readonly Span[], fromA: number, toA: number, insert: string): GuardedChange | null {
  const doc = state.doc;
  let from = fromA;
  let to = toA;
  let text = insert;
  if (head !== null && (from < head.to || (head.bare && from === head.to && text !== ""))) {
    from = head.to;
    to = Math.max(to, head.to);
    if (head.bare && text !== "" && !text.startsWith("\n")) text = `\n${text}`;
  }
  const kept = keepUnsorted(state, from, to, text, unsorted, head?.to ?? 0);
  if (kept !== null) return kept;
  if (from === to && text !== "") {
    const kind = protectedLineKind(state, from);
    const line = doc.lineAt(from);
    if (kind !== null && from === line.to && !text.startsWith("\n")) return { changes: [{ from, to, insert: `\n${text}` }], cursor: from + 1 + text.length };
    if (kind !== null && from === line.from && !text.endsWith("\n")) return { changes: [{ from, to, insert: `${text}\n` }], cursor: from + text.length };
  }
  if (text === "" && to - from === 1 && doc.sliceString(from, to) === "\n") {
    const before = doc.lineAt(from);
    const after = doc.lineAt(to);
    const afterKind = protectedLineKind(state, after.from);
    if (afterKind === "unsorted" && before.length > 0) return { changes: [], cursor: null };
    if (protectedLineKind(state, before.from) === "source" && after.length > 0) return { changes: [{ from: before.from, to, insert: "" }], cursor: before.from };
    if (afterKind === "source" && before.length > 0) {
      return { changes: [{ from: after.from, to: after.to < doc.length ? after.to + 1 : after.to, insert: "" }], cursor: from };
    }
  }
  if (from === fromA && to === toA && text === insert) return null;
  return { changes: [{ from, to, insert: text }], cursor: from + text.length };
}

function touchesHidden(tr: Transaction, head: WikiHead | null, unsorted: readonly Span[]): boolean {
  let touched = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if ((head !== null && fromA < head.to) || overlaps(fromA, toA, unsorted)) touched = true;
  });
  return touched;
}

function changeCount(tr: Transaction): number {
  let count = 0;
  tr.changes.iterChangedRanges(() => {
    count += 1;
  });
  return count;
}

function clampSelection(selection: EditorSelection, floor: number): EditorSelection | null {
  if (selection.ranges.every((range) => range.from >= floor)) return null;
  return EditorSelection.create(
    selection.ranges.map((range) => (range.from >= floor ? range : EditorSelection.range(Math.max(range.anchor, floor), Math.max(range.head, floor)))),
    selection.mainIndex,
  );
}

export const wikiGuard = EditorState.transactionFilter.of((tr) => {
  const context = tr.startState.facet(wikiContext);
  if (context === null) return tr;
  if (guardedEdit(tr)) {
    const head = wikiHead(tr.startState, context.title);
    const unsorted = collectUnsorted(tr.startState).filter((range) => head === null || range.from >= head.to);
    if (changeCount(tr) > 1 && touchesHidden(tr, head, unsorted)) return {};
    const specs: ChangeSpec[] = [];
    const cursors: (number | null)[] = [];
    let modified = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const insert = inserted.toString();
      const guarded = guardChange(tr.startState, head, unsorted, fromA, toA, insert);
      if (guarded !== null) modified = true;
      const change = guarded ?? { changes: [{ from: fromA, to: toA, insert }], cursor: fromA + insert.length };
      for (const part of change.changes) {
        if (part.to > part.from || part.insert !== "") specs.push(part);
      }
      cursors.push(change.cursor);
    });
    if (modified) {
      const changes = ChangeSet.of(specs, tr.startState.doc.length);
      const event = tr.annotation(Transaction.userEvent);
      const cursor = cursors.length === 1 && tr.startState.selection.ranges.length === 1 ? (cursors[0] ?? null) : null;
      return {
        changes,
        selection: cursor === null ? tr.startState.selection.map(changes, 1) : EditorSelection.cursor(cursor),
        effects: tr.effects,
        scrollIntoView: tr.scrollIntoView,
        ...(event === undefined ? {} : { userEvent: event }),
      };
    }
  }
  const head = wikiHead(tr.state, context.title);
  if (head === null) return tr;
  const clamped = clampSelection(tr.newSelection, head.to);
  return clamped === null ? tr : [tr, { selection: clamped, sequential: true }];
});

function blurOnEscape(view: EditorView): boolean {
  if (completionStatus(view.state) !== null) return false;
  const selection = view.state.selection;
  if (selection.ranges.length > 1 || !selection.main.empty) return false;
  view.contentDOM.blur();
  return true;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export const wikiEditorTheme = EditorView.theme({
  ".cm-content": { minHeight: "8rem" },
  ".cm-line.cm-lp-source-line": {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-2xs)",
    lineHeight: "1.2",
    paddingTop: "0",
    paddingBottom: "0.1em",
  },
  ".cm-wiki-source": {
    fontSize: "var(--text-2xs)",
    lineHeight: "1.2",
    color: "color-mix(in oklab, var(--subtle-foreground) 60%, transparent)",
    cursor: "default",
    userSelect: "none",
    transition: "color 120ms ease",
  },
  ".cm-wiki-source:hover": { color: "var(--muted-foreground)" },
  ".cm-wiki-source .cm-lp-link": { textDecorationColor: "color-mix(in oklab, currentColor 40%, transparent)" },
  ".cm-wiki-link-missing": {
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: "color-mix(in oklab, currentColor 55%, transparent)",
    textUnderlineOffset: "4px",
    cursor: "help",
  },
  "&.cm-wiki-raw .cm-content": { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" },
});

const rawMode: Extension = EditorView.editorAttributes.of({ class: "cm-wiki-raw" });

export interface WikiEditorOptions {
  readonly context: WikiEditorContext;
  readonly raw: boolean;
  readonly codeTheme: CodeTheme | null;
  readonly openLink: (href: string) => void;
  readonly save: () => void;
  readonly onUpdate: (update: ViewUpdate) => void;
}

export class WikiEditorConfig {
  readonly context = new Compartment();
  readonly mode = new Compartment();
  readonly code = new Compartment();

  constructor(private readonly options: Pick<WikiEditorOptions, "openLink" | "save" | "onUpdate">) {}

  modeExtension(raw: boolean, context: WikiEditorContext): Extension {
    if (raw) return rawMode;
    return [
      livePreview({
        frontmatter: "hide",
        acceptFrontmatter: wikiAcceptsFrontmatter,
        openLink: this.options.openLink,
        resolveImage: (src) => markdownImageUrl(context.pluginId, src, context.slug),
      }),
      formattingToolbar(),
      wikiBlockField,
      wikiInlinePlugin,
      wikiGuard,
      autocompletion({ override: [slashCommandSource], icons: false }),
    ];
  }

  extensions(options: Pick<WikiEditorOptions, "context" | "raw" | "codeTheme">): Extension {
    return [
      editorBasics({ ariaLabel: `Text of ${options.context.title}`, markdownExtensions: [WikiLinkSyntax] }),
      this.context.of(wikiContext.of(options.context)),
      this.mode.of(this.modeExtension(options.raw, options.context)),
      this.code.of(codeHighlighting(options.codeTheme)),
      livePreviewTheme({ scroll: "page" }),
      wikiEditorTheme,
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              this.options.save();
              return true;
            },
          },
        ]),
      ),
      Prec.high(keymap.of([{ key: "Escape", run: blurOnEscape }])),
      EditorView.domEventHandlers({ drop: (event) => hasFiles(event) }),
      EditorView.updateListener.of(this.options.onUpdate),
    ];
  }
}

export function createWikiState(content: string, extensions: Extension): EditorState {
  const state = EditorState.create({ doc: content, extensions });
  return state.update({ selection: EditorSelection.cursor(wikiBodyStart(state)) }).state;
}
