import { rotatePoint } from "./math.js";
import { generator, type Drawable, type Op, type RoughOptions } from "./render-core.js";
import type { LinearElement } from "./scene.js";

type ArrowheadKind = "arrow" | "bar" | "triangle" | "circle" | "diamond";

function arrowheadKind(name: string): { kind: ArrowheadKind; outline: boolean } {
  const outline = name.endsWith("_outline");
  const base = outline ? name.slice(0, -"_outline".length) : name;
  if (base === "bar" || base === "triangle" || base === "diamond") return { kind: base, outline };
  if (base === "dot" || base === "circle") return { kind: "circle", outline };
  return { kind: "arrow", outline: false };
}

function arrowheadSize(kind: ArrowheadKind): number {
  if (kind === "arrow") return 25;
  if (kind === "diamond") return 12;
  return 15;
}

function arrowheadAngle(kind: ArrowheadKind): number {
  if (kind === "bar") return 90;
  if (kind === "arrow") return 20;
  return 25;
}

function curvePathOps(drawable: Drawable): readonly Op[] {
  for (const set of drawable.sets) if (set.type === "path") return set.ops;
  return drawable.sets[0]?.ops ?? [];
}

function bezierAnchor(ops: readonly Op[], position: "start" | "end"): { tip: [number, number]; from: [number, number] } | null {
  const index = position === "start" ? 1 : ops.length - 1;
  const data = ops[index]?.data;
  if (data === undefined || data.length !== 6) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = data;
  const previous = ops[index - 1];
  const p0: [number, number] =
    previous?.op === "move"
      ? [previous.data[0] ?? 0, previous.data[1] ?? 0]
      : previous?.op === "bcurveTo"
        ? [previous.data[4] ?? 0, previous.data[5] ?? 0]
        : [0, 0];
  const t = 0.3;
  const at = (a: number, b: number, c: number, d: number): number =>
    (1 - t) ** 3 * d + 3 * t * (1 - t) ** 2 * c + 3 * t ** 2 * (1 - t) * b + a * t ** 3;
  const from: [number, number] = [at(p0[0], x1, x2, x3), at(p0[1], y1, y2, y3)];
  return { tip: position === "start" ? p0 : [x3, y3], from };
}

function lastSegmentLength(element: LinearElement, position: "start" | "end"): number {
  const n = element.points.length;
  const tip = position === "end" ? element.points[n - 1] : element.points[0];
  const previous = n > 1 ? (position === "end" ? element.points[n - 2] : element.points[1]) : undefined;
  if (tip === undefined) return 0;
  const [px, py] = previous ?? [0, 0];
  return Math.hypot(tip[0] - px, tip[1] - py);
}

function rotateTuple(x: number, y: number, cx: number, cy: number, degrees: number): [number, number] {
  const p = rotatePoint({ x, y }, { x: cx, y: cy }, (degrees * Math.PI) / 180);
  return [p.x, p.y];
}

function arrowheadPoints(element: LinearElement, base: Drawable, position: "start" | "end", kind: ArrowheadKind): number[] | null {
  const anchor = bezierAnchor(curvePathOps(base), position);
  if (anchor === null) return null;
  const [x2, y2] = anchor.tip;
  const [x1, y1] = anchor.from;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return null;
  const nx = (x2 - x1) / length;
  const ny = (y2 - y1) / length;
  const size = Math.min(arrowheadSize(kind), lastSegmentLength(element, position) * (kind === "diamond" ? 0.25 : 0.5));
  const xs = x2 - nx * size;
  const ys = y2 - ny * size;
  if (kind === "circle") return [x2, y2, Math.hypot(ys - y2, xs - x2) + element.strokeWidth - 2];
  const angle = arrowheadAngle(kind);
  const [x3, y3] = rotateTuple(xs, ys, x2, y2, -angle);
  const [x4, y4] = rotateTuple(xs, ys, x2, y2, angle);
  if (kind !== "diamond") return [x2, y2, x3, y3, x4, y4];
  const n = element.points.length;
  const neighbor = n > 1 ? (position === "start" ? element.points[1] : element.points[n - 2]) : undefined;
  const [px, py] = neighbor ?? [0, 0];
  const direction = position === "start" ? Math.atan2(py - y2, px - x2) : Math.atan2(y2 - py, x2 - px);
  const reach = position === "start" ? size * 2 : -size * 2;
  const opposite = rotatePoint({ x: x2 + reach, y: y2 }, { x: x2, y: y2 }, direction);
  return [x2, y2, x3, y3, opposite.x, opposite.y, x4, y4];
}

function tuples(values: readonly number[]): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0; i + 1 < values.length; i += 2) result.push([values[i] ?? 0, values[i + 1] ?? 0]);
  return result;
}

export function arrowheadDrawables(
  element: LinearElement,
  base: Drawable,
  position: "start" | "end",
  name: string,
  options: RoughOptions,
): Drawable[] {
  const { kind, outline } = arrowheadKind(name);
  const points = arrowheadPoints(element, base, position, kind);
  if (points === null) return [];
  const solid = { ...options, strokeLineDash: undefined };
  const fill = outline ? undefined : element.strokeColor;
  if (kind === "circle") {
    const [x = 0, y = 0, diameter = 0] = points;
    return [
      generator.circle(x, y, diameter, {
        ...solid,
        fill,
        fillStyle: "solid",
        stroke: element.strokeColor,
        roughness: Math.min(0.5, options.roughness ?? 0),
      }),
    ];
  }
  if (kind === "triangle" || kind === "diamond") {
    const polygon = tuples(points);
    const first = polygon[0];
    return [
      generator.polygon(first === undefined ? polygon : [...polygon, first], {
        ...solid,
        fill,
        fillStyle: "solid",
        roughness: Math.min(1, options.roughness ?? 0),
      }),
    ];
  }
  const [x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = points;
  const dash = element.strokeStyle === "dotted" ? [1.5, element.strokeWidth + 4] : undefined;
  const capOptions = { ...options, strokeLineDash: dash, roughness: Math.min(1, options.roughness ?? 0) };
  return [generator.line(x3, y3, x2, y2, capOptions), generator.line(x4, y4, x2, y2, capOptions)];
}
