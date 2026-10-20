import {
  diamondVertices,
  elementBounds,
  hasPoints,
  localPoints,
  rectangleRadius,
  sceneToLocal,
  type PointsElement,
} from "./bounds.js";
import { isTransparent } from "./colors.js";
import {
  boundsContain,
  boundsFromCorners,
  boundsIntersect,
  clamp,
  distance,
  distanceToPolyline,
  expandBounds,
  pointInPolygon,
  type Bounds,
  type Point,
} from "./math.js";
import type { SketchElement } from "./scene.js";

export const HIT_TOLERANCE = 10;
const LOOP_THRESHOLD = 8;
const FREEDRAW_RADIUS_FACTOR = 2;

export function isFilled(element: SketchElement): boolean {
  return element.type !== "unsupported" && !isTransparent(element.backgroundColor);
}

export function isClosedLoop(element: PointsElement): boolean {
  const first = element.points[0];
  const last = element.points[element.points.length - 1];
  if (element.points.length < 3 || first === undefined || last === undefined) return false;
  return Math.hypot(first[0] - last[0], first[1] - last[1]) <= LOOP_THRESHOLD;
}

function roundedRectDistance(p: Point, width: number, height: number, radius: number): number {
  const hw = Math.abs(width) / 2;
  const hh = Math.abs(height) / 2;
  const r = Math.min(radius, hw, hh);
  const qx = Math.abs(p.x - width / 2) - (hw - r);
  const qy = Math.abs(p.y - height / 2) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function ellipseDistance(p: Point, width: number, height: number): number {
  const a = Math.abs(width) / 2;
  const b = Math.abs(height) / 2;
  const x = Math.abs(p.x - width / 2);
  const y = Math.abs(p.y - height / 2);
  if (a === 0 || b === 0) return roundedRectDistance(p, width, height, 0);
  let tx = Math.SQRT1_2;
  let ty = Math.SQRT1_2;
  for (let i = 0; i < 4; i += 1) {
    const ex = ((a * a - b * b) * tx ** 3) / a;
    const ey = ((b * b - a * a) * ty ** 3) / b;
    const r = Math.hypot(a * tx - ex, b * ty - ey);
    const q = Math.hypot(x - ex, y - ey);
    if (q === 0) break;
    tx = clamp((((x - ex) * r) / q + ex) / a, 0, 1);
    ty = clamp((((y - ey) * r) / q + ey) / b, 0, 1);
    const t = Math.hypot(tx, ty);
    tx /= t;
    ty /= t;
  }
  const d = Math.hypot(x - a * tx, y - b * ty);
  return (x * x) / (a * a) + (y * y) / (b * b) < 1 ? -d : d;
}

function diamondDistance(p: Point, width: number, height: number): number {
  const vertices = diamondVertices(width, height);
  const d = distanceToPolyline(p, vertices, true);
  return pointInPolygon(p, vertices) ? -d : d;
}

function pointsDistance(element: PointsElement, local: Point): number {
  const points = localPoints(element);
  const d = distanceToPolyline(local, points, false);
  if (isFilled(element) && isClosedLoop(element) && pointInPolygon(local, points)) return -d;
  return d;
}

export function signedDistance(element: SketchElement, p: Point): number {
  const local = sceneToLocal(element, p);
  if (hasPoints(element)) return pointsDistance(element, local);
  if (element.type === "ellipse") return ellipseDistance(local, element.width, element.height);
  if (element.type === "diamond") return diamondDistance(local, element.width, element.height);
  const radius = element.type === "rectangle" ? rectangleRadius(element) : 0;
  return roundedRectDistance(local, element.width, element.height, radius);
}

function hitsInside(element: SketchElement): boolean {
  if (element.type === "text" || element.type === "unsupported") return true;
  if (hasPoints(element)) return isFilled(element) && isClosedLoop(element);
  return isFilled(element);
}

export function hitTolerance(element: SketchElement, zoom: number, slop: number = HIT_TOLERANCE): number {
  const base = slop / zoom;
  if (element.type === "unsupported") return base;
  if (element.type === "freedraw") return base + element.strokeWidth * FREEDRAW_RADIUS_FACTOR;
  return base + element.strokeWidth / 2;
}

export function hitElement(element: SketchElement, p: Point, zoom: number, slop: number = HIT_TOLERANCE): boolean {
  if (element.isDeleted) return false;
  const tolerance = hitTolerance(element, zoom, slop);
  if (!boundsContainPoint(expandBounds(elementBounds(element), tolerance), p)) return false;
  const d = signedDistance(element, p);
  return hitsInside(element) ? d <= tolerance : Math.abs(d) <= tolerance;
}

function boundsContainPoint(bounds: Bounds, p: Point): boolean {
  return p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY;
}

export function topmostHit(elements: readonly SketchElement[], p: Point, zoom: number, slop: number = HIT_TOLERANCE): SketchElement | null {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (element !== undefined && hitElement(element, p, zoom, slop)) return element;
  }
  return null;
}

function resolveTarget(element: SketchElement, byId: ReadonlyMap<string, SketchElement>): string {
  if (element.type !== "text" || element.containerId === null) return element.id;
  const container = byId.get(element.containerId);
  return container === undefined || container.isDeleted ? element.id : container.id;
}

function idMap(elements: readonly SketchElement[]): Map<string, SketchElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

export function pickTarget(elements: readonly SketchElement[], p: Point, zoom: number, slop: number = HIT_TOLERANCE): string | null {
  const hit = topmostHit(elements, p, zoom, slop);
  return hit === null ? null : resolveTarget(hit, idMap(elements));
}

function isFrameShape(element: SketchElement): boolean {
  return !element.isDeleted && (element.type === "rectangle" || element.type === "diamond" || element.type === "ellipse");
}

function frameArea(element: SketchElement): number {
  return Math.abs(element.width * element.height);
}

function smallestFrameAround(elements: readonly SketchElement[], p: Point, zoom: number, slop: number): SketchElement | null {
  let best: SketchElement | null = null;
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (element === undefined || !isFrameShape(element)) continue;
    if (signedDistance(element, p) > hitTolerance(element, zoom, slop)) continue;
    if (best === null || frameArea(element) < frameArea(best)) best = element;
  }
  return best;
}

export function editTargetAt(elements: readonly SketchElement[], p: Point, zoom: number, slop: number = HIT_TOLERANCE): string | null {
  const target = topmostHit(elements, p, zoom, slop) ?? smallestFrameAround(elements, p, zoom, slop);
  return target === null ? null : resolveTarget(target, idMap(elements));
}

function isAttachedLabel(element: SketchElement, byId: ReadonlyMap<string, SketchElement>): boolean {
  if (element.type !== "text" || element.containerId === null) return false;
  const container = byId.get(element.containerId);
  return container !== undefined && !container.isDeleted;
}

export function elementsInMarquee(elements: readonly SketchElement[], marquee: Bounds): string[] {
  const byId = idMap(elements);
  return elements
    .filter((element) => !element.isDeleted && !isAttachedLabel(element, byId))
    .filter((element) => boundsContain(marquee, elementBounds(element)))
    .map((element) => element.id);
}

export function elementsAlongPath(elements: readonly SketchElement[], from: Point, to: Point, zoom: number): string[] {
  const step = Math.max(0.5, HIT_TOLERANCE / zoom / 2);
  const count = Math.max(1, Math.ceil(distance(from, to) / step));
  const samples = Array.from({ length: count + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / count,
    y: from.y + ((to.y - from.y) * i) / count,
  }));
  const path = boundsFromCorners(from, to);
  const byId = idMap(elements);
  const hits = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    if (!boundsIntersect(expandBounds(elementBounds(element), hitTolerance(element, zoom)), path)) continue;
    if (samples.some((sample) => hitElement(element, sample, zoom))) hits.add(resolveTarget(element, byId));
  }
  return elements.filter((element) => hits.has(element.id)).map((element) => element.id);
}
