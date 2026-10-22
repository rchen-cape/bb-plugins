import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { Language, foldService, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import {
  Parser,
  TreeFragment,
  type Input,
  type PartialParse,
  type SyntaxNode,
} from "@lezer/common";
import { Tag, tags } from "@lezer/highlight";
import {
  GFM,
  MarkdownParser,
  type BlockContext,
  type DelimiterType,
  type MarkdownConfig,
  type MarkdownExtension,
} from "@lezer/markdown";
import { codeBlockParsers } from "./code-languages.js";

export const highlightTag = Tag.define("highlight");

const EQUALS = 61;
const PUNCTUATION = /[\p{S}\p{P}]/u;
const WHITESPACE_OR_EMPTY = /\s|^$/;

const highlightDelimiter: DelimiterType = {
  resolve: "Highlight",
  mark: "HighlightMark",
};

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (
          next !== EQUALS ||
          cx.char(pos + 1) !== EQUALS ||
          cx.char(pos + 2) === EQUALS ||
          cx.char(pos - 1) === EQUALS
        ) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = WHITESPACE_OR_EMPTY.test(before);
        const spaceAfter = WHITESPACE_OR_EMPTY.test(after);
        const punctuationBefore = PUNCTUATION.test(before);
        const punctuationAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          highlightDelimiter,
          pos,
          pos + 2,
          !spaceAfter &&
            (!punctuationAfter || spaceBefore || punctuationBefore),
          !spaceBefore &&
            (!punctuationBefore || spaceAfter || punctuationAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

export interface FrontmatterBounds {
  readonly openTo: number;
  readonly closeFrom: number;
  readonly closeMarkTo: number;
  readonly to: number;
}

const OPENING_FENCE = /^---[ \t]*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

function scanFrontmatter(
  text: string,
  complete: boolean,
): FrontmatterBounds | null | "more" {
  if (!text.startsWith("---"))
    return text.length < 3 && !complete ? "more" : null;
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return complete ? null : "more";
  if (!OPENING_FENCE.test(text.slice(0, firstBreak))) return null;
  let lineStart = firstBreak + 1;
  while (lineStart <= text.length) {
    const lineBreak = text.indexOf("\n", lineStart);
    if (lineBreak < 0 && !complete) return "more";
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    if (CLOSING_FENCE.test(text.slice(lineStart, lineEnd))) {
      return {
        openTo: 3,
        closeFrom: lineStart,
        closeMarkTo: lineStart + 3,
        to: lineEnd,
      };
    }
    if (lineBreak < 0) return null;
    lineStart = lineBreak + 1;
  }
  return null;
}

export function findFrontmatter(
  read: (from: number, to: number) => string,
  length: number,
): FrontmatterBounds | null {
  if (read(0, Math.min(length, 3)) !== "---") return null;
  let window = Math.min(length, 2048);
  for (;;) {
    const complete = window >= length;
    const result = scanFrontmatter(read(0, window), complete);
    if (result !== "more") return result;
    window = Math.min(length, window * 4);
  }
}

export function frontmatterInText(text: string): FrontmatterBounds | null {
  return findFrontmatter((from, to) => text.slice(from, to), text.length);
}

const frontmatterByParse = new WeakMap<PartialParse, FrontmatterBounds>();

export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true, style: tags.meta },
    { name: "FrontmatterMark", style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "LinkReference",
      parse(cx: BlockContext, line) {
        if (cx.lineStart !== 0 || cx.depth !== 1 || line.pos !== 0) {
          return false;
        }
        const bounds = frontmatterByParse.get(cx);
        if (bounds === undefined) return false;
        const children = [
          cx.elt("FrontmatterMark", 0, bounds.openTo),
          cx.elt("FrontmatterMark", bounds.closeFrom, bounds.closeMarkTo),
        ];
        while (cx.lineStart < bounds.closeFrom) {
          if (!cx.nextLine()) break;
        }
        cx.nextLine();
        cx.addElement(cx.elt("Frontmatter", 0, bounds.to, children));
        return true;
      },
    },
  ],
  wrap: (inner, input, _fragments, ranges) => {
    if (ranges[0]?.from === 0) {
      const bounds = findFrontmatter(
        (from, to) => input.read(from, to),
        input.length,
      );
      if (bounds !== null) frontmatterByParse.set(inner, bounds);
    }
    return inner;
  },
};

class FrontmatterAwareParser extends Parser {
  constructor(private readonly inner: Parser) {
    super();
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    let reusable = fragments;
    if (fragments.length > 0 && ranges[0]?.from === 0) {
      const bounds = findFrontmatter(
        (from, to) => input.read(from, to),
        input.length,
      );
      if (bounds !== null) {
        reusable = TreeFragment.applyChanges(fragments, [
          { fromA: 0, toA: bounds.to + 1, fromB: 0, toB: bounds.to + 1 },
        ]);
      }
    }
    return this.inner.createParse(input, reusable, ranges);
  }
}

const HEADING_NAME = /^(?:ATX|Setext)Heading(\d)$/;

export function headingLevel(name: string): number | null {
  const match = HEADING_NAME.exec(name);
  return match === null ? null : Number(match[1]);
}

function sectionEnd(heading: SyntaxNode, level: number): number {
  let last = heading;
  for (;;) {
    const next = last.nextSibling;
    if (next === null) break;
    const nextLevel = headingLevel(next.name);
    if (nextLevel !== null && nextLevel <= level) break;
    last = next;
  }
  return last.to;
}

export const headingFoldService: Extension = foldService.of(
  (state: EditorState, start: number, end: number) => {
    for (
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(end, -1);
      node !== null;
      node = node.parent
    ) {
      if (node.from < start) break;
      const level = headingLevel(node.name);
      if (level === null) continue;
      const upto = sectionEnd(node, level);
      if (upto > end) return { from: end, to: upto };
    }
    return null;
  },
);

export function markdownLanguageWith(
  extensions: readonly MarkdownExtension[],
): Language {
  const parser = commonmarkLanguage.parser;
  if (!(parser instanceof MarkdownParser)) {
    throw new Error("commonmarkLanguage.parser is not a Markdown parser");
  }
  const configured = parser
    .configure([GFM, Highlight, Frontmatter])
    .configure([codeBlockParsers, ...extensions]);
  return new Language(
    commonmarkLanguage.data,
    new FrontmatterAwareParser(configured),
    [headingFoldService],
    "markdown",
  );
}
