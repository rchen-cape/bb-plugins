// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview } from "./decorations.js";
import { editorBasics } from "./setup.js";
import { setPointerSelecting, setPreviewFocus } from "./state.js";
import { installDomPolyfills } from "./test-dom.js";
import { formattingToolbar } from "./toolbar.js";

installDomPolyfills();

const views: EditorView[] = [];

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        editorBasics({ ariaLabel: "Toolbar test" }),
        livePreview(),
        formattingToolbar(),
      ],
    }),
  });
  views.push(view);
  return view;
}

function select(view: EditorView, from: number, to: number): void {
  view.dispatch({
    selection: EditorSelection.single(from, to),
    effects: setPreviewFocus.of(true),
  });
}

function toolbar(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-lp-toolbar");
}

function button(view: EditorView, label: string): HTMLButtonElement {
  const found = toolbar(view)?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (found === null || found === undefined)
    throw new Error(`missing ${label} button`);
  return found;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

describe("formattingToolbar", () => {
  it("shows the buttons in order for a focused non-empty selection", () => {
    const view = mount("hello world");
    expect(toolbar(view)).toBeNull();
    select(view, 6, 11);
    const element = toolbar(view);
    expect(element?.getAttribute("role")).toBe("toolbar");
    const buttons = [...(element?.querySelectorAll("button") ?? [])];
    expect(buttons.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Highlight",
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "Link",
    ]);
    expect(buttons.every((item) => item.type === "button")).toBe(true);
    expect(buttons[0]?.title).toBe("Highlight (Ctrl+Shift+H)");
    expect(buttons[1]?.title).toBe("Bold (Ctrl+B)");
    expect(buttons.map((item) => item.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(buttons[0]?.querySelector("svg")?.getAttribute("stroke")).toBe(
      "currentColor",
    );
    expect(buttons[0]?.querySelector(".cm-lp-toolbar-swatch")).not.toBeNull();
  });

  it("runs commands, keeps the selection and updates pressed state without rebuilding", () => {
    const view = mount("hello world");
    select(view, 6, 11);
    const highlight = button(view, "Highlight");
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    highlight.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    highlight.click();
    expect(view.state.doc.toString()).toBe("hello ==world==");
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("world");
    expect(button(view, "Highlight")).toBe(highlight);
    expect(highlight.getAttribute("aria-pressed")).toBe("true");
    button(view, "Bold").click();
    expect(view.state.doc.toString()).toBe("hello ==**world**==");
    expect(button(view, "Bold").getAttribute("aria-pressed")).toBe("true");
    button(view, "Highlight").click();
    expect(view.state.doc.toString()).toBe("hello **world**");
    button(view, "Link").click();
    expect(view.state.doc.toString()).toBe("hello **[world](url)**");
  });

  it("hides while the pointer is selecting, inside code and for empty selections", () => {
    const view = mount("text here\n\n```\ncode\n```");
    select(view, 0, 4);
    expect(toolbar(view)).not.toBeNull();
    view.dispatch({ effects: setPointerSelecting.of(true) });
    expect(toolbar(view)).toBeNull();
    view.dispatch({ effects: setPointerSelecting.of(false) });
    expect(toolbar(view)).not.toBeNull();
    select(view, 15, 19);
    expect(toolbar(view)).toBeNull();
    select(view, 2, 2);
    expect(toolbar(view)).toBeNull();
    view.dispatch({
      selection: EditorSelection.single(0, 4),
      effects: setPreviewFocus.of(false),
    });
    expect(toolbar(view)).toBeNull();
  });
});
