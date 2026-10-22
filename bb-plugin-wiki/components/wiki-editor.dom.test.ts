// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setPreviewFocus } from "../lib/live-preview/index.js";
import { createResolver } from "./doc-render";
import { WikiEditorConfig, createWikiState, type WikiEditorContext } from "./wiki-editor";

const CONTEXT: WikiEditorContext = {
  pluginId: "wiki",
  slug: "alpha",
  title: "Alpha project",
  resolve: createResolver([{ slug: "beta", title: "Beta topic", type: "topic", aliases: [], tag: "beta", updatedAt: "2026-10-14T10:00:00.000Z", headings: [] }]),
};

const views: EditorView[] = [];

function mount(doc: string, raw = false) {
  const openLink = vi.fn<(href: string) => void>();
  const save = vi.fn<() => void>();
  const config = new WikiEditorConfig({ openLink, save, onUpdate: () => {} });
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: createWikiState(doc, config.extensions({ context: CONTEXT, raw, codeTheme: null })) });
  views.push(view);
  return { view, config, openLink, save };
}

function key(view: EditorView, init: KeyboardEventInit): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

function mouse(element: Element, type: string): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

describe("wiki editor", () => {
  it("starts with the cursor below the hidden title and labels the text box", () => {
    const doc = "---\ntitle: Alpha project\n---\n\n# Alpha project\n\nBody\n";
    const { view } = mount(doc);
    expect(view.state.selection.main.head).toBe(doc.indexOf("Body"));
    expect(view.contentDOM.getAttribute("aria-label")).toBe("Text of Alpha project");
    expect(view.contentDOM.textContent).toBe("Body");
  });

  it("keeps an editable line under frontmatter with nothing after it", () => {
    const { view } = mount("---\na: 1\n---\n");
    expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(1);
    expect(view.contentDOM.textContent).toBe("Start writing…");
  });

  it("saves on Mod-S and blurs on Escape only when there is nothing to collapse", () => {
    const { view, save } = mount("Body text\n");
    key(view, { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);

    view.focus();
    const blur = vi.spyOn(view.contentDOM, "blur");
    view.dispatch({ selection: EditorSelection.single(0, 4) });
    key(view, { key: "Escape" });
    expect(blur).not.toHaveBeenCalled();
    expect(view.state.selection.main.empty).toBe(true);
    key(view, { key: "Escape" });
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("leaves dropped files to the page instead of inserting their text", () => {
    const { view } = mount("Body\n");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [], getData: () => "" } });
    const bubbled = vi.fn();
    document.body.addEventListener("drop", bubbled);
    view.contentDOM.dispatchEvent(drop);
    document.body.removeEventListener("drop", bubbled);
    expect(bubbled).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("Body\n");
  });

  it("opens wiki links and source thread links through openLink", () => {
    const { view, openLink } = mount('See [[Beta topic]].\n\n<!-- wiki:source thread="thr_9" title="Debug" -->\nFact.\n');
    const chip = view.contentDOM.querySelector(".cm-wiki-link");
    const thread = view.contentDOM.querySelector(".cm-wiki-source-link");
    if (chip === null || thread === null) throw new Error("missing links");
    mouse(chip, "mousedown");
    mouse(chip, "mouseup");
    mouse(thread, "mousedown");
    mouse(thread, "mouseup");
    expect(openLink.mock.calls).toEqual([["#wiki/beta"], ["#wiki-thread/thr_9"]]);
  });

  it("shows everything raw in Markdown mode and switches back live", () => {
    const doc = "---\ntitle: Alpha project\n---\n\n# Alpha project\n\n<!-- wiki:source manual -->\nSee [[Beta topic]].\n";
    const { view, config } = mount(doc, true);
    expect(view.contentDOM.textContent).toContain("title: Alpha project");
    expect(view.contentDOM.textContent).toContain("<!-- wiki:source manual -->");
    expect(view.dom.classList.contains("cm-wiki-raw")).toBe(true);
    view.dispatch({ effects: config.mode.reconfigure(config.modeExtension(false, CONTEXT)) });
    expect(view.dom.classList.contains("cm-wiki-raw")).toBe(false);
    expect(view.contentDOM.textContent).toBe("added by handSee Beta topic.");
  });

  it("never deletes the hidden unsorted marker with Backspace or Delete", () => {
    const marker = "<!-- wiki:unsorted -->";
    const doc = `Intro.\n\n---\n\n${marker}\n\n<!-- wiki:source manual -->\n- loose note\n`;
    const below = doc.indexOf(marker) + marker.length + 1;
    const { view } = mount(doc);
    view.dispatch({ selection: EditorSelection.cursor(below) });
    key(view, { key: "Backspace" });
    expect(view.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n\n<!-- wiki:source manual -->\n- loose note\n`);
    key(view, { key: "Backspace" });
    expect(view.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n<!-- wiki:source manual -->\n- loose note\n`);
    key(view, { key: "Backspace" });
    expect(view.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n<!-- wiki:source manual -->\n- loose note\n`);

    const list = mount(`Intro.\n\n---\n\n${marker}\n\n- note\n`).view;
    list.dispatch({ selection: EditorSelection.cursor(list.state.doc.toString().indexOf("- note")) });
    key(list, { key: "Backspace" });
    key(list, { key: "Backspace" });
    key(list, { key: "Backspace" });
    expect(list.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n- note\n`);

    const rule = mount(`Intro.\n\n---\n${marker}\n- note\n`).view;
    rule.dispatch({ selection: EditorSelection.cursor(rule.state.doc.toString().indexOf(`\n${marker}`)) });
    key(rule, { key: "Delete" });
    expect(rule.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n- note\n`);

    const blank = mount(`Intro.\n\n---\n\n${marker}\n- note\n`).view;
    blank.dispatch({ selection: EditorSelection.cursor(blank.state.doc.toString().indexOf(`\n${marker}`)) });
    key(blank, { key: "Delete" });
    expect(blank.state.doc.toString()).toBe(`Intro.\n\n---\n${marker}\n- note\n`);
  });

  it("starts a body line when typing into a doc that is only its title", () => {
    for (const doc of ["# Alpha project", "---\ntitle: Alpha project\n---\n# Alpha project"]) {
      const { view } = mount(doc);
      expect(view.state.selection.main.head).toBe(doc.length);
      view.dispatch({ changes: { from: doc.length, insert: "x" }, selection: EditorSelection.cursor(doc.length + 1), userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe(`${doc}\nx`);
      expect(view.state.selection.main.head).toBe(doc.length + 2);
      expect(view.contentDOM.textContent).toBe("x");
    }
  });

  it("does nothing on Alt-ArrowUp from the first body line under the hidden title", () => {
    for (const doc of ["---\ntitle: Alpha project\n---\n# Alpha project\nBody\n", "---\ntitle: Alpha project\n---\n# Alpha project\n\nBody\n"]) {
      const { view } = mount(doc);
      expect(view.state.selection.main.head).toBe(doc.indexOf("Body"));
      key(view, { key: "ArrowUp", altKey: true });
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("removes an empty line under a source label with Backspace and keeps the label", () => {
    const doc = "<!-- wiki:source manual -->\n\nFact\n";
    const { view } = mount(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("\nFact")) });
    key(view, { key: "Backspace" });
    expect(view.state.doc.toString()).toBe("<!-- wiki:source manual -->\nFact\n");
    const above = mount("Intro\n\n<!-- wiki:source manual -->\nFact\n").view;
    above.dispatch({ selection: EditorSelection.cursor(6) });
    key(above, { key: "Delete" });
    expect(above.state.doc.toString()).toBe("Intro\n<!-- wiki:source manual -->\nFact\n");
  });

  it("shows frontmatter the server would not read instead of hiding it", () => {
    const { view } = mount("---\ntitle: Alpha: project\nnote: [unclosed\n---\n\nMore body\n");
    expect(view.contentDOM.textContent).toContain("note: [unclosed");
    expect(view.contentDOM.textContent).toContain("More body");
    const rule = mount("---\nImportant intro paragraph\n\n---\n\nMore body\n").view;
    expect(rule.contentDOM.textContent).toContain("Important intro paragraph");
    expect(rule.state.selection.main.head).toBe(0);
  });

  it("hides the hint while focused and shows the slash hint on the empty line instead", () => {
    const { view } = mount("# Alpha project\n");
    expect(view.contentDOM.textContent).toBe("Start writing…");
    view.dispatch({ effects: setPreviewFocus.of(true) });
    expect(view.contentDOM.textContent).toBe("Type / for commands");
  });
});
