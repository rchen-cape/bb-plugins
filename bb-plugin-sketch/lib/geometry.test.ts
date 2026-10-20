import { describe, expect, it } from "vitest";
import {
  absolutePoints,
  boundsContain,
  clampZoom,
  commonBounds,
  editTargetAt,
  elementBounds,
  elementCenter,
  elementsAlongPath,
  elementsInMarquee,
  fitBounds,
  frameContains,
  hitElement,
  nextZoomStep,
  panBy,
  pickTarget,
  sceneToScreen,
  screenToScene,
  selectionFrame,
  snapAngle,
  snapPoint,
  snapToGrid,
  topmostHit,
  visibleSceneBounds,
  wheelZoom,
  zoomAt,
  type Viewport,
} from "./geometry";
import { arrow, freedraw, linear, rect, shape, text, unsupported } from "./test-fixtures";

describe("bounds", () => {
  it("rotates boxes around their center", () => {
    const box = rect(0, 0, 100, 50, { angle: Math.PI / 2 });
    const b = elementBounds(box);
    expect(b.minX).toBeCloseTo(25);
    expect(b.maxX).toBeCloseTo(75);
    expect(b.minY).toBeCloseTo(-25);
    expect(b.maxY).toBeCloseTo(75);
  });

  it("uses exact bounds for rotated ellipses", () => {
    const ellipse = shape("ellipse", { x: 0, y: 0, width: 100, height: 50 }, { angle: Math.PI / 4 });
    const b = elementBounds(ellipse);
    const half = Math.sqrt((50 * 50 + 25 * 25) / 2);
    expect(b.maxX - b.minX).toBeCloseTo(half * 2);
    expect(elementCenter(ellipse)).toEqual({ x: 50, y: 25 });
  });

  it("measures linear elements from their points", () => {
    const line = linear("line", { x: 100, y: 100 }, [[0, 0], [-50, 20], [30, -10]]);
    expect(elementBounds(line)).toEqual({ minX: 50, minY: 90, maxX: 130, maxY: 120 });
    expect(elementCenter(line)).toEqual({ x: 90, y: 105 });
  });

  it("rotates linear points around the points' center", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 0 }, { angle: Math.PI / 2 });
    const [start, end] = absolutePoints(line);
    expect(start?.x).toBeCloseTo(50);
    expect(start?.y).toBeCloseTo(-50);
    expect(end?.x).toBeCloseTo(50);
    expect(end?.y).toBeCloseTo(50);
  });

  it("joins bounds and skips deleted elements", () => {
    expect(commonBounds([rect(0, 0, 10, 10), rect(20, -5, 10, 10), rect(500, 500, 1, 1, { isDeleted: true })])).toEqual({
      minX: 0,
      minY: -5,
      maxX: 30,
      maxY: 10,
    });
    expect(commonBounds([])).toBeNull();
  });

  it("frames one element with its angle and many without", () => {
    const box = rect(10, 10, 100, 50, { angle: 0.5 });
    expect(selectionFrame([box])).toEqual({ x: 10, y: 10, width: 100, height: 50, angle: 0.5 });
    const label = text({ x: 20, y: 20 }, "hi", { containerId: box.id });
    expect(selectionFrame([box, label])?.angle).toBe(0.5);
    const frame = selectionFrame([rect(0, 0, 10, 10), rect(20, 20, 10, 10)]);
    expect(frame).toEqual({ x: 0, y: 0, width: 30, height: 30, angle: 0 });
    expect(selectionFrame([arrow({ x: 0, y: 0 }, { x: 10, y: 20 })])).toEqual({ x: 0, y: 0, width: 10, height: 20, angle: 0 });
  });

  it("tests points against a rotated frame", () => {
    const frame = { x: 0, y: 0, width: 100, height: 10, angle: Math.PI / 2 };
    expect(frameContains(frame, { x: 50, y: 40 })).toBe(true);
    expect(frameContains(frame, { x: 90, y: 5 })).toBe(false);
    expect(frameContains(frame, { x: 57, y: 40 }, 4)).toBe(true);
  });
});

describe("hit testing", () => {
  const open = rect(0, 0, 100, 100);
  const filled = rect(0, 0, 100, 100, { backgroundColor: "#a5d8ff" });

  it("hits unfilled shapes only near the outline", () => {
    expect(hitElement(open, { x: 50, y: 50 }, 1)).toBe(false);
    expect(hitElement(open, { x: 50, y: 5 }, 1)).toBe(true);
    expect(hitElement(open, { x: 50, y: -10 }, 1)).toBe(true);
    expect(hitElement(open, { x: 50, y: -12 }, 1)).toBe(false);
  });

  it("scales the tolerance with zoom", () => {
    expect(hitElement(open, { x: 50, y: -8 }, 1)).toBe(true);
    expect(hitElement(open, { x: 50, y: -8 }, 2)).toBe(false);
    expect(hitElement(open, { x: 50, y: -40 }, 0.25)).toBe(true);
  });

  it("hits filled shapes, text and unsupported elements inside", () => {
    expect(hitElement(filled, { x: 50, y: 50 }, 1)).toBe(true);
    expect(hitElement(text({ x: 0, y: 0 }, "hello"), { x: 25, y: 12 }, 1)).toBe(true);
    expect(hitElement(unsupported("u", { x: 0, y: 0, width: 50, height: 50 }), { x: 25, y: 25 }, 1)).toBe(true);
  });

  it("follows rounded corners", () => {
    const rounded = rect(0, 0, 200, 200, { roundness: { type: 3 } });
    expect(hitElement(rounded, { x: 0, y: 0 }, 1)).toBe(false);
    expect(hitElement(rounded, { x: 10, y: 10 }, 1)).toBe(true);
    expect(hitElement({ ...rounded, roundness: null }, { x: 0, y: 0 }, 1)).toBe(true);
  });

  it("hits ellipses and diamonds on their outline", () => {
    const ellipse = shape("ellipse", { x: 0, y: 0, width: 100, height: 60 });
    expect(hitElement(ellipse, { x: 50, y: 2 }, 1)).toBe(true);
    expect(hitElement(ellipse, { x: 50, y: 30 }, 1)).toBe(false);
    expect(hitElement(ellipse, { x: 3, y: 3 }, 1)).toBe(false);
    const diamond = shape("diamond", { x: 0, y: 0, width: 100, height: 100 });
    expect(hitElement(diamond, { x: 25, y: 25 }, 1)).toBe(true);
    expect(hitElement(diamond, { x: 50, y: 50 }, 1)).toBe(false);
    expect(hitElement(diamond, { x: 2, y: 2 }, 1)).toBe(false);
  });

  it("hits rotated shapes in their own frame", () => {
    const thin = rect(0, 45, 100, 10, { angle: Math.PI / 2, backgroundColor: "#000000" });
    expect(hitElement(thin, { x: 50, y: 5 }, 1)).toBe(true);
    expect(hitElement(thin, { x: 5, y: 50 }, 1)).toBe(false);
  });

  it("hits lines near their segments", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(hitElement(line, { x: 50, y: 55 }, 1)).toBe(true);
    expect(hitElement(line, { x: 50, y: 70 }, 1)).toBe(false);
    const pen = freedraw({ x: 0, y: 0 }, [[0, 0], [50, 0], [100, 0]]);
    expect(hitElement(pen, { x: 75, y: 12 }, 1)).toBe(true);
    expect(hitElement(pen, { x: 75, y: 30 }, 1)).toBe(false);
  });

  it("hits inside closed filled lines", () => {
    const loop = linear("line", { x: 0, y: 0 }, [[0, 0], [100, 0], [100, 100], [0, 100], [0, 2]], { backgroundColor: "#ffc9c9" });
    expect(hitElement(loop, { x: 50, y: 50 }, 1)).toBe(true);
    expect(hitElement({ ...loop, backgroundColor: "transparent" }, { x: 50, y: 50 }, 1)).toBe(false);
  });

  it("ignores deleted elements", () => {
    expect(hitElement({ ...filled, isDeleted: true }, { x: 50, y: 50 }, 1)).toBe(false);
  });

  it("returns the topmost element and resolves labels to containers", () => {
    const bottom = rect(0, 0, 100, 100, { backgroundColor: "#ffffff" });
    const top = rect(50, 50, 100, 100, { backgroundColor: "#ffffff" });
    expect(topmostHit([bottom, top], { x: 75, y: 75 }, 1)?.id).toBe(top.id);
    expect(topmostHit([bottom, top], { x: 25, y: 25 }, 1)?.id).toBe(bottom.id);
    expect(topmostHit([bottom, top], { x: 500, y: 500 }, 1)).toBeNull();
    const label = text({ x: 30, y: 40 }, "hi", { containerId: open.id });
    expect(pickTarget([open, label], { x: 35, y: 50 }, 1)).toBe(open.id);
    expect(pickTarget([label], { x: 35, y: 50 }, 1)).toBe(label.id);
  });

  it("finds the shape around a point for editing, even when it has no fill", () => {
    const open = rect(0, 0, 100, 60);
    const ring = shape("ellipse", { x: 200, y: 0, width: 100, height: 60 });
    const label = text({ x: 30, y: 20 }, "hi", { containerId: open.id });
    expect(pickTarget([open, ring], { x: 50, y: 30 }, 1)).toBeNull();
    expect(editTargetAt([open, ring], { x: 50, y: 30 }, 1)).toBe(open.id);
    expect(editTargetAt([open, ring], { x: 250, y: 30 }, 1)).toBe(ring.id);
    expect(editTargetAt([open, ring], { x: 200, y: 0 }, 1)).toBeNull();
    expect(editTargetAt([open, label], { x: 35, y: 25 }, 1)).toBe(open.id);
    expect(editTargetAt([open], { x: 500, y: 500 }, 1)).toBeNull();
  });
});

describe("marquee and eraser", () => {
  it("selects only elements fully inside, without labels", () => {
    const inside = rect(10, 10, 20, 20);
    const partly = rect(90, 90, 20, 20);
    const label = text({ x: 12, y: 12 }, "a", { containerId: inside.id });
    const free = text({ x: 40, y: 40 }, "b");
    const marquee = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(elementsInMarquee([inside, partly, label, free], marquee)).toEqual([inside.id, free.id]);
    expect(boundsContain(marquee, elementBounds(partly))).toBe(false);
  });

  it("finds elements crossed by an eraser stroke", () => {
    const open = rect(0, 0, 100, 100);
    const far = rect(500, 0, 100, 100);
    const label = text({ x: 300, y: 300 }, "abc", { containerId: open.id });
    expect(elementsAlongPath([open, far, label], { x: -20, y: 50 }, { x: 20, y: 50 }, 1)).toEqual([open.id]);
    expect(elementsAlongPath([open, far], { x: 30, y: 50 }, { x: 70, y: 50 }, 1)).toEqual([]);
    expect(elementsAlongPath([open, label], { x: 305, y: 310 }, { x: 306, y: 310 }, 1)).toEqual([open.id]);
  });
});

describe("viewport", () => {
  const view: Viewport = { scrollX: 100, scrollY: -50, zoom: 2 };

  it("uses Excalidraw's scroll convention", () => {
    expect(screenToScene(view, { x: 400, y: 300 })).toEqual({ x: 100, y: 200 });
    expect(sceneToScreen(view, { x: 100, y: 200 })).toEqual({ x: 400, y: 300 });
  });

  it("zooms around a screen point", () => {
    const anchor = { x: 320, y: 240 };
    const before = screenToScene(view, anchor);
    const next = zoomAt(view, 4, anchor);
    expect(next.zoom).toBe(4);
    const after = screenToScene(next, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom to 0.1 through 30", () => {
    expect(zoomAt(view, 100, { x: 0, y: 0 }).zoom).toBe(30);
    expect(zoomAt(view, 0.001, { x: 0, y: 0 }).zoom).toBe(0.1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(wheelZoom(1, -1000)).toBeGreaterThan(1);
    expect(wheelZoom(1, 1000)).toBeLessThan(1);
    expect(wheelZoom(30, -1000)).toBe(30);
  });

  it("steps zoom through friendly levels", () => {
    expect(nextZoomStep(1, 1)).toBe(1.1);
    expect(nextZoomStep(1, -1)).toBe(0.9);
    expect(nextZoomStep(1.05, -1)).toBe(1);
    expect(nextZoomStep(30, 1)).toBe(30);
    expect(nextZoomStep(0.1, -1)).toBe(0.1);
  });

  it("pans in screen pixels", () => {
    expect(panBy(view, 20, -10)).toEqual({ scrollX: 110, scrollY: -55, zoom: 2 });
  });

  it("fits bounds in the viewport", () => {
    const fitted = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, { width: 548, height: 400 }, { padding: 24 });
    expect(fitted.zoom).toBeCloseTo(0.5);
    const center = sceneToScreen(fitted, { x: 500, y: 250 });
    expect(center.x).toBeCloseTo(274);
    expect(center.y).toBeCloseTo(200);
    expect(fitBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { width: 800, height: 600 }).zoom).toBe(1);
    expect(fitBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { width: 800, height: 600 }, { maxZoom: 30 }).zoom).toBeGreaterThan(1);
    const visible = visibleSceneBounds(fitted, { width: 548, height: 400 });
    expect(visible.minX).toBeCloseTo(-48);
    expect(visible.maxX).toBeCloseTo(1048);
  });
});

describe("snapping", () => {
  it("snaps values and points to the grid", () => {
    expect(snapToGrid(29, 20)).toBe(20);
    expect(snapToGrid(31, 20)).toBe(40);
    expect(snapPoint({ x: 9, y: 11 }, 20)).toEqual({ x: 0, y: 20 });
    expect(snapPoint({ x: 9, y: 11 }, null)).toEqual({ x: 9, y: 11 });
  });

  it("snaps angles to 15 degrees keeping the length", () => {
    const snapped = snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(snapped.x).toBeCloseTo(100.32, 1);
    expect(snapped.y).toBeCloseTo(0);
    const diagonal = snapAngle({ x: 0, y: 0 }, { x: 100, y: 95 });
    expect(diagonal.x).toBeCloseTo(diagonal.y);
  });
});
