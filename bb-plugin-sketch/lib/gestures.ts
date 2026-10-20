import { applyOverlay, bindEnd, bindingOf, canBind, findBindTarget, syncBindings, type LinearEnd } from "./binding.js";
import { absolutePoints, commonBounds, frameCenter, selectionFrame, type Frame } from "./bounds.js";
import { translateElement, updateElement, withAbsolutePoints } from "./elements.js";
import { fitLabel } from "./labels.js";
import { boundsOfPoints, rotatePoint, snapAngle, snapPoint, snapToGrid, type Box, type Point } from "./math.js";
import {
  handleEdgePoint,
  handlesFor,
  mustKeepAspect,
  resizeElements,
  scaleFactors,
  uniformScale,
  type HandleId,
} from "./resize.js";
import { isLinear, isShape, type FreedrawElement, type SketchElement } from "./scene.js";
import { labelIndex, normalizeSelection, selectedElements, withLabels } from "./selection.js";
import type { MeasureText } from "./text.js";

export const DRAG_THRESHOLD = 3;
export const MIN_CREATE_SIZE = 3;

export type MoveGesture = {
  readonly elements: readonly SketchElement[];
  readonly movedIds: ReadonlySet<string>;
};

export function beginMove(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): MoveGesture {
  return { elements, movedIds: withLabels(elements, normalizeSelection(elements, selectedIds)) };
}

export function moveElementsBy(elements: readonly SketchElement[], ids: ReadonlySet<string>, delta: Point): readonly SketchElement[] {
  if ((delta.x === 0 && delta.y === 0) || ids.size === 0) return elements;
  const moved = elements.map((element) => (ids.has(element.id) ? translateElement(element, delta.x, delta.y) : element));
  return syncBindings(moved, ids, "move");
}

export function moveTo(gesture: MoveGesture, delta: Point): readonly SketchElement[] {
  return moveElementsBy(gesture.elements, gesture.movedIds, delta);
}

export function lockAxis(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}

export function snapMoveDelta(
  elements: readonly SketchElement[],
  ids: ReadonlySet<string>,
  delta: Point,
  gridSize: number | null,
): Point {
  if (gridSize === null || !(gridSize > 0)) return delta;
  const bounds = commonBounds(selectedElements(elements, ids));
  if (bounds === null) return delta;
  return {
    x: snapToGrid(bounds.minX + delta.x, gridSize) - bounds.minX,
    y: snapToGrid(bounds.minY + delta.y, gridSize) - bounds.minY,
  };
}

export function pastDragThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > DRAG_THRESHOLD;
}

export type ResizeGesture = {
  readonly elements: readonly SketchElement[];
  readonly targetIds: ReadonlySet<string>;
  readonly handle: HandleId;
  readonly frame: Frame;
  readonly grab: Point;
  readonly keepAspect: boolean;
};

export type ResizeModifiers = { readonly shift: boolean; readonly alt: boolean };

export function beginResize(
  elements: readonly SketchElement[],
  selectedIds: ReadonlySet<string>,
  handle: HandleId,
  pointer: Point,
): ResizeGesture | null {
  const targetIds = normalizeSelection(elements, selectedIds);
  const targets = selectedElements(elements, targetIds);
  const frame = selectionFrame(targets);
  if (frame === null || !handlesFor(targets).includes(handle)) return null;
  const center = frameCenter(frame);
  const local = rotatePoint(pointer, center, -frame.angle);
  const edge = rotatePoint(handleEdgePoint(frame, handle), center, -frame.angle);
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");
  const grab = { x: horizontal ? local.x - edge.x : 0, y: vertical ? local.y - edge.y : 0 };
  return { elements, targetIds, handle, frame, grab, keepAspect: mustKeepAspect(targets) };
}

function fittedLabels(
  gesture: ResizeGesture,
  resized: readonly SketchElement[],
  fontScale: number | null,
  measure: MeasureText,
): Map<string, SketchElement> {
  const changes = new Map<string, SketchElement>(resized.map((element) => [element.id, element]));
  const labels = labelIndex(gesture.elements);
  for (const container of resized) {
    if (!isShape(container)) continue;
    const label = labels.get(container.id);
    if (label === undefined) continue;
    const scaled =
      fontScale === null || fontScale === 1 ? label : updateElement(label, { fontSize: Math.max(1, label.fontSize * fontScale) });
    const fitted = fitLabel(container, scaled, measure);
    changes.set(fitted.container.id, fitted.container);
    changes.set(fitted.label.id, fitted.label);
  }
  return changes;
}

export function resizeTo(
  gesture: ResizeGesture,
  pointer: Point,
  modifiers: ResizeModifiers,
  measure: MeasureText,
): readonly SketchElement[] {
  const { frame, handle, grab } = gesture;
  const center = frameCenter(frame);
  const local = rotatePoint(pointer, center, -frame.angle);
  const target = rotatePoint({ x: local.x - grab.x, y: local.y - grab.y }, center, frame.angle);
  const options = { keepAspect: gesture.keepAspect || modifiers.shift, fromCenter: modifiers.alt };
  const targets = selectedElements(gesture.elements, gesture.targetIds);
  const resized = resizeElements(targets, frame, handle, target, options);
  const { sx, sy } = scaleFactors(frame, handle, target, options);
  const fontScale = targets.length > 1 ? uniformScale(sx, sy) : null;
  const next = applyOverlay(gesture.elements, fittedLabels(gesture, resized, fontScale, measure));
  return syncBindings(next, withLabels(next, gesture.targetIds), "resize");
}

export type EndpointOptions = {
  readonly zoom: number;
  readonly shift: boolean;
  readonly bind: boolean;
  readonly gridSize?: number | null;
};

export type EndpointResult = { readonly elements: readonly SketchElement[]; readonly bindTargetId: string | null };

function otherEnd(end: LinearEnd): LinearEnd {
  return end === "start" ? "end" : "start";
}

export function dragEndpoint(
  elements: readonly SketchElement[],
  linearId: string,
  end: LinearEnd,
  pointer: Point,
  options: EndpointOptions,
): EndpointResult {
  const element = elements.find((candidate) => candidate.id === linearId);
  if (element === undefined || !isLinear(element)) return { elements, bindTargetId: null };
  const abs = absolutePoints(element);
  const index = end === "start" ? 0 : abs.length - 1;
  const neighbor = abs[end === "start" ? 1 : abs.length - 2];
  const snapped = snapPoint(pointer, options.gridSize ?? null);
  const point = options.shift && neighbor !== undefined ? snapAngle(neighbor, snapped) : snapped;
  abs[index] = point;
  const moved = withAbsolutePoints(element, abs);
  const next = elements.map((candidate) => (candidate.id === linearId ? moved : candidate));
  if (!canBind(moved)) return { elements: next, bindTargetId: null };
  const other = bindingOf(moved, otherEnd(end))?.elementId;
  const exclude = new Set([moved.id, ...(other === undefined ? [] : [other])]);
  const target = options.bind ? findBindTarget(next, point, options.zoom, exclude) : null;
  return { elements: bindEnd(next, moved.id, end, target?.id ?? null), bindTargetId: target?.id ?? null };
}

export function linearEndHandles(element: SketchElement): { start: Point; end: Point } | null {
  if (!isLinear(element)) return null;
  const abs = absolutePoints(element);
  const start = abs[0];
  const end = abs[abs.length - 1];
  return start === undefined || end === undefined ? null : { start, end };
}

export function linearEndAt(element: SketchElement, p: Point, zoom: number, hitSize = 14): LinearEnd | null {
  const handles = linearEndHandles(element);
  if (handles === null) return null;
  const reach = hitSize / 2 / zoom;
  if (Math.hypot(p.x - handles.end.x, p.y - handles.end.y) <= reach) return "end";
  if (Math.hypot(p.x - handles.start.x, p.y - handles.start.y) <= reach) return "start";
  return null;
}

export function boxFromDrag(origin: Point, pointer: Point, modifiers: ResizeModifiers): Box {
  let dx = pointer.x - origin.x;
  let dy = pointer.y - origin.y;
  if (modifiers.shift) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (Math.sign(dx) || 1) * size;
    dy = (Math.sign(dy) || 1) * size;
  }
  if (modifiers.alt) {
    return { x: origin.x - Math.abs(dx), y: origin.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return { x: Math.min(origin.x, origin.x + dx), y: Math.min(origin.y, origin.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

export function linearEndFromDrag(origin: Point, pointer: Point, shift: boolean): Point {
  return shift ? snapAngle(origin, pointer) : pointer;
}

export function appendFreedrawPoint(element: FreedrawElement, point: Point, pressure: number | null): FreedrawElement {
  const x = point.x - element.x;
  const y = point.y - element.y;
  const last = element.points[element.points.length - 1];
  if (last !== undefined && last[0] === x && last[1] === y) return element;
  const points: [number, number][] = [...element.points, [x, y]];
  const pressures = element.simulatePressure ? element.pressures : [...element.pressures, pressure ?? 0.5];
  const bounds = boundsOfPoints(points.map(([px, py]) => ({ x: px, y: py })));
  return updateElement(element, { points, pressures, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY });
}

export function isTooSmall(element: SketchElement, zoom: number): boolean {
  const min = MIN_CREATE_SIZE / zoom;
  if (element.type === "freedraw" || element.type === "text" || element.type === "unsupported") return false;
  if (isLinear(element)) return Math.max(element.width, element.height) < min;
  return element.width < min || element.height < min;
}
