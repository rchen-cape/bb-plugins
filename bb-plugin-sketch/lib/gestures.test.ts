import { describe, expect, it } from "vitest";
import { ensureLabel, commitText } from "./labels";
import { createFreedraw } from "./elements";
import {
  appendFreedrawPoint,
  beginMove,
  beginResize,
  boxFromDrag,
  isTooSmall,
  linearEndAt,
  linearEndFromDrag,
  lockAxis,
  moveTo,
  pastDragThreshold,
  resizeTo,
  snapMoveDelta,
} from "./gestures";
import { handlePoint } from "./resize";
import type { SketchElement } from "./scene";
import { arrow, byId, measure, rect, styleWith, text } from "./test-fixtures";

const PLAIN = { shift: false, alt: false };

function labeledBox(): { elements: readonly SketchElement[]; box: string; label: string } {
  const box = rect(0, 0, 100, 60);
  const created = ensureLabel([box], box.id, styleWith(), measure);
  if (created === null) throw new Error("no label");
  return { elements: commitText(created.elements, created.labelId, "label", measure).elements, box: box.id, label: created.labelId };
}

describe("move", () => {
  it("moves the selection with labels and keeps other elements untouched", () => {
    const { elements, box, label } = labeledBox();
    const other = rect(500, 500, 10, 10);
    const scene = [...elements, other];
    const gesture = beginMove(scene, new Set([box]));
    const moved = moveTo(gesture, { x: 15, y: -5 });
    expect(byId(moved, box)).toMatchObject({ x: 15, y: -5 });
    expect(byId(moved, label).x).toBeCloseTo(byId(scene, label).x + 15);
    expect(moved[2]).toBe(other);
    expect(moveTo(gesture, { x: 30, y: 0 })[0]?.x).toBe(30);
    expect(moveTo(gesture, { x: 0, y: 0 })).toBe(scene);
  });

  it("moves groups as a whole", () => {
    const a = rect(0, 0, 10, 10, { groupIds: ["g"] });
    const b = rect(20, 0, 10, 10, { groupIds: ["g"] });
    const moved = moveTo(beginMove([a, b], new Set([a.id])), { x: 5, y: 0 });
    expect(moved.map((element) => element.x)).toEqual([5, 25]);
  });

  it("locks to the dominant axis and snaps the selection corner to the grid", () => {
    expect(lockAxis({ x: 10, y: 3 })).toEqual({ x: 10, y: 0 });
    expect(lockAxis({ x: -2, y: -9 })).toEqual({ x: 0, y: -9 });
    const box = rect(3, 7, 10, 10, { roughness: 0 });
    expect(snapMoveDelta([box], new Set([box.id]), { x: 12, y: 0 }, 20)).toEqual({ x: 17, y: -7 });
    expect(snapMoveDelta([box], new Set([box.id]), { x: 12, y: 0 }, null)).toEqual({ x: 12, y: 0 });
  });

  it("starts a drag after 3 px", () => {
    expect(pastDragThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(pastDragThreshold({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(true);
  });
});

describe("resize gesture", () => {
  it("does not jump when grabbing a handle away from the edge", () => {
    const box = rect(0, 0, 100, 100);
    const handle = handlePoint({ x: 0, y: 0, width: 100, height: 100, angle: 0 }, "se", 1);
    const gesture = beginResize([box], new Set([box.id]), "se", handle);
    if (gesture === null) throw new Error("no gesture");
    expect(resizeTo(gesture, handle, PLAIN, measure)[0]).toMatchObject({ width: 100, height: 100 });
    expect(resizeTo(gesture, { x: handle.x + 50, y: handle.y + 20 }, PLAIN, measure)[0]).toMatchObject({ width: 150, height: 120 });
    expect(resizeTo(gesture, { x: handle.x + 50, y: handle.y + 20 }, { shift: true, alt: false }, measure)[0]).toMatchObject({
      width: 150,
      height: 150,
    });
  });

  it("refuses handles the selection doesn't have", () => {
    const label = text({ x: 0, y: 0 }, "hi");
    expect(beginResize([label], new Set([label.id]), "e", { x: 0, y: 0 })).toBeNull();
    const line = arrow({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(beginResize([line], new Set([line.id]), "se", { x: 10, y: 10 })).toBeNull();
    expect(beginResize([line], new Set(), "se", { x: 10, y: 10 })).toBeNull();
  });

  it("rewraps a container's label and keeps it centered", () => {
    const { elements, box, label } = labeledBox();
    const gesture = beginResize(elements, new Set([box]), "e", { x: 100, y: 30 });
    if (gesture === null) throw new Error("no gesture");
    const resized = resizeTo(gesture, { x: 200, y: 30 }, PLAIN, measure);
    const updated = byId(resized, label);
    expect(byId(resized, box).width).toBe(200);
    expect(updated.x + updated.width / 2).toBeCloseTo(100);
    expect(updated.type === "text" && updated.fontSize).toBe(20);
    const narrow = resizeTo(gesture, { x: 40, y: 30 }, PLAIN, measure);
    expect(byId(narrow, label).type === "text" && byId(narrow, label).height).toBeGreaterThan(25);
  });

  it("grows a container instead of clipping its label", () => {
    const { elements, box } = labeledBox();
    const gesture = beginResize(elements, new Set([box]), "s", { x: 50, y: 60 });
    if (gesture === null) throw new Error("no gesture");
    const squashed = resizeTo(gesture, { x: 50, y: 5 }, PLAIN, measure);
    expect(byId(squashed, box).height).toBe(35);
  });

  it("scales label fonts when many elements scale uniformly", () => {
    const { elements, box, label } = labeledBox();
    const other = rect(100, 60, 100, 60);
    const scene = [...elements, other];
    const gesture = beginResize(scene, new Set([box, other.id]), "se", { x: 200, y: 120 });
    if (gesture === null) throw new Error("no gesture");
    const resized = resizeTo(gesture, { x: 400, y: 240 }, { shift: true, alt: false }, measure);
    const updated = byId(resized, label);
    expect(updated.type === "text" && updated.fontSize).toBe(40);
    expect(byId(resized, other.id)).toMatchObject({ x: 200, y: 120, width: 200, height: 120 });
  });
});

describe("creation helpers", () => {
  it("builds boxes from drags", () => {
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 30 }, PLAIN)).toEqual({ x: 0, y: 10, width: 10, height: 20 });
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 30 }, { shift: true, alt: false })).toEqual({ x: -10, y: 10, width: 20, height: 20 });
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 30, y: 15 }, { shift: false, alt: true })).toEqual({ x: -10, y: 5, width: 40, height: 10 });
  });

  it("snaps new arrows to 15 degree steps", () => {
    const end = linearEndFromDrag({ x: 0, y: 0 }, { x: 100, y: 5 }, true);
    expect(end.y).toBeCloseTo(0);
    expect(linearEndFromDrag({ x: 0, y: 0 }, { x: 100, y: 5 }, false)).toEqual({ x: 100, y: 5 });
  });

  it("appends pen points relative to the stroke origin", () => {
    const pen = createFreedraw({ x: 100, y: 100 }, styleWith(), 0.4);
    const next = appendFreedrawPoint(appendFreedrawPoint(pen, { x: 110, y: 90 }, 0.6), { x: 90, y: 120 }, null);
    expect(next.points).toEqual([[0, 0], [10, -10], [-10, 20]]);
    expect(next.pressures).toEqual([0.4, 0.6, 0.5]);
    expect(next).toMatchObject({ width: 20, height: 30, x: 100, y: 100 });
    expect(appendFreedrawPoint(next, { x: 90, y: 120 }, null)).toBe(next);
    const simulated = appendFreedrawPoint(createFreedraw({ x: 0, y: 0 }, styleWith(), null), { x: 5, y: 5 }, 0.9);
    expect(simulated.pressures).toEqual([]);
  });

  it("drops shapes smaller than 3 screen px", () => {
    expect(isTooSmall(rect(0, 0, 2, 50), 1)).toBe(true);
    expect(isTooSmall(rect(0, 0, 2, 50), 2)).toBe(false);
    expect(isTooSmall(rect(0, 0, 10, 10), 1)).toBe(false);
    expect(isTooSmall(arrow({ x: 0, y: 0 }, { x: 2, y: 1 }), 1)).toBe(true);
    expect(isTooSmall(arrow({ x: 0, y: 0 }, { x: 0, y: 40 }), 1)).toBe(false);
    expect(isTooSmall(createFreedraw({ x: 0, y: 0 }, styleWith(), null), 1)).toBe(false);
  });

  it("finds arrow endpoint handles", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(linearEndAt(line, { x: 98, y: 3 }, 1)).toBe("end");
    expect(linearEndAt(line, { x: 2, y: -3 }, 1)).toBe("start");
    expect(linearEndAt(line, { x: 50, y: 0 }, 1)).toBeNull();
    expect(linearEndAt(rect(0, 0, 1, 1), { x: 0, y: 0 }, 1)).toBeNull();
  });
});
