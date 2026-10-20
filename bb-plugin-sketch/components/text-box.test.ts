import { describe, expect, it } from "vitest";
import { ensureLabel } from "../lib/actions";
import { byId, measure, rect, styleWith, text } from "../lib/test-fixtures";
import { labelMaxWidth } from "../lib/text";
import { CARET_SLACK, textBox } from "./text-box";

describe("textBox", () => {
  it("places free text at its own box, scaled by the view", () => {
    const element = text({ x: 10, y: 20 }, "Hello", { id: "t" });
    const box = textBox(element, [element], { scrollX: 5, scrollY: -10, zoom: 2 });
    expect(box).toMatchObject({ left: 30, top: 20, width: element.width * 2 + CARET_SLACK, height: element.height * 2, wrap: false });
  });

  it("shifts centered free text so the caret slack stays balanced", () => {
    const element = text({ x: 10, y: 20 }, "Hello", { id: "t", textAlign: "center" });
    expect(textBox(element, [element], { scrollX: 0, scrollY: 0, zoom: 1 }).left).toBe(10 - CARET_SLACK / 2);
  });

  it("uses the container's inner width for labels so the browser wraps like the engine", () => {
    const container = rect(100, 100, 200, 80, { id: "box" });
    const labeled = ensureLabel([container], "box", styleWith(), measure);
    if (labeled === null) throw new Error("no label");
    const label = byId(labeled.elements, labeled.labelId);
    if (label.type !== "text") throw new Error("not text");
    const box = textBox(label, labeled.elements, { scrollX: 0, scrollY: 0, zoom: 1 });
    expect(box.wrap).toBe(true);
    expect(box.width).toBe(labelMaxWidth(container));
    expect(box.top).toBe(label.y);
  });
});
