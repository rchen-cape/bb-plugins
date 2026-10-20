import { describe, expect, it } from "vitest";
import { deleteSelection, duplicateSelection } from "./actions";
import {
  BINDING_GAP,
  bindEnd,
  canBind,
  findBindTarget,
  isBindTarget,
  outlinePoint,
  pruneDanglingReferences,
  recomputeLinear,
  syncBindings,
  updateBoundArrows,
} from "./binding";
import { absolutePoints } from "./bounds";
import { translateElement } from "./elements";
import { beginMove, beginResize, dragEndpoint, moveTo, resizeTo } from "./gestures";
import type { LinearElement, SketchElement } from "./scene";
import { arrow, byId, measure, rect, shape, text } from "./test-fixtures";

function linearOf(elements: readonly SketchElement[], id: string): LinearElement {
  const element = byId(elements, id);
  if (element.type !== "arrow" && element.type !== "line") throw new Error("not linear");
  return element;
}

function endOf(elements: readonly SketchElement[], id: string): { x: number; y: number } {
  const points = absolutePoints(linearOf(elements, id));
  const last = points[points.length - 1];
  if (last === undefined) throw new Error("no points");
  return last;
}

function startOf(elements: readonly SketchElement[], id: string): { x: number; y: number } {
  const first = absolutePoints(linearOf(elements, id))[0];
  if (first === undefined) throw new Error("no points");
  return first;
}

function boundIds(elements: readonly SketchElement[], id: string): string[] {
  const element = byId(elements, id);
  return element.type === "unsupported" ? [] : (element.boundElements ?? []).map((entry) => entry.id);
}

function bound(): { elements: readonly SketchElement[]; source: string; target: string; link: string } {
  const source = rect(0, 0, 100, 100);
  const target = rect(300, 0, 100, 100);
  const link = arrow({ x: 110, y: 50 }, { x: 290, y: 50 });
  let elements: readonly SketchElement[] = [source, target, link];
  elements = bindEnd(elements, link.id, "start", source.id);
  elements = bindEnd(elements, link.id, "end", target.id);
  return { elements, source: source.id, target: target.id, link: link.id };
}

describe("targets", () => {
  it("binds to shapes and free text only", () => {
    expect(isBindTarget(rect(0, 0, 10, 10))).toBe(true);
    expect(isBindTarget(shape("ellipse", { x: 0, y: 0, width: 10, height: 10 }))).toBe(true);
    expect(isBindTarget(text({ x: 0, y: 0 }, "x"))).toBe(true);
    expect(isBindTarget(text({ x: 0, y: 0 }, "x", { containerId: "box" }))).toBe(false);
    expect(isBindTarget(arrow({ x: 0, y: 0 }, { x: 1, y: 1 }))).toBe(false);
    expect(canBind(arrow({ x: 0, y: 0 }, { x: 1, y: 1 }))).toBe(true);
    expect(canBind(arrow({ x: 0, y: 0 }, { x: 1, y: 1 }, { elbowed: true }))).toBe(false);
  });

  it("finds a target inside or within 16 px divided by zoom", () => {
    const box = rect(0, 0, 100, 100);
    expect(findBindTarget([box], { x: 50, y: 50 }, 1)?.id).toBe(box.id);
    expect(findBindTarget([box], { x: 115, y: 50 }, 1)?.id).toBe(box.id);
    expect(findBindTarget([box], { x: 118, y: 50 }, 1)).toBeNull();
    expect(findBindTarget([box], { x: 107, y: 50 }, 2)?.id).toBe(box.id);
    expect(findBindTarget([box], { x: 110, y: 50 }, 2)).toBeNull();
    expect(findBindTarget([box], { x: 50, y: 50 }, 1, new Set([box.id]))).toBeNull();
  });

  it("prefers the smaller of nested shapes", () => {
    const small = rect(40, 40, 20, 20);
    const big = rect(0, 0, 200, 200);
    expect(findBindTarget([small, big], { x: 50, y: 50 }, 1)?.id).toBe(small.id);
  });
});

describe("outline points", () => {
  it("lands on the outline toward the reference plus the gap", () => {
    const box = rect(0, 0, 100, 100);
    expect(outlinePoint(box, { x: -100, y: 50 })).toEqual({ x: -BINDING_GAP, y: 50 });
    const ellipse = shape("ellipse", { x: 0, y: 0, width: 200, height: 100 });
    const top = outlinePoint(ellipse, { x: 100, y: -500 }, 0);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(0);
    const diamond = shape("diamond", { x: 0, y: 0, width: 100, height: 100 });
    const corner = outlinePoint(diamond, { x: 500, y: 500 }, 0);
    expect(corner.x).toBeCloseTo(75);
    expect(corner.y).toBeCloseTo(75);
  });

  it("follows rounded corners and rotation", () => {
    const rounded = rect(0, 0, 200, 200, { roundness: { type: 3 } });
    const corner = outlinePoint(rounded, { x: -1000, y: -1000 }, 0);
    const expected = 32 - 32 / Math.SQRT2;
    expect(corner.x).toBeCloseTo(expected);
    expect(corner.y).toBeCloseTo(expected);
    const tall = rect(0, 25, 100, 50, { angle: Math.PI / 2 });
    const above = outlinePoint(tall, { x: 50, y: -500 }, 0);
    expect(above.x).toBeCloseTo(50);
    expect(above.y).toBeCloseTo(0);
  });
});

describe("bindEnd", () => {
  it("records the binding with Excalidraw field names and keeps boundElements in sync", () => {
    const { elements, source, target, link } = bound();
    const line = linearOf(elements, link);
    expect(line.startBinding).toEqual({ elementId: source, focus: 0, gap: 4 });
    expect(line.endBinding).toEqual({ elementId: target, focus: 0, gap: 4 });
    expect(byId(elements, target)).toMatchObject({ boundElements: [{ id: link, type: "arrow" }] });
    expect(boundIds(elements, source)).toEqual([link]);
  });

  it("aims at the centers and sits outside the outlines", () => {
    const { elements, link } = bound();
    expect(startOf(elements, link)).toEqual({ x: 104, y: 50 });
    expect(endOf(elements, link)).toEqual({ x: 296, y: 50 });
  });

  it("moves the binding to a new target and cleans the old one", () => {
    const { elements, target, link } = bound();
    const other = rect(300, 300, 100, 100);
    const next = bindEnd([...elements, other], link, "end", other.id);
    expect(linearOf(next, link).endBinding?.elementId).toBe(other.id);
    expect(boundIds(next, target)).toEqual([]);
    expect(boundIds(next, other.id)).toEqual([link]);
    const unbound = bindEnd(next, link, "end", null);
    expect(linearOf(unbound, link).endBinding).toBeNull();
    expect(boundIds(unbound, other.id)).toEqual([]);
  });

  it("ignores ids that are not bind targets", () => {
    const { elements, link } = bound();
    const label = text({ x: 0, y: 0 }, "x", { containerId: "box" });
    const next = bindEnd([...elements, label], link, "end", label.id);
    expect(linearOf(next, link).endBinding).toBeNull();
  });
});

describe("updates after edits", () => {
  it("follows a moved target", () => {
    const { elements, target, link } = bound();
    const moved = moveTo(beginMove(elements, new Set([target])), { x: 0, y: 200 });
    const end = endOf(moved, link);
    const start = startOf(moved, link);
    const center = { x: 350, y: 250 };
    const cross = (end.x - start.x) * (center.y - start.y) - (end.y - start.y) * (center.x - start.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(end.x).toBeLessThan(300);
    expect(linearOf(moved, link).endBinding?.elementId).toBe(target);
  });

  it("unbinds an arrow moved without its targets", () => {
    const { elements, source, target, link } = bound();
    const moved = moveTo(beginMove(elements, new Set([link])), { x: 0, y: 300 });
    const line = linearOf(moved, link);
    expect(line.startBinding).toBeNull();
    expect(line.endBinding).toBeNull();
    expect(boundIds(moved, source)).toEqual([]);
    expect(boundIds(moved, target)).toEqual([]);
    expect(startOf(moved, link)).toEqual({ x: 104, y: 350 });
  });

  it("keeps bindings when the arrow moves with its targets", () => {
    const { elements, source, target, link } = bound();
    const moved = moveTo(beginMove(elements, new Set([source, target, link])), { x: 10, y: 10 });
    expect(linearOf(moved, link).startBinding?.elementId).toBe(source);
    expect(startOf(moved, link)).toEqual({ x: 114, y: 60 });
    const pointsBefore = linearOf(elements, link).points;
    expect(linearOf(moved, link).points).toBe(pointsBefore);
  });

  it("keeps one end when moved with one target", () => {
    const { elements, source, target, link } = bound();
    const moved = moveTo(beginMove(elements, new Set([source, link])), { x: 0, y: 10 });
    expect(linearOf(moved, link).startBinding?.elementId).toBe(source);
    expect(linearOf(moved, link).endBinding).toBeNull();
    expect(boundIds(moved, target)).toEqual([]);
  });

  it("follows a resized target", () => {
    const { elements, target, link } = bound();
    const gesture = beginResize(elements, new Set([target]), "w", { x: 300, y: 50 });
    if (gesture === null) throw new Error("no gesture");
    const resized = resizeTo(gesture, { x: 200, y: 50 }, { shift: false, alt: false }, measure);
    expect(byId(resized, target).x).toBe(200);
    expect(endOf(resized, link).x).toBeCloseTo(196);
  });

  it("recomputes arrows after another change", () => {
    const { elements, target, link } = bound();
    const shifted = elements.map((element) => (element.id === target ? translateElement(element, 100, 0) : element));
    const updated = updateBoundArrows(shifted, new Set([target]));
    expect(endOf(updated, link).x).toBeCloseTo(396);
    const synced = syncBindings(shifted, new Set([target]), "move");
    expect(endOf(synced, link).x).toBeCloseTo(396);
    expect(updateBoundArrows(shifted, new Set())).toBe(shifted);
  });

  it("unbinds when a target is deleted and cleans targets when an arrow is deleted", () => {
    const { elements, source, target, link } = bound();
    const withoutTarget = deleteSelection({ elements, selectedIds: new Set([target]) }).elements;
    expect(linearOf(withoutTarget, link).endBinding).toBeNull();
    expect(linearOf(withoutTarget, link).startBinding?.elementId).toBe(source);
    const withoutArrow = deleteSelection({ elements, selectedIds: new Set([link]) }).elements;
    expect(boundIds(withoutArrow, source)).toEqual([]);
    expect(boundIds(withoutArrow, target)).toEqual([]);
  });

  it("remaps bindings inside a duplicated set and drops the rest", () => {
    const { elements, source, target, link } = bound();
    const all = duplicateSelection({ elements, selectedIds: new Set([source, target, link]) });
    const copies = all.elements.slice(3);
    const copyLink = copies.find((element) => element.type === "arrow");
    const copySource = copies.find((element) => element.type === "rectangle" && element.x === 10);
    if (copyLink === undefined || copySource === undefined || copyLink.type !== "arrow") throw new Error("missing copies");
    expect(copyLink.startBinding?.elementId).toBe(copySource.id);
    expect(boundIds(all.elements, copySource.id)).toEqual([copyLink.id]);
    const only = duplicateSelection({ elements, selectedIds: new Set([link]) });
    const lone = only.elements[3];
    expect(lone?.type === "arrow" && lone.startBinding).toBeNull();
    expect(lone?.type === "arrow" && lone.endBinding).toBeNull();
    expect(boundIds(only.elements, source)).toEqual([link]);
  });

  it("prunes references to missing elements", () => {
    const { elements, source, link } = bound();
    const orphaned = elements.filter((element) => element.id !== source);
    const pruned = pruneDanglingReferences(orphaned);
    expect(linearOf(pruned, link).startBinding).toBeNull();
    expect(pruneDanglingReferences(pruned)).toBe(pruned);
  });

  it("leaves bindings to elements it can't draw alone", () => {
    const link = arrow({ x: 0, y: 0 }, { x: 10, y: 0 }, { endBinding: { elementId: "image", focus: 0.5, gap: 1 } });
    expect(recomputeLinear(link, () => undefined)).toBe(link);
  });
});

describe("dragEndpoint", () => {
  it("binds when the endpoint enters a shape and snaps to its outline", () => {
    const target = rect(300, 0, 100, 100);
    const link = arrow({ x: 0, y: 50 }, { x: 0, y: 50 });
    const result = dragEndpoint([target, link], link.id, "end", { x: 320, y: 60 }, { zoom: 1, shift: false, bind: true });
    expect(result.bindTargetId).toBe(target.id);
    expect(linearOf(result.elements, link.id).endBinding?.elementId).toBe(target.id);
    const end = endOf(result.elements, link.id);
    expect(end.x).toBeLessThan(300);
    expect(end.x).toBeGreaterThan(294);
  });

  it("unbinds when dragged away or binding is off", () => {
    const { elements, target, link } = bound();
    const away = dragEndpoint(elements, link, "end", { x: 600, y: 600 }, { zoom: 1, shift: false, bind: true });
    expect(away.bindTargetId).toBeNull();
    expect(linearOf(away.elements, link).endBinding).toBeNull();
    expect(boundIds(away.elements, target)).toEqual([]);
    expect(endOf(away.elements, link)).toEqual({ x: 600, y: 600 });
    const off = dragEndpoint(elements, link, "end", { x: 350, y: 50 }, { zoom: 1, shift: false, bind: false });
    expect(linearOf(off.elements, link).endBinding).toBeNull();
  });

  it("re-aims the bound start while the end moves", () => {
    const source = rect(0, 0, 100, 100);
    const link = arrow({ x: 50, y: 50 }, { x: 50, y: 50 });
    let elements: readonly SketchElement[] = [source, link];
    elements = dragEndpoint(elements, link.id, "start", { x: 50, y: 50 }, { zoom: 1, shift: false, bind: true }).elements;
    expect(linearOf(elements, link.id).startBinding?.elementId).toBe(source.id);
    const dragged = dragEndpoint(elements, link.id, "end", { x: 50, y: 300 }, { zoom: 1, shift: false, bind: true });
    expect(startOf(dragged.elements, link.id)).toEqual({ x: 50, y: 104 });
    expect(dragged.bindTargetId).toBeNull();
  });

  it("snaps the angle with Shift", () => {
    const link = arrow({ x: 0, y: 0 }, { x: 10, y: 0 });
    const result = dragEndpoint([link], link.id, "end", { x: 100, y: 7 }, { zoom: 1, shift: true, bind: false });
    expect(endOf(result.elements, link.id).y).toBeCloseTo(0);
  });
});
