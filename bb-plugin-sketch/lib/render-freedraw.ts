import { getStroke } from "perfect-freehand";
import { isTransparent } from "./colors.js";
import { isClosedLoop } from "./hit.js";
import { clamp } from "./math.js";
import {
  BoundsBuilder,
  drawablePaths,
  formatNumber,
  generator,
  roughOptions,
  withFill,
  type RenderModel,
  type RenderPath,
} from "./render-core.js";
import type { FreedrawElement } from "./scene.js";

const FREEDRAW_SIZE = 4.25;

function midpoint(a: readonly number[], b: readonly number[]): [number, number] {
  return [((a[0] ?? 0) + (b[0] ?? 0)) / 2, ((a[1] ?? 0) + (b[1] ?? 0)) / 2];
}

function pair(p: readonly number[]): string {
  return `${formatNumber(p[0] ?? 0)} ${formatNumber(p[1] ?? 0)}`;
}

export function strokeOutlinePath(points: readonly (readonly number[])[]): string {
  const first = points[0];
  if (first === undefined) return "";
  const parts = ["M", pair(first), "Q"];
  points.forEach((point, i) => {
    const next = points[i + 1];
    if (next === undefined) parts.push(pair(point), pair(midpoint(point, first)), "L", pair(first), "Z");
    else parts.push(pair(point), pair(midpoint(point, next)));
  });
  return parts.join(" ");
}

function simplify(points: readonly [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return [...points];
  let index = -1;
  let worst = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    const d = segmentDistance(p, first, last);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance || index < 0) return [first, last];
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function freedrawInput(element: FreedrawElement): number[][] {
  if (element.simulatePressure) return element.points.map(([x, y]) => [x, y]);
  return element.points.map(([x, y], i) => [x, y, element.pressures[i] ?? 0.5]);
}

export function freedrawModel(element: FreedrawElement): RenderModel {
  const builder = new BoundsBuilder();
  const paths: RenderPath[] = [];
  if (isClosedLoop(element) && !isTransparent(element.backgroundColor)) {
    const outline = simplify(element.points, 0.75);
    const fillOptions = { ...withFill(roughOptions(element, false), element), stroke: "none" };
    paths.push(...drawablePaths([generator.curve(outline, fillOptions)], element.strokeColor, builder));
  }
  const outlinePoints = getStroke(freedrawInput(element), {
    size: element.strokeWidth * FREEDRAW_SIZE,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    simulatePressure: element.simulatePressure,
    last: true,
  });
  for (const [x, y] of outlinePoints) builder.add(x, y, 0);
  const d = strokeOutlinePath(outlinePoints);
  if (d !== "") {
    paths.push({
      d,
      fill: element.strokeColor,
      stroke: null,
      strokeWidth: 0,
      dash: null,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
    });
  }
  return { paths, texts: [], bounds: builder.result() };
}
