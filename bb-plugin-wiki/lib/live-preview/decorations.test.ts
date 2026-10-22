import { describe, expect, it } from "vitest";
import { EditorSelection, type EditorState } from "@codemirror/state";
import {
  buildBlockDecorations,
  buildInlineDecorations,
  normalizeHref,
  resolveLivePreviewOptions,
  toDecorationSet,
  type LivePreviewOptions,
  type LivePreviewRange,
} from "./decorations.js";
import {
  markdownState,
  withPointer,
  withSelection,
  type SelectionInput,
} from "./test-support.js";
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
} from "./widgets.js";

interface Built {
  readonly state: EditorState;
  readonly inline: LivePreviewRange[];
  readonly block: readonly LivePreviewRange[];
  readonly atomic: readonly { from: number; to: number }[];
}

const NO_HINT: LivePreviewOptions = { emptyLineHint: null };

function build(
  doc: string,
  selection: SelectionInput = doc.length,
  options: LivePreviewOptions = NO_HINT,
  focused = true,
): Built {
  return buildFor(markdownState(doc, { selection, focused }), options);
}

function buildFor(
  state: EditorState,
  options: LivePreviewOptions = NO_HINT,
): Built {
  const resolved = resolveLivePreviewOptions(options);
  const blocks = buildBlockDecorations(state, resolved);
  return {
    state,
    inline: buildInlineDecorations(state, 0, state.doc.length, resolved),
    block: blocks.ranges,
    atomic: blocks.atomic,
  };
}

function hidden(built: Built): string[] {
  return built.inline
    .filter((range) => range.kind === "hide")
    .sort((a, b) => a.from - b.from)
    .map((range) => built.state.doc.sliceString(range.from, range.to));
}

function widgets(
  built: Built,
  ranges: readonly LivePreviewRange[] = built.inline,
): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    if (range.kind !== "widget") continue;
    found.push({
      name: range.widget.constructor.name,
      text: built.state.doc.sliceString(range.from, range.to),
    });
  }
  return found;
}

function widgetOf<T>(
  ranges: readonly LivePreviewRange[],
  type: abstract new (...args: never[]) => T,
): T[] {
  const found: T[] = [];
  for (const range of ranges) {
    if (range.kind === "widget" && range.widget instanceof type)
      found.push(range.widget);
  }
  return found;
}

function lineClasses(built: Built): Record<number, string[]> {
  const result: Record<number, string[]> = {};
  for (const range of built.inline) {
    if (range.kind !== "line") continue;
    const number = built.state.doc.lineAt(range.from).number;
    (result[number] ??= []).push(...range.className.split(" "));
  }
  for (const list of Object.values(result)) list.sort();
  return result;
}

function marks(
  built: Built,
  className: string,
): { text: string; attributes: Readonly<Record<string, string>> | null }[] {
  return built.inline
    .filter((range) => range.kind === "mark" && range.className === className)
    .sort((a, b) => a.from - b.from)
    .map((range) => ({
      text: built.state.doc.sliceString(range.from, range.to),
      attributes: range.kind === "mark" ? range.attributes : null,
    }));
}

describe("headings", () => {
  const doc = "# Title\n\nbody";

  it("hides the header mark and its space unless touched", () => {
    const away = build(doc);
    expect(hidden(away)).toEqual(["# "]);
    expect(lineClasses(away)[1]).toEqual(["cm-lp-h1", "cm-lp-heading"]);
    expect(hidden(build(doc, 0))).toEqual([]);
    expect(hidden(build(doc, 2))).toEqual([]);
    expect(hidden(build(doc, 5))).toEqual(["# "]);
  });

  it("hides a closing sequence separately", () => {
    const closing = "### Three ###\n\nx";
    expect(hidden(build(closing))).toEqual(["### ", " ###"]);
    expect(hidden(build(closing, 12))).toEqual(["### "]);
    expect(lineClasses(build(closing))[1]).toEqual([
      "cm-lp-h3",
      "cm-lp-heading",
    ]);
  });

  it("styles setext headings and their underline", () => {
    const built = build("Title\n===\n\nSub\n---\n\nx");
    const classes = lineClasses(built);
    expect(classes[1]).toEqual(["cm-lp-h1", "cm-lp-heading"]);
    expect(classes[2]).toEqual(["cm-lp-setext-mark"]);
    expect(classes[4]).toEqual(["cm-lp-h2", "cm-lp-heading"]);
    expect(classes[5]).toEqual(["cm-lp-setext-mark"]);
  });
});

describe("inline marks", () => {
  it("hides emphasis, strong, strike and highlight marks unless the selection touches them", () => {
    const doc = "a *i* **b** ~~s~~ ==h== z";
    expect(hidden(build(doc))).toEqual([
      "*",
      "*",
      "**",
      "**",
      "~~",
      "~~",
      "==",
      "==",
    ]);
    expect(hidden(build(doc, doc.indexOf("b")))).toEqual([
      "*",
      "*",
      "~~",
      "~~",
      "==",
      "==",
    ]);
    expect(hidden(build(doc, doc.indexOf("==")))).toEqual([
      "*",
      "*",
      "**",
      "**",
      "~~",
      "~~",
    ]);
    expect(hidden(build(doc, doc.indexOf("h==") + 3))).toEqual([
      "*",
      "*",
      "**",
      "**",
      "~~",
      "~~",
    ]);
  });

  it("reveals marks overlapped by a range selection", () => {
    const doc = "one **two** three";
    expect(hidden(build(doc, [0, 6]))).toEqual([]);
    expect(hidden(build(doc, [12, 17]))).toEqual(["**", "**"]);
  });

  it("styles inline code and hides backticks", () => {
    const doc = "x `code` y";
    const built = build(doc);
    expect(marks(built, "cm-lp-inline-code").map((mark) => mark.text)).toEqual([
      "`code`",
    ]);
    expect(hidden(built)).toEqual(["`", "`"]);
    expect(hidden(build(doc, 4))).toEqual([]);
  });

  it("hides escape backslashes", () => {
    expect(hidden(build("\\*not emphasis\\* x"))).toEqual(["\\", "\\"]);
    expect(hidden(build("\\*x", 1))).toEqual([]);
  });
});

describe("links", () => {
  const doc = 'see [the docs](https://a.dev/x "Title") now';

  it("renders link text with data-href and hides the syntax", () => {
    const built = build(doc);
    expect(hidden(built)).toEqual(["[", '](https://a.dev/x "Title")']);
    expect(marks(built, "cm-lp-link")).toEqual([
      {
        text: "the docs",
        attributes: {
          "data-href": "https://a.dev/x",
          "data-lp-rendered": "true",
        },
      },
    ]);
  });

  it("reveals the raw link when touched but keeps the link mark", () => {
    const built = build(doc, doc.indexOf("docs"));
    expect(hidden(built)).toEqual([]);
    expect(marks(built, "cm-lp-link")).toEqual([
      { text: "the docs", attributes: { "data-href": "https://a.dev/x" } },
    ]);
  });

  it("marks bare URLs and autolinks and hides autolink brackets", () => {
    const built = build("go https://x.dev/a and <https://y.dev> or www.z.dev");
    expect(marks(built, "cm-lp-url")).toEqual([
      {
        text: "https://x.dev/a",
        attributes: { "data-href": "https://x.dev/a" },
      },
      { text: "https://y.dev", attributes: { "data-href": "https://y.dev" } },
      { text: "www.z.dev", attributes: { "data-href": "https://www.z.dev" } },
    ]);
    expect(hidden(built)).toEqual(["<", ">"]);
    expect(hidden(build("go <https://y.dev> now", "go <https".length))).toEqual(
      [],
    );
  });

  it("gives the revealed link URL a data-href for Mod-click", () => {
    const built = build(doc, doc.indexOf("docs"));
    expect(marks(built, "cm-lp-link-url")).toEqual([
      {
        text: "https://a.dev/x",
        attributes: { "data-href": "https://a.dev/x" },
      },
    ]);
    expect(marks(build(doc), "cm-lp-link-url")).toEqual([]);
  });

  it("leaves reference-style brackets alone", () => {
    const built = build("see [1] and [x][ref]");
    expect(hidden(built)).toEqual([]);
    expect(marks(built, "cm-lp-link")).toEqual([]);
  });

  it("normalizes hrefs", () => {
    expect(normalizeHref("<https://a.b>")).toBe("https://a.b");
    expect(normalizeHref("www.a.b")).toBe("https://www.a.b");
    expect(normalizeHref("me@a.b")).toBe("mailto:me@a.b");
    expect(normalizeHref("./doc.md")).toBe("./doc.md");
  });
});

describe("images", () => {
  const doc = "pic ![alt text](img/a.png) end";

  it("replaces images with a widget when resolveImage gives a URL", () => {
    const built = build(doc, doc.length, {
      ...NO_HINT,
      resolveImage: (src) => `/media/${src}`,
    });
    expect(widgets(built)).toEqual([
      { name: "ImageWidget", text: "![alt text](img/a.png)" },
    ]);
    const [image] = widgetOf(built.inline, ImageWidget);
    expect(image?.url).toBe("/media/img/a.png");
    expect(image?.alt).toBe("alt text");
    expect(image?.video).toBe(false);
  });

  it("shows the source when touched", () => {
    const built = build(doc, doc.indexOf("alt"), {
      ...NO_HINT,
      resolveImage: (src) => src,
    });
    expect(widgets(built)).toEqual([]);
    expect(hidden(built)).toEqual([]);
  });

  it("falls back to link styling without a resolved URL", () => {
    const built = build(doc, doc.length, {
      ...NO_HINT,
      resolveImage: () => null,
    });
    expect(widgets(built)).toEqual([]);
    expect(hidden(built)).toEqual(["![", "](img/a.png)"]);
    expect(marks(built, "cm-lp-link").map((mark) => mark.text)).toEqual([
      "alt text",
    ]);
  });

  it("uses a video widget for video extensions", () => {
    const built = build("![clip](a/b.MP4?x=1)\n\nz", 22, {
      ...NO_HINT,
      resolveImage: (src) => src,
    });
    expect(widgetOf(built.inline, ImageWidget)[0]?.video).toBe(true);
  });
});

describe("block constructs", () => {
  it("hides quote marks per line and adds quote line classes", () => {
    const doc = "> one\n> two\n\nafter";
    const built = build(doc);
    expect(hidden(built)).toEqual(["> ", "> "]);
    expect(lineClasses(built)[1]).toEqual(["cm-lp-quote"]);
    expect(lineClasses(built)[2]).toEqual(["cm-lp-quote"]);
    expect(hidden(build(doc, 6))).toEqual(["> "]);
  });

  it("replaces bullet marks with depth-specific bullets", () => {
    const doc = "- a\n  - b\n    - c\n\nend";
    const built = build(doc);
    expect(
      widgets(built)
        .filter((widget) => widget.name === "BulletWidget")
        .map((widget) => widget.text),
    ).toEqual(["-", "-", "-"]);
    expect(
      widgetOf(built.inline, BulletWidget).map((widget) => widget.symbol),
    ).toEqual(["•", "◦", "▪"]);
    expect(widgetOf(build(doc, 1).inline, BulletWidget)).toHaveLength(2);
    expect(widgetOf(build(doc, 2).inline, BulletWidget)).toHaveLength(3);
    expect(widgetOf(build(doc, 3).inline, BulletWidget)).toHaveLength(3);
  });

  it("keeps a new empty bullet or task rendered with the cursor after it", () => {
    for (const doc of ["- a\n- ", "- [ ] a\n- [ ] "]) {
      const built = build(doc, doc.length);
      expect(
        widgets(built).filter((widget) => widget.name !== "IndentWidget"),
      ).toHaveLength(2);
    }
  });

  it("renders nested list indentation as fixed-width indents", () => {
    const built = build("- a\n  - b\n    - c\n\nend");
    expect(
      widgets(built)
        .filter((widget) => widget.name === "IndentWidget")
        .map((widget) => widget.text),
    ).toEqual(["  ", "    "]);
    expect(
      widgetOf(built.inline, IndentWidget).map((widget) => widget.level),
    ).toEqual([1, 2]);
  });

  it("marks nested quote lines", () => {
    const built = build("> outer\n> > inner\n\nz");
    expect(lineClasses(built)[2]).toEqual([
      "cm-lp-quote",
      "cm-lp-quote-nested",
    ]);
  });

  it("styles ordered list marks without hiding them", () => {
    const built = build("1. first\n2. second\n\nz");
    expect(marks(built, "cm-lp-list-mark").map((mark) => mark.text)).toEqual([
      "1.",
      "2.",
    ]);
    expect(widgets(built)).toEqual([]);
  });

  it("renders tasks as checkboxes and strikes done ones", () => {
    const doc = "- [ ] todo\n- [x] done\n\nz";
    const built = build(doc);
    expect(widgets(built)).toEqual([
      { name: "CheckboxWidget", text: "- [ ]" },
      { name: "CheckboxWidget", text: "- [x]" },
    ]);
    expect(
      widgetOf(built.inline, CheckboxWidget).map((widget) => widget.checked),
    ).toEqual([false, true]);
    expect(marks(built, "cm-lp-task-done").map((mark) => mark.text)).toEqual([
      "done",
    ]);
    expect(widgets(build(doc, 3)).map((widget) => widget.text)).toEqual([
      "- [x]",
    ]);
    expect(widgets(build(doc, 5)).map((widget) => widget.text)).toEqual([
      "- [x]",
    ]);
    expect(widgets(build(doc, 6)).map((widget) => widget.text)).toEqual([
      "- [ ]",
      "- [x]",
    ]);
    expect(widgets(build(doc, 10)).map((widget) => widget.text)).toEqual([
      "- [ ]",
      "- [x]",
    ]);
  });

  it("replaces horizontal rules unless the cursor is on that line", () => {
    const doc = "a\n\n---\n\nb";
    const built = build(doc);
    expect(widgets(built)).toEqual([{ name: "HrWidget", text: "---" }]);
    expect(lineClasses(built)[3]).toEqual(["cm-lp-hr-line"]);
    expect(widgetOf(build(doc, 6).inline, HrWidget)).toEqual([]);
  });

  it("labels fenced code and hides fences when the selection is outside", () => {
    const doc = "```ts\nconst a = 1\n```\n\nafter";
    const built = build(doc);
    expect(widgets(built)).toEqual([
      { name: "CodeLabelWidget", text: "```ts" },
    ]);
    expect(widgetOf(built.inline, CodeLabelWidget)[0]?.label).toBe("ts");
    expect(hidden(built)).toEqual(["```"]);
    const classes = lineClasses(built);
    expect(classes[1]).toEqual(["cm-lp-codeblock", "cm-lp-codeblock-first"]);
    expect(classes[2]).toEqual(["cm-lp-codeblock"]);
    expect(classes[3]).toEqual(["cm-lp-codeblock", "cm-lp-codeblock-last"]);
    const inside = build(doc, 8);
    expect(widgets(inside)).toEqual([]);
    expect(hidden(inside)).toEqual([]);
    expect(lineClasses(inside)[1]).toEqual([
      "cm-lp-codeblock",
      "cm-lp-codeblock-first",
    ]);
  });

  it("hides quote marks on every line of code, tables and comments in a quote", () => {
    const doc = "> ```js\n> code\n> ```\n\nz";
    expect(hidden(build(doc))).toEqual(["> ", "> ", "> ", "```"]);
    const table = "> | a | b |\n> | - | - |\n> | 1 | 2 |\n\nz";
    expect(hidden(build(table, 4))).toEqual(["> ", "> ", "> "]);
  });

  it("does not decorate markdown inside code", () => {
    const built = build("```\n**not bold** # x\n```\n\nz");
    expect(hidden(built)).toEqual(["```"]);
  });

  it("styles comment lines", () => {
    const built = build("<!-- wiki:source a -->\ntext\n\nz");
    expect(lineClasses(built)[1]).toEqual(["cm-lp-comment-line"]);
  });
});

describe("tables", () => {
  const doc = "| a | **b** |\n| --- | :-: |\n| c | [d](u) |\n\npara";

  it("block-replaces the table with a widget when the selection is elsewhere", () => {
    const built = build(doc);
    expect(widgets(built, built.block)).toEqual([
      { name: "TableWidget", text: doc.slice(0, doc.indexOf("\n\n")) },
    ]);
    const [table] = widgetOf(built.block, TableWidget);
    expect(table?.model.header.map((cell) => cell.text)).toEqual([
      "a",
      "**b**",
    ]);
    expect(table?.model.align).toEqual([null, "center"]);
    expect(
      table?.model.rows.map((row) => row.map((cell) => cell.text)),
    ).toEqual([["c", "[d](u)"]]);
    expect(
      built.block.every((range) => range.kind !== "widget" || range.block),
    ).toBe(true);
  });

  it("shows monospace source lines when the selection is on the table", () => {
    const built = build(doc, 3);
    expect(built.block).toEqual([]);
    const classes = lineClasses(built);
    expect(classes[1]).toEqual(["cm-lp-table-source"]);
    expect(classes[3]).toEqual(["cm-lp-table-source"]);
  });

  it("renders the table when unfocused even with the cursor inside", () => {
    expect(
      widgetOf(build(doc, 3, NO_HINT, false).block, TableWidget),
    ).toHaveLength(1);
  });
});

describe("frontmatter", () => {
  const doc = "---\ntitle: A\ntags: [x]\n---\n# Body\n";

  it("collapses to a Properties widget by default", () => {
    const built = build(doc);
    expect(widgets(built, built.block)).toEqual([
      { name: "FrontmatterWidget", text: "---\ntitle: A\ntags: [x]\n---" },
    ]);
    expect(widgetOf(built.block, FrontmatterWidget)[0]?.label).toBe(
      "Properties",
    );
    expect(built.atomic).toEqual([]);
  });

  it("reveals collapsed frontmatter when the selection is inside", () => {
    const built = build(doc, 6);
    expect(built.block).toEqual([]);
    expect(lineClasses(built)[2]).toEqual(["cm-lp-frontmatter-line"]);
  });

  it("hides frontmatter with its line break and never reveals it", () => {
    const options: LivePreviewOptions = { ...NO_HINT, frontmatter: "hide" };
    for (const cursor of [doc.length, 6]) {
      const built = build(doc, cursor, options);
      expect(widgets(built, built.block)).toEqual([
        { name: "HiddenBlockWidget", text: "---\ntitle: A\ntags: [x]\n---\n" },
      ]);
      expect(built.atomic).toEqual([{ from: 0, to: 27 }]);
    }
    expect(
      widgetOf(build(doc, 0, options).block, HiddenBlockWidget),
    ).toHaveLength(1);
  });

  it("keeps the empty last line visible after hidden frontmatter", () => {
    const options: LivePreviewOptions = { ...NO_HINT, frontmatter: "hide" };
    const only = "---\na: 1\n---\n";
    const built = build(only, only.length, options);
    expect(widgets(built, built.block)).toEqual([
      { name: "HiddenBlockWidget", text: "---\na: 1\n---" },
    ]);
    expect(built.atomic).toEqual([{ from: 0, to: 12 }]);
  });

  it("shows frontmatter the host does not accept as plain source lines", () => {
    const seen: string[] = [];
    const options: LivePreviewOptions = {
      ...NO_HINT,
      frontmatter: "hide",
      acceptFrontmatter: (block) => {
        seen.push(block);
        return false;
      },
    };
    for (const cursor of [doc.length, 0]) {
      const built = build(doc, cursor, options);
      expect(built.block).toEqual([]);
      expect(built.atomic).toEqual([]);
      expect(lineClasses(built)[1]).toEqual(["cm-lp-frontmatter-line"]);
    }
    expect(new Set(seen)).toEqual(new Set(["---\ntitle: A\ntags: [x]\n---"]));
    const accepted = build(doc, doc.length, {
      ...options,
      acceptFrontmatter: () => true,
    });
    expect(widgetOf(accepted.block, HiddenBlockWidget)).toHaveLength(1);
  });
});

describe("reveal state", () => {
  const doc = "**bold** and # not\n\n# Head\n\n- item";

  it("reveals nothing while unfocused", () => {
    for (const cursor of [0, 3, 22, 32]) {
      expect(hidden(build(doc, cursor, NO_HINT, false))).toEqual([
        "**",
        "**",
        "# ",
      ]);
    }
    expect(widgets(build(doc, 32, NO_HINT, false))).toHaveLength(1);
  });

  it("supports multiple selection ranges", () => {
    const selection = EditorSelection.create([
      EditorSelection.cursor(3),
      EditorSelection.cursor(21),
    ]);
    expect(hidden(build(doc, selection))).toEqual([]);
  });

  it("freezes the reveal set during pointer selection", () => {
    let state = markdownState(doc, { selection: doc.length });
    state = withPointer(state, true);
    state = withSelection(state, 3);
    expect(hidden(buildFor(state))).toEqual(["**", "**", "# "]);
    state = withSelection(state, [0, 25]);
    expect(hidden(buildFor(state))).toEqual(["**", "**", "# "]);
    state = withPointer(state, false);
    expect(hidden(buildFor(state))).toEqual([]);
  });

  it("freezes an unfocused editor as unrevealed until mouseup", () => {
    let state = markdownState(doc, { selection: doc.length, focused: false });
    state = withPointer(state, true);
    state = withSelection(state, 3);
    expect(hidden(buildFor(state))).toEqual(["**", "**", "# "]);
  });
});

describe("empty line hint", () => {
  const doc = "text\n\n```\n\n```\n";

  it("shows on the focused empty cursor line outside code", () => {
    const built = build(doc, 5, {});
    expect(widgetOf(built.inline, HintWidget).map((hint) => hint.text)).toEqual(
      ["Type / for commands"],
    );
  });

  it("is absent inside code, on non-empty lines, when unfocused or disabled", () => {
    expect(widgetOf(build(doc, 10, {}).inline, HintWidget)).toEqual([]);
    expect(widgetOf(build(doc, 2, {}).inline, HintWidget)).toEqual([]);
    expect(widgetOf(build(doc, 5, {}, false).inline, HintWidget)).toEqual([]);
    expect(
      widgetOf(build(doc, 5, { emptyLineHint: null }).inline, HintWidget),
    ).toEqual([]);
    expect(
      widgetOf(
        build("", 0, { emptyLineHint: "Start writing" }).inline,
        HintWidget,
      )[0]?.text,
    ).toBe("Start writing");
  });
});

describe("decoration sets", () => {
  it("converts ranges into a sorted decoration set", () => {
    const built = build(
      "# A\n\n**b** `c` [d](e)\n\n- [ ] f\n\n| x |\n| - |\n| y |\n\nz",
    );
    const inline = toDecorationSet(built.inline);
    const block = toDecorationSet(built.block);
    expect(inline.size).toBe(built.inline.length);
    expect(block.size).toBe(1);
  });
});

function largeDocument(): string {
  const sections: string[] = [];
  for (let index = 0; sections.length < 2000; index++) {
    sections.push(
      `## Section ${index}`,
      "",
      `Some **bold** text, *italic*, ==highlight==, \`code\` and [a link](https://example.org/${index}).`,
      `- item with ~~strike~~ ${index}`,
      `- [ ] task ${index}`,
      `- [x] done ${index}`,
      `> quote ${index}`,
      "",
      "```ts",
      `const value${index} = ${index};`,
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      `| ${index} | **${index}** |`,
      "",
    );
  }
  return sections.slice(0, 2000).join("\n");
}

describe("performance", () => {
  it("builds decorations for a 2,000-line document quickly", () => {
    const doc = largeDocument();
    const state = markdownState(doc, { selection: Math.floor(doc.length / 2) });
    expect(state.doc.lines).toBe(2000);
    const options = resolveLivePreviewOptions({});
    const viewportEnd = state.doc.line(60).to;
    const time = (run: () => void, rounds: number): number => {
      for (let index = 0; index < 5; index++) run();
      const start = performance.now();
      for (let index = 0; index < rounds; index++) run();
      return (performance.now() - start) / rounds;
    };
    const viewport = time(
      () =>
        toDecorationSet(buildInlineDecorations(state, 0, viewportEnd, options)),
      200,
    );
    const full = time(
      () =>
        toDecorationSet(
          buildInlineDecorations(state, 0, state.doc.length, options),
        ),
      20,
    );
    const blocks = time(
      () => toDecorationSet(buildBlockDecorations(state, options).ranges),
      50,
    );
    console.log(
      `live-preview perf (2000 lines): viewport(60 lines)=${viewport.toFixed(3)}ms full-doc inline=${full.toFixed(2)}ms block field=${blocks.toFixed(2)}ms`,
    );
    expect(viewport).toBeLessThan(5);
    expect(full).toBeLessThan(250);
  });
});
