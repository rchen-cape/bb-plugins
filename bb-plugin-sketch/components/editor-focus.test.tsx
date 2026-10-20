// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOX, NOTE, click, nextFrame, openSketch, pointer, press } from "./editor-test-support";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

function toolPressed(container: HTMLElement, name: string): string | null {
  const tools = container.querySelector<HTMLElement>("[role='toolbar'][aria-label='Tools']");
  if (tools === null) throw new Error("no toolbar");
  return within(tools).getByRole("button", { name }).getAttribute("aria-pressed");
}

function sceneTransform(container: HTMLElement): string | null | undefined {
  return container.querySelector("[data-sketch-scene] g")?.getAttribute("transform");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("focus after dialogs and menus", () => {
  it("returns focus to the sketch after the shortcuts dialog closes", async () => {
    const { slot, root } = await openSketch();
    root.focus();
    fireEvent.keyDown(root, { key: "?" });
    const dialog = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(root));
    fireEvent.keyDown(root, { key: "r" });
    expect(toolPressed(slot.container, "Rectangle")).toBe("true");
  });

  it("returns focus to the sketch after the sketch menu closes", async () => {
    const { slot, root } = await openSketch();
    fireEvent.pointerDown(slot.getByRole("button", { name: "Sketch: Plan" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await slot.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it("returns focus to the sketch when a focused panel button goes away", async () => {
    const { slot, canvas, root } = await openSketch();
    click(canvas, 100, 120);
    const remove = within(slot.getByRole("region", { name: "Style" })).getByRole("button", { name: "Delete" });
    remove.focus();
    fireEvent.click(remove);
    expect(slot.container.querySelector("[data-element-id='box']")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(root));
    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    expect(slot.container.querySelector("[data-element-id='box']")).not.toBeNull();
  });

  it("does not take focus back from a field outside the sketch", async () => {
    const { slot, canvas } = await openSketch();
    const outside = document.createElement("input");
    document.body.append(outside);
    click(canvas, 100, 120);
    const remove = within(slot.getByRole("region", { name: "Style" })).getByRole("button", { name: "Delete" });
    remove.focus();
    outside.focus();
    fireEvent.click(remove);
    await act(nextFrame);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("does not take focus back after the user clicked away from the sketch", async () => {
    const { slot, canvas } = await openSketch();
    click(canvas, 100, 120);
    const remove = within(slot.getByRole("region", { name: "Style" })).getByRole("button", { name: "Delete" });
    remove.focus();
    remove.blur();
    await act(async () => Promise.resolve());
    fireEvent.click(remove);
    await act(nextFrame);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("island buttons", () => {
  it("keep keyboard focus on the sketch after a mouse press", async () => {
    const { slot, canvas, root } = await openSketch();
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    const tools = slot.getByRole("toolbar", { name: "Tools" });
    expect(press(within(tools).getByRole("button", { name: "Ellipse" }))).toBe(true);
    expect(document.activeElement).toBe(root);
    expect(toolPressed(slot.container, "Ellipse")).toBe("true");
    fireEvent.keyDown(root, { key: " " });
    pointer(canvas, "pointerDown", 300, 300);
    pointer(canvas, "pointerMove", 340, 320);
    pointer(canvas, "pointerUp", 340, 320);
    fireEvent.keyUp(root, { key: " " });
    expect(sceneTransform(slot.container)).toBe("scale(1) translate(40 20)");
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(2);
    outside.remove();
  });

  it("keep arrow nudges working after picking a color", async () => {
    const { slot, canvas, root } = await openSketch();
    click(canvas, 100, 120);
    const stroke = within(slot.getByRole("region", { name: "Style" })).getByRole("group", { name: "Stroke" });
    expect(press(within(stroke).getByRole("button", { name: "#e03131" }))).toBe(true);
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(slot.container.querySelector("[data-element-id='box']")?.getAttribute("transform")).toBe(`translate(${BOX.x + 1} ${BOX.y})`);
  });

  it("stay reachable with the keyboard", async () => {
    const { slot } = await openSketch();
    const zoom = slot.getByRole("group", { name: "Zoom" });
    for (const button of within(zoom).getAllByRole("button")) {
      expect(press(button)).toBe(true);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
    const send = slot.getByRole("button", { name: "Send to Wiki" });
    send.focus();
    expect(document.activeElement).toBe(send);
  });
});

describe("text editor with an input method", () => {
  async function editNote() {
    const page = await openSketch();
    fireEvent.doubleClick(page.canvas, { clientX: NOTE.x + 5, clientY: NOTE.y + 5 });
    const editor = await page.slot.findByRole("textbox", { name: "Text" });
    return { ...page, editor };
  }

  it("leaves Escape and Mod+Enter to the input method while composing", async () => {
    const { slot, editor, root } = await editNote();
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: "Escape", keyCode: 229 });
    expect(slot.getByRole("textbox", { name: "Text" })).toBe(editor);
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(slot.queryByRole("textbox", { name: "Text" })).toBeNull();
    expect(document.activeElement).toBe(root);
  });

  it("indents with Tab only when not composing", async () => {
    const { editor } = await editNote();
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
    editor.setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: "Tab", isComposing: true });
    expect(editor.value).toBe("Hello");
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.value).toBe("    Hello");
  });
});
