// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type SketchRpcContract } from "../contract";
import { BOX, SHA_1, SHA_2, file, handlers, inputsOf, summary } from "./editor-test-support";
import { SketchPage } from "./SketchPage";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("sketch routes with spaces", () => {
  it("opens a host-encoded route and navigates with plain sketch names", async () => {
    const rpc = handlers({
      list: () => [summary("Login flow"), summary("Other sketch")],
      get: (input) => (rpcContract.get.input.parse(input).id === "Login flow" ? { ...summary("Login flow"), sha256: SHA_1, content: file([BOX]) } : null),
      create: () => ({ ...summary("Untitled 2"), sha256: SHA_2, content: file([]) }),
    });
    const slot = renderSlot<{ subPath: string }, SketchRpcContract>({ component: SketchPage }, { subPath: "Login%20flow" }, { rpc });
    expect(await slot.findByRole("button", { name: "Sketch: Login flow" })).toBeTruthy();
    expect(inputsOf(slot.inspection.rpcCalls, "get")).toEqual([{ id: "Login flow" }]);
    const openMenu = async () => {
      fireEvent.pointerDown(slot.getByRole("button", { name: "Sketch: Login flow" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
      return slot.findByRole("menu");
    };
    fireEvent.click(within(await openMenu()).getByRole("menuitemcheckbox", { name: "Other sketch" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Other sketch", replace: false } });
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    await act(async () => {
      fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: /New sketch/ }));
    });
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "sketch", options: { subPath: "Untitled 2", replace: false } }));
  });
});
