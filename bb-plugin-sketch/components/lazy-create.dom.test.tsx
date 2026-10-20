// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type SketchDetail, type SketchRpcContract } from "../contract";
import { parseSceneFile } from "../lib/scene";
import { SHA_2, handlers, inputsOf, summary } from "./editor-test-support";
import { SketchPage } from "./SketchPage";

const host = vi.hoisted(() => {
  let path = "";
  let pending = "";
  let version = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    path: () => path,
    version: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate: (next: string) => {
      if (next === pending) return;
      pending = next;
      version += 1;
      emit();
      setTimeout(() => {
        path = next;
        emit();
      }, 20);
    },
    reset: () => {
      path = "";
      pending = "";
      version = 0;
      listeners.clear();
    },
  };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const react = await import("react");
  return {
    ...actual,
    useBbNavigate: () => {
      const version = react.useSyncExternalStore(host.subscribe, host.version);
      return react.useMemo(() => ({ version, toPluginPanel: (_panel: string, options?: { subPath?: string }) => host.navigate(options?.subPath ?? "") }), [version]);
    },
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

vi.mock("./export-png", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-png")>();
  return { ...actual, renderPng: vi.fn(async () => ({ blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), width: 10, height: 10 })) };
});

function RoutedPage() {
  const subPath = useSyncExternalStore(host.subscribe, host.path);
  return createElement(SketchPage, { subPath });
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

beforeEach(() => {
  localStorage.clear();
  host.reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("creating the first sketch when the host updates navigation before the route", () => {
  it("keeps the same canvas and every stroke", async () => {
    let created = false;
    let finish: () => void = () => undefined;
    const rpc = handlers({
      list: () => (created ? [summary("Untitled")] : []),
      get: () => null,
      create: (input) => {
        created = true;
        const { content } = rpcContract.create.input.parse(input);
        return new Promise<SketchDetail>((resolve) => {
          finish = () => resolve({ ...summary("Untitled"), sha256: SHA_2, content: content ?? "" });
        });
      },
    });
    const slot = renderSlot<object, SketchRpcContract>({ component: RoutedPage }, {}, { rpc });
    const canvas = await slot.findByRole("application", { name: "Sketch canvas" });
    drawBox(canvas, 10, 10);
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "create")).toHaveLength(1), { timeout: 3000 });
    drawBox(canvas, 200, 200);
    finish();
    await waitFor(() => expect(host.path()).toBe("Untitled"));
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "save")).toHaveLength(1), { timeout: 3000 });
    const save = rpcContract.save.input.parse(inputsOf(slot.inspection.rpcCalls, "save")[0]);
    expect(save).toMatchObject({ id: "Untitled", expectedSha256: SHA_2 });
    expect(parseSceneFile(save.content).scene.elements).toHaveLength(2);
    expect(inputsOf(slot.inspection.rpcCalls, "get")).toEqual([]);
    expect(slot.getByRole("application", { name: "Sketch canvas" })).toBe(canvas);
    expect(slot.getByRole("button", { name: "Sketch: Untitled" })).toBeTruthy();
  });
});
