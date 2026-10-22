import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import {
  blockPrefix,
  editingKeymap,
  indentListItem,
  insertLink,
  insertTable,
  linkActive,
  livePreviewBackspace,
  livePreviewEnter,
  livePreviewKeymap,
  livePreviewShiftTab,
  livePreviewTab,
  markActive,
  outdentListItem,
  setBlock,
  toggleMark,
  type BlockKind,
  type MarkKind,
} from "./commands.js";
import {
  markdownState,
  parsedState,
  type SelectionInput,
} from "./test-support.js";

interface Result {
  readonly doc: string;
  readonly selection: string[];
  readonly handled: boolean;
}

function run(
  command: StateCommand,
  doc: string,
  selection: SelectionInput,
): Result {
  let state: EditorState = markdownState(doc, { selection });
  const handled = command({
    state,
    dispatch: (tr: Transaction) => {
      state = parsedState(tr.state);
    },
  });
  return {
    doc: state.doc.toString(),
    selection: state.selection.ranges.map((range) =>
      state.doc.sliceString(range.from, range.to),
    ),
    handled,
  };
}

function cursorAfter(
  command: StateCommand,
  doc: string,
  selection: SelectionInput,
): { doc: string; head: number } {
  let state: EditorState = markdownState(doc, { selection });
  command({
    state,
    dispatch: (tr: Transaction) => {
      state = tr.state;
    },
  });
  return { doc: state.doc.toString(), head: state.selection.main.head };
}

function mark(kind: MarkKind, doc: string, selection: SelectionInput): Result {
  return run(toggleMark(kind), doc, selection);
}

describe("toggleMark", () => {
  it("wraps a selection and keeps it over the same text", () => {
    expect(mark("bold", "hello world", [6, 11])).toEqual({
      doc: "hello **world**",
      selection: ["world"],
      handled: true,
    });
    expect(mark("italic", "hello world", [6, 11]).doc).toBe("hello *world*");
    expect(mark("strike", "hello world", [6, 11]).doc).toBe("hello ~~world~~");
    expect(mark("highlight", "hello world", [6, 11]).doc).toBe(
      "hello ==world==",
    );
    expect(mark("code", "hello world", [6, 11]).doc).toBe("hello `world`");
  });

  it("trims whitespace at the edges before wrapping", () => {
    expect(mark("bold", "say  hi  now", [3, 9]).doc).toBe("say  **hi**  now");
    expect(mark("highlight", "   ", [0, 3]).doc).toBe("   ");
  });

  it("unwraps when the selection is inside or exactly covers the node", () => {
    expect(mark("bold", "a **bold** b", [4, 8])).toEqual({
      doc: "a bold b",
      selection: ["bold"],
      handled: true,
    });
    expect(mark("bold", "a **bold** b", [2, 10])).toEqual({
      doc: "a bold b",
      selection: ["bold"],
      handled: true,
    });
    expect(mark("bold", "a **bold** b", [5, 7]).doc).toBe("a bold b");
    expect(mark("highlight", "x ==mark== y", [4, 8]).doc).toBe("x mark y");
    expect(mark("code", "x `c` y", [3, 4]).doc).toBe("x c y");
    expect(mark("italic", "x _it_ y", [3, 5]).doc).toBe("x it y");
  });

  it("does not confuse bold with italic", () => {
    expect(mark("italic", "a **bold** b", [4, 8]).doc).toBe("a ***bold*** b");
    expect(mark("bold", "a *it* b", [3, 5]).doc).toBe("a ***it*** b");
  });

  it("merges a partially overlapping node of the same kind", () => {
    expect(mark("bold", "**ab**cd", [3, 7])).toEqual({
      doc: "**abc**d",
      selection: ["bc"],
      handled: true,
    });
  });

  it("never splits hidden marks or inline nodes at the selection edges", () => {
    expect(mark("highlight", "a *italic*, b", [3, 10])).toEqual({
      doc: "a *==italic==*, b",
      selection: ["italic"],
      handled: true,
    });
    expect(mark("highlight", "a *italic*, b", [2, 10])).toEqual({
      doc: "a *==italic==*, b",
      selection: ["italic"],
      handled: true,
    });
    expect(mark("italic", "a *italic*, b", [2, 10])).toEqual({
      doc: "a italic, b",
      selection: ["italic"],
      handled: true,
    });
    expect(mark("highlight", "a **bold** c", [0, 6]).doc).toBe(
      "==a **bold**== c",
    );
    expect(mark("highlight", "x `co de` y", [3, 5]).doc).toBe(
      "x ==`co de`== y",
    );
    expect(mark("code", "x `co de` y", [3, 5]).doc).toBe("x co de y");
    expect(mark("bold", "see [text](https://u.dev) ok", [4, 25]).doc).toBe(
      "see **[text](https://u.dev)** ok",
    );
    expect(mark("bold", "see [text](https://u.dev) ok", [5, 9]).doc).toBe(
      "see [**text**](https://u.dev) ok",
    );
    expect(mark("bold", "go https://u.dev/x now", [6, 10]).doc).toBe(
      "go **https://u.dev/x** now",
    );
    expect(mark("bold", "- item one", [0, 10]).doc).toBe("- **item one**");
    expect(mark("highlight", "## Title", [0, 8]).doc).toBe("## ==Title==");
  });

  it("applies per line and never wraps across a line break", () => {
    expect(mark("bold", "one\n\n  two", [0, 10]).doc).toBe(
      "**one**\n\n  **two**",
    );
    expect(mark("bold", "**one**\n**two**", [0, 15]).doc).toBe("one\ntwo");
  });

  it("handles multiple ranges", () => {
    const selection = EditorSelection.create([
      EditorSelection.range(0, 1),
      EditorSelection.range(4, 5),
    ]);
    expect(mark("highlight", "a b c d", selection)).toEqual({
      doc: "==a== b ==c== d",
      selection: ["a", "c"],
      handled: true,
    });
  });

  it("inserts empty markers at a cursor, or unwraps around it", () => {
    expect(cursorAfter(toggleMark("bold"), "ab", 1)).toEqual({
      doc: "a****b",
      head: 3,
    });
    expect(cursorAfter(toggleMark("highlight"), "", 0)).toEqual({
      doc: "====",
      head: 2,
    });
    expect(cursorAfter(toggleMark("bold"), "x **bold** y", 5)).toEqual({
      doc: "x bold y",
      head: 3,
    });
    expect(cursorAfter(toggleMark("bold"), "x **bold** y", 10).doc).toBe(
      "x **bold****** y",
    );
  });
});

describe("toggleMark edge cases", () => {
  it("never leaves a closing marker after a space when the selection ends at an opening mark", () => {
    expect(mark("highlight", "say **hi** now", [0, 6]).doc).toBe(
      "==say== **hi** now",
    );
    expect(mark("bold", "a *b* c", [0, 3]).doc).toBe("**a** *b* c");
  });

  it("keeps the selection over the text, not the inserted markers", () => {
    expect(mark("bold", "**a** b **c**", [0, 13])).toEqual({
      doc: "**a b c**",
      selection: ["a b c"],
      handled: true,
    });
    expect(mark("bold", "one two\nthree four", [4, 13]).selection).toEqual([
      "two**\n**three",
    ]);
  });
});

describe("markActive", () => {
  it("reports whether the main selection is inside a node of that kind", () => {
    const state = markdownState("a **b ==c== d** e", { selection: 8 });
    expect(markActive(state, "bold")).toBe(true);
    expect(markActive(state, "highlight")).toBe(true);
    expect(markActive(state, "italic")).toBe(false);
    expect(
      markActive(markdownState("a **b** e", { selection: [4, 5] }), "bold"),
    ).toBe(true);
    expect(
      markActive(markdownState("a **b** e", { selection: [0, 9] }), "bold"),
    ).toBe(false);
    expect(
      markActive(markdownState("a **b** e", { selection: 2 }), "bold"),
    ).toBe(false);
  });

  it("detects links", () => {
    expect(linkActive(markdownState("[a](b)", { selection: 1 }))).toBe(true);
    expect(linkActive(markdownState("plain", { selection: 1 }))).toBe(false);
  });
});

describe("insertLink", () => {
  it("inserts an empty link with the cursor in the text", () => {
    expect(cursorAfter(insertLink, "go ", 3)).toEqual({
      doc: "go []()",
      head: 4,
    });
  });

  it("wraps the selection and selects the url placeholder", () => {
    expect(run(insertLink, "see docs now", [4, 8])).toEqual({
      doc: "see [docs](url) now",
      selection: ["url"],
      handled: true,
    });
  });
});

function block(
  kind: BlockKind,
  doc: string,
  selection: SelectionInput = doc.length,
): { doc: string; head: number } {
  return cursorAfter(setBlock(kind), doc, selection);
}

describe("setBlock", () => {
  it("replaces existing prefixes with the new block kind", () => {
    expect(block("h1", "text").doc).toBe("# text");
    expect(block("h2", "# text").doc).toBe("## text");
    expect(block("h3", "- [ ] text").doc).toBe("### text");
    expect(block("paragraph", "## text").doc).toBe("text");
    expect(block("paragraph", "  - text").doc).toBe("text");
    expect(block("bullet", "1. text").doc).toBe("- text");
    expect(block("bullet", "  * text").doc).toBe("  - text");
    expect(block("task", "- text").doc).toBe("- [ ] text");
    expect(block("task", "> text").doc).toBe("- [ ] text");
    expect(block("quote", "# text").doc).toBe("> text");
    expect(block("ordered", "text").doc).toBe("1. text");
  });

  it("keeps the cursor on the same text", () => {
    expect(block("h1", "text", 2)).toEqual({ doc: "# text", head: 4 });
    expect(block("paragraph", "### text", 1)).toEqual({ doc: "text", head: 0 });
    expect(block("task", "", 0)).toEqual({ doc: "- [ ] ", head: 6 });
  });

  it("continues ordered numbering from the previous line", () => {
    expect(block("ordered", "1. one\n2. two\nthree").doc).toBe(
      "1. one\n2. two\n3. three",
    );
  });

  it("applies to every non-blank selected line", () => {
    expect(block("bullet", "a\n\nb", [0, 4]).doc).toBe("- a\n\n- b");
    expect(block("ordered", "a\nb\nc", [0, 5]).doc).toBe("1. a\n2. b\n3. c");
  });

  it("wraps the line or selection in a fenced code block", () => {
    expect(block("code", "", 0)).toEqual({ doc: "```\n\n```", head: 4 });
    expect(block("code", "let a = 1", 3)).toEqual({
      doc: "```\nlet a = 1\n```",
      head: 13,
    });
    expect(block("code", "a\nb", [0, 3]).doc).toBe("```\na\nb\n```");
  });

  it("inserts a divider on its own line followed by an empty line", () => {
    expect(block("divider", "para\n", 5)).toEqual({
      doc: "para\n\n---\n",
      head: 10,
    });
    expect(block("divider", "para\n\n", 6)).toEqual({
      doc: "para\n\n---\n",
      head: 10,
    });
    expect(block("divider", "para", 2)).toEqual({
      doc: "para\n\n---\n",
      head: 10,
    });
    expect(block("divider", "", 0)).toEqual({ doc: "***\n", head: 4 });
  });

  it("inserts a table and selects the first header", () => {
    expect(run(insertTable, "", 0)).toEqual({
      doc: "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |",
      selection: ["Column 1"],
      handled: true,
    });
  });

  it("keeps a blank line between a new table and the next line", () => {
    const table = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    expect(run(insertTable, "text\nmore", 4).doc).toBe(
      `text\n\n${table}\n\nmore`,
    );
    expect(run(insertTable, "\nmore", 0).doc).toBe(`${table}\n\nmore`);
    expect(run(insertTable, "text\n\nmore", 4).doc).toBe(
      `text\n\n${table}\n\nmore`,
    );
    const state = markdownState(`text\n\n${table}\n\nmore`);
    let names = "";
    syntaxTree(state).iterate({
      enter(ref) {
        if (ref.name === "TableRow") names += "r";
      },
    });
    expect(names).toBe("r");
  });

  it("parses block prefixes without eating content", () => {
    expect(blockPrefix("#tag")).toEqual({ indent: "", end: 0 });
    expect(blockPrefix("**bold**")).toEqual({ indent: "", end: 0 });
    expect(blockPrefix("1.5 apples")).toEqual({ indent: "", end: 0 });
    expect(blockPrefix("---")).toEqual({ indent: "", end: 0 });
    expect(blockPrefix("  > - [x] a")).toEqual({ indent: "  ", end: 10 });
  });
});

describe("list indentation", () => {
  it("indents a list item by its continuation unit, children included", () => {
    expect(run(indentListItem, "- a\n- b\n  - c", 6).doc).toBe(
      "- a\n  - b\n    - c",
    );
    expect(run(indentListItem, "1. a\n2. b", 7).doc).toBe("1. a\n   1. b");
  });

  it("restarts or continues nested ordered numbering and closes the gap", () => {
    expect(run(indentListItem, "1. a\n2. b\n3. c", 7).doc).toBe(
      "1. a\n   1. b\n2. c",
    );
    expect(run(indentListItem, "1. a\n   1. x\n2. b\n3. c", 15).doc).toBe(
      "1. a\n   1. x\n   2. b\n2. c",
    );
    expect(
      run(indentListItem, "1. a\n2. b\n3. c", EditorSelection.single(7, 12))
        .doc,
    ).toBe("1. a\n   1. b\n   2. c");
  });

  it("outdents a nested item", () => {
    expect(run(outdentListItem, "- a\n  - b", 8).doc).toBe("- a\n- b");
    expect(run(outdentListItem, "1. a\n   1. b", 10).doc).toBe("1. a\n2. b");
    expect(run(outdentListItem, "1. a\n   1. b\n   2. c\n2. d", 10).doc).toBe(
      "1. a\n2. b\n   1. c\n3. d",
    );
  });

  it("returns false outside list items", () => {
    expect(run(indentListItem, "para", 2).handled).toBe(false);
    expect(run(outdentListItem, "para", 2).handled).toBe(false);
  });
});

describe("Enter, Backspace and Tab", () => {
  it("inserts an empty block above when Enter is at the start of item or heading text", () => {
    expect(cursorAfter(livePreviewEnter, "- one\n- two", 8)).toEqual({
      doc: "- one\n- \n- two",
      head: 11,
    });
    expect(cursorAfter(livePreviewEnter, "- [x] done", 6)).toEqual({
      doc: "- [ ] \n- [x] done",
      head: 13,
    });
    expect(cursorAfter(livePreviewEnter, "1. a\n2. b\n3. c", 8)).toEqual({
      doc: "1. a\n2. \n3. b\n4. c",
      head: 12,
    });
    expect(cursorAfter(livePreviewEnter, "## Lists", 3)).toEqual({
      doc: "\n## Lists",
      head: 4,
    });
  });

  it("ends the list on Enter in an empty item instead of loosening it", () => {
    expect(cursorAfter(livePreviewEnter, "- solo\n- ", 9)).toEqual({
      doc: "- solo\n",
      head: 7,
    });
    expect(cursorAfter(livePreviewEnter, "- a\n  - child\n  - ", 18).doc).toBe(
      "- a\n  - child\n- ",
    );
    expect(cursorAfter(livePreviewEnter, "- solo", 6).doc).toBe("- solo\n- ");
  });

  it("turns an item or heading into a paragraph on Backspace at its text start", () => {
    expect(
      cursorAfter(
        livePreviewBackspace,
        "- [x] Finished\n- [ ] Open\n- [ ] Next",
        21,
      ),
    ).toEqual({
      doc: "- [x] Finished\n\nOpen\n\n- [ ] Next",
      head: 16,
    });
    expect(cursorAfter(livePreviewBackspace, "- a\n- ", 6)).toEqual({
      doc: "- a\n",
      head: 4,
    });
    expect(cursorAfter(livePreviewBackspace, "para\n## Lists", 8)).toEqual({
      doc: "para\n\nLists",
      head: 6,
    });
    expect(cursorAfter(livePreviewBackspace, "- a\n  - b", 8).doc).toBe(
      "- a\n- b",
    );
    expect(run(livePreviewBackspace, "> quote", 2).doc).toBe("quote");
  });

  it("indents code with the indent unit and keeps focus elsewhere", () => {
    expect(run(livePreviewTab, "```py\nx\n```", 6).doc).toBe("```py\n  x\n```");
    expect(run(livePreviewShiftTab, "```py\n  x\n```", 8).doc).toBe(
      "```py\nx\n```",
    );
    expect(run(livePreviewTab, "para", 2)).toEqual({
      doc: "para",
      selection: [""],
      handled: true,
    });
    expect(run(livePreviewShiftTab, "para", 2).handled).toBe(true);
    expect(run(livePreviewTab, "- a\n- b", 6).doc).toBe("- a\n  - b");
  });
});

describe("keymaps", () => {
  it("binds the documented live-preview keys first", () => {
    expect(livePreviewKeymap.map((binding) => binding.key)).toEqual([
      "Mod-b",
      "Mod-i",
      "Mod-Shift-s",
      "Mod-Shift-h",
      "Mod-e",
      "Mod-k",
      "Mod-Alt-0",
      "Mod-Alt-1",
      "Mod-Alt-2",
      "Mod-Alt-3",
      "Tab",
      "Shift-Tab",
      "Enter",
      "Backspace",
      "Home",
      undefined,
    ]);
    expect(livePreviewKeymap[livePreviewKeymap.length - 1]?.mac).toBe(
      "Cmd-ArrowLeft",
    );
  });

  it("drops deleteLine and Mod-Enter from the default keymap and adds history and fold keys", () => {
    const keys = editingKeymap().map((binding) => binding.key);
    expect(keys).not.toContain("Shift-Mod-k");
    expect(keys).not.toContain("Mod-Enter");
    expect(keys).toContain("Mod-z");
    expect(keys).toContain("Ctrl-Shift-[");
    expect(keys).toContain("Mod-a");
  });
});
