import { z } from "zod";
import { absolutePoints, type PointsElement } from "./bounds.js";
import { boundsOfPoints, type Box, type Point } from "./math.js";
import {
  FILL_STYLES,
  STROKE_STYLES,
  TEXT_ALIGNS,
  newElementId,
  newSeed,
  newVersionNonce,
  type Binding,
  type BoundElement,
  type FillStyle,
  type FreedrawElement,
  type LinearElement,
  type LinearType,
  type Roundness,
  type ShapeElement,
  type ShapeType,
  type SketchElement,
  type StrokeStyle,
  type TextAlign,
  type TextElement,
} from "./scene.js";
import { DEFAULT_STYLE, FONT_FAMILIES, LINE_HEIGHT } from "./sketch.js";
import { measureTextBlock, type MeasureText } from "./text.js";

export const EDGE_STYLES = ["sharp", "round"] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

export const ARROWHEADS = ["arrow", "triangle", "bar", "circle", "diamond"] as const;
export type Arrowhead = (typeof ARROWHEADS)[number];

export const ROUGHNESS_PICKS = [0, 1, 2] as const;

export type SketchStyle = {
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: FillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle;
  readonly roughness: number;
  readonly opacity: number;
  readonly edges: EdgeStyle;
  readonly fontFamily: number;
  readonly fontSize: number;
  readonly textAlign: TextAlign;
  readonly startArrowhead: Arrowhead | null;
  readonly endArrowhead: Arrowhead | null;
};

export const DEFAULT_SKETCH_STYLE: SketchStyle = {
  strokeColor: DEFAULT_STYLE.strokeColor,
  backgroundColor: DEFAULT_STYLE.backgroundColor,
  fillStyle: DEFAULT_STYLE.fillStyle,
  strokeWidth: DEFAULT_STYLE.strokeWidth,
  strokeStyle: DEFAULT_STYLE.strokeStyle,
  roughness: DEFAULT_STYLE.roughness,
  opacity: DEFAULT_STYLE.opacity,
  edges: DEFAULT_STYLE.roundness,
  fontFamily: DEFAULT_STYLE.fontFamily,
  fontSize: DEFAULT_STYLE.fontSize,
  textAlign: DEFAULT_STYLE.textAlign,
  startArrowhead: DEFAULT_STYLE.startArrowhead,
  endArrowhead: DEFAULT_STYLE.endArrowhead,
};

const KNOWN_FONT_FAMILIES: readonly number[] = Object.values(FONT_FAMILIES);
const styleColorSchema = z.string().trim().min(1).max(64);
const arrowheadSchema = z.enum(ARROWHEADS).nullable();

export const sketchStyleSchema = z.object({
  strokeColor: styleColorSchema.catch(DEFAULT_SKETCH_STYLE.strokeColor),
  backgroundColor: styleColorSchema.catch(DEFAULT_SKETCH_STYLE.backgroundColor),
  fillStyle: z.enum(FILL_STYLES).catch(DEFAULT_SKETCH_STYLE.fillStyle),
  strokeWidth: z.number().positive().max(100).catch(DEFAULT_SKETCH_STYLE.strokeWidth),
  strokeStyle: z.enum(STROKE_STYLES).catch(DEFAULT_SKETCH_STYLE.strokeStyle),
  roughness: z.number().min(0).max(10).catch(DEFAULT_SKETCH_STYLE.roughness),
  opacity: z.number().min(0).max(100).catch(DEFAULT_SKETCH_STYLE.opacity),
  edges: z.enum(EDGE_STYLES).catch(DEFAULT_SKETCH_STYLE.edges),
  fontFamily: z
    .number()
    .int()
    .refine((value) => KNOWN_FONT_FAMILIES.includes(value))
    .catch(DEFAULT_SKETCH_STYLE.fontFamily),
  fontSize: z.number().positive().max(1000).catch(DEFAULT_SKETCH_STYLE.fontSize),
  textAlign: z.enum(TEXT_ALIGNS).catch(DEFAULT_SKETCH_STYLE.textAlign),
  startArrowhead: arrowheadSchema.catch(DEFAULT_SKETCH_STYLE.startArrowhead),
  endArrowhead: arrowheadSchema.catch(DEFAULT_SKETCH_STYLE.endArrowhead),
});

export function parseSketchStyle(raw: unknown): SketchStyle {
  const parsed = sketchStyleSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_SKETCH_STYLE;
}

export function roundnessFor(type: SketchElement["type"], edges: EdgeStyle): Roundness | null {
  if (edges === "sharp") return null;
  if (type === "rectangle") return { type: 3 };
  if (type === "diamond" || type === "arrow" || type === "line") return { type: 2 };
  return null;
}

export function edgesOf(roundness: Roundness | null): EdgeStyle {
  return roundness === null ? "sharp" : "round";
}

function now(): number {
  return Date.now();
}

function baseFields(style: SketchStyle) {
  return {
    id: newElementId(),
    angle: 0,
    version: 1,
    versionNonce: newVersionNonce(),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    updated: now(),
    link: null,
    locked: false,
    seed: newSeed(),
    boundElements: null,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: style.opacity,
  };
}

export function createShape(type: ShapeType, box: Box, style: SketchStyle): ShapeElement {
  return {
    ...baseFields(style),
    type,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    roundness: roundnessFor(type, style.edges),
  };
}

export function sizeOfPoints(points: readonly (readonly [number, number])[]): { width: number; height: number } {
  const bounds = boundsOfPoints(points.map(([x, y]) => ({ x, y })));
  return { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
}

const COLLAPSED_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 0],
];

function normalizedPoints(points: readonly (readonly [number, number])[]): { offset: Point; points: [number, number][] } {
  const first = points[0] ?? [0, 0];
  return {
    offset: { x: first[0], y: first[1] },
    points: points.map(([x, y]) => [x - first[0], y - first[1]]),
  };
}

export function createLinear(
  type: LinearType,
  origin: Point,
  points: readonly (readonly [number, number])[],
  style: SketchStyle,
): LinearElement {
  const source = points.length >= 2 ? points : COLLAPSED_POINTS;
  const normalized = normalizedPoints(source);
  const arrow = type === "arrow";
  return {
    ...baseFields(style),
    type,
    x: origin.x + normalized.offset.x,
    y: origin.y + normalized.offset.y,
    ...sizeOfPoints(normalized.points),
    roundness: roundnessFor(type, style.edges),
    points: normalized.points,
    startBinding: null,
    endBinding: null,
    startArrowhead: arrow ? style.startArrowhead : null,
    endArrowhead: arrow ? style.endArrowhead : null,
    ...(arrow ? { elbowed: false } : {}),
  };
}

export function createFreedraw(origin: Point, style: SketchStyle, pressure: number | null): FreedrawElement {
  return {
    ...baseFields(style),
    type: "freedraw",
    x: origin.x,
    y: origin.y,
    width: 0,
    height: 0,
    roundness: null,
    points: [[0, 0]],
    pressures: pressure === null ? [] : [pressure],
    simulatePressure: pressure === null,
  };
}

export type TextOptions = {
  readonly containerId?: string | null;
  readonly textAlign?: TextAlign;
  readonly verticalAlign?: TextElement["verticalAlign"];
};

export function createText(
  origin: Point,
  text: string,
  style: SketchStyle,
  measure: MeasureText,
  options: TextOptions = {},
): TextElement {
  const metrics = measureTextBlock(text, style.fontSize, style.fontFamily, LINE_HEIGHT, measure);
  return {
    ...baseFields(style),
    type: "text",
    x: origin.x,
    y: origin.y,
    width: metrics.width,
    height: metrics.height,
    backgroundColor: "transparent",
    roundness: null,
    text,
    originalText: text,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    textAlign: options.textAlign ?? style.textAlign,
    verticalAlign: options.verticalAlign ?? "top",
    containerId: options.containerId ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

export function textOriginAt(point: Point, style: Pick<SketchStyle, "fontSize">): Point {
  return { x: point.x, y: point.y - (style.fontSize * LINE_HEIGHT) / 2 };
}

export function updateElement<T extends SketchElement>(element: T, patch: Partial<T>): T {
  return { ...element, ...patch, version: element.version + 1, versionNonce: newVersionNonce(), updated: now() };
}

export function elementMap(elements: readonly SketchElement[]): Map<string, SketchElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

function remapBoundElements(entries: readonly BoundElement[] | null, idMap: ReadonlyMap<string, string>): BoundElement[] | null {
  if (entries === null) return null;
  const mapped = entries.flatMap((entry) => {
    const id = idMap.get(entry.id);
    return id === undefined ? [] : [{ id, type: entry.type }];
  });
  return mapped.length === 0 ? null : mapped;
}

function remapBinding(binding: Binding | null, idMap: ReadonlyMap<string, string>): Binding | null {
  if (binding === null) return null;
  const elementId = idMap.get(binding.elementId);
  return elementId === undefined ? null : { ...binding, elementId };
}

function withoutKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

function cloneElement(
  element: SketchElement,
  idMap: ReadonlyMap<string, string>,
  groupFor: (groupId: string) => string,
): SketchElement {
  const common = {
    id: idMap.get(element.id) ?? newElementId(),
    groupIds: element.groupIds.map(groupFor),
    version: 1,
    versionNonce: newVersionNonce(),
  };
  if (element.type === "unsupported") {
    return { ...element, ...common, raw: withoutKeys(element.raw, ["boundElements", "containerId", "frameId"]) };
  }
  const styled = {
    ...common,
    seed: newSeed(),
    updated: now(),
    frameId: element.frameId === null ? null : (idMap.get(element.frameId) ?? null),
    boundElements: remapBoundElements(element.boundElements, idMap),
  };
  if (element.type === "text") {
    const containerId = element.containerId === null ? null : (idMap.get(element.containerId) ?? null);
    return { ...element, ...styled, containerId };
  }
  if (element.type === "arrow" || element.type === "line") {
    return {
      ...element,
      ...styled,
      startBinding: remapBinding(element.startBinding, idMap),
      endBinding: remapBinding(element.endBinding, idMap),
    };
  }
  return { ...element, ...styled };
}

export function cloneElements(source: readonly SketchElement[]): { elements: SketchElement[]; idMap: Map<string, string> } {
  const idMap = new Map(source.map((element) => [element.id, newElementId()]));
  const groupMap = new Map<string, string>();
  const groupFor = (groupId: string): string => {
    const existing = groupMap.get(groupId);
    if (existing !== undefined) return existing;
    const next = newElementId();
    groupMap.set(groupId, next);
    return next;
  };
  return { elements: source.map((element) => cloneElement(element, idMap, groupFor)), idMap };
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((p, i) => {
    const q = b[i];
    return q !== undefined && Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
  });
}

export function withAbsolutePoints<T extends PointsElement>(element: T, absolute: readonly Point[]): T {
  if (element.angle === 0 && samePoints(absolutePoints(element), absolute)) return element;
  const first = absolute[0] ?? { x: element.x, y: element.y };
  const points: [number, number][] = absolute.map((p) => [p.x - first.x, p.y - first.y]);
  const bounds = boundsOfPoints(absolute);
  return {
    ...element,
    x: first.x,
    y: first.y,
    angle: 0,
    points,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    version: element.version + 1,
    versionNonce: newVersionNonce(),
    updated: now(),
  };
}

export function translateElement(element: SketchElement, dx: number, dy: number): SketchElement {
  if (dx === 0 && dy === 0) return element;
  return updateElement<SketchElement>(element, { x: element.x + dx, y: element.y + dy });
}
