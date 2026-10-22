import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  slashApplySpec,
  slashCommandSource,
  slashQueryAt,
  type SlashAction,
} from "./slash-menu.js";
import { markdownState } from "./test-support.js";

function labels(query: string): string[] {
  return filterSlashCommands(query).map((command) => command.label);
}

function apply(
  doc: string,
  action: SlashAction,
): { doc: string; head: number; selected: string } {
  const state = markdownState(doc, { selection: doc.length });
  const found = slashQueryAt(state, doc.length);
  if (found === null) throw new Error("expected a slash query");
  const next: EditorState = state.update(
    slashApplySpec(state, action, found.from, doc.length),
  ).state;
  const main = next.selection.main;
  return {
    doc: next.doc.toString(),
    head: main.head,
    selected: next.doc.sliceString(main.from, main.to),
  };
}

describe("slashQueryAt", () => {
  it("matches a slash at the start of a line, after indentation", () => {
    expect(slashQueryAt(markdownState("/"), 1)).toEqual({ from: 0, query: "" });
    expect(slashQueryAt(markdownState("a\n  /head"), 9)).toEqual({
      from: 4,
      query: "head",
    });
    expect(slashQueryAt(markdownState("/heading 1"), 10)).toEqual({
      from: 0,
      query: "heading 1",
    });
  });

  it("ignores slashes after text, other characters and code", () => {
    expect(slashQueryAt(markdownState("text /x"), 7)).toBeNull();
    expect(slashQueryAt(markdownState("/a-b"), 4)).toBeNull();
    expect(slashQueryAt(markdownState("```\n/x\n```"), 6)).toBeNull();
    expect(slashQueryAt(markdownState("    /x"), 6)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("lists every command for an empty query", () => {
    expect(labels("")).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(labels("")).toEqual([
      "Text",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "To-do list",
      "Quote",
      "Code block",
      "Divider",
      "Table",
    ]);
  });

  it("matches label words and aliases", () => {
    expect(labels("head")).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(labels("heading 2")).toEqual(["Heading 2"]);
    expect(labels("h1")).toEqual(["Heading 1"]);
    expect(labels("todo")).toEqual(["To-do list"]);
    expect(labels("checkbox")).toEqual(["To-do list"]);
    expect(labels("ul")).toEqual(["Bulleted list"]);
    expect(labels("ol")).toEqual(["Numbered list"]);
    expect(labels("hr")).toEqual(["Divider"]);
    expect(labels("codeblock")).toEqual(["Code block"]);
    expect(labels("list")).toEqual([
      "Bulleted list",
      "Numbered list",
      "To-do list",
    ]);
    expect(labels("zzz")).toEqual([]);
  });
});

describe("slashCommandSource", () => {
  it("offers unfiltered options from the slash", () => {
    const state = markdownState("intro\n/to", { selection: 9 });
    const result = slashCommandSource(new CompletionContext(state, 9, false));
    if (result === null || result instanceof Promise)
      throw new Error("expected a result");
    expect(result.from).toBe(6);
    expect(result.filter).toBe(false);
    expect(result.options.map((option) => option.label)).toEqual([
      "To-do list",
    ]);
  });

  it("returns null without a match", () => {
    const state = markdownState("/zz", { selection: 3 });
    expect(
      slashCommandSource(new CompletionContext(state, 3, false)),
    ).toBeNull();
  });
});

describe("slashApplySpec", () => {
  it("removes the query and sets the block", () => {
    expect(apply("/todo", "task")).toEqual({
      doc: "- [ ] ",
      head: 6,
      selected: "",
    });
    expect(apply("/h2", "h2")).toEqual({ doc: "## ", head: 3, selected: "" });
    expect(apply("first\n  /ul", "bullet")).toEqual({
      doc: "first\n  - ",
      head: 10,
      selected: "",
    });
    expect(apply("para\n/div", "divider")).toEqual({
      doc: "para\n\n---\n",
      head: 10,
      selected: "",
    });
    expect(apply("/code", "code")).toEqual({
      doc: "```\n\n```",
      head: 4,
      selected: "",
    });
    expect(apply("/table", "table").selected).toBe("Column 1");
  });
});
