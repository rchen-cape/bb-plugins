import { describe, expect, it } from "vitest";
import { selectionFrame } from "./bounds";
import {
  handleAt,
  handleCursor,
  handlePoint,
  handlePositions,
  handlesFor,
  mustKeepAspect,
  resizeEdges,
  resizeElements,
  uniformScale,
  type HandleId,
} from "./resize";
import type { SketchElement } from "./scene";
import { arrow, freedraw, rect, shape, text } from "./test-fixtures";

function resize(elements: SketchElement[], handle: HandleId, pointer: { x: number; y: number }, keepAspect = false, fromCenter = false): SketchElement[] {
  const frame = selectionFrame(elements);
  if (frame === null) throw new Error("no frame");
  return resizeElements(elements, frame, handle, pointer, { keepAspect, fromCenter });
}

function box(element: SketchElement | undefined): { x: number; y: number; width: number; height: number } {
  if (element === undefined) throw new Error("missing");
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

describe("handles", () => {
  it("picks handles per selection", () => {
    expect(handlesFor([rect(0, 0, 10, 10)])).toHaveLength(8);
    expect(handlesFor([text({ x: 0, y: 0 }, "hi")])).toEqual(["nw", "ne", "se", "sw"]);
    expect(handlesFor([arrow({ x: 0, y: 0 }, { x: 10, y: 10 })])).toEqual([]);
    expect(handlesFor([arrow({ x: 0, y: 0 }, { x: 10, y: 10 }), rect(0, 0, 10, 10)])).toHaveLength(8);
    expect(handlesFor([])).toEqual([]);
  });

  it("forces aspect for text and rotated multi selections", () => {
    expect(mustKeepAspect([text({ x: 0, y: 0 }, "hi")])).toBe(true);
    expect(mustKeepAspect([rect(0, 0, 10, 10)])).toBe(false);
    expect(mustKeepAspect([rect(0, 0, 10, 10), text({ x: 0, y: 0 }, "hi")])).toBe(true);
    expect(mustKeepAspect([rect(0, 0, 10, 10), rect(0, 0, 10, 10, { angle: 1 })])).toBe(true);
    expect(mustKeepAspect([rect(0, 0, 10, 10, { angle: 1 })])).toBe(false);
  });

  it("places handles on the padded frame and hit tests them", () => {
    const frame = { x: 0, y: 0, width: 100, height: 100, angle: 0 };
    expect(handlePoint(frame, "se", 1)).toEqual({ x: 104, y: 104 });
    expect(handlePoint(frame, "n", 2)).toEqual({ x: 50, y: -2 });
    expect(handleAt(frame, handlesFor([rect(0, 0, 100, 100)]), { x: 103, y: 106 }, 1)).toBe("se");
    expect(handleAt(frame, handlesFor([rect(0, 0, 100, 100)]), { x: 50, y: 50 }, 1)).toBeNull();
    expect(handleAt(frame, ["nw", "ne", "se", "sw"], { x: 104, y: 50 }, 1)).toBeNull();
  });

  it("hides side handles on small frames", () => {
    const frame = { x: 0, y: 0, width: 10, height: 100, angle: 0 };
    expect(handlePositions(frame, 1, handlesFor([rect(0, 0, 10, 100)])).map((h) => h.id)).toEqual(["nw", "ne", "e", "se", "sw", "w"]);
  });

  it("rotates handles and cursors with the frame", () => {
    const frame = { x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 };
    const east = handlePoint(frame, "e", 1);
    expect(east.x).toBeCloseTo(50);
    expect(east.y).toBeCloseTo(79);
    expect(handleCursor("e", 0)).toBe("ew-resize");
    expect(handleCursor("e", Math.PI / 2)).toBe("ns-resize");
    expect(handleCursor("nw", 0)).toBe("nwse-resize");
    expect(handleCursor("ne", 0)).toBe("nesw-resize");
  });
});

describe("resize edges", () => {
  const frame = { x: 0, y: 0, width: 100, height: 50, angle: 0 };

  it("moves the dragged edges", () => {
    expect(resizeEdges(frame, "se", { x: 150, y: 80 }, { keepAspect: false, fromCenter: false })).toEqual({ left: 0, right: 150, top: 0, bottom: 80 });
    expect(resizeEdges(frame, "w", { x: 20, y: 999 }, { keepAspect: false, fromCenter: false })).toEqual({ left: 20, right: 100, top: 0, bottom: 50 });
  });

  it("keeps aspect from the opposite corner or centered on side handles", () => {
    expect(resizeEdges(frame, "se", { x: 200, y: 60 }, { keepAspect: true, fromCenter: false })).toEqual({ left: 0, right: 200, top: 0, bottom: 100 });
    expect(resizeEdges(frame, "nw", { x: -100, y: 40 }, { keepAspect: true, fromCenter: false })).toEqual({ left: -100, right: 100, top: -50, bottom: 50 });
    expect(resizeEdges(frame, "e", { x: 200, y: 0 }, { keepAspect: true, fromCenter: false })).toEqual({ left: 0, right: 200, top: -25, bottom: 75 });
  });

  it("resizes from the center with Alt", () => {
    expect(resizeEdges(frame, "se", { x: 150, y: 75 }, { keepAspect: false, fromCenter: true })).toEqual({ left: -50, right: 150, top: -25, bottom: 75 });
  });

  it("measures uniform scale", () => {
    expect(uniformScale(2, -2)).toBe(2);
    expect(uniformScale(2, 1.5)).toBeNull();
  });
});

describe("resizeElements", () => {
  it("resizes a single shape", () => {
    const [resized] = resize([rect(0, 0, 100, 100)], "se", { x: 150, y: 120 });
    expect(box(resized)).toEqual({ x: 0, y: 0, width: 150, height: 120 });
    expect(resized?.version).toBe(2);
  });

  it("keeps aspect with Shift and grows from the center with Alt", () => {
    expect(box(resize([rect(0, 0, 100, 100)], "se", { x: 150, y: 120 }, true)[0])).toEqual({ x: 0, y: 0, width: 150, height: 150 });
    expect(box(resize([rect(0, 0, 100, 100)], "se", { x: 150, y: 120 }, false, true)[0])).toEqual({ x: -50, y: -20, width: 200, height: 140 });
  });

  it("normalizes flips to positive sizes", () => {
    expect(box(resize([rect(0, 0, 100, 100)], "e", { x: -50, y: 50 })[0])).toEqual({ x: -50, y: 0, width: 50, height: 100 });
    expect(box(resize([rect(0, 0, 100, 100)], "nw", { x: 150, y: 130 })[0])).toEqual({ x: 100, y: 100, width: 50, height: 30 });
  });

  it("mirrors points when a linear element flips", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 50 });
    const pen = freedraw({ x: 0, y: 0 }, [[0, 0], [100, 50]]);
    const [flipped, flippedPen] = resize([line, pen], "w", { x: 200, y: 25 });
    expect(flipped?.type === "arrow" && flipped.points).toEqual([[0, 0], [-100, 50]]);
    expect(flipped?.x).toBe(200);
    expect(flippedPen?.type === "freedraw" && flippedPen.points).toEqual([[0, 0], [-100, 50]]);
  });

  it("scales many elements proportionally, including points and font size", () => {
    const a = rect(0, 0, 100, 100);
    const label = text({ x: 100, y: 100 }, "ab", { width: 50, height: 25, fontSize: 20 });
    const [ra, rt] = resize([a, label], "se", { x: 300, y: 250 }, true);
    expect(box(ra)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(box(rt)).toEqual({ x: 200, y: 200, width: 100, height: 50 });
    expect(rt?.type === "text" && rt.fontSize).toBe(40);
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 100 });
    const b = rect(100, 0, 100, 100);
    const [rl, rb] = resize([line, b], "e", { x: 400, y: 50 });
    expect(rl?.type === "arrow" && rl.points).toEqual([[0, 0], [200, 100]]);
    expect(box(rb)).toEqual({ x: 200, y: 0, width: 200, height: 100 });
  });

  it("mirrors rotated angles when a multi selection flips on one axis", () => {
    const tilted = rect(0, 0, 50, 50, { angle: 0.3 });
    const other = rect(100, 100, 50, 50);
    const frame = selectionFrame([tilted, other]);
    if (frame === null) throw new Error("no frame");
    const [flipped] = resizeElements([tilted, other], frame, "e", { x: frame.x - frame.width, y: 0 }, { keepAspect: true, fromCenter: false });
    expect(flipped?.angle).toBeCloseTo(Math.PI * 2 - 0.3);
  });

  it("keeps the opposite side fixed for a rotated shape", () => {
    const tilted = rect(0, 0, 100, 50, { angle: Math.PI / 2 });
    const [resized] = resize([tilted], "e", { x: 50, y: 125 });
    expect(resized?.x).toBeCloseTo(-25);
    expect(resized?.y).toBeCloseTo(25);
    expect(resized?.width).toBeCloseTo(150);
    expect(resized?.height).toBeCloseTo(50);
    expect(resized?.angle).toBeCloseTo(Math.PI / 2);
  });

  it("scales a single text by its font size from a corner", () => {
    const label = text({ x: 0, y: 0 }, "abcd", { fontSize: 20 });
    const [scaled] = resize([label], "se", { x: 80, y: 45 }, true);
    expect(scaled?.type === "text" && scaled.fontSize).toBe(40);
    expect(box(scaled)).toEqual({ x: 0, y: 0, width: 80, height: 50 });
  });

  it("leaves ellipses and diamonds in their type", () => {
    const [ellipse] = resize([shape("ellipse", { x: 0, y: 0, width: 10, height: 10 })], "s", { x: 5, y: 30 });
    expect(ellipse?.type).toBe("ellipse");
    expect(ellipse?.height).toBe(30);
  });
});
