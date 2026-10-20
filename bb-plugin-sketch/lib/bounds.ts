import {
  boundsOfPoints,
  rotatePoint,
  unionBounds,
  type Bounds,
  type Point,
} from "./math.js";
import { isLinear, type FreedrawElement, type LinearElement, type Roundness, type SketchElement } from "./scene.js";

export type PointsElement = LinearElement | FreedrawElement;

export type Frame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
};

const PROPORTIONAL_RADIUS = 0.25;
const ADAPTIVE_RADIUS = 32;

export function hasPoints(element: SketchElement): element is PointsElement {
  return isLinear(element) || element.type === "freedraw";
}

export function cornerRadius(size: number, roundness: Roundness | null): number {
  if (roundness === null) return 0;
  if (roundness.type === 1 || roundness.type === 2) return size * PROPORTIONAL_RADIUS;
  if (roundness.type === 3) {
    const fixed = roundness.value ?? ADAPTIVE_RADIUS;
    return size <= fixed / PROPORTIONAL_RADIUS ? size * PROPORTIONAL_RADIUS : fixed;
  }
  return 0;
}

export function rectangleRadius(element: { width: number; height: number; roundness: Roundness | null }): number {
  return cornerRadius(Math.min(Math.abs(element.width), Math.abs(element.height)), element.roundness);
}

export function diamondVertices(width: number, height: number): Point[] {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height / 2 },
    { x: width / 2, y: height },
    { x: 0, y: height / 2 },
  ];
}

export function localPoints(element: PointsElement): Point[] {
  return element.points.map(([x, y]) => ({ x, y }));
}

export function localBounds(element: SketchElement): Bounds {
  if (hasPoints(element)) return boundsOfPoints(localPoints(element));
  return {
    minX: Math.min(0, element.width),
    minY: Math.min(0, element.height),
    maxX: Math.max(0, element.width),
    maxY: Math.max(0, element.height),
  };
}

export function localCenter(element: SketchElement): Point {
  const bounds = localBounds(element);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export function elementCenter(element: SketchElement): Point {
  const center = localCenter(element);
  return { x: element.x + center.x, y: element.y + center.y };
}

export function sceneToLocal(element: SketchElement, p: Point): Point {
  const unrotated = rotatePoint(p, elementCenter(element), -element.angle);
  return { x: unrotated.x - element.x, y: unrotated.y - element.y };
}

export function localToScene(element: SketchElement, p: Point): Point {
  return rotatePoint({ x: element.x + p.x, y: element.y + p.y }, elementCenter(element), element.angle);
}

export function absolutePoints(element: PointsElement): Point[] {
  const center = elementCenter(element);
  return element.points.map(([x, y]) => rotatePoint({ x: element.x + x, y: element.y + y }, center, element.angle));
}

export function elementCorners(element: SketchElement): Point[] {
  const b = localBounds(element);
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  return corners.map((corner) => localToScene(element, corner));
}

function ellipseBounds(element: SketchElement): Bounds {
  const center = elementCenter(element);
  const a = Math.abs(element.width) / 2;
  const b = Math.abs(element.height) / 2;
  const cos = Math.cos(element.angle);
  const sin = Math.sin(element.angle);
  const hx = Math.sqrt(a * a * cos * cos + b * b * sin * sin);
  const hy = Math.sqrt(a * a * sin * sin + b * b * cos * cos);
  return { minX: center.x - hx, minY: center.y - hy, maxX: center.x + hx, maxY: center.y + hy };
}

export function elementBounds(element: SketchElement): Bounds {
  if (hasPoints(element)) return boundsOfPoints(absolutePoints(element));
  if (element.type === "ellipse") return ellipseBounds(element);
  if (element.type === "diamond" && element.angle !== 0) {
    return boundsOfPoints(diamondVertices(element.width, element.height).map((p) => localToScene(element, p)));
  }
  return boundsOfPoints(elementCorners(element));
}

export function commonBounds(elements: readonly SketchElement[]): Bounds | null {
  let result: Bounds | null = null;
  for (const element of elements) {
    if (element.isDeleted) continue;
    const bounds = elementBounds(element);
    result = result === null ? bounds : unionBounds(result, bounds);
  }
  return result;
}

function isLabelOfListed(element: SketchElement, ids: ReadonlySet<string>): boolean {
  return element.type === "text" && element.containerId !== null && ids.has(element.containerId);
}

export function selectionFrame(elements: readonly SketchElement[]): Frame | null {
  const ids = new Set(elements.map((element) => element.id));
  const top = elements.filter((element) => !element.isDeleted && !isLabelOfListed(element, ids));
  const only = top.length === 1 ? top[0] : undefined;
  if (only !== undefined && !hasPoints(only)) {
    const b = localBounds(only);
    return { x: only.x + b.minX, y: only.y + b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, angle: only.angle };
  }
  const bounds = commonBounds(top);
  if (bounds === null) return null;
  return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY, angle: 0 };
}

export function frameCenter(frame: Frame): Point {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function frameCorners(frame: Frame, padding = 0): Point[] {
  const center = frameCenter(frame);
  const corners = [
    { x: frame.x - padding, y: frame.y - padding },
    { x: frame.x + frame.width + padding, y: frame.y - padding },
    { x: frame.x + frame.width + padding, y: frame.y + frame.height + padding },
    { x: frame.x - padding, y: frame.y + frame.height + padding },
  ];
  return corners.map((corner) => rotatePoint(corner, center, frame.angle));
}

export function frameContains(frame: Frame, p: Point, padding = 0): boolean {
  const local = rotatePoint(p, frameCenter(frame), -frame.angle);
  return (
    local.x >= frame.x - padding &&
    local.x <= frame.x + frame.width + padding &&
    local.y >= frame.y - padding &&
    local.y <= frame.y + frame.height + padding
  );
}
