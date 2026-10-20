import { describe, expect, it } from "vitest";
import { editTargetAt } from "./hit";
import { rect, shape, text } from "./test-fixtures";

describe("editTargetAt", () => {
  it("edits text under the pointer even inside a later unfilled frame", () => {
    const note = text({ x: 820, y: 500 }, "inner note");
    const frame = rect(700, 380, 450, 300);
    expect(editTargetAt([note, frame], { x: 840, y: 510 }, 1)).toBe(note.id);
  });

  it("edits a shape under a later unfilled frame through its fill", () => {
    const box = rect(100, 100, 100, 80, { backgroundColor: "#a5d8ff" });
    const boundary = rect(0, 0, 400, 300);
    expect(editTargetAt([box, boundary], { x: 150, y: 140 }, 1)).toBe(box.id);
  });

  it("edits a shape's label through the container", () => {
    const box = rect(0, 0, 200, 100);
    const label = text({ x: 60, y: 40 }, "Server", { containerId: box.id });
    const boundary = rect(-100, -100, 500, 400);
    expect(editTargetAt([box, label, boundary], { x: 70, y: 50 }, 1)).toBe(box.id);
  });

  it("falls back to the smallest unfilled shape around the point", () => {
    const outer = rect(0, 0, 400, 300);
    const inner = rect(100, 100, 100, 80);
    const ring = shape("ellipse", { x: 50, y: 50, width: 300, height: 200 });
    expect(editTargetAt([inner, outer], { x: 150, y: 140 }, 1)).toBe(inner.id);
    expect(editTargetAt([outer, ring, inner], { x: 150, y: 140 }, 1)).toBe(inner.id);
    expect(editTargetAt([outer, ring], { x: 200, y: 150 }, 1)).toBe(ring.id);
    expect(editTargetAt([outer, ring], { x: 20, y: 20 }, 1)).toBe(outer.id);
  });

  it("prefers a stroke hit on a frame over a larger frame around it", () => {
    const outer = rect(0, 0, 400, 300);
    const inner = rect(100, 100, 100, 80);
    expect(editTargetAt([inner, outer], { x: 100, y: 140 }, 1)).toBe(inner.id);
    expect(editTargetAt([inner, outer], { x: 0, y: 140 }, 1)).toBe(outer.id);
  });

  it("ignores deleted shapes and empty space", () => {
    const gone = rect(0, 0, 100, 100, { isDeleted: true });
    expect(editTargetAt([gone], { x: 50, y: 50 }, 1)).toBeNull();
    expect(editTargetAt([rect(0, 0, 100, 100)], { x: 500, y: 500 }, 1)).toBeNull();
  });
});
