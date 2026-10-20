// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RpcCall } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { rpcContract, type SketchDetail, type SketchRpcContract, type SketchSummary, type WikiDoc } from "./contract";
import { parseSceneFile, serializeScene, type SketchElement } from "./lib/scene";
import { CHANGED_CHANNEL } from "./lib/sketch";
import { rect } from "./lib/test-fixtures";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-1"),
    dismiss: vi.fn(),
  }),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

vi.mock("./components/export-png", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/export-png")>();
  return {
    ...actual,
    renderPng: vi.fn(async () => ({ blob: new Blob([PNG_BYTES], { type: "image/png" }), width: 264, height: 192 })),
  };
});

const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const SHA_3 = "c".repeat(64);
const UPDATED = "2026-10-19T10:00:00.000Z";

const BOX = rect(100, 100, 100, 80, { id: "box-1" });

function content(elements: readonly SketchElement[]): string {
  return serializeScene({ elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
}

function summary(id: string, count = 1): SketchSummary {
  return { id, title: id, updatedAt: UPDATED, elementCount: count, sizeBytes: 100 };
}

function detail(id: string, elements: readonly SketchElement[], sha256 = SHA_1): SketchDetail {
  return { ...summary(id, elements.length), sha256, content: content(elements) };
}

const DOCS: WikiDoc[] = [
  { slug: "alpha", title: "Alpha project", type: "project", aliases: ["ap"], tag: "alpha", headings: ["Alpha project", "Diagrams"] },
  { slug: "beta", title: "Beta topic", type: "topic", aliases: [], tag: "beta", headings: ["Beta topic"] },
];

type Handlers = PluginRpcTestHandlers<SketchRpcContract>;

function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    status: () => ({ directory: "~/Sketches", sketchCount: 1, wiki: { available: true, inbox: true } }),
    list: () => [summary("Plan")],
    get: (input) => {
      const { id } = rpcContract.get.input.parse(input);
      return id === "Plan" ? detail("Plan", [BOX]) : null;
    },
    create: (input) => {
      const parsed = rpcContract.create.input.parse(input);
      return { ...summary(parsed.title ?? "Untitled"), sha256: SHA_2, content: parsed.content ?? content([]) };
    },
    save: () => ({ outcome: "written", sha256: SHA_2, updatedAt: UPDATED }),
    rename: (input) => summary(rpcContract.rename.input.parse(input).title),
    duplicate: () => summary("Plan copy"),
    delete: (input) => ({ id: rpcContract.delete.input.parse(input).id }),
    savePreview: () => ({ stored: true }),
    wikiDocs: () => ({ wiki: { available: true, inbox: true }, docs: DOCS }),
    wikiSuggest: () => ({ suggestions: [] }),
    sendToWiki: (input) => {
      const { destination } = rpcContract.sendToWiki.input.parse(input);
      return destination.kind === "inbox" ? { kind: "inbox", cardId: "card_00000001" } : { kind: "doc", slug: destination.slug, title: "Alpha project" };
    },
    ...overrides,
  };
}

function inputsOf(calls: readonly RpcCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

async function load() {
  return loadPluginApp(() => import("./app"));
}

async function renderPage(subPath = "Plan", overrides: Partial<Handlers> = {}) {
  const app = await load();
  const slot = renderSlot<{ subPath: string }, SketchRpcContract>(app.navPanels[0]!, { subPath }, { rpc: handlers(overrides), pluginId: "sketch" });
  const canvas = await slot.findByRole("application", { name: "Sketch canvas" });
  return { slot, canvas };
}

function elementIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-sketch-scene] [data-element-id]")].map((node) => node.getAttribute("data-element-id") ?? "");
}

function press(target: Element, key: string, init: Partial<KeyboardEventInit> & { code?: string } = {}) {
  fireEvent.keyDown(target, { key, code: init.code ?? "", ...init });
}

function drag(canvas: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1, clientX: from[0], clientY: from[1], pointerType: "mouse" });
  fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pointerType: "mouse" });
  fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: to[0], clientY: to[1], pointerType: "mouse" });
  fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: to[0], clientY: to[1], pointerType: "mouse" });
}

function click(canvas: Element, at: [number, number], init: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1, clientX: at[0], clientY: at[1], pointerType: "mouse", ...init });
  fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: at[0], clientY: at[1], pointerType: "mouse", ...init });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sketch app registrations", () => {
  it("registers the Sketch page and its icon", async () => {
    const app = await load();
    expect(app.navPanels.map(({ id, title, path, icon }) => ({ id, title, path, icon }))).toEqual([
      { id: "sketch", title: "Sketch", path: "sketch", icon: "sketch-pen" },
    ]);
    expect(app.icons.map((icon) => icon.name)).toEqual(["sketch-pen"]);
  });
});

describe("Sketch page", () => {
  it("opens the sketch from the route and draws its elements", async () => {
    const { slot } = await renderPage();
    expect(await slot.findByRole("button", { name: "Sketch: Plan" })).toBeTruthy();
    expect(within(slot.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1"]));
    expect(inputsOf(slot.inspection.rpcCalls, "get")).toEqual([{ id: "Plan" }]);
  });

  it("opens the most recent sketch when the route is empty", async () => {
    const app = await load();
    const slot = renderSlot<{ subPath: string }, SketchRpcContract>(app.navPanels[0]!, { subPath: "" }, {
      rpc: handlers({ list: () => [summary("Newest"), summary("Plan")] }),
    });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "sketch", options: { subPath: "Newest", replace: true } }]),
    );
  });

  it("switches tools with single keys and keeps the tool with Q", async () => {
    const { slot, canvas } = await renderPage();
    const tools = slot.getByRole("toolbar", { name: "Tools" });
    const pressed = (name: string) => within(tools).getByRole("button", { name }).getAttribute("aria-pressed");
    press(canvas, "r");
    expect(pressed("Rectangle")).toBe("true");
    press(canvas, "5");
    expect(pressed("Arrow")).toBe("true");
    press(canvas, "x");
    expect(pressed("Draw")).toBe("true");
    press(canvas, "q");
    expect(pressed("Keep tool after drawing")).toBe("true");
    press(canvas, "Escape");
    expect(pressed("Select")).toBe("true");
  });

  it("draws a rectangle with the pointer, selects it and saves it", async () => {
    const { slot, canvas } = await renderPage();
    await waitFor(() => expect(elementIds(slot.container)).toHaveLength(1));
    press(canvas, "r");
    drag(canvas, [300, 300], [420, 380]);
    expect(elementIds(slot.container)).toHaveLength(2);
    expect(within(slot.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.container.querySelector("[data-selection='box']")).not.toBeNull();
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(1), { timeout: 3000 });
    const saved = rpcContract.save.input.parse(inputsOf(slot.inspection.rpcCalls, "save")[0]);
    expect(saved.id).toBe("Plan");
    expect(saved.expectedSha256).toBe(SHA_1);
    const { scene } = parseSceneFile(saved.content);
    const drawn = scene.elements.find((element) => element.id !== "box-1");
    expect(drawn).toMatchObject({ type: "rectangle", x: 300, y: 300, width: 120, height: 80 });
  });

  it("drops a click that is too small to be a shape", async () => {
    const { slot, canvas } = await renderPage();
    await waitFor(() => expect(elementIds(slot.container)).toHaveLength(1));
    press(canvas, "o");
    click(canvas, [500, 500]);
    expect(elementIds(slot.container)).toEqual(["box-1"]);
  });

  it("selects with a click, deletes, and undoes the delete", async () => {
    const { slot, canvas } = await renderPage();
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1"]));
    click(canvas, [100, 140]);
    expect(slot.container.querySelector("[data-selection='box']")).not.toBeNull();
    press(canvas, "Delete");
    expect(elementIds(slot.container)).toEqual([]);
    press(canvas, "z", { code: "KeyZ", metaKey: true });
    expect(elementIds(slot.container)).toEqual(["box-1"]);
    press(canvas, "z", { code: "KeyZ", metaKey: true, shiftKey: true });
    expect(elementIds(slot.container)).toEqual([]);
  });

  it("moves a selected shape by dragging it", async () => {
    const { slot, canvas } = await renderPage();
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1"]));
    drag(canvas, [100, 140], [160, 200]);
    const group = slot.container.querySelector("[data-element-id='box-1']");
    expect(group?.getAttribute("transform")).toBe("translate(160 160)");
  });

  it("selects with a marquee and clears with Escape", async () => {
    const { slot, canvas } = await renderPage();
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1"]));
    drag(canvas, [50, 50], [260, 260]);
    expect(slot.container.querySelector("[data-selection='box']")).not.toBeNull();
    press(canvas, "Escape");
    expect(slot.container.querySelector("[data-selection='box']")).toBeNull();
  });

  it("adopts a file that changed somewhere else", async () => {
    let current = detail("Plan", [BOX]);
    const { slot } = await renderPage("Plan", { get: () => current });
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1"]));
    current = detail("Plan", [BOX, rect(400, 100, 50, 50, { id: "box-2" })], SHA_3);
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { id: "Plan" });
    await waitFor(() => expect(elementIds(slot.container)).toEqual(["box-1", "box-2"]));
  });

  it("creates a file on the first edit when there are no sketches", async () => {
    const app = await load();
    const slot = renderSlot<{ subPath: string }, SketchRpcContract>(app.navPanels[0]!, { subPath: "" }, { rpc: handlers({ list: () => [] }) });
    const canvas = await slot.findByRole("application", { name: "Sketch canvas" });
    expect(slot.getByText("Pick a tool, or press R, O, A, T to start")).toBeTruthy();
    press(canvas, "r");
    drag(canvas, [10, 10], [90, 70]);
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "create")).toHaveLength(1), { timeout: 3000 });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Untitled", replace: true } }),
    );
  });
});

describe("Send to Wiki", () => {
  async function openDialog(overrides: Partial<Handlers> = {}, select = false) {
    const page = await renderPage("Plan", overrides);
    await waitFor(() => expect(elementIds(page.slot.container)).toEqual(["box-1"]));
    if (select) click(page.canvas, [100, 120]);
    press(page.canvas, "s", { code: "KeyS", metaKey: true, shiftKey: true });
    const dialog = await page.slot.findByRole("dialog", { name: "Send to Wiki" });
    await within(dialog).findByText(/PNG · 264 × 192 px/);
    return { ...page, dialog };
  }

  it("sends the whole sketch to the inbox", async () => {
    const { slot, dialog } = await openDialog();
    const send = within(dialog).getByRole("button", { name: "Send to inbox" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "sendToWiki")).toHaveLength(1));
    expect(inputsOf(slot.inspection.rpcCalls, "sendToWiki")[0]).toEqual({ name: "Plan", png: PNG_BASE64, caption: "", note: "", destination: { kind: "inbox" } });
    expect(toast.success).toHaveBeenCalledWith("Sent to your Wiki inbox", expect.objectContaining({ action: expect.objectContaining({ label: "Review" }) }));
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Send to Wiki" })).toBeNull());
    expect(JSON.parse(localStorage.getItem("sketch:wiki:v1") ?? "{}")).toMatchObject({ kind: "inbox" });
  });

  it("adds the selection to a doc under the chosen heading", async () => {
    const { slot, dialog } = await openDialog({}, true);
    expect(within(dialog).getByText(/Sends the selected part of/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    const search = within(dialog).getByRole("combobox", { name: "Search Wiki docs" });
    fireEvent.change(search, { target: { value: "alp" } });
    const option = await within(dialog).findByRole("option", { name: /Alpha project/ });
    fireEvent.click(option);
    const heading = within(dialog).getByRole("combobox", { name: "Heading" });
    fireEvent.change(heading, { target: { value: "Diagrams" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Caption/ }), { target: { value: "Login flow" } });
    const add = within(dialog).getByRole("button", { name: "Add to Alpha project" });
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Enter", metaKey: true });
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "sendToWiki")).toHaveLength(1));
    expect(inputsOf(slot.inspection.rpcCalls, "sendToWiki")[0]).toEqual({
      name: "Plan",
      png: PNG_BASE64,
      caption: "Login flow",
      note: "",
      destination: { kind: "doc", slug: "alpha", heading: "Diagrams" },
    });
    expect(toast.success).toHaveBeenCalledWith("Added to Alpha project", expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }));
    expect(JSON.parse(localStorage.getItem("sketch:wiki:v1") ?? "{}")).toEqual({ kind: "doc", slug: "alpha", heading: "Diagrams" });
  });

  it("explains when the Wiki is not available and keeps sending off", async () => {
    const { dialog } = await openDialog({ wikiDocs: () => ({ wiki: { available: false, reason: "The Wiki plugin isn't installed." }, docs: [] }) });
    expect(await within(dialog).findByText(/The Wiki plugin isn't installed\./)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send to inbox" }).hasAttribute("disabled")).toBe(true);
  });
});
