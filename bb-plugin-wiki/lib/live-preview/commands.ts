import {
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown";
import {
  ensureSyntaxTree,
  foldKeymap,
  indentUnit,
  syntaxTree,
} from "@codemirror/language";
import {
  ChangeSet,
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type StateCommand,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { isInsideCode } from "./decorations.js";

export type MarkKind = "bold" | "italic" | "strike" | "highlight" | "code";

export const MARKERS: Readonly<Record<MarkKind, string>> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  highlight: "==",
  code: "`",
};

const NODE_NAMES: Readonly<Record<MarkKind, string>> = {
  bold: "StrongEmphasis",
  italic: "Emphasis",
  strike: "Strikethrough",
  highlight: "Highlight",
  code: "InlineCode",
};

const MARK_NAMES: Readonly<Record<MarkKind, string>> = {
  bold: "EmphasisMark",
  italic: "EmphasisMark",
  strike: "StrikethroughMark",
  highlight: "HighlightMark",
  code: "CodeMark",
};

interface Part {
  readonly from: number;
  readonly to: number;
}

function enclosingNode(
  state: EditorState,
  from: number,
  to: number,
  name: string,
): SyntaxNode | null {
  const empty = from === to;
  for (const side of [1, -1] as const) {
    for (
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, side);
      node !== null;
      node = node.parent
    ) {
      if (node.name !== name) continue;
      if (
        empty
          ? node.from < from && node.to > to
          : node.from <= from && node.to >= to
      )
        return node;
    }
  }
  return null;
}

export function enclosingMark(
  state: EditorState,
  from: number,
  to: number,
  kind: MarkKind,
): SyntaxNode | null {
  return enclosingNode(state, from, to, NODE_NAMES[kind]);
}

function trimPart(state: EditorState, from: number, to: number): Part | null {
  const text = state.doc.sliceString(from, to);
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (end <= start) return null;
  return { from: from + start, to: from + end };
}

const EDGE_MARKS = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "HighlightMark",
  "CodeMark",
]);
const START_MARKS = new Set([
  ...EDGE_MARKS,
  "ListMark",
  "QuoteMark",
  "HeaderMark",
  "TaskMarker",
]);
const INLINE_NODES = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "Highlight",
  "InlineCode",
  "Link",
  "Image",
  "Autolink",
  "URL",
]);
const ATOMIC_INLINE = new Set(["Autolink", "URL"]);

function markAt(
  state: EditorState,
  pos: number,
  side: 1 | -1,
  names: ReadonlySet<string>,
): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    node !== null;
    node = node.parent
  ) {
    if (
      names.has(node.name) &&
      (side > 0 ? node.from === pos : node.to === pos)
    )
      return node;
  }
  return null;
}

function skipSpaces(state: EditorState, pos: number, limit: number): number {
  let at = pos;
  while (at < limit && /[ \t]/.test(state.doc.sliceString(at, at + 1))) at++;
  return at;
}

function skipSpacesBack(
  state: EditorState,
  pos: number,
  limit: number,
): number {
  let at = pos;
  while (at > limit && /[ \t]/.test(state.doc.sliceString(at - 1, at))) at--;
  return at;
}

function linkTextBounds(node: SyntaxNode): Part | null {
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  return open === undefined || close === undefined
    ? null
    : { from: open.to, to: close.from };
}

function expansionFor(
  state: EditorState,
  from: number,
  to: number,
  kind: MarkKind,
): Part {
  let start = from;
  let end = to;
  syntaxTree(state).iterate({
    from,
    to,
    enter(ref) {
      if (!INLINE_NODES.has(ref.name)) return undefined;
      const contains = ref.from <= from && ref.to >= to;
      if (!contains) {
        if (ref.from < to && ref.to > from) {
          start = Math.min(start, ref.from);
          end = Math.max(end, ref.to);
        }
        return undefined;
      }
      const exact = ref.from === from && ref.to === to;
      if (exact) return undefined;
      if (
        (ref.name === "InlineCode" && kind !== "code") ||
        ATOMIC_INLINE.has(ref.name)
      ) {
        start = Math.min(start, ref.from);
        end = Math.max(end, ref.to);
        return undefined;
      }
      if (ref.name === "Link" || ref.name === "Image") {
        const text = linkTextBounds(ref.node);
        if (text === null || from < text.from || to > text.to) {
          start = Math.min(start, ref.from);
          end = Math.max(end, ref.to);
        }
      }
      return undefined;
    },
  });
  return { from: start, to: end };
}

function normalizePart(
  state: EditorState,
  part: Part,
  kind: MarkKind,
): Part | null {
  let from = part.from;
  let to = part.to;
  for (let changed = true; changed && from < to;) {
    changed = false;
    const opening = markAt(state, from, 1, START_MARKS);
    if (opening !== null && opening.to <= to) {
      from = skipSpaces(state, opening.to, to);
      changed = true;
    }
    const closing = markAt(state, to, -1, EDGE_MARKS);
    if (closing !== null && closing.from >= from && from < to) {
      to = skipSpacesBack(state, closing.from, from);
      changed = true;
    }
  }
  if (from >= to) return null;
  for (;;) {
    const next = expansionFor(state, from, to, kind);
    if (next.from === from && next.to === to) return { from, to };
    from = next.from;
    to = next.to;
  }
}

function rangeParts(
  state: EditorState,
  range: SelectionRange,
  kind: MarkKind,
): Part[] {
  if (range.empty) return [{ from: range.from, to: range.to }];
  const parts: Part[] = [];
  const doc = state.doc;
  const first = doc.lineAt(range.from).number;
  const last = doc.lineAt(range.to).number;
  for (let number = first; number <= last; number++) {
    const line = doc.line(number);
    const trimmed = trimPart(
      state,
      Math.max(line.from, range.from),
      Math.min(line.to, range.to),
    );
    const part = trimmed === null ? null : normalizePart(state, trimmed, kind);
    if (part !== null) parts.push(part);
  }
  return parts;
}

function markChildren(node: SyntaxNode, kind: MarkKind): SyntaxNode[] {
  const marks = node.getChildren(MARK_NAMES[kind]);
  const first = marks[0];
  const last = marks[marks.length - 1];
  if (first === undefined || last === undefined || first === last) return [];
  return [first, last];
}

function overlappingNodes(
  state: EditorState,
  part: Part,
  kind: MarkKind,
): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const name = NODE_NAMES[kind];
  syntaxTree(state).iterate({
    from: part.from,
    to: part.to,
    enter(ref) {
      if (ref.name === name && ref.from < part.to && ref.to > part.from) {
        found.push(ref.node);
        return false;
      }
      return undefined;
    },
  });
  return found;
}

export function markActive(state: EditorState, kind: MarkKind): boolean {
  const parts = rangeParts(state, state.selection.main, kind);
  return (
    parts.length > 0 &&
    parts.every(
      (part) => enclosingMark(state, part.from, part.to, kind) !== null,
    )
  );
}

export function toggleMarkSpec(
  state: EditorState,
  kind: MarkKind,
): TransactionSpec {
  const marker = MARKERS[kind];
  const ranges = state.selection.ranges;
  const partsByRange = ranges.map((range) => rangeParts(state, range, kind));
  const allParts = partsByRange.flat();
  const active =
    allParts.length > 0 &&
    allParts.every(
      (part) => enclosingMark(state, part.from, part.to, kind) !== null,
    );
  const removals: ChangeSpec[] = [];
  const inserts: ChangeSpec[] = [];
  const removed = new Set<number>();
  const cursorInserts = new Set<number>();
  const removeMarks = (node: SyntaxNode): void => {
    for (const mark of markChildren(node, kind)) {
      if (removed.has(mark.from)) continue;
      removed.add(mark.from);
      removals.push({ from: mark.from, to: mark.to });
    }
  };
  for (const part of allParts) {
    const container = enclosingMark(state, part.from, part.to, kind);
    if (active) {
      if (container !== null) removeMarks(container);
      continue;
    }
    if (container !== null) continue;
    if (part.from === part.to) {
      if (!cursorInserts.has(part.from)) {
        cursorInserts.add(part.from);
        inserts.push({ from: part.from, insert: marker + marker });
      }
      continue;
    }
    let from = part.from;
    let to = part.to;
    for (const node of overlappingNodes(state, part, kind)) {
      from = Math.min(from, node.from);
      to = Math.max(to, node.to);
      removeMarks(node);
    }
    inserts.push({ from, insert: marker }, { from: to, insert: marker });
  }
  const removeSet = ChangeSet.of(removals, state.doc.length);
  const insertSet = ChangeSet.of(inserts, state.doc.length).map(removeSet);
  const set = removeSet.compose(insertSet);
  const mapPos = (pos: number, assoc: 1 | -1): number =>
    insertSet.mapPos(removeSet.mapPos(pos, assoc), assoc);
  const selection = EditorSelection.create(
    ranges.map((range, index) => {
      if (range.empty) {
        return EditorSelection.cursor(
          cursorInserts.has(range.head) && !active
            ? mapPos(range.head, -1) + marker.length
            : mapPos(range.head, 1),
        );
      }
      const parts = partsByRange[index] ?? [];
      const firstPart = parts[0];
      const lastPart = parts[parts.length - 1];
      const start =
        firstPart === undefined
          ? range.from
          : Math.max(range.from, firstPart.from);
      const end =
        lastPart === undefined ? range.to : Math.min(range.to, lastPart.to);
      const from = mapPos(start, 1);
      const to = Math.max(from, mapPos(end, -1));
      return range.anchor <= range.head
        ? EditorSelection.range(from, to)
        : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  return {
    changes: set,
    selection,
    scrollIntoView: true,
    userEvent: active ? "delete.format" : "input.format",
  };
}

export function toggleMark(kind: MarkKind): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(state.update(toggleMarkSpec(state, kind)));
    return true;
  };
}

export function linkActive(state: EditorState): boolean {
  const main = state.selection.main;
  return enclosingNode(state, main.from, main.to, "Link") !== null;
}

export const insertLink: StateCommand = ({ state, dispatch }) => {
  const spec = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: "[]()" },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    return {
      changes: [
        { from: range.from, insert: "[" },
        { from: range.to, insert: "](url)" },
      ],
      range: EditorSelection.range(range.to + 3, range.to + 6),
    };
  });
  dispatch(
    state.update(spec, { scrollIntoView: true, userEvent: "input.format" }),
  );
  return true;
};

export type BlockKind =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  | "code"
  | "divider";

const PREFIX_PIECE =
  /^(?:>[ \t]?|#{1,6}(?:[ \t]+|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?:[ \t]+|$))/;
const ORDERED_LINE = /^([ \t]*)(\d{1,9})[.)][ \t]/;

export function blockPrefix(text: string): { indent: string; end: number } {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  let end = indent.length;
  for (;;) {
    const match = PREFIX_PIECE.exec(text.slice(end));
    if (match === null || match[0].length === 0) break;
    end += match[0].length;
  }
  return { indent, end };
}

function orderedStart(
  state: EditorState,
  lineNumber: number,
  indent: string,
): number {
  if (lineNumber <= 1) return 1;
  const previous = ORDERED_LINE.exec(state.doc.line(lineNumber - 1).text);
  if (previous === null || previous[1] !== indent) return 1;
  return Number(previous[2]) + 1;
}

function prefixFor(kind: BlockKind, indent: string, number: number): string {
  switch (kind) {
    case "h1":
      return "# ";
    case "h2":
      return "## ";
    case "h3":
      return "### ";
    case "bullet":
      return `${indent}- `;
    case "ordered":
      return `${indent}${number}. `;
    case "task":
      return `${indent}- [ ] `;
    case "quote":
      return "> ";
    default:
      return "";
  }
}

function selectedLines(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) {
      if (first === last || state.doc.line(number).text.trim() !== "")
        numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

export interface EditPlan {
  readonly changes: ChangeSet;
  readonly selection: EditorSelection;
}

function plan(
  state: EditorState,
  change: ChangeSpec,
  selection: EditorSelection,
): EditPlan {
  return { changes: ChangeSet.of(change, state.doc.length), selection };
}

function codeBlockSpec(state: EditorState): EditPlan {
  const main = state.selection.main;
  const first = state.doc.lineAt(main.from);
  const last = state.doc.lineAt(main.to);
  const body = state.doc.sliceString(first.from, last.to);
  const insert = `\`\`\`\n${body}\n\`\`\``;
  return plan(
    state,
    { from: first.from, to: last.to, insert },
    EditorSelection.single(first.from + 4 + body.length),
  );
}

function dividerSpec(state: EditorState): EditPlan {
  const line = state.doc.lineAt(state.selection.main.head);
  const rule = line.number === 1 && line.text.trim() === "" ? "***" : "---";
  if (line.text.trim() === "") {
    const previousBlank =
      line.number === 1 || state.doc.line(line.number - 1).text.trim() === "";
    const insert = `${previousBlank ? "" : "\n"}${rule}\n`;
    return plan(
      state,
      { from: line.from, to: line.to, insert },
      EditorSelection.single(line.from + insert.length),
    );
  }
  const insert = `\n\n${rule}\n`;
  return plan(
    state,
    { from: line.to, insert },
    EditorSelection.single(line.to + insert.length),
  );
}

export function setBlockSpec(state: EditorState, kind: BlockKind): EditPlan {
  if (kind === "code") return codeBlockSpec(state);
  if (kind === "divider") return dividerSpec(state);
  const changes: ChangeSpec[] = [];
  let ordinal = 0;
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    const prefix = blockPrefix(line.text);
    if (kind === "ordered" && ordinal === 0)
      ordinal = orderedStart(state, number, prefix.indent);
    const insert = prefixFor(kind, prefix.indent, ordinal);
    if (kind === "ordered") ordinal++;
    if (line.text.slice(0, prefix.end) === insert) continue;
    changes.push({ from: line.from, to: line.from + prefix.end, insert });
  }
  const set = ChangeSet.of(changes, state.doc.length);
  return {
    changes: set,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) =>
        EditorSelection.range(
          set.mapPos(range.anchor, 1),
          set.mapPos(range.head, 1),
        ),
      ),
      state.selection.mainIndex,
    ),
  };
}

export function setBlock(kind: BlockKind): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(
      state.update(setBlockSpec(state, kind), {
        scrollIntoView: true,
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

export const TABLE_TEMPLATE = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";

export function insertTableSpec(state: EditorState): EditPlan {
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === "";
  const from = blank ? line.from : line.to;
  const lead = blank ? "" : "\n\n";
  const next =
    line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const trail = next !== null && next.text.trim() !== "" ? "\n" : "";
  return plan(
    state,
    {
      from,
      to: blank ? line.to : from,
      insert: lead + TABLE_TEMPLATE + trail,
    },
    EditorSelection.single(from + lead.length + 2, from + lead.length + 10),
  );
}

export const insertTable: StateCommand = ({ state, dispatch }) => {
  dispatch(
    state.update(insertTableSpec(state), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

interface ListLine {
  readonly item: SyntaxNode;
  readonly mark: SyntaxNode;
}

function listItemOnLine(
  state: EditorState,
  lineNumber: number,
): ListLine | null {
  const line = state.doc.line(lineNumber);
  const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
  const at = line.from + indent;
  if (at >= line.to) return null;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1);
    node !== null;
    node = node.parent
  ) {
    if (node.name !== "ListItem") continue;
    const mark = node.getChild("ListMark");
    if (mark !== null && mark.from === at) return { item: node, mark };
    return null;
  }
  return null;
}

function contentColumn(state: EditorState, item: ListLine): number {
  const line = state.doc.lineAt(item.mark.from);
  let end = item.mark.to;
  while (end < line.to && state.doc.sliceString(end, end + 1) === " ") end++;
  return end - line.from;
}

function markColumn(state: EditorState, item: ListLine): number {
  return item.mark.from - state.doc.lineAt(item.mark.from).from;
}

function selectedListItems(state: EditorState): ListLine[] {
  const items: ListLine[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) {
      const item = listItemOnLine(state, number);
      if (item !== null && !seen.has(item.item.from)) {
        seen.add(item.item.from);
        items.push(item);
      }
    }
  }
  return items;
}

function itemLines(
  state: EditorState,
  item: ListLine,
  covered: Set<number>,
): number[] {
  const first = state.doc.lineAt(item.item.from).number;
  const last = state.doc.lineAt(item.item.to).number;
  const numbers: number[] = [];
  for (let number = first; number <= last; number++) {
    if (!covered.has(number)) {
      covered.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

function previousSibling(item: SyntaxNode): ListLine | null {
  for (let node = item.prevSibling; node !== null; node = node.prevSibling) {
    if (node.name !== "ListItem") continue;
    const mark = node.getChild("ListMark");
    return mark === null ? null : { item: node, mark };
  }
  return null;
}

const ORDERED_MARK = /^(\d{1,9})[.)]$/;

interface Renumber {
  readonly list: SyntaxNode;
  readonly start: number | null;
}

function itemWithMarkAt(tree: Tree, pos: number): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, 1);
    node !== null;
    node = node.parent
  ) {
    if (node.name === "ListItem")
      return node.getChild("ListMark")?.from === pos ? node : null;
  }
  return null;
}

function firstListItem(list: SyntaxNode): SyntaxNode | null {
  for (let child = list.firstChild; child !== null; child = child.nextSibling)
    if (child.name === "ListItem") return child;
  return null;
}

function renumberChanges(
  doc: Text,
  list: SyntaxNode,
  start: number | null,
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let next = start;
  for (let child = list.firstChild; child !== null; child = child.nextSibling) {
    if (child.name !== "ListItem") continue;
    const mark = child.getChild("ListMark");
    if (mark === null) continue;
    const match = ORDERED_MARK.exec(doc.sliceString(mark.from, mark.to));
    const digits = match?.[1];
    if (digits === undefined) continue;
    const number = next ?? Number(digits);
    if (String(number) !== digits)
      changes.push({
        from: mark.from,
        to: mark.from + digits.length,
        insert: String(number),
      });
    next = number + 1;
  }
  return changes;
}

function withRenumbering(
  state: EditorState,
  changes: ChangeSet,
  targets: (tree: Tree) => readonly Renumber[],
): ChangeSet {
  const next = state.update({ changes }).state;
  const tree = ensureSyntaxTree(next, next.doc.length, 200);
  if (tree === null) return changes;
  const seen = new Set<number>();
  const extra: ChangeSpec[] = [];
  for (const target of targets(tree)) {
    if (target.list.name !== "OrderedList" || seen.has(target.list.from))
      continue;
    seen.add(target.list.from);
    extra.push(...renumberChanges(next.doc, target.list, target.start));
  }
  return extra.length === 0
    ? changes
    : changes.compose(ChangeSet.of(extra, next.doc.length));
}

function movedItems(
  tree: Tree,
  changes: ChangeSet,
  items: readonly ListLine[],
): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (const item of items) {
    const node = itemWithMarkAt(tree, changes.mapPos(item.mark.from, 1));
    if (node !== null) found.push(node);
  }
  return found;
}

export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const items = selectedListItems(state);
  if (items.length === 0) return false;
  const specs: ChangeSpec[] = [];
  const covered = new Set<number>();
  for (const item of items) {
    const sibling = previousSibling(item.item);
    const width =
      sibling === null
        ? item.mark.to - item.mark.from + 1
        : contentColumn(state, sibling) - markColumn(state, item);
    const unit = " ".repeat(Math.max(1, width));
    for (const number of itemLines(state, item, covered)) {
      const line = state.doc.line(number);
      if (line.text.trim() !== "")
        specs.push({ from: line.from, insert: unit });
    }
  }
  const base = ChangeSet.of(specs, state.doc.length);
  const nested = items.filter((item) => previousSibling(item.item) !== null);
  const changes = withRenumbering(state, base, (tree) => {
    const moved = movedItems(tree, base, nested);
    const movedFroms = new Set(moved.map((node) => node.from));
    const targets: Renumber[] = [];
    for (const node of moved) {
      const list = node.parent;
      if (list === null) continue;
      const first = firstListItem(list);
      targets.push({
        list,
        start: first !== null && movedFroms.has(first.from) ? 1 : null,
      });
      const outer = list.parent?.parent ?? null;
      if (outer !== null) targets.push({ list: outer, start: null });
    }
    return targets;
  });
  dispatch(state.update({ changes, userEvent: "input.indent" }));
  return true;
};

export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const items = selectedListItems(state);
  if (items.length === 0) return false;
  const specs: ChangeSpec[] = [];
  const covered = new Set<number>();
  const outdented: ListLine[] = [];
  for (const item of items) {
    let parent: SyntaxNode | null = item.item.parent?.parent ?? null;
    while (parent !== null && parent.name !== "ListItem")
      parent = parent.parent;
    const parentMark = parent?.getChild("ListMark") ?? null;
    if (parent === null || parentMark === null) continue;
    const width =
      markColumn(state, item) -
      markColumn(state, { item: parent, mark: parentMark });
    if (width <= 0) continue;
    outdented.push(item);
    for (const number of itemLines(state, item, covered)) {
      const line = state.doc.line(number);
      const leading = /^ */.exec(line.text)?.[0].length ?? 0;
      const remove = Math.min(width, leading);
      if (remove > 0) specs.push({ from: line.from, to: line.from + remove });
    }
  }
  if (specs.length === 0) return true;
  const base = ChangeSet.of(specs, state.doc.length);
  const changes = withRenumbering(state, base, (tree) => {
    const targets: Renumber[] = [];
    for (const node of movedItems(tree, base, outdented)) {
      if (node.parent !== null)
        targets.push({ list: node.parent, start: null });
      for (const child of node.getChildren("OrderedList"))
        targets.push({ list: child, start: 1 });
    }
    return targets;
  });
  dispatch(state.update({ changes, userEvent: "delete.dedent" }));
  return true;
};

interface BlockStart {
  readonly content: number;
  readonly item: ListLine | null;
}

function blockStartOnLine(state: EditorState, line: Line): BlockStart | null {
  const item = listItemOnLine(state, line.number);
  if (item !== null) {
    let content = skipSpaces(state, item.mark.to, line.to);
    const marker = item.item.getChild("Task")?.getChild("TaskMarker") ?? null;
    if (marker !== null && marker.from === content)
      content = skipSpaces(state, marker.to, line.to);
    return { content, item };
  }
  const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(
      line.from + indent,
      1,
    );
    node !== null;
    node = node.parent
  ) {
    if (!/^ATXHeading\d$/.test(node.name)) continue;
    const mark = node.getChild("HeaderMark");
    if (mark === null || mark.from !== line.from + indent) return null;
    return { content: skipSpaces(state, mark.to, line.to), item: null };
  }
  return null;
}

function nestedItem(item: SyntaxNode): boolean {
  for (let node = item.parent; node !== null; node = node.parent)
    if (node.name === "ListItem") return true;
  return false;
}

function singleCursor(state: EditorState): SelectionRange | null {
  const range = state.selection.main;
  return state.selection.ranges.length === 1 && range.empty ? range : null;
}

const insertBlockAbove: StateCommand = ({ state, dispatch }) => {
  const range = singleCursor(state);
  if (range === null) return false;
  const line = state.doc.lineAt(range.head);
  const block = blockStartOnLine(state, line);
  if (block === null || range.head !== block.content) return false;
  if (state.doc.sliceString(block.content, line.to).trim() === "") return false;
  const item = block.item;
  const prefix =
    item === null
      ? ""
      : line.text
          .slice(0, block.content - line.from)
          .replace(/\[[xX]\]/, "[ ]");
  let changes = ChangeSet.of(
    { from: line.from, insert: `${prefix}\n` },
    state.doc.length,
  );
  if (item !== null && item.item.parent?.name === "OrderedList") {
    const base = changes;
    changes = withRenumbering(state, base, (tree) => {
      const node = itemWithMarkAt(tree, base.mapPos(item.mark.from, 1));
      return node?.parent ? [{ list: node.parent, start: null }] : [];
    });
  }
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.cursor(changes.mapPos(range.head, 1)),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

const removeBlockPrefix: StateCommand = (target) => {
  const { state, dispatch } = target;
  const range = singleCursor(state);
  if (range === null) return false;
  const line = state.doc.lineAt(range.head);
  const block = blockStartOnLine(state, line);
  if (block === null || range.head !== block.content) return false;
  if (block.item !== null && nestedItem(block.item.item))
    return outdentListItem(target);
  const hasContent =
    state.doc.sliceString(block.content, line.to).trim() !== "";
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const before =
    hasContent && previous !== null && previous.text.trim() !== "" ? "\n" : "";
  const changes: ChangeSpec[] = [
    { from: line.from, to: block.content, insert: before },
  ];
  if (
    block.item !== null &&
    hasContent &&
    line.number < state.doc.lines &&
    listItemOnLine(state, line.number + 1) !== null
  )
    changes.push({ from: line.to, insert: "\n" });
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.cursor(line.from + before.length),
      scrollIntoView: true,
      userEvent: "delete.backward",
    }),
  );
  return true;
};

const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

export const livePreviewEnter: StateCommand = (target) =>
  insertBlockAbove(target) || continueMarkup(target);

export const livePreviewBackspace: StateCommand = (target) =>
  removeBlockPrefix(target) || deleteMarkupBackward(target);

function allInCode(state: EditorState): boolean {
  return state.selection.ranges.every(
    (range) =>
      isInsideCode(state, range.from) &&
      isInsideCode(state, state.doc.lineAt(range.to).from),
  );
}

const indentCode: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (!allInCode(state)) return false;
  if (state.selection.ranges.some((range) => !range.empty))
    return indentMore(target);
  dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

const outdentCode: StateCommand = (target) =>
  allInCode(target.state) && indentLess(target);

export const livePreviewTab: StateCommand = (target) =>
  indentListItem(target) || indentCode(target) || true;

export const livePreviewShiftTab: StateCommand = (target) =>
  outdentListItem(target) || outdentCode(target) || true;

function moveToContentStart(view: EditorView, extend: boolean): boolean {
  const state = view.state;
  const ranges: SelectionRange[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const block = blockStartOnLine(state, line);
    if (block === null || range.head < block.content) return false;
    if (view.moveToLineBoundary(range, false, true).head > block.content)
      return false;
    ranges.push(
      extend
        ? EditorSelection.range(range.anchor, block.content)
        : EditorSelection.cursor(block.content),
    );
  }
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const cursorBlockContentStart: Command = (view) =>
  moveToContentStart(view, false);

export const selectBlockContentStart: Command = (view) =>
  moveToContentStart(view, true);

export const livePreviewKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleMark("bold") },
  { key: "Mod-i", run: toggleMark("italic") },
  { key: "Mod-Shift-s", run: toggleMark("strike") },
  { key: "Mod-Shift-h", run: toggleMark("highlight") },
  { key: "Mod-e", run: toggleMark("code") },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-Alt-0", run: setBlock("paragraph") },
  { key: "Mod-Alt-1", run: setBlock("h1") },
  { key: "Mod-Alt-2", run: setBlock("h2") },
  { key: "Mod-Alt-3", run: setBlock("h3") },
  { key: "Tab", run: livePreviewTab },
  { key: "Shift-Tab", run: livePreviewShiftTab },
  { key: "Enter", run: livePreviewEnter },
  { key: "Backspace", run: livePreviewBackspace },
  {
    key: "Home",
    run: cursorBlockContentStart,
    shift: selectBlockContentStart,
  },
  {
    mac: "Cmd-ArrowLeft",
    run: cursorBlockContentStart,
    shift: selectBlockContentStart,
  },
];

export function editingKeymap(): KeyBinding[] {
  return [
    ...defaultKeymap.filter(
      (binding) => binding.key !== "Shift-Mod-k" && binding.key !== "Mod-Enter",
    ),
    ...historyKeymap,
    ...foldKeymap,
  ];
}
