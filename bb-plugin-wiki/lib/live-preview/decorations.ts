import { syntaxTree } from "@codemirror/language";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  StateField,
  Transaction,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";
import {
  IterMode,
  type SyntaxNode,
  type SyntaxNodeRef,
  type Tree,
} from "@lezer/common";
import { previewStateField, previewValue, isRevealed } from "./state.js";
import { externalChange } from "./document.js";
import { findFrontmatter, type FrontmatterBounds } from "./syntax.js";
import { parseTable, type TableModel } from "./table.js";
import {
  BulletWidget,
  CheckboxWidget,
  CodeLabelWidget,
  FrontmatterWidget,
  HiddenBlockWidget,
  HintWidget,
  HrWidget,
  ImageWidget,
  IndentWidget,
  TableWidget,
  bulletSymbol,
  isVideoSource,
} from "./widgets.js";

export interface LivePreviewOptions {
  resolveImage?: (src: string) => string | null;
  openLink?: (href: string) => void;
  frontmatter?: "hide" | "collapse";
  acceptFrontmatter?: (block: string) => boolean;
  emptyLineHint?: string | null;
}

export interface ResolvedLivePreviewOptions {
  readonly resolveImage: ((src: string) => string | null) | null;
  readonly openLink: ((href: string) => void) | null;
  readonly frontmatter: "hide" | "collapse";
  readonly acceptFrontmatter: ((block: string) => boolean) | null;
  readonly emptyLineHint: string | null;
}

function lastResult(
  accept: (block: string) => boolean,
): (block: string) => boolean {
  let last: string | null = null;
  let result = true;
  return (block) => {
    if (block !== last) {
      result = accept(block);
      last = block;
    }
    return result;
  };
}

export function resolveLivePreviewOptions(
  options: LivePreviewOptions = {},
): ResolvedLivePreviewOptions {
  return {
    resolveImage: options.resolveImage ?? null,
    openLink: options.openLink ?? null,
    frontmatter: options.frontmatter ?? "collapse",
    acceptFrontmatter:
      options.acceptFrontmatter === undefined
        ? null
        : lastResult(options.acceptFrontmatter),
    emptyLineHint:
      options.emptyLineHint === undefined
        ? "Type / for commands"
        : options.emptyLineHint,
  };
}

function frontmatterAccepted(
  doc: Text,
  to: number,
  options: ResolvedLivePreviewOptions,
): boolean {
  return (
    options.acceptFrontmatter === null ||
    options.acceptFrontmatter(doc.sliceString(0, to))
  );
}

export type LivePreviewRange =
  | {
      readonly kind: "line";
      readonly from: number;
      readonly to: number;
      readonly className: string;
    }
  | {
      readonly kind: "mark";
      readonly from: number;
      readonly to: number;
      readonly className: string;
      readonly attributes: Readonly<Record<string, string>> | null;
    }
  | { readonly kind: "hide"; readonly from: number; readonly to: number }
  | {
      readonly kind: "widget";
      readonly from: number;
      readonly to: number;
      readonly widget: WidgetType;
      readonly block: boolean;
    };

const CODE_NODES = new Set(["FencedCode", "CodeBlock"]);
const HINT_BLOCKERS = new Set([
  "FencedCode",
  "CodeBlock",
  "Frontmatter",
  "Table",
  "CommentBlock",
  "HTMLBlock",
]);
const EMPHASIS_MARKS: Readonly<Record<string, string>> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  Highlight: "HighlightMark",
};
const NON_URL_PARENTS = new Set(["Link", "Image", "LinkReference"]);

export function normalizeHref(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (/^www\./i.test(unwrapped)) return `https://${unwrapped}`;
  if (/^[\w.+-]+@[\w-]+(\.[\w.-]+)+$/.test(unwrapped))
    return `mailto:${unwrapped}`;
  return unwrapped;
}

function isSpace(text: string): boolean {
  return text === " " || text === "\t";
}

class RangeBuilder {
  readonly ranges: LivePreviewRange[] = [];
  private readonly seen = new Set<string>();

  constructor(
    readonly state: EditorState,
    readonly from: number,
    readonly to: number,
  ) {}

  private push(key: string, range: LivePreviewRange): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.ranges.push(range);
  }

  text(from: number, to: number): string {
    return this.state.doc.sliceString(from, to);
  }

  touched(from: number, to: number): boolean {
    return isRevealed(this.state, from, to);
  }

  spaceAfter(pos: number): number {
    const line = this.state.doc.lineAt(pos);
    return pos < line.to && isSpace(this.text(pos, pos + 1)) ? pos + 1 : pos;
  }

  line(pos: number, className: string): void {
    const line = this.state.doc.lineAt(pos);
    this.push(`l${line.from}:${className}`, {
      kind: "line",
      from: line.from,
      to: line.from,
      className,
    });
  }

  lines(from: number, to: number, className: string): void {
    const doc = this.state.doc;
    const start = doc.lineAt(Math.max(from, this.from)).number;
    const end = doc.lineAt(Math.min(to, this.to)).number;
    for (let number = start; number <= end; number++) {
      this.line(doc.line(number).from, className);
    }
  }

  private singleLine(from: number, to: number): boolean {
    return to <= this.state.doc.lineAt(from).to;
  }

  hide(from: number, to: number): void {
    if (to <= from || !this.singleLine(from, to)) return;
    this.push(`h${from}:${to}`, { kind: "hide", from, to });
  }

  mark(
    from: number,
    to: number,
    className: string,
    attributes: Readonly<Record<string, string>> | null = null,
  ): void {
    if (to <= from) return;
    this.push(`m${from}:${to}:${className}`, {
      kind: "mark",
      from,
      to,
      className,
      attributes,
    });
  }

  widget(from: number, to: number, widget: WidgetType): void {
    if (to < from || !this.singleLine(from, to)) return;
    this.push(`w${from}:${to}`, {
      kind: "widget",
      from,
      to,
      widget,
      block: false,
    });
  }
}

function childrenNamed(node: SyntaxNode, name: string): SyntaxNode[] {
  return node.getChildren(name);
}

function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") depth++;
  }
  return depth;
}

function tableRevealed(state: EditorState, from: number, to: number): boolean {
  const doc = state.doc;
  return isRevealed(state, doc.lineAt(from).from, doc.lineAt(to).to);
}

function frontmatterRevealed(
  state: EditorState,
  from: number,
  to: number,
  options: ResolvedLivePreviewOptions,
): boolean {
  if (!frontmatterAccepted(state.doc, to, options)) return true;
  return options.frontmatter === "collapse" && isRevealed(state, from, to);
}

function addHeading(b: RangeBuilder, node: SyntaxNode, level: number): void {
  const doc = b.state.doc;
  const line = doc.lineAt(node.from);
  b.line(line.from, `cm-lp-heading cm-lp-h${level}`);
  const marks = childrenNamed(node, "HeaderMark");
  const open = marks[0];
  if (open === undefined) return;
  let contentStart = open.to;
  while (
    contentStart < line.to &&
    isSpace(b.text(contentStart, contentStart + 1))
  )
    contentStart++;
  if (!b.touched(line.from, contentStart)) b.hide(open.from, contentStart);
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  if (close === undefined || close.from < contentStart) return;
  let closeStart = close.from;
  while (
    closeStart > contentStart &&
    isSpace(b.text(closeStart - 1, closeStart))
  )
    closeStart--;
  if (!b.touched(closeStart, close.to)) b.hide(closeStart, close.to);
}

function addSetextHeading(
  b: RangeBuilder,
  node: SyntaxNode,
  level: number,
): void {
  const marks = childrenNamed(node, "HeaderMark");
  const underline = marks[marks.length - 1];
  if (underline === undefined) return;
  const doc = b.state.doc;
  const underlineLine = doc.lineAt(underline.from);
  if (underlineLine.from > node.from) {
    b.lines(node.from, underlineLine.from - 1, `cm-lp-heading cm-lp-h${level}`);
  }
  if (underlineLine.from >= b.from && underlineLine.from <= b.to)
    b.line(underlineLine.from, "cm-lp-setext-mark");
}

function addListIndent(
  b: RangeBuilder,
  node: SyntaxNode,
  mark: SyntaxNode,
): void {
  const line = b.state.doc.lineAt(mark.from);
  if (mark.from <= line.from || b.text(line.from, mark.from).trim() !== "")
    return;
  const level = listDepth(node) - 1;
  if (level > 0) b.widget(line.from, mark.from, new IndentWidget(level));
}

function quoteDepth(node: SyntaxNode): number {
  let depth = 0;
  for (
    let current: SyntaxNode | null = node;
    current !== null;
    current = current.parent
  ) {
    if (current.name === "Blockquote") depth++;
  }
  return depth;
}

function addListItem(b: RangeBuilder, node: SyntaxNode): void {
  const mark = node.getChild("ListMark");
  if (mark === null) return;
  addListIndent(b, node, mark);
  const ordered = node.parent?.name === "OrderedList";
  const task = node.getChild("Task");
  const taskMarker = task?.getChild("TaskMarker") ?? null;
  if (task !== null && taskMarker !== null) {
    const checked =
      b.text(taskMarker.from + 1, taskMarker.from + 2).toLowerCase() === "x";
    if (checked)
      b.mark(b.spaceAfter(taskMarker.to), task.to, "cm-lp-task-done");
    b.line(mark.from, "cm-lp-task-line");
    if (!b.touched(mark.from, taskMarker.to))
      b.widget(mark.from, taskMarker.to, new CheckboxWidget(checked));
    return;
  }
  if (ordered) {
    b.mark(mark.from, mark.to, "cm-lp-list-mark");
    return;
  }
  if (!b.touched(mark.from, mark.to)) {
    b.widget(
      mark.from,
      mark.to,
      new BulletWidget(bulletSymbol(listDepth(node))),
    );
  }
}

function hideQuoteMark(b: RangeBuilder, from: number, to: number): void {
  if (!b.touched(from, to + 1)) b.hide(from, b.spaceAfter(to));
}

function hideNestedQuoteMarks(b: RangeBuilder, node: SyntaxNode): void {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.to < b.from || child.from > b.to || child.name === "CodeText")
      continue;
    if (child.name === "QuoteMark") hideQuoteMark(b, child.from, child.to);
    else hideNestedQuoteMarks(b, child);
  }
}

function hideInnerQuoteMarks(b: RangeBuilder, node: SyntaxNode): void {
  if (quoteDepth(node) > 0) hideNestedQuoteMarks(b, node);
}

function addCodeLines(b: RangeBuilder, from: number, to: number): void {
  const doc = b.state.doc;
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  b.lines(first.from, last.to, "cm-lp-codeblock");
  if (first.from >= b.from && first.from <= b.to)
    b.line(first.from, "cm-lp-codeblock-first");
  if (last.from >= b.from && last.from <= b.to)
    b.line(last.from, "cm-lp-codeblock-last");
}

function addFencedCode(b: RangeBuilder, node: SyntaxNode): void {
  const doc = b.state.doc;
  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  addCodeLines(b, node.from, node.to);
  if (b.touched(first.from, last.to)) return;
  const marks = childrenNamed(node, "CodeMark");
  const open = marks[0];
  if (open !== undefined) {
    const info = node.getChild("CodeInfo");
    b.widget(
      open.from,
      first.to,
      new CodeLabelWidget(info === null ? "" : b.text(info.from, info.to)),
    );
  }
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  if (close !== undefined && close.from > first.to)
    b.hide(close.from, close.to);
}

function linkParts(
  b: RangeBuilder,
  node: SyntaxNode,
): {
  open: SyntaxNode;
  close: SyntaxNode;
  url: SyntaxNode | null;
  href: string;
} | null {
  const marks = childrenNamed(node, "LinkMark");
  const open = marks[0];
  const close = marks[1];
  const paren = marks[2];
  if (open === undefined || close === undefined || paren === undefined)
    return null;
  if (b.text(paren.from, paren.to) !== "(") return null;
  const url = node.getChild("URL");
  return {
    open,
    close,
    url,
    href: url === null ? "" : normalizeHref(b.text(url.from, url.to)),
  };
}

function addLink(b: RangeBuilder, node: SyntaxNode): boolean {
  const parts = linkParts(b, node);
  if (parts === null) return false;
  const revealed = b.touched(node.from, node.to);
  const attributes: Record<string, string> = {};
  if (parts.href !== "") attributes["data-href"] = parts.href;
  if (!revealed) attributes["data-lp-rendered"] = "true";
  b.mark(parts.open.to, parts.close.from, "cm-lp-link", attributes);
  if (!revealed) {
    b.hide(parts.open.from, parts.open.to);
    b.hide(parts.close.from, node.to);
  } else if (parts.url !== null && parts.href !== "") {
    b.mark(parts.url.from, parts.url.to, "cm-lp-link-url", {
      "data-href": parts.href,
    });
  }
  return true;
}

function addImage(
  b: RangeBuilder,
  node: SyntaxNode,
  options: ResolvedLivePreviewOptions,
): void {
  const parts = linkParts(b, node);
  if (parts === null) return;
  const resolved =
    options.resolveImage === null || parts.href === ""
      ? null
      : options.resolveImage(parts.href);
  if (resolved !== null) {
    if (!b.touched(node.from, node.to)) {
      const alt = b.text(parts.open.to, parts.close.from);
      b.widget(
        node.from,
        node.to,
        new ImageWidget(resolved, alt, isVideoSource(parts.href)),
      );
    }
    return;
  }
  addLink(b, node);
}

function addEmptyLineHint(
  b: RangeBuilder,
  options: ResolvedLivePreviewOptions,
): void {
  const hint = options.emptyLineHint;
  if (hint === null || hint === "") return;
  const state = b.state;
  const value = previewValue(state);
  if (!value.focused || value.pointerSelecting) return;
  const main = state.selection.main;
  if (!main.empty || state.selection.ranges.length > 1) return;
  const line = state.doc.lineAt(main.head);
  if (line.length !== 0 || line.from < b.from || line.from > b.to) return;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1);
    node !== null;
    node = node.parent
  ) {
    if (HINT_BLOCKERS.has(node.name)) return;
  }
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, -1);
    node !== null;
    node = node.parent
  ) {
    if (HINT_BLOCKERS.has(node.name) && node.to > line.from) return;
  }
  b.widget(line.from, line.from, new HintWidget(hint));
}

function visitInline(
  b: RangeBuilder,
  ref: SyntaxNodeRef,
  options: ResolvedLivePreviewOptions,
): boolean {
  const name = ref.name;
  const node = ref.node;
  const atx = /^ATXHeading(\d)$/.exec(name);
  if (atx !== null) {
    addHeading(b, node, Number(atx[1]));
    return true;
  }
  const setext = /^SetextHeading(\d)$/.exec(name);
  if (setext !== null) {
    addSetextHeading(b, node, Number(setext[1]));
    return true;
  }
  const emphasisMark = EMPHASIS_MARKS[name];
  if (emphasisMark !== undefined) {
    if (!b.touched(node.from, node.to)) {
      for (const mark of childrenNamed(node, emphasisMark))
        b.hide(mark.from, mark.to);
    }
    return true;
  }
  switch (name) {
    case "Frontmatter":
      if (frontmatterRevealed(b.state, node.from, node.to, options)) {
        b.lines(node.from, node.to, "cm-lp-frontmatter-line");
      }
      return false;
    case "Table":
      if (tableRevealed(b.state, node.from, node.to)) {
        b.lines(node.from, node.to, "cm-lp-table-source");
        hideInnerQuoteMarks(b, node);
      }
      return false;
    case "FencedCode":
      addFencedCode(b, node);
      hideInnerQuoteMarks(b, node);
      return false;
    case "CodeBlock":
      addCodeLines(b, node.from, node.to);
      hideInnerQuoteMarks(b, node);
      return false;
    case "CommentBlock":
      b.lines(node.from, node.to, "cm-lp-comment-line");
      hideInnerQuoteMarks(b, node);
      return false;
    case "Blockquote":
      b.lines(
        node.from,
        node.to,
        quoteDepth(node) > 1 ? "cm-lp-quote-nested" : "cm-lp-quote",
      );
      return true;
    case "QuoteMark":
      hideQuoteMark(b, node.from, node.to);
      return false;
    case "ListItem":
      addListItem(b, node);
      return true;
    case "HorizontalRule": {
      const line = b.state.doc.lineAt(node.from);
      b.line(line.from, "cm-lp-hr-line");
      if (!b.touched(line.from, line.to))
        b.widget(node.from, node.to, new HrWidget());
      return false;
    }
    case "InlineCode":
      b.mark(node.from, node.to, "cm-lp-inline-code");
      if (!b.touched(node.from, node.to)) {
        for (const mark of childrenNamed(node, "CodeMark"))
          b.hide(mark.from, mark.to);
      }
      return false;
    case "Link":
      addLink(b, node);
      return true;
    case "Image":
      addImage(b, node, options);
      return false;
    case "Autolink": {
      const url = node.getChild("URL");
      if (url !== null) {
        b.mark(url.from, url.to, "cm-lp-url", {
          "data-href": normalizeHref(b.text(url.from, url.to)),
        });
      }
      if (!b.touched(node.from, node.to)) {
        for (const mark of childrenNamed(node, "LinkMark"))
          b.hide(mark.from, mark.to);
      }
      return false;
    }
    case "URL":
      if (!NON_URL_PARENTS.has(node.parent?.name ?? "")) {
        b.mark(node.from, node.to, "cm-lp-url", {
          "data-href": normalizeHref(b.text(node.from, node.to)),
        });
      }
      return false;
    case "Escape":
      if (!b.touched(node.from, node.to)) b.hide(node.from, node.from + 1);
      return false;
    default:
      return true;
  }
}

export function buildInlineDecorations(
  state: EditorState,
  from: number,
  to: number,
  options: ResolvedLivePreviewOptions,
): LivePreviewRange[] {
  const builder = new RangeBuilder(state, from, to);
  collectInline(builder, from, to, options);
  addEmptyLineHint(builder, options);
  return builder.ranges;
}

function collectInline(
  b: RangeBuilder,
  from: number,
  to: number,
  options: ResolvedLivePreviewOptions,
): void {
  syntaxTree(b.state).iterate({
    from,
    to,
    mode: IterMode.IgnoreMounts,
    enter: (ref) => visitInline(b, ref, options),
  });
}

export function buildVisibleDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  options: ResolvedLivePreviewOptions,
): LivePreviewRange[] {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return [];
  const builder = new RangeBuilder(state, first.from, last.to);
  for (const range of ranges)
    collectInline(builder, range.from, range.to, options);
  addEmptyLineHint(builder, options);
  return builder.ranges;
}

const hiddenDecoration = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();

function markDecoration(
  className: string,
  attributes: Readonly<Record<string, string>> | null,
): Decoration {
  if (attributes !== null)
    return Decoration.mark({ class: className, attributes: { ...attributes } });
  let known = markCache.get(className);
  if (known === undefined) {
    known = Decoration.mark({ class: className });
    markCache.set(className, known);
  }
  return known;
}

function lineDecoration(className: string): Decoration {
  let known = lineCache.get(className);
  if (known === undefined) {
    known = Decoration.line({ class: className });
    lineCache.set(className, known);
  }
  return known;
}

export function toDecorationSet(
  ranges: readonly LivePreviewRange[],
): DecorationSet {
  const built: Range<Decoration>[] = [];
  for (const range of ranges) {
    switch (range.kind) {
      case "line":
        built.push(lineDecoration(range.className).range(range.from));
        break;
      case "mark":
        built.push(
          markDecoration(range.className, range.attributes).range(
            range.from,
            range.to,
          ),
        );
        break;
      case "hide":
        built.push(hiddenDecoration.range(range.from, range.to));
        break;
      case "widget":
        if (range.from === range.to && !range.block) {
          built.push(
            Decoration.widget({ widget: range.widget, side: 1 }).range(
              range.from,
            ),
          );
        } else {
          built.push(
            Decoration.replace({
              widget: range.widget,
              block: range.block,
            }).range(range.from, range.to),
          );
        }
        break;
    }
  }
  return Decoration.set(built, true);
}

interface BlockNode {
  readonly name: "Table" | "Frontmatter";
  readonly from: number;
  readonly to: number;
}

const blockNodeCache = new WeakMap<Tree, readonly BlockNode[]>();
const CONTAINER_NODES = new Set([
  "Document",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
]);

function collectBlockNodes(tree: Tree): readonly BlockNode[] {
  const known = blockNodeCache.get(tree);
  if (known !== undefined) return known;
  const found: BlockNode[] = [];
  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(ref) {
      if (ref.name === "Table" || ref.name === "Frontmatter") {
        found.push({ name: ref.name, from: ref.from, to: ref.to });
        return false;
      }
      return CONTAINER_NODES.has(ref.name);
    },
  });
  blockNodeCache.set(tree, found);
  return found;
}

function tableModelAt(state: EditorState, from: number): TableModel | null {
  const node = syntaxTree(state).resolveInner(from, 1);
  let table: SyntaxNode | null = node;
  while (table !== null && table.name !== "Table") table = table.parent;
  if (table === null) return null;
  const start = state.doc.lineAt(table.from).from;
  const lines: string[] = [];
  const offsets: number[] = [];
  for (
    let child = table.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (
      child.name === "TableHeader" ||
      child.name === "TableDelimiter" ||
      child.name === "TableRow"
    ) {
      lines.push(state.doc.sliceString(child.from, child.to));
      offsets.push(child.from - start);
    }
  }
  return parseTable(lines, offsets);
}

export interface BlockDecorations {
  readonly ranges: readonly LivePreviewRange[];
  readonly atomic: readonly { from: number; to: number }[];
  readonly key: string;
}

export function buildBlockDecorations(
  state: EditorState,
  options: ResolvedLivePreviewOptions,
): BlockDecorations {
  const ranges: LivePreviewRange[] = [];
  const atomic: { from: number; to: number }[] = [];
  const keys: string[] = [];
  const doc = state.doc;
  for (const block of collectBlockNodes(syntaxTree(state))) {
    if (block.name === "Frontmatter") {
      if (!frontmatterAccepted(doc, block.to, options)) {
        keys.push("fx");
      } else if (options.frontmatter === "hide") {
        const end = block.to + 1 < doc.length ? block.to + 1 : block.to;
        ranges.push({
          kind: "widget",
          from: block.from,
          to: end,
          widget: new HiddenBlockWidget(),
          block: true,
        });
        atomic.push({ from: block.from, to: end });
        keys.push(`f${block.from}:${end}`);
      } else if (!isRevealed(state, block.from, block.to)) {
        ranges.push({
          kind: "widget",
          from: block.from,
          to: block.to,
          widget: new FrontmatterWidget("Properties"),
          block: true,
        });
        keys.push(`f${block.from}:${block.to}`);
      } else {
        keys.push("fr");
      }
      continue;
    }
    const from = doc.lineAt(block.from).from;
    const to = doc.lineAt(block.to).to;
    if (tableRevealed(state, block.from, block.to)) {
      keys.push(`tr${from}`);
      continue;
    }
    const model = tableModelAt(state, block.from);
    if (model === null) continue;
    ranges.push({
      kind: "widget",
      from,
      to,
      widget: new TableWidget(model),
      block: true,
    });
    keys.push(`t${from}:${to}`);
  }
  return { ranges, atomic, key: keys.join(",") };
}

interface BlockFieldValue {
  readonly decorations: DecorationSet;
  readonly atomic: RangeSet<Decoration>;
  readonly key: string;
}

function blockFieldValue(
  state: EditorState,
  options: ResolvedLivePreviewOptions,
): BlockFieldValue {
  const built = buildBlockDecorations(state, options);
  return {
    decorations: toDecorationSet(built.ranges),
    atomic: RangeSet.of(
      built.atomic.map((range) => hiddenDecoration.range(range.from, range.to)),
      true,
    ),
    key: built.key,
  };
}

function needsRebuild(tr: Transaction): boolean {
  return (
    tr.docChanged ||
    tr.selection !== undefined ||
    syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
    tr.state.field(previewStateField, false) !==
      tr.startState.field(previewStateField, false)
  );
}

function blockField(
  options: ResolvedLivePreviewOptions,
): StateField<BlockFieldValue> {
  return StateField.define<BlockFieldValue>({
    create: (state) => blockFieldValue(state, options),
    update(value, tr) {
      if (!needsRebuild(tr)) return value;
      const next = blockFieldValue(tr.state, options);
      if (
        !tr.docChanged &&
        syntaxTree(tr.state) === syntaxTree(tr.startState) &&
        next.key === value.key
      )
        return value;
      return next;
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ],
  });
}

function frontmatterBounds(
  doc: Text,
  options: ResolvedLivePreviewOptions,
): FrontmatterBounds | null {
  const bounds = findFrontmatter(
    (from, to) => doc.sliceString(from, to),
    doc.length,
  );
  return bounds !== null && frontmatterAccepted(doc, bounds.to, options)
    ? bounds
    : null;
}

function guardedEdit(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    tr.annotation(externalChange) !== true &&
    tr.annotation(Transaction.userEvent) !== undefined &&
    !tr.isUserEvent("undo") &&
    !tr.isUserEvent("redo")
  );
}

function hiddenFloor(doc: Text, bounds: FrontmatterBounds): number {
  return Math.min(doc.length, bounds.to + 1);
}

function clampSelection(
  selection: EditorSelection,
  floor: number,
): EditorSelection | null {
  if (selection.ranges.every((range) => range.from >= floor)) return null;
  return EditorSelection.create(
    selection.ranges.map((range) =>
      range.from >= floor
        ? range
        : EditorSelection.range(
            Math.max(range.anchor, floor),
            Math.max(range.head, floor),
          ),
    ),
    selection.mainIndex,
  );
}

function guardChanges(
  tr: Transaction,
  bounds: FrontmatterBounds,
  hide: boolean,
): ChangeSpec[] | null {
  const doc = tr.startState.doc;
  const floor = hide ? hiddenFloor(doc, bounds) : bounds.to + 1;
  const bare = hide && bounds.to === doc.length;
  if (!hide && bounds.to >= doc.length) return null;
  const changes: ChangeSpec[] = [];
  let modified = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.toString();
    let from = fromA;
    let to = toA;
    if (hide) {
      if (from < floor) {
        from = floor;
        to = Math.max(to, floor);
      }
    } else if (from === bounds.to && to > bounds.to) {
      from = floor;
    }
    const prefix = bare && from === floor && insert !== "" ? "\n" : "";
    if (from !== fromA || to !== toA || prefix !== "") modified = true;
    if (to > from || insert !== "")
      changes.push({ from, to, insert: prefix + insert });
  });
  return modified ? changes : null;
}

function frontmatterGuard(options: ResolvedLivePreviewOptions): Extension {
  const hide = options.frontmatter === "hide";
  return EditorState.transactionFilter.of((tr) => {
    if (guardedEdit(tr)) {
      const bounds = frontmatterBounds(tr.startState.doc, options);
      const changes = bounds === null ? null : guardChanges(tr, bounds, hide);
      if (bounds !== null && changes !== null) {
        const set = ChangeSet.of(changes, tr.startState.doc.length);
        const start = hide
          ? (clampSelection(
              tr.startState.selection,
              hiddenFloor(tr.startState.doc, bounds),
            ) ?? tr.startState.selection)
          : tr.startState.selection;
        const event = tr.annotation(Transaction.userEvent);
        return {
          changes: set,
          selection: set.empty ? start : start.map(set, 1),
          effects: tr.effects,
          scrollIntoView: tr.scrollIntoView,
          ...(event === undefined ? {} : { userEvent: event }),
        };
      }
    }
    if (!hide) return tr;
    const bounds = frontmatterBounds(tr.newDoc, options);
    if (bounds === null) return tr;
    const clamped = clampSelection(
      tr.newSelection,
      hiddenFloor(tr.newDoc, bounds),
    );
    return clamped === null
      ? tr
      : [tr, { selection: clamped, sequential: true }];
  });
}

function isMac(): boolean {
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (nav === null) return false;
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent);
}

function isModClick(event: MouseEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

interface LinkPress {
  readonly href: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: number | null;
  dragging: boolean;
}

const DRAG_DISTANCE = 4;

class LinkClicks {
  private press: LinkPress | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly open: (href: string) => void,
  ) {}

  start(event: MouseEvent, href: string): void {
    this.cancel();
    this.press = {
      href,
      x: event.clientX,
      y: event.clientY,
      anchor: this.view.posAtCoords({ x: event.clientX, y: event.clientY }),
      dragging: false,
    };
    const doc = this.view.dom.ownerDocument;
    doc.addEventListener("mousemove", this.move, true);
    doc.addEventListener("mouseup", this.up, true);
  }

  private readonly move = (event: MouseEvent): void => {
    const press = this.press;
    if (press === null) return;
    if (event.buttons === 0) {
      this.cancel();
      return;
    }
    if (
      !press.dragging &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) <
        DRAG_DISTANCE
    )
      return;
    press.dragging = true;
    const head = this.view.posAtCoords(
      { x: event.clientX, y: event.clientY },
      false,
    );
    if (!this.view.hasFocus) this.view.focus();
    this.view.dispatch({
      selection: EditorSelection.range(press.anchor ?? head, head),
      userEvent: "select.pointer",
    });
  };

  private readonly up = (event: MouseEvent): void => {
    const press = this.press;
    this.cancel();
    if (press !== null && !press.dragging && event.button === 0)
      this.open(press.href);
  };

  cancel(): void {
    const doc = this.view.dom.ownerDocument;
    doc.removeEventListener("mousemove", this.move, true);
    doc.removeEventListener("mouseup", this.up, true);
    this.press = null;
  }
}

function inlinePlugin(options: ResolvedLivePreviewOptions): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      readonly links: LinkClicks | null;

      constructor(view: EditorView) {
        this.decorations = toDecorationSet(
          buildVisibleDecorations(view.state, view.visibleRanges, options),
        );
        this.links =
          options.openLink === null
            ? null
            : new LinkClicks(view, options.openLink);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState) ||
          update.state.field(previewStateField, false) !==
            update.startState.field(previewStateField, false)
        ) {
          this.decorations = toDecorationSet(
            buildVisibleDecorations(
              update.state,
              update.view.visibleRanges,
              options,
            ),
          );
        }
      }

      destroy(): void {
        this.links?.cancel();
      }
    },
    {
      decorations: (value) => value.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const open = options.openLink;
          if (open === null || event.button !== 0) return false;
          const target = event.target;
          if (!(target instanceof Element)) return false;
          const link = target.closest("[data-href]");
          if (link === null || !view.contentDOM.contains(link)) return false;
          const href = link.getAttribute("data-href");
          if (href === null || href === "") return false;
          if (isModClick(event)) {
            event.preventDefault();
            open(href);
            return true;
          }
          const plain =
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey;
          const rendered =
            link.classList.contains("cm-lp-link") &&
            link.getAttribute("data-lp-rendered") === "true";
          if (!plain || !rendered || this.links === null) return false;
          event.preventDefault();
          this.links.start(event, href);
          return true;
        },
      },
    },
  );
}

function stepIntoTable(view: EditorView, forward: boolean): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty) return false;
  const doc = state.doc;
  const tables = collectBlockNodes(syntaxTree(state)).filter(
    (block) => block.name === "Table",
  );
  const ordered = forward ? tables : [...tables].reverse();
  const table = ordered.find((block) =>
    forward
      ? doc.lineAt(block.from).from > range.head
      : doc.lineAt(block.to).to < range.head,
  );
  if (table === undefined || tableRevealed(state, table.from, table.to))
    return false;
  const from = doc.lineAt(table.from).from;
  const to = doc.lineAt(table.to).to;
  const target = view.moveVertically(range, forward).head;
  if (forward ? target < from : target > to) return false;
  const line = doc.lineAt(forward ? from : to);
  const column = range.head - doc.lineAt(range.head).from;
  view.dispatch({
    selection: EditorSelection.cursor(
      line.from + Math.min(column, line.length),
    ),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

const tableKeys: Extension = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (view) => stepIntoTable(view, true) },
    { key: "ArrowUp", run: (view) => stepIntoTable(view, false) },
  ]),
);

export function livePreview(options: LivePreviewOptions = {}): Extension {
  const resolved = resolveLivePreviewOptions(options);
  return [
    blockField(resolved),
    inlinePlugin(resolved),
    frontmatterGuard(resolved),
    tableKeys,
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  ];
}

export function isInsideCode(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node !== null;
    node = node.parent
  ) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}
