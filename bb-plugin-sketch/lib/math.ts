export type Point = { readonly x: number; readonly y: number };
export type Bounds = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export const ANGLE_SNAP = Math.PI / 12;

export function addPoints(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtractPoints(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scalePoint(p: Point, factor: number): Point {
  return { x: p.x * factor, y: p.y * factor };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rotatePoint(p: Point, center: Point, angle: number): Point {
  if (angle === 0) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function rotateVector(v: Point, angle: number): Point {
  return rotatePoint(v, { x: 0, y: 0 }, angle);
}

export function normalizeAngle(angle: number): number {
  const full = Math.PI * 2;
  const value = angle % full;
  return value < 0 ? value + full : value;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: readonly Point[], closed: boolean): number {
  const first = points[0];
  if (first === undefined) return Infinity;
  if (points.length === 1) return distance(p, first);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined) best = Math.min(best, distanceToSegment(p, a, b));
  }
  const last = points[points.length - 1];
  if (closed && last !== undefined) best = Math.min(best, distanceToSegment(p, last, first));
  return best;
}

export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const crosses = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function boundsOfPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function expandBounds(b: Bounds, by: number): Bounds {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boundsFromCorners(a: Point, b: Point): Bounds {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

export function snapAngle(origin: Point, target: Point, step: number = ANGLE_SNAP): Point {
  const length = distance(origin, target);
  if (length === 0) return target;
  const angle = Math.round(Math.atan2(target.y - origin.y, target.x - origin.x) / step) * step;
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

export function snapToGrid(value: number, gridSize: number): number {
  if (!(gridSize > 0)) return value;
  return Math.round(value / gridSize) * gridSize;
}

export function snapPoint(p: Point, gridSize: number | null): Point {
  if (gridSize === null || !(gridSize > 0)) return p;
  return { x: snapToGrid(p.x, gridSize), y: snapToGrid(p.y, gridSize) };
}
