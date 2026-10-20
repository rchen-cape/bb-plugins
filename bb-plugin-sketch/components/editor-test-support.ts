import { fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { renderSlot, type PluginRpcTestHandlers, type RpcCall } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type SketchRpcContract, type SketchSummary, type WikiDoc } from "../contract";
import { serializeScene, type SketchElement } from "../lib/scene";
import { rect, text } from "../lib/test-fixtures";
import { SketchPage } from "./SketchPage";

export type Handlers = PluginRpcTestHandlers<SketchRpcContract>;

export const SHA_1 = "1".repeat(64);
export const SHA_2 = "2".repeat(64);
export const BOX = rect(100, 100, 100, 80, { id: "box" });
export const NOTE = text({ x: 400, y: 100 }, "Hello", { id: "note" });

export const DOCS: WikiDoc[] = [
  { slug: "alpha", title: "Alpha project", type: "project", aliases: [], tag: "alpha", headings: ["Alpha project", "Diagrams"] },
  { slug: "beta", title: "Beta topic", type: "topic", aliases: [], tag: "beta", headings: ["Beta topic", "Flows"] },
];

export function summary(id: string): SketchSummary {
  return { id, title: id, updatedAt: "2026-10-19T10:00:00.000Z", elementCount: 1, sizeBytes: 10 };
}

export function file(elements: readonly SketchElement[]): string {
  return serializeScene({ elements, appState: {}, files: {} });
}

export function handlers(overrides: Partial<Handlers> = {}): Handlers {
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
    wikiDocs: () => ({ wiki: { available: true, inbox: true }, docs: DOCS }),
    wikiSuggest: () => ({ suggestions: [] }),
    sendToWiki: () => ({ kind: "inbox", cardId: "card_00000001" }),
    ...overrides,
  };
}

export async function openSketch(overrides: Partial<Handlers> = {}, elementCount = 2) {
  const slot = renderSlot<{ subPath: string }, SketchRpcContract>({ component: SketchPage }, { subPath: "Plan" }, { rpc: handlers(overrides) });
  const canvas = await slot.findByRole("application", { name: "Sketch canvas" });
  await waitFor(() => expect(slot.container.querySelectorAll("[data-sketch-scene] [data-element-id]")).toHaveLength(elementCount));
  return { slot, canvas, root: sketchRoot(slot.container) };
}

export function sketchRoot(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-sketch-root]");
  if (found === null) throw new Error("no sketch root");
  return found;
}

export function inputsOf(calls: readonly RpcCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

export function pointer(canvas: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) {
  fireEvent[type](canvas, { pointerId: 1, button: 0, buttons: type === "pointerUp" ? 0 : 1, clientX: x, clientY: y, pointerType: "mouse" });
}

export function click(canvas: Element, x: number, y: number) {
  pointer(canvas, "pointerDown", x, y);
  pointer(canvas, "pointerUp", x, y);
}

export function press(button: Element) {
  const kept = !fireEvent.mouseDown(button);
  fireEvent.mouseUp(button);
  fireEvent.click(button);
  return kept;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
