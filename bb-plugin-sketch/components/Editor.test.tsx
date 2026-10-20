// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers, type RpcCall } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { rpcContract, type SketchRpcContract, type SketchSummary } from "../contract";
import { parseSceneFile, serializeScene, type SketchElement } from "../lib/scene";
import { rect, text } from "../lib/test-fixtures";
import { SketchPage } from "./SketchPage";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

vi.mock("./export-png", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-png")>();
  return { ...actual, renderPng: vi.fn(async () => ({ blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), width: 10, height: 10 })) };
});

const SHA_1 = "1".repeat(64);
const SHA_2 = "2".repeat(64);
const BOX = rect(100, 100, 100, 80, { id: "box" });
const NOTE = text({ x: 400, y: 100 }, "Hello", { id: "note" });

function summary(id: string): SketchSummary {
  return { id, title: id, updatedAt: "2026-10-19T10:00:00.000Z", elementCount: 1, sizeBytes: 10 };
}

function file(elements: readonly SketchElement[]): string {
  return serializeScene({ elements, appState: {}, files: {} });
}

function handlers(overrides: Partial<PluginRpcTestHandlers<SketchRpcContract>> = {}): PluginRpcTestHandlers<SketchRpcContract> {
  return {
    status: () => ({ directory: "~/Sketches", sketchCount: 1, wiki: { available: true, inbox: true } }),
    list: () => [summary("Plan")],
    get: () => ({ ...summary("Plan"), sha256: SHA_1, content: file([BOX, NOTE]) }),
    create: () => ({ ...summary("Untitled"), sha256: SHA_2, content: file([]) }),
    save: () => ({ outcome: "written", sha256: SHA_2, updatedAt: "2026-10-19T10:00:00.000Z" }),
    rename: (input) => summary(rpcContract.rename.input.parse(input).title),
    duplicate: () => summary("Plan copy"),
    delete: (input) => ({ id: rpcContract.delete.input.parse(input).id }),
    savePreview: () => ({ stored: true }),
    wikiDocs: () => ({ wiki: { available: true, inbox: true }, docs: [] }),
    wikiSuggest: () => ({ suggestions: [] }),
    sendToWiki: () => ({ kind: "inbox", cardId: "card_00000001" }),
    ...overrides,
  };
}

async function open(overrides: Partial<PluginRpcTestHandlers<SketchRpcContract>> = {}) {
  const slot = renderSlot<{ subPath: string }, SketchRpcContract>({ component: SketchPage }, { subPath: "Plan" }, { rpc: handlers(overrides) });
  const canvas = await slot.findByRole("application", { name: "Sketch canvas" });
  await waitFor(() => expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(2));
  return { slot, canvas };
}

function inputsOf(calls: readonly RpcCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

function pointer(canvas: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number, init: Record<string, unknown> = {}) {
  fireEvent[type](canvas, { pointerId: 1, button: 0, buttons: type === "pointerUp" ? 0 : 1, clientX: x, clientY: y, pointerType: "mouse", ...init });
}

function click(canvas: Element, x: number, y: number) {
  pointer(canvas, "pointerDown", x, y);
  pointer(canvas, "pointerUp", x, y);
}

function root(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-sketch-root]");
  if (found === null) throw new Error("no sketch root");
  return found;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("text editing", () => {
  it("edits text on double-click, previews live, and commits on Escape", async () => {
    const { slot, canvas } = await open();
    fireEvent.doubleClick(canvas, { clientX: NOTE.x + 5, clientY: NOTE.y + 5 });
    const editor = await slot.findByRole("textbox", { name: "Text" });
    expect(slot.container.querySelector("[data-sketch-scene] [data-element-id='note']")).toBeNull();
    fireEvent.change(editor, { target: { value: "Hello there" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(slot.queryByRole("textbox", { name: "Text" })).toBeNull();
    expect(document.activeElement).toBe(root(slot.container));
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(1), { timeout: 3000 });
    const saved = parseSceneFile(rpcContract.save.input.parse(inputsOf(slot.inspection.rpcCalls, "save")[0]).content).scene.elements;
    expect(saved.find((element) => element.id === "note")).toMatchObject({ text: "Hello there" });
  });

  it("adds a label to a shape with Enter", async () => {
    const { slot, canvas } = await open();
    click(canvas, 100, 120);
    fireEvent.keyDown(canvas, { key: "Enter" });
    const editor = await slot.findByRole("textbox", { name: "Label" });
    fireEvent.change(editor, { target: { value: "Server" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-type='text']")).toHaveLength(2));
  });

  it("creates text with a double-click on empty canvas", async () => {
    const { slot, canvas } = await open();
    fireEvent.doubleClick(canvas, { clientX: 600, clientY: 400 });
    const editor = await slot.findByRole("textbox", { name: "Text" });
    fireEvent.change(editor, { target: { value: "New idea" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(3);
  });
});

describe("context menu", () => {
  it("selects the element under the pointer and offers its actions", async () => {
    const { slot, canvas } = await open();
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 120 });
    const menu = await slot.findByRole("menu", { name: "Canvas actions" });
    expect(within(menu).getByRole("menuitem", { name: /Duplicate/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Send to Wiki/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Duplicate/ }));
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(3);
  });

  it("offers paste, select all and the grid on empty canvas", async () => {
    const { slot, canvas } = await open();
    fireEvent.contextMenu(canvas, { clientX: 700, clientY: 600 });
    const menu = await slot.findByRole("menu", { name: "Canvas actions" });
    expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent?.replace(/⌘.*$|Ctrl.*$/, ""))).toEqual(["Paste", "Select all", "Show grid"]);
  });
});

describe("clipboard", () => {
  function clipboardEvent(type: "copy" | "cut" | "paste", data: Record<string, string> = {}) {
    const store = new Map(Object.entries(data));
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (kind: string, value: string) => store.set(kind, value), getData: (kind: string) => store.get(kind) ?? "" },
    });
    return { event, store };
  }

  it("copies the selection as Excalidraw clipboard JSON and pastes it back", async () => {
    const { slot, canvas } = await open();
    click(canvas, 100, 120);
    root(slot.container).focus();
    const copy = clipboardEvent("copy");
    act(() => {
      document.dispatchEvent(copy.event);
    });
    expect(copy.event.defaultPrevented).toBe(true);
    const json = copy.store.get("text/plain") ?? "";
    expect(JSON.parse(json)).toMatchObject({ type: "excalidraw/clipboard", elements: [expect.objectContaining({ id: "box" })] });
    const paste = clipboardEvent("paste", { "text/plain": json });
    act(() => {
      document.dispatchEvent(paste.event);
    });
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(3);
  });

  it("pastes plain text as a text element and ignores events outside the sketch", async () => {
    const { slot } = await open();
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    act(() => {
      document.dispatchEvent(clipboardEvent("paste", { "text/plain": "ignored" }).event);
    });
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(2);
    root(slot.container).focus();
    act(() => {
      document.dispatchEvent(clipboardEvent("paste", { "text/plain": "Pasted words" }).event);
    });
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-type='text']")).toHaveLength(2);
    outside.remove();
  });

  it("cuts the selection", async () => {
    const { slot, canvas } = await open();
    click(canvas, 100, 120);
    root(slot.container).focus();
    const cut = clipboardEvent("cut");
    act(() => {
      document.dispatchEvent(cut.event);
    });
    expect(cut.store.get("text/plain")).toContain("excalidraw/clipboard");
    expect(slot.container.querySelector("[data-element-id='box']")).toBeNull();
  });
});

describe("viewport", () => {
  it("zooms with the buttons, resets with the percentage and pans with the wheel", async () => {
    const { slot, canvas } = await open();
    const zoom = slot.getByRole("group", { name: "Zoom" });
    fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    expect(within(zoom).getByRole("button", { name: /Zoom 110%/ })).toBeTruthy();
    fireEvent.click(within(zoom).getByRole("button", { name: /reset to 100%/ }));
    expect(within(zoom).getByRole("button", { name: /Zoom 100%/ })).toBeTruthy();
    fireEvent.wheel(canvas, { deltaX: 0, deltaY: 100 });
    await waitFor(() => expect(slot.container.querySelector("[data-sketch-scene] g")?.getAttribute("transform")).toBe("scale(1) translate(0 -100)"));
    fireEvent.wheel(canvas, { deltaY: -50, ctrlKey: true, clientX: 0, clientY: 0 });
    await waitFor(() => expect(within(zoom).getByRole("button", { name: /Zoom 111%/ })).toBeTruthy());
  });

  it("pans while Space is held", async () => {
    const { slot, canvas } = await open();
    fireEvent.keyDown(canvas, { key: " " });
    pointer(canvas, "pointerDown", 300, 300);
    pointer(canvas, "pointerMove", 340, 320);
    pointer(canvas, "pointerUp", 340, 320);
    fireEvent.keyUp(canvas, { key: " " });
    expect(slot.container.querySelector("[data-sketch-scene] g")?.getAttribute("transform")).toBe("scale(1) translate(40 20)");
    expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(2);
  });

  it("toggles the grid with the shortcut and saves it in the file", async () => {
    const { slot, canvas } = await open();
    fireEvent.keyDown(canvas, { key: "'", code: "Quote", metaKey: true });
    expect(slot.container.querySelector("[data-sketch-scene] pattern")).not.toBeNull();
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(1), { timeout: 3000 });
    const saved = parseSceneFile(rpcContract.save.input.parse(inputsOf(slot.inspection.rpcCalls, "save")[0]).content);
    expect(saved.scene.appState).toMatchObject({ gridModeEnabled: true });
  });
});

describe("properties panel", () => {
  it("shows rows for the selection and applies picks as the new style", async () => {
    const { slot, canvas } = await open();
    expect(slot.queryByRole("region", { name: "Style" })).toBeNull();
    click(canvas, 100, 120);
    const panel = slot.getByRole("region", { name: "Style" });
    expect(within(panel).queryByRole("group", { name: "Font size" })).toBeNull();
    fireEvent.click(within(within(panel).getByRole("group", { name: "Stroke" })).getByRole("button", { name: "#e03131" }));
    expect(slot.container.querySelector("[data-element-id='box'] path")?.getAttribute("stroke")).toBe("#e03131");
    expect(JSON.parse(localStorage.getItem("sketch:style:v1") ?? "{}")).toMatchObject({ strokeColor: "#e03131" });
    fireEvent.click(within(within(panel).getByRole("group", { name: "Layers" })).getByRole("button", { name: "Bring to front" }));
    fireEvent.keyDown(canvas, { key: "r" });
    expect(within(slot.getByRole("region", { name: "Style" })).getByRole("group", { name: "Stroke" })).toBeTruthy();
  });
});

describe("saving problems", () => {
  it("shows a conflict banner and keeps mine by saving without a sha", async () => {
    let conflicts = 1;
    const { slot, canvas } = await open({
      save: () => {
        if (conflicts > 0) {
          conflicts -= 1;
          return { outcome: "conflict" };
        }
        return { outcome: "written", sha256: SHA_2, updatedAt: "2026-10-19T10:00:00.000Z" };
      },
    });
    click(canvas, 100, 120);
    fireEvent.keyDown(canvas, { key: "Delete" });
    const banner = await slot.findByRole("alert", undefined, { timeout: 3000 });
    expect(banner.textContent).toContain("Changed somewhere else.");
    fireEvent.click(within(banner).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(2));
    expect(rpcContract.save.input.parse(inputsOf(slot.inspection.rpcCalls, "save")[1]).expectedSha256).toBeNull();
    await waitFor(() => expect(slot.queryByText("Changed somewhere else.")).toBeNull());
  });

  it("offers Retry after a failed save", async () => {
    let failures = 1;
    const { slot, canvas } = await open({
      save: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("disk full");
        }
        return { outcome: "written", sha256: SHA_2, updatedAt: "2026-10-19T10:00:00.000Z" };
      },
    });
    click(canvas, 100, 120);
    fireEvent.keyDown(canvas, { key: "Delete" });
    const retry = await slot.findByRole("button", { name: "Retry" }, { timeout: 3000 });
    fireEvent.click(retry);
    await waitFor(() => expect(slot.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(2);
  });
});

describe("sketch menu dialogs", () => {
  async function openMenu(slot: Awaited<ReturnType<typeof open>>["slot"]) {
    const trigger = slot.getByRole("button", { name: "Sketch: Plan" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    return slot.findByRole("menu");
  }

  it("renames the sketch after saving pending edits", async () => {
    const { slot, canvas } = await open();
    click(canvas, 100, 120);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    const menu = await openMenu(slot);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
    const dialog = await slot.findByRole("dialog", { name: "Rename sketch" });
    const input = within(dialog).getByRole("textbox", { name: "Sketch name" });
    fireEvent.change(input, { target: { value: "Login flow" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "rename")).toEqual([{ id: "Plan", title: "Login flow" }]));
    const methods = slot.inspection.rpcCalls.map((call) => call.method).filter((method) => method === "save" || method === "rename");
    expect(methods).toEqual(["save", "rename"]);
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Login flow", replace: true } }),
    );
    expect(await slot.findByRole("button", { name: "Sketch: Login flow" })).toBeTruthy();
  });

  it("deletes the sketch without saving it again", async () => {
    const { slot, canvas } = await open();
    click(canvas, 100, 120);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    const menu = await openMenu(slot);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await slot.findByRole("dialog", { name: /Delete “Plan”/ });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "delete")).toEqual([{ id: "Plan" }]));
    expect(toast.success).toHaveBeenCalledWith("Deleted “Plan”");
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "", replace: true } });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(inputsOf(slot.inspection.rpcCalls, "save")).toEqual([]);
  });
});

describe("sketch menu files", () => {
  async function openMenu(slot: Awaited<ReturnType<typeof open>>["slot"]) {
    fireEvent.pointerDown(slot.getByRole("button", { name: "Sketch: Plan" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    return slot.findByRole("menu");
  }

  it("lists sketches with the open one checked and creates a new one", async () => {
    const { slot } = await open({ list: () => [summary("Plan"), summary("Other")] });
    const menu = await openMenu(slot);
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Plan" }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Other" }).getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /New sketch/ }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "create")).toEqual([{ title: null, content: null }]));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Untitled", replace: false } }));
  });

  it("opens an .excalidraw file as a new sketch named after the file", async () => {
    const { slot } = await open();
    const picker = slot.container.querySelector<HTMLInputElement>("input[type='file']");
    if (picker === null) throw new Error("no file picker");
    const content = file([rect(0, 0, 10, 10)]);
    const upload = new File([content], "Login flow.excalidraw", { type: "application/json" });
    await act(async () => {
      fireEvent.change(picker, { target: { files: [upload] } });
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "create")).toEqual([{ title: "Login flow", content }]));
  });

  it("refuses a file that is not an Excalidraw scene", async () => {
    const { slot } = await open();
    const picker = slot.container.querySelector<HTMLInputElement>("input[type='file']");
    if (picker === null) throw new Error("no file picker");
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["{\"hello\":1}"], "notes.excalidraw")] } });
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open notes.excalidraw: This is not an Excalidraw file."));
    expect(inputsOf(slot.inspection.rpcCalls, "create")).toEqual([]);
  });
});
