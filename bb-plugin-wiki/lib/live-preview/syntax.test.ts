import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import {
  findFrontmatter,
  frontmatterInText,
  headingLevel,
  markdownLanguageWith,
} from "./syntax.js";
import { markdownState, parsedState } from "./test-support.js";

const language = markdownLanguageWith([]);

function parse(doc: string): Tree {
  return language.parser.parse(doc);
}

function nodeTexts(
  doc: string,
  name: string,
  tree: Tree = parse(doc),
): string[] {
  const found: string[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === name) found.push(doc.slice(node.from, node.to));
    },
  });
  return found;
}

describe("Highlight", () => {
  it("parses ==text== into Highlight with two HighlightMarks", () => {
    const doc = "a ==marked== word";
    expect(nodeTexts(doc, "Highlight")).toEqual(["==marked=="]);
    expect(nodeTexts(doc, "HighlightMark")).toEqual(["==", "=="]);
  });

  it("does not treat === runs as delimiters", () => {
    expect(nodeTexts("===", "Highlight")).toEqual([]);
    expect(nodeTexts("a ===b=== c", "Highlight")).toEqual([]);
    expect(nodeTexts("x ====y==== z", "Highlight")).toEqual([]);
  });

  it("follows flanking rules like strikethrough", () => {
    expect(nodeTexts("a==b==c", "Highlight")).toEqual(["==b=="]);
    expect(nodeTexts("a == b == c", "Highlight")).toEqual([]);
    expect(nodeTexts("x ==b == c", "Highlight")).toEqual([]);
  });

  it("nests with other inline marks", () => {
    expect(nodeTexts("**==bold mark==**", "Highlight")).toEqual([
      "==bold mark==",
    ]);
    expect(nodeTexts("==a *b* c==", "Emphasis")).toEqual(["*b*"]);
  });

  it("leaves highlights inside code alone", () => {
    expect(nodeTexts("`==x==`", "Highlight")).toEqual([]);
  });
});

describe("Frontmatter", () => {
  it("is recognized only at offset 0 and suppresses the setext heading", () => {
    const doc = "---\ntitle: X\n---\n# Heading";
    expect(nodeTexts(doc, "Frontmatter")).toEqual(["---\ntitle: X\n---"]);
    expect(nodeTexts(doc, "FrontmatterMark")).toEqual(["---", "---"]);
    expect(nodeTexts(doc, "SetextHeading2")).toEqual([]);
    expect(nodeTexts(doc, "ATXHeading1")).toEqual(["# Heading"]);
  });

  it("accepts ... as the closing fence and trailing spaces on fences", () => {
    expect(nodeTexts("--- \na: 1\n...\nbody", "Frontmatter")).toEqual([
      "--- \na: 1\n...",
    ]);
  });

  it("is not recognized away from the start", () => {
    const doc = "\n---\ntitle: X\n---\n";
    expect(nodeTexts(doc, "Frontmatter")).toEqual([]);
    expect(nodeTexts("intro\n\n---\na: 1\n---", "Frontmatter")).toEqual([]);
    expect(nodeTexts("  ---\na: 1\n---", "Frontmatter")).toEqual([]);
  });

  it("needs a closing fence", () => {
    const doc = "---\ntitle: X\n\nbody";
    expect(nodeTexts(doc, "Frontmatter")).toEqual([]);
    expect(nodeTexts(doc, "HorizontalRule")).toEqual(["---"]);
  });

  it("supports an empty block", () => {
    expect(nodeTexts("---\n---\ntext", "Frontmatter")).toEqual(["---\n---"]);
  });

  it("finds bounds through a reader, including ones past the first window", () => {
    const long = `---\n${"key: value\n".repeat(400)}---\nbody`;
    const bounds = frontmatterInText(long);
    expect(bounds).not.toBeNull();
    expect(long.slice(bounds?.closeFrom ?? 0, bounds?.to ?? 0)).toBe("---");
    expect(
      findFrontmatter((from, to) => "---\nx".slice(from, to), 5),
    ).toBeNull();
  });

  it("recognizes a closing fence typed later in a long document", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `line ${index} with some words`,
    );
    const doc = `---\n${lines.join("\n")}\n\nafter`;
    let state = markdownState(doc);
    expect(
      nodeTexts(state.doc.toString(), "Frontmatter", syntaxTree(state)),
    ).toEqual([]);
    const insertAt = state.doc.line(30).from;
    state = parsedState(
      state.update({ changes: { from: insertAt, insert: "---\n" } }).state,
    );
    const text = state.doc.toString();
    const found = nodeTexts(text, "Frontmatter", syntaxTree(state));
    expect(found).toHaveLength(1);
    expect(found[0]?.endsWith("---")).toBe(true);
    state = parsedState(
      state.update({ changes: { from: insertAt, to: insertAt + 4 } }).state,
    );
    expect(
      nodeTexts(state.doc.toString(), "Frontmatter", syntaxTree(state)),
    ).toEqual([]);
  });
});

describe("markdownLanguageWith", () => {
  it("enables GFM but not subscript, superscript, or emoji", () => {
    expect(nodeTexts("~~gone~~", "Strikethrough")).toEqual(["~~gone~~"]);
    expect(nodeTexts("- [ ] task", "Task")).toEqual(["[ ] task"]);
    expect(nodeTexts("| a |\n| - |\n| b |", "Table")).toHaveLength(1);
    expect(nodeTexts("see https://example.org now", "URL")).toEqual([
      "https://example.org",
    ]);
    expect(nodeTexts("H~2~O", "Subscript")).toEqual([]);
    expect(nodeTexts("x^2^", "Superscript")).toEqual([]);
    expect(nodeTexts(":smile:", "Emoji")).toEqual([]);
  });

  it("reads heading levels from node names", () => {
    expect(headingLevel("ATXHeading3")).toBe(3);
    expect(headingLevel("SetextHeading2")).toBe(2);
    expect(headingLevel("Paragraph")).toBeNull();
  });

  it("accepts extra markdown extensions", () => {
    const custom = markdownLanguageWith([
      {
        defineNodes: ["Shout"],
        parseInline: [
          {
            name: "Shout",
            parse(cx, next, pos) {
              if (next !== 33 || cx.char(pos + 1) !== 33) return -1;
              return cx.addElement(cx.elt("Shout", pos, pos + 2));
            },
          },
        ],
      },
    ]);
    const doc = "hey!! you";
    const tree = custom.parser.parse(doc);
    expect(nodeTexts(doc, "Shout", tree)).toEqual(["!!"]);
  });
});
