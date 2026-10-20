// @vitest-environment jsdom
import { cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrow } from "../lib/test-fixtures";
import { SHA_1, click, file, openSketch, summary, BOX, NOTE } from "./editor-test-support";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

const VIEWPORT_VARIANT = /(^|\s)(sm|md|lg|xl|2xl):/;
const PICK_PX = 28;
const PICK_GAP_PX = 2;
const PANEL_INNER_PX = 224 - 2 * 12;
const WIDEST_SCROLLBAR_PX = 17;

function classesIn(element: Element): string[] {
  return [element, ...element.querySelectorAll("*")].map((node) => node.getAttribute("class") ?? "");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("top bar", () => {
  it("lays out by the sketch pane's width, not the window's", async () => {
    const { slot } = await openSketch();
    const bar = slot.container.querySelector<HTMLElement>("[data-sketch-top-bar]");
    if (bar === null) throw new Error("no top bar");
    expect(bar.classList.contains("@container")).toBe(true);
    expect(classesIn(bar).filter((name) => VIEWPORT_VARIANT.test(name))).toEqual([]);
    expect(within(bar).getByRole("toolbar", { name: "Tools" })).toBeTruthy();
  });

  it("keeps Send to Wiki as a labelled icon button when the pane is narrow", async () => {
    const { slot } = await openSketch();
    const send = slot.getByRole("button", { name: "Send to Wiki" });
    const label = send.querySelector("[data-send-label]");
    expect(label?.textContent).toBe("Send to Wiki");
    expect(label?.classList.contains("hidden")).toBe(true);
    expect(label?.classList.contains("@md:inline")).toBe(true);
    expect(send.classList.contains("shrink-0")).toBe(true);
  });
});

describe("properties panel", () => {
  it("reserves the scrollbar gutter and fits the widest row on one line", async () => {
    const line = arrow({ x: 500, y: 300 }, { x: 640, y: 300 }, { id: "line" });
    const { slot, canvas } = await openSketch({ get: () => ({ ...summary("Plan"), sha256: SHA_1, content: file([BOX, NOTE, line]) }) }, 3);
    click(canvas, 570, 300);
    const panel = slot.getByRole("region", { name: "Style" });
    expect(within(panel).getByRole("group", { name: "End arrowhead" })).toBeTruthy();
    expect(panel.classList.contains("[scrollbar-gutter:stable]")).toBe(true);
    expect(panel.classList.contains("w-56")).toBe(true);
    const widest = Math.max(...within(panel).getAllByRole("group").map((row) => row.querySelectorAll("button, label").length));
    expect(widest).toBe(6);
    expect(widest * PICK_PX + (widest - 1) * PICK_GAP_PX).toBeLessThanOrEqual(PANEL_INNER_PX - WIDEST_SCROLLBAR_PX);
  });
});
