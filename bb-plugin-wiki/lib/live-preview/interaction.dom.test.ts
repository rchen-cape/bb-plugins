// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { livePreview, type LivePreviewOptions } from "./decorations.js";
import { externalChange } from "./document.js";
import { editorBasics } from "./setup.js";
import { previewValue } from "./state.js";
import { installDomPolyfills } from "./test-dom.js";

installDomPolyfills();

const views: EditorView[] = [];

function mount(
  doc: string,
  options: LivePreviewOptions = {},
  selection = 0,
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(selection),
      extensions: [
        editorBasics({ ariaLabel: "Test note" }),
        livePreview(options),
      ],
    }),
  });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    "editor",
  );
}

function type(view: EditorView, text: string): void {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
    userEvent: "input.type",
  });
}

function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

const HIDE: LivePreviewOptions = { frontmatter: "hide" };
const doc = "---\na: 1\n---\nbody";

describe("hidden frontmatter protection", () => {
  it("ignores Backspace at the first visible position", () => {
    const view = mount(doc, HIDE, 13);
    press(view, "Backspace");
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(13);
  });

  it("moves edits made from the initial cursor below the frontmatter", () => {
    const view = mount(doc, HIDE);
    type(view, "x");
    expect(view.state.doc.toString()).toBe("---\na: 1\n---\nxbody");
    expect(view.state.selection.main.head).toBe(14);
    const enter = mount(doc, HIDE);
    press(enter, "Enter");
    expect(enter.state.doc.toString()).toBe("---\na: 1\n---\n\nbody");
    expect(enter.state.selection.main.head).toBe(14);
  });

  it("starts a new line when the document is only frontmatter", () => {
    const view = mount("---\na: 1\n---", HIDE, 12);
    type(view, "x");
    expect(view.state.doc.toString()).toBe("---\na: 1\n---\nx");
    expect(view.state.selection.main.head).toBe(14);
  });

  it("clamps the selection on any transaction, including focus changes", () => {
    const view = mount(doc, HIDE);
    view.dispatch({});
    expect(view.state.selection.main.head).toBe(13);
  });

  it("lets external reloads and undo change the frontmatter", () => {
    const view = mount(doc, HIDE, 13);
    view.dispatch({
      changes: { from: 4, to: 8, insert: "b: 2" },
      annotations: externalChange.of(true),
    });
    expect(view.state.doc.toString()).toBe("---\nb: 2\n---\nbody");
    type(view, "x");
    undo(view);
    expect(view.state.doc.toString()).toBe("---\nb: 2\n---\nbody");
  });
});

describe("frontmatter the host does not accept", () => {
  it("is neither hidden nor guarded", () => {
    const view = mount(doc, { ...HIDE, acceptFrontmatter: () => false });
    view.dispatch({});
    expect(view.state.selection.main.head).toBe(0);
    expect(view.contentDOM.textContent).toContain("a: 1");
    type(view, "x");
    expect(view.state.doc.toString()).toBe(`x${doc}`);
  });
});

describe("collapsed frontmatter protection", () => {
  it("does not join the first line onto the closing fence", () => {
    const text = "---\na: 1\n---\n# Title\n\n---\n\nrest";
    const view = mount(text, {}, 13);
    press(view, "Backspace");
    expect(view.state.doc.toString()).toBe(text);
    const forward = mount(text, {}, 12);
    press(forward, "Delete");
    expect(forward.state.doc.toString()).toBe(text);
  });

  it("still lets the user edit inside revealed frontmatter", () => {
    const view = mount(doc, {}, 8);
    press(view, "Backspace");
    expect(view.state.doc.toString()).toBe("---\na: \n---\nbody");
  });
});

describe("pointer selection state", () => {
  it("releases the frozen reveal set after a drag-and-drop or a buttonless move", () => {
    const view = mount("**bold** text", {}, 13);
    view.contentDOM.dispatchEvent(mouse("mousedown", { buttons: 1 }));
    expect(previewValue(view.state).pointerSelecting).toBe(true);
    document.dispatchEvent(new Event("dragend"));
    expect(previewValue(view.state).pointerSelecting).toBe(false);
    view.contentDOM.dispatchEvent(mouse("mousedown", { buttons: 1 }));
    document.dispatchEvent(mouse("mousemove", { buttons: 1 }));
    expect(previewValue(view.state).pointerSelecting).toBe(true);
    document.dispatchEvent(mouse("mousemove", { buttons: 0 }));
    expect(previewValue(view.state).pointerSelecting).toBe(false);
  });
});
