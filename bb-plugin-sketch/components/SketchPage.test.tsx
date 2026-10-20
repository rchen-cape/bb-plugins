// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers, type RpcCall } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { rpcContract, type SketchDetail, type SketchRpcContract, type SketchSummary } from "../contract";
import { parseSceneFile, serializeScene, type SketchElement } from "../lib/scene";
import { CHANGED_CHANNEL } from "../lib/sketch";
import { rect } from "../lib/test-fixtures";
import { sketchSubPath } from "./routes";
import { SketchPage } from "./SketchPage";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

vi.mock("./export-png", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-png")>();
  return { ...actual, renderPng: vi.fn(async () => ({ blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), width: 10, height: 10 })) };
});

type Handlers = PluginRpcTestHandlers<SketchRpcContract>;
type Slot = ReturnType<typeof renderSlot>;

const SHA_1 = "1".repeat(64);
const SHA_2 = "2".repeat(64);
const UPDATED = "2026-10-19T10:00:00.000Z";
const BOX = rect(100, 100, 100, 80, { id: "box" });
const SAVE_WAIT = { timeout: 3000 };

function file(elements: readonly SketchElement[]): string {
  return serializeScene({ elements, appState: {}, files: {} });
}

function summary(id: string): SketchSummary {
  return { id, title: id, updatedAt: UPDATED, elementCount: 1, sizeBytes: 10 };
}

function detail(id: string, content: string = file([BOX]), sha256 = SHA_1): SketchDetail {
  return { ...summary(id), sha256, content };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    status: () => ({ directory: "~/Sketches", sketchCount: 1, wiki: { available: true, inbox: true } }),
    list: () => [summary("Plan")],
    get: (input) => {
      const { id } = rpcContract.get.input.parse(input);
      return id === "Plan" ? detail("Plan") : null;
    },
    create: (input) => {
      const { title, content } = rpcContract.create.input.parse(input);
      return { ...summary(title ?? "Untitled"), sha256: SHA_2, content: content ?? file([]) };
    },
    save: () => ({ outcome: "written", sha256: SHA_2, updatedAt: UPDATED }),
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

function render(subPath: string, overrides: Partial<Handlers> = {}) {
  return renderSlot<{ subPath: string }, SketchRpcContract>({ component: SketchPage }, { subPath }, { rpc: handlers(overrides) });
}

function route(slot: Slot, subPath: string) {
  act(() => slot.lifecycle.rerender(createElement(SketchPage, { subPath })));
}

function inputsOf(calls: readonly RpcCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

function created(slot: Slot) {
  return inputsOf(slot.inspection.rpcCalls, "create").map((input) => rpcContract.create.input.parse(input));
}

function saved(slot: Slot) {
  return inputsOf(slot.inspection.rpcCalls, "save").map((input) => rpcContract.save.input.parse(input));
}

function elementCount(content: string | null): number {
  return parseSceneFile(content ?? "").scene.elements.length;
}

function drawBox(canvas: Element, x: number, y: number) {
  fireEvent.keyDown(canvas, { key: "r", code: "KeyR" });
  const at = (type: "pointerDown" | "pointerMove" | "pointerUp", dx: number, dy: number) =>
    fireEvent[type](canvas, { pointerId: 1, button: 0, buttons: type === "pointerUp" ? 0 : 1, clientX: x + dx, clientY: y + dy, pointerType: "mouse" });
  at("pointerDown", 0, 0);
  at("pointerMove", 30, 20);
  at("pointerMove", 60, 40);
  at("pointerUp", 60, 40);
}

async function canvasOf(slot: Slot) {
  return slot.findByRole("application", { name: "Sketch canvas" });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("creating the first sketch", () => {
  it("keeps strokes drawn while the file is being created, even when the list arrives first", async () => {
    let listed: SketchSummary[] = [];
    const creating = deferred<SketchDetail>();
    const slot = render("", { list: () => listed, create: () => creating.promise });
    const canvas = await canvasOf(slot);
    drawBox(canvas, 10, 10);
    await waitFor(() => expect(created(slot)).toHaveLength(1), SAVE_WAIT);
    listed = [summary("First")];
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { id: "First" });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "list").length).toBeGreaterThan(1));
    drawBox(canvas, 200, 200);
    expect(slot.inspection.navigateCalls).toEqual([]);
    await act(async () => creating.resolve(detail("First", created(slot)[0]?.content ?? "")));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "First", replace: true } }));
    route(slot, "First");
    await waitFor(() => expect(saved(slot)).toHaveLength(1), SAVE_WAIT);
    expect(saved(slot)[0]).toMatchObject({ id: "First", expectedSha256: SHA_1 });
    expect(elementCount(saved(slot)[0]?.content ?? null)).toBe(2);
    expect(inputsOf(slot.inspection.rpcCalls, "get")).toEqual([]);
    expect(await canvasOf(slot)).toBe(canvas);
  });

  it("names the sketch that was created, not the one now on screen", async () => {
    const slot = render("", {
      list: () => [],
      get: (input) => (rpcContract.get.input.parse(input).id === "Login" ? detail("Login", file([])) : null),
    });
    drawBox(await canvasOf(slot), 10, 10);
    const picker = slot.container.querySelector<HTMLInputElement>("input[type='file']");
    if (picker === null) throw new Error("no file picker");
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File([file([])], "Login.excalidraw")] } });
    });
    await waitFor(() => expect(created(slot)).toHaveLength(1));
    route(slot, "Login");
    await waitFor(() => expect(created(slot)).toHaveLength(2));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved your drawing as “Untitled”"));
    expect(created(slot)[1]).toMatchObject({ title: null });
    expect(elementCount(created(slot)[1]?.content ?? null)).toBe(1);
    expect(slot.getByRole("button", { name: "Sketch: Login" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).not.toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Untitled", replace: true } });
  });
});

describe("edits made during a conflict", () => {
  it("saves them as a new sketch when you leave", async () => {
    const slot = render("Plan", {
      list: () => [summary("Plan"), summary("Other")],
      get: (input) => detail(rpcContract.get.input.parse(input).id),
      save: () => ({ outcome: "conflict" }),
    });
    const canvas = await canvasOf(slot);
    drawBox(canvas, 300, 300);
    await slot.findByRole("button", { name: "Keep mine" }, SAVE_WAIT);
    drawBox(canvas, 500, 300);
    route(slot, "Other");
    await waitFor(() => expect(created(slot)).toHaveLength(1));
    expect(created(slot)[0]?.title).toBe("Plan (my edits)");
    expect(elementCount(created(slot)[0]?.content ?? null)).toBe(3);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved your unsaved edits to “Plan” as “Plan (my edits)”."));
    expect(saved(slot)).toHaveLength(1);
  });
});

describe("the bare Sketch route", () => {
  it("keeps the open sketch instead of jumping to the last one remembered", async () => {
    const slot = render("Plan", { list: () => [summary("Other"), summary("Plan")] });
    await canvasOf(slot);
    localStorage.setItem("sketch:last:v1", JSON.stringify("Other"));
    route(slot, "");
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Plan", replace: true } }));
    expect(slot.inspection.navigateCalls).not.toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Other", replace: true } });
  });
});

describe("a sketch that moves outside the page", () => {
  it("follows a rename", async () => {
    const slot = render("Plan");
    const canvas = await canvasOf(slot);
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { id: "Plan", renamedTo: "Flow" });
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Flow", replace: true } }));
    expect(await slot.findByRole("button", { name: "Sketch: Flow" })).toBeTruthy();
    drawBox(canvas, 300, 300);
    await waitFor(() => expect(saved(slot)).toHaveLength(1), SAVE_WAIT);
    expect(saved(slot)[0]?.id).toBe("Flow");
  });

  it("offers to save the open sketch as a new one when its file is gone", async () => {
    let gone = false;
    const slot = render("Plan", { get: () => (gone ? null : detail("Plan")) });
    const canvas = await canvasOf(slot);
    gone = true;
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { id: "Plan" });
    const banner = await slot.findByRole("alert");
    expect(banner.textContent).toContain("“Plan” isn't in your sketch folder anymore.");
    drawBox(canvas, 300, 300);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saved(slot)).toEqual([]);
    const saveAsNew = within(banner).getByRole("button", { name: "Save as a new sketch" });
    expect(fireEvent.mouseDown(saveAsNew)).toBe(false);
    await act(async () => {
      fireEvent.click(saveAsNew);
    });
    await waitFor(() => expect(created(slot)).toHaveLength(1));
    expect(created(slot)[0]?.title).toBe("Plan (my edits)");
    expect(elementCount(created(slot)[0]?.content ?? null)).toBe(2);
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: sketchSubPath("Plan (my edits)"), replace: true } }),
    );
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
    expect(saved(slot)).toEqual([]);
  });

  it("shows the missing banner instead of Keep mine when a save finds the file gone", async () => {
    let gets = 0;
    const slot = render("Plan", {
      get: () => {
        gets += 1;
        return gets === 1 ? detail("Plan") : null;
      },
      save: () => ({ outcome: "conflict" }),
    });
    drawBox(await canvasOf(slot), 300, 300);
    await slot.findByText(/isn't in your sketch folder anymore/, undefined, SAVE_WAIT);
    expect(slot.queryByRole("button", { name: "Keep mine" })).toBeNull();
  });
});

describe("opening a file with elements Sketch can't read", () => {
  it("says what it kept and what it skipped", async () => {
    const content = JSON.stringify({
      type: "excalidraw",
      elements: [BOX, { id: "t", type: "text", x: 0, y: 0 }, { type: "rectangle", x: 0, y: 0 }],
    });
    const slot = render("Plan", { get: () => detail("Plan", content) });
    await canvasOf(slot);
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith("2 elements in “Plan” couldn't be read. 1 is kept as a placeholder; 1 was skipped and will be left out when Sketch saves."),
    );
  });
});
