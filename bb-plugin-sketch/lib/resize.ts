import { updateElement, withAbsolutePoints } from "./elements.js";
import {
  absolutePoints,
  elementCenter,
  frameCenter,
  hasPoints,
  type Frame,
  type PointsElement,
} from "./bounds.js";
import { normalizeAngle, rotatePoint, type Point } from "./math.js";
import type { SketchElement } from "./scene.js";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLE_IDS: readonly HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNER_HANDLES: readonly HandleId[] = ["nw", "ne", "se", "sw"];
export const HANDLE_SIZE = 8;
export const SELECTION_PADDING = 4;

const SIDE_HANDLE_MIN_SPAN = HANDLE_SIZE * 3;
const HANDLE_DIRECTIONS: Record<HandleId, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
const CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"] as const;

export type ResizeOptions = { readonly keepAspect: boolean; readonly fromCenter: boolean };
export type ResizeEdges = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };

function isListedLabel(element: SketchElement, ids: ReadonlySet<string>): boolean {
  return element.type === "text" && element.containerId !== null && ids.has(element.containerId);
}

export function resizeTargets(elements: readonly SketchElement[]): SketchElement[] {
  const ids = new Set(elements.map((element) => element.id));
  return elements.filter((element) => !element.isDeleted && !isListedLabel(element, ids));
}

export function handlesFor(elements: readonly SketchElement[]): HandleId[] {
  const targets = resizeTargets(elements);
  const only = targets.length === 1 ? targets[0] : undefined;
  if (targets.length === 0) return [];
  if (only?.type === "arrow" || only?.type === "line") return [];
  if (only?.type === "text") return [...CORNER_HANDLES];
  return [...HANDLE_IDS];
}

export function mustKeepAspect(elements: readonly SketchElement[]): boolean {
  const targets = resizeTargets(elements);
  if (targets.length === 1) return targets[0]?.type === "text";
  return targets.some((element) => element.type === "text" || (!hasPoints(element) && element.angle !== 0));
}

export function visibleHandles(frame: Frame, zoom: number, ids: readonly HandleId[]): HandleId[] {
  const narrow = frame.width * zoom < SIDE_HANDLE_MIN_SPAN;
  const short = frame.height * zoom < SIDE_HANDLE_MIN_SPAN;
  return ids.filter((id) => !((narrow && (id === "n" || id === "s")) || (short && (id === "e" || id === "w"))));
}

function handleLocal(frame: Frame, id: HandleId, pad: number): Point {
  const xs = { w: frame.x - pad, c: frame.x + frame.width / 2, e: frame.x + frame.width + pad };
  const ys = { n: frame.y - pad, c: frame.y + frame.height / 2, s: frame.y + frame.height + pad };
  const x = id.includes("w") ? xs.w : id.includes("e") ? xs.e : xs.c;
  const y = id.includes("n") ? ys.n : id.includes("s") ? ys.s : ys.c;
  return { x, y };
}

export function handlePoint(frame: Frame, id: HandleId, zoom: number): Point {
  return rotatePoint(handleLocal(frame, id, SELECTION_PADDING / zoom), frameCenter(frame), frame.angle);
}

export function handlePositions(frame: Frame, zoom: number, ids: readonly HandleId[]): { id: HandleId; point: Point }[] {
  return visibleHandles(frame, zoom, ids).map((id) => ({ id, point: handlePoint(frame, id, zoom) }));
}

export function handleAt(
  frame: Frame,
  ids: readonly HandleId[],
  p: Point,
  zoom: number,
  hitSize: number = HANDLE_SIZE + 6,
): HandleId | null {
  const local = rotatePoint(p, frameCenter(frame), -frame.angle);
  const reach = hitSize / 2 / zoom;
  const visible = visibleHandles(frame, zoom, ids);
  const ordered = [...visible.filter((id) => id.length === 2), ...visible.filter((id) => id.length === 1)];
  for (const id of ordered) {
    const h = handleLocal(frame, id, SELECTION_PADDING / zoom);
    if (Math.abs(local.x - h.x) <= reach && Math.abs(local.y - h.y) <= reach) return id;
  }
  return null;
}

export function handleCursor(id: HandleId, angle: number): string {
  const degrees = HANDLE_DIRECTIONS[id] + (normalizeAngle(angle) * 180) / Math.PI;
  const step = Math.round(degrees / 45) % 4;
  return CURSORS[step] ?? "default";
}

export function handleEdgePoint(frame: Frame, id: HandleId): Point {
  return rotatePoint(handleLocal(frame, id, 0), frameCenter(frame), frame.angle);
}

function aspectEdges(frame: Frame, handle: HandleId, edges: ResizeEdges, options: ResizeOptions): ResizeEdges {
  const { x, y, width: w, height: h } = frame;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");
  const sx = (edges.right - edges.left) / w;
  const sy = (edges.bottom - edges.top) / h;
  const scale = horizontal && vertical ? Math.max(Math.abs(sx), Math.abs(sy)) : horizontal ? Math.abs(sx) : Math.abs(sy);
  const nw = w * scale * (horizontal ? Math.sign(sx) || 1 : 1);
  const nh = h * scale * (vertical ? Math.sign(sy) || 1 : 1);
  const [left, right] =
    options.fromCenter || !horizontal
      ? [cx - nw / 2, cx + nw / 2]
      : handle.includes("w")
        ? [x + w - nw, x + w]
        : [x, x + nw];
  const [top, bottom] =
    options.fromCenter || !vertical
      ? [cy - nh / 2, cy + nh / 2]
      : handle.includes("n")
        ? [y + h - nh, y + h]
        : [y, y + nh];
  return { left, right, top, bottom };
}

export function resizeEdges(frame: Frame, handle: HandleId, localPointer: Point, options: ResizeOptions): ResizeEdges {
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  let left = frame.x;
  let right = frame.x + frame.width;
  let top = frame.y;
  let bottom = frame.y + frame.height;
  if (handle.includes("e")) right = localPointer.x;
  if (handle.includes("w")) left = localPointer.x;
  if (handle.includes("n")) top = localPointer.y;
  if (handle.includes("s")) bottom = localPointer.y;
  if (options.fromCenter) {
    if (handle.includes("e")) left = 2 * cx - right;
    if (handle.includes("w")) right = 2 * cx - left;
    if (handle.includes("n")) bottom = 2 * cy - top;
    if (handle.includes("s")) top = 2 * cy - bottom;
  }
  const edges = { left, right, top, bottom };
  if (!options.keepAspect || frame.width === 0 || frame.height === 0) return edges;
  return aspectEdges(frame, handle, edges, options);
}

type Mapping = {
  readonly frame: Frame;
  readonly edges: ResizeEdges;
  readonly sx: number;
  readonly sy: number;
};

function mapLocal(mapping: Mapping, p: Point): Point {
  return {
    x: mapping.edges.left + (p.x - mapping.frame.x) * mapping.sx,
    y: mapping.edges.top + (p.y - mapping.frame.y) * mapping.sy,
  };
}

function resizePointsElement(element: PointsElement, mapping: Mapping): PointsElement {
  return withAbsolutePoints(element, absolutePoints(element).map((p) => mapLocal(mapping, p)));
}

function flippedAngle(angle: number, mapping: Mapping): number {
  return Math.sign(mapping.sx) * Math.sign(mapping.sy) < 0 ? normalizeAngle(-angle) : angle;
}

export function uniformScale(sx: number, sy: number): number | null {
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  return Math.abs(ax - ay) <= 1e-6 * Math.max(1, ax, ay) ? ax : null;
}

function fontScale(mapping: Mapping): number {
  return Math.sqrt(Math.abs(mapping.sx * mapping.sy));
}

function resizeBoxElement(element: SketchElement, mapping: Mapping): SketchElement {
  const center = mapLocal(mapping, elementCenter(element));
  const width = Math.abs(element.width * mapping.sx);
  const height = Math.abs(element.height * mapping.sy);
  const placement = {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    angle: flippedAngle(element.angle, mapping),
  };
  if (element.type === "text") {
    return updateElement(element, { ...placement, fontSize: Math.max(1, element.fontSize * fontScale(mapping)) });
  }
  return updateElement<SketchElement>(element, placement);
}

function resizeRotatedElement(element: SketchElement, mapping: Mapping): SketchElement {
  const { frame, edges } = mapping;
  const left = Math.min(edges.left, edges.right);
  const top = Math.min(edges.top, edges.bottom);
  const width = Math.abs(edges.right - edges.left);
  const height = Math.abs(edges.bottom - edges.top);
  const center = rotatePoint({ x: left + width / 2, y: top + height / 2 }, frameCenter(frame), frame.angle);
  const placement = { x: center.x - width / 2, y: center.y - height / 2, width, height };
  if (element.type === "text") {
    return updateElement(element, { ...placement, fontSize: Math.max(1, element.fontSize * fontScale(mapping)) });
  }
  return updateElement<SketchElement>(element, placement);
}

export function resizeElements(
  originals: readonly SketchElement[],
  frame: Frame,
  handle: HandleId,
  pointer: Point,
  options: ResizeOptions,
): SketchElement[] {
  const local = rotatePoint(pointer, frameCenter(frame), -frame.angle);
  const edges = resizeEdges(frame, handle, local, options);
  const mapping: Mapping = {
    frame,
    edges,
    sx: frame.width === 0 ? 1 : (edges.right - edges.left) / frame.width,
    sy: frame.height === 0 ? 1 : (edges.bottom - edges.top) / frame.height,
  };
  return originals.map((element) => {
    if (hasPoints(element)) return resizePointsElement(element, mapping);
    if (frame.angle !== 0) return resizeRotatedElement(element, mapping);
    return resizeBoxElement(element, mapping);
  });
}

export function scaleFactors(frame: Frame, handle: HandleId, pointer: Point, options: ResizeOptions): { sx: number; sy: number } {
  const local = rotatePoint(pointer, frameCenter(frame), -frame.angle);
  const edges = resizeEdges(frame, handle, local, options);
  return {
    sx: frame.width === 0 ? 1 : (edges.right - edges.left) / frame.width,
    sy: frame.height === 0 ? 1 : (edges.bottom - edges.top) / frame.height,
  };
}
