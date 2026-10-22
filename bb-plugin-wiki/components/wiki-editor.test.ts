import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import type { DocSummary } from "../contract";
import { markdownLanguageWith, previewStateField, setPreviewFocus, ImageWidget, HintWidget } from "../lib/live-preview/index.js";
import { parsedState } from "../lib/live-preview/test-support.js";
import { createResolver } from "./doc-render";
import {
  EMPTY_DOC_HINT,
  SourceMarkerWidget,
  WikiLinkSyntax,
  WikiLinkWidget,
  buildWikiBlocks,
  buildWikiInline,
  protectedLineKind,
  wikiBodyStart,
  wikiContext,
  wikiGuard,
  wikiAcceptsFrontmatter,
  wikiHead,
  type WikiEditorContext,
} from "./wiki-editor";

function summary(slug: string, title: string, extra: Partial<DocSummary> = {}): DocSummary {
  return { slug, title, type: "topic", aliases: [], tag: slug, updatedAt: "2026-10-14T10:00:00.000Z", headings: [], ...extra };
}

const CONTEXT: WikiEditorContext = {
  pluginId: "wiki",
  slug: "alpha",
  title: "Alpha project",
  resolve: createResolver([summary("alpha", "Alpha project"), summary("beta", "Beta topic", { headings: ["Beta topic", "Setup"] })]),
};

const asset = (path: string) => `/api/v1/plugins/wiki/http/asset?path=${encodeURIComponent(path)}`;

function wikiState(doc: string, options: { selection?: number | readonly [number, number]; focused?: boolean; extensions?: Extension } = {}): EditorState {
  const selection = options.selection ?? 0;
  const state = parsedState(
    EditorState.create({
      doc,
      selection: typeof selection === "number" ? EditorSelection.single(selection) : EditorSelection.single(selection[0], selection[1]),
      extensions: [markdownLanguageWith([WikiLinkSyntax]), previewStateField, wikiContext.of(CONTEXT), options.extensions ?? []],
    }),
  );
  return options.focused === true ? state.update({ effects: setPreviewFocus.of(true) }).state : state;
}

function nodes(state: EditorState, name: string): string[] {
  const found: string[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === name) found.push(state.doc.sliceString(ref.from, ref.to));
    },
  });
  return found;
}

function inline(state: EditorState) {
  return buildWikiInline(state, [{ from: 0, to: state.doc.length }]);
}

function widgets(state: EditorState) {
  return inline(state).flatMap((range) => (range.kind === "replace" ? [{ text: state.doc.sliceString(range.from, range.to), widget: range.widget }] : []));
}

function hiddenText(state: EditorState): string[] {
  const hidden: string[] = [];
  const decorations = buildWikiBlocks(state).decorations;
  decorations.between(0, state.doc.length, (from, to, decoration) => {
    if (to > from && decoration.spec.block === true) hidden.push(state.doc.sliceString(from, to));
  });
  return hidden;
}

function hints(state: EditorState): number[] {
  const at: number[] = [];
  buildWikiBlocks(state).decorations.between(0, state.doc.length, (from, _to, decoration) => {
    if (decoration.spec.widget instanceof HintWidget) at.push(from);
  });
  return at;
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

const GUARDED: Extension = wikiGuard;

describe("WikiLink syntax", () => {
  it("parses links and embeds before markdown links and images", () => {
    const state = wikiState("See [[Beta topic#Setup|the setup]], ![[x.png|A chart]] and [md](https://a.dev) ![i](b.png).");
    expect(nodes(state, "WikiLink")).toEqual(["[[Beta topic#Setup|the setup]]"]);
    expect(nodes(state, "WikiEmbed")).toEqual(["![[x.png|A chart]]"]);
    expect(nodes(state, "Link")).toEqual(["[md](https://a.dev)"]);
    expect(nodes(state, "Image")).toEqual(["![i](b.png)"]);
  });

  it("skips empty, nested, multi-line and code wiki links", () => {
    const state = wikiState("[[]] [[a [b]] c]] [[a\nb]] `[[code]]`\n\n```\n[[fenced]]\n```\n");
    expect(nodes(state, "WikiLink")).toEqual([]);
  });
});

describe("wiki links", () => {
  it("renders resolved links as link chips and unresolved ones with an explanation", () => {
    const state = wikiState("See [[Beta topic#Setup]] and [[Nowhere|that page]].");
    expect(widgets(state).map(({ text, widget }) => [text, widget])).toEqual([
      ["[[Beta topic#Setup]]", new WikiLinkWidget("Beta topic › Setup", "#wiki/beta#setup", null)],
      ["[[Nowhere|that page]]", new WikiLinkWidget("that page", null, "No Wiki doc named “Nowhere” yet")],
    ]);
  });

  it("links to the open doc's own headings", () => {
    const state = wikiState("## Setup\n\n## Setup\n\nSee [[#Setup]].");
    expect(widgets(state)[0]?.widget).toEqual(new WikiLinkWidget("Setup", "#wiki/alpha#setup", null));
  });

  it("shows the raw text with link styling once the cursor touches it", () => {
    const doc = "See [[Beta topic]] and [[Nowhere]].";
    const state = wikiState(doc, { selection: 6, focused: true });
    expect(inline(state)).toEqual([
      { kind: "mark", from: 4, to: 18, className: "cm-lp-link cm-wiki-link-source", attributes: { "data-href": "#wiki/beta" } },
      { kind: "replace", from: 23, to: 34, widget: new WikiLinkWidget("Nowhere", null, "No Wiki doc named “Nowhere” yet") },
    ]);
    expect(inline(wikiState(doc, { selection: 6 })).every((range) => range.kind === "replace")).toBe(true);
  });

  it("embeds images and video from the assets folder, and links other files", () => {
    const state = wikiState("![[chart.png|A chart]]\n\n![[clip.mp4]]\n\n![[notes.pdf]]\n");
    expect(widgets(state).map(({ widget }) => widget)).toEqual([
      new ImageWidget(asset("assets/chart.png"), "A chart", false),
      new ImageWidget(asset("assets/clip.mp4"), "clip.mp4", true),
      new WikiLinkWidget("notes.pdf", asset("assets/notes.pdf"), null),
    ]);
  });

  it("renders HTML media lines outside code", () => {
    const state = wikiState('<video controls src="assets/a.mp4"></video>\n\n<img src="b.png" alt="B">\n\n```\n<img src="c.png">\n```\n');
    expect(widgets(state).map(({ widget }) => widget)).toEqual([new ImageWidget(asset("assets/a.mp4"), "", true), new ImageWidget(asset("b.png"), "B", false)]);
  });
});

describe("source markers", () => {
  const MARKERS = [
    "Intro.",
    "",
    '<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->',
    "- first",
    "",
    '<!-- wiki:source thread="thr_abc" title="Debug push" added="2026-10-15" -->',
    "Body",
    "",
    "```",
    '<!-- wiki:source manual added="2026-10-15" -->',
    "```",
  ].join("\n");

  it("replaces marker lines with a small label and a source-line class, but not in code", () => {
    const state = wikiState(MARKERS);
    const ranges = inline(state);
    expect(ranges.filter((range) => range.kind === "line").map((range) => state.doc.lineAt(range.from).number)).toEqual([3, 6]);
    expect(ranges.flatMap((range) => (range.kind === "line" ? [range.className] : []))).toEqual(["cm-lp-source-line", "cm-lp-source-line"]);
    expect(widgets(state).map(({ widget }) => widget)).toEqual([
      new SourceMarkerWidget({ parts: [{ text: "from 10-14-26 notes" }], title: "Added 2026-10-15" }),
      new SourceMarkerWidget({ parts: [{ text: "from " }, { text: "“Debug push”", threadLink: "#wiki-thread/thr_abc" }], title: "Added 2026-10-15" }),
    ]);
    expect(protectedLineKind(state, state.doc.line(3).from)).toBe("source");
    expect(protectedLineKind(state, state.doc.line(10).from)).toBeNull();
  });

  it("keeps markers rendered even when the cursor is on them", () => {
    const state = wikiState(MARKERS, { selection: wikiState(MARKERS).doc.line(3).from + 3, focused: true });
    expect(widgets(state)).toHaveLength(2);
  });

  it.each([
    ["a byte order mark", "﻿"],
    ["a no-break space", " "],
    ["a form feed", "\f"],
  ])("shows no label for a marker line that starts with %s", (_label, lead) => {
    const state = wikiState(`Real advice.\n${lead}<!-- wiki:source notes="10-14-26.md" -->\nWe decided.`);
    expect(widgets(state)).toEqual([]);
  });
});

describe("hidden head and unsorted lines", () => {
  const FRESH = "---\ntitle: Alpha project\ntype: project\naliases: []\n---\n\n# Alpha project\n";

  it("hides the blank lines and the H1 that repeat the title, so the title shows once", () => {
    const state = wikiState(`${FRESH}\nBody\n`);
    expect(hiddenText(state)).toEqual(["\n# Alpha project\n\n"]);
    expect(wikiBodyStart(state)).toBe(state.doc.toString().indexOf("Body"));
    expect(hiddenText(wikiState("# Alpha project\n\nBody"))).toEqual(["# Alpha project\n\n"]);
    expect(hiddenText(wikiState("# Something else\n\nBody"))).toEqual([]);
    expect(wikiHead(wikiState("---\na: 1\n---\n\n\nBody"), "Alpha project")).toEqual({ from: 13, to: 15, bare: false, hideTo: 15 });
  });

  it("shows a faint hint when nothing but the title is left, until the editor is focused", () => {
    const state = wikiState(FRESH);
    expect(hints(state)).toEqual([FRESH.length]);
    expect(hints(state.update({ effects: setPreviewFocus.of(true) }).state)).toEqual([]);
    expect(hints(wikiState(`${FRESH}Body`))).toEqual([]);
    expect(EMPTY_DOC_HINT).toBe("Start writing…");
  });

  it("hides the unsorted divider marker but keeps the rule above it", () => {
    const state = wikiState("# Other\n\nText\n\n---\n\n<!-- wiki:unsorted -->\n- loose note\n");
    expect(hiddenText(state)).toEqual(["<!-- wiki:unsorted -->\n"]);
    expect(protectedLineKind(state, state.doc.toString().indexOf("<!--"))).toBe("unsorted");
  });
});

describe("wikiGuard", () => {
  const DOC = "---\ntitle: Alpha project\n---\n\n# Alpha project\n\nBody\n";
  const BODY = DOC.indexOf("Body");

  it("moves typing aimed at the hidden head down to the body, and keeps the cursor there", () => {
    const state = wikiState(DOC, { focused: true, extensions: GUARDED });
    const typed = apply(state, { changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(typed.doc.toString()).toBe(DOC.replace("Body", "xBody"));
    const deleted = apply(wikiState(DOC, { selection: BODY, focused: true, extensions: GUARDED }), { changes: { from: BODY - 1, to: BODY }, userEvent: "delete.backward" });
    expect(deleted.doc.toString()).toBe(DOC);
    const clicked = apply(state, { selection: EditorSelection.cursor(3), userEvent: "select.pointer" });
    expect(clicked.selection.main.head).toBe(BODY);
  });

  it("leaves outside reloads and undo alone", () => {
    const state = wikiState(DOC, { extensions: GUARDED });
    expect(apply(state, { changes: { from: 0, insert: "x" } }).doc.toString()).toBe(`x${DOC}`);
  });

  it("starts a new line when typing right next to a source marker", () => {
    const doc = 'Intro\n\n<!-- wiki:source manual -->\nBody';
    const end = doc.indexOf("\nBody");
    const start = doc.indexOf("<!--");
    const state = wikiState(doc, { selection: end, focused: true, extensions: GUARDED });
    const after = apply(state, { changes: { from: end, insert: "x" }, selection: EditorSelection.cursor(end + 1), userEvent: "input.type" });
    expect(after.doc.toString()).toBe('Intro\n\n<!-- wiki:source manual -->\nx\nBody');
    expect(after.selection.main.head).toBe(end + 2);
    const before = apply(wikiState(doc, { selection: start, focused: true, extensions: GUARDED }), { changes: { from: start, insert: "y" }, userEvent: "input.type" });
    expect(before.doc.toString()).toBe('Intro\n\ny\n<!-- wiki:source manual -->\nBody');
    expect(before.selection.main.head).toBe(start + 1);
    const enter = apply(state, { changes: { from: end, insert: "\n" }, userEvent: "input" });
    expect(enter.doc.toString()).toBe('Intro\n\n<!-- wiki:source manual -->\n\nBody');
  });

  it("removes a source marker whole instead of joining it with the next or previous line", () => {
    const doc = 'Intro\n<!-- wiki:source manual -->\nBody';
    const body = doc.indexOf("Body");
    const backspace = apply(wikiState(doc, { selection: body, focused: true, extensions: GUARDED }), { changes: { from: body - 1, to: body }, userEvent: "delete.backward" });
    expect(backspace.doc.toString()).toBe("Intro\nBody");
    expect(backspace.selection.main.head).toBe(6);
    const del = apply(wikiState(doc, { selection: 5, focused: true, extensions: GUARDED }), { changes: { from: 5, to: 6 }, userEvent: "delete.forward" });
    expect(del.doc.toString()).toBe("Intro\nBody");
    expect(del.selection.main.head).toBe(5);
  });

  it("keeps the hidden unsorted marker when a deletion or a paste spans it", () => {
    const doc = "Intro.\n\n---\n\n<!-- wiki:unsorted -->\n- loose\n";
    const state = wikiState(doc, { focused: true, extensions: GUARDED });
    const from = doc.indexOf("---");
    const to = doc.indexOf("loose");
    const cut = apply(state, { changes: { from, to }, userEvent: "delete.cut" });
    expect(cut.doc.toString()).toBe("Intro.\n\n<!-- wiki:unsorted -->\nloose\n");
    const pasted = apply(state, { changes: { from, to, insert: "x" }, userEvent: "input.paste" });
    expect(pasted.doc.toString()).toBe("Intro.\n\nx\n<!-- wiki:unsorted -->\nloose\n");
    expect(pasted.selection.main.head).toBe(from + 1);
    const joined = apply(state, { changes: { from: 3, to }, userEvent: "delete.cut" });
    expect(joined.doc.toString()).toBe("Int\n<!-- wiki:unsorted -->\nloose\n");
  });

  it("treats frontmatter the server cannot read as body text", () => {
    expect(wikiAcceptsFrontmatter("---\ntitle: Alpha project\n---")).toBe(true);
    expect(wikiAcceptsFrontmatter("---\ntitle: Alpha: project\n---")).toBe(false);
    expect(wikiAcceptsFrontmatter("---\nImportant intro paragraph\n\n---")).toBe(false);
    const doc = "---\ntitle: Alpha: project\n---\n# Alpha project\nBody";
    expect(wikiHead(wikiState(doc), "Alpha project")).toBeNull();
    expect(wikiBodyStart(wikiState(doc))).toBe(0);
  });
});
