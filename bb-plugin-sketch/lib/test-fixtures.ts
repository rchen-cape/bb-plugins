import {
  createFreedraw,
  createLinear,
  createShape,
  createText,
  DEFAULT_SKETCH_STYLE,
  type SketchStyle,
} from "./elements.js";
import type { Point } from "./math.js";
import type {
  FreedrawElement,
  LinearElement,
  LinearType,
  ShapeElement,
  ShapeType,
  SketchElement,
  TextElement,
  UnsupportedElement,
} from "./scene.js";
import type { MeasureText } from "./text.js";

export const CHAR_WIDTH_RATIO = 0.5;

export const measure: MeasureText = (text, font) => {
  const size = Number.parseFloat(font);
  return [...text].length * (Number.isFinite(size) ? size : 20) * CHAR_WIDTH_RATIO;
};

export function styleWith(patch: Partial<SketchStyle> = {}): SketchStyle {
  return { ...DEFAULT_SKETCH_STYLE, ...patch };
}

export function shape(
  type: ShapeType,
  box: { x: number; y: number; width: number; height: number },
  props: Partial<ShapeElement> = {},
  style: Partial<SketchStyle> = {},
): ShapeElement {
  return { ...createShape(type, box, styleWith(style)), ...props };
}

export function rect(x: number, y: number, width: number, height: number, props: Partial<ShapeElement> = {}): ShapeElement {
  return shape("rectangle", { x, y, width, height }, { roundness: null, ...props });
}

export function linear(
  type: LinearType,
  origin: Point,
  points: readonly (readonly [number, number])[],
  props: Partial<LinearElement> = {},
  style: Partial<SketchStyle> = {},
): LinearElement {
  return { ...createLinear(type, origin, points, styleWith(style)), ...props };
}

export function arrow(from: Point, to: Point, props: Partial<LinearElement> = {}): LinearElement {
  return linear("arrow", from, [
    [0, 0],
    [to.x - from.x, to.y - from.y],
  ], props);
}

export function text(origin: Point, value: string, props: Partial<TextElement> = {}, style: Partial<SketchStyle> = {}): TextElement {
  return { ...createText(origin, value, styleWith(style), measure), ...props };
}

export function freedraw(origin: Point, points: readonly (readonly [number, number])[], props: Partial<FreedrawElement> = {}): FreedrawElement {
  const base = createFreedraw(origin, styleWith(), null);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    ...base,
    points: points.map(([x, y]) => [x, y]),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    ...props,
  };
}

export function unsupported(id: string, box: { x: number; y: number; width: number; height: number }): UnsupportedElement {
  return {
    id,
    type: "unsupported",
    originalType: "image",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [],
    raw: { id, type: "image", x: box.x, y: box.y, width: box.width, height: box.height, fileId: "file-1", status: "saved" },
  };
}

export function byId(elements: readonly SketchElement[], id: string): SketchElement {
  const found = elements.find((element) => element.id === id);
  if (found === undefined) throw new Error(`missing element ${id}`);
  return found;
}

export function ids(elements: readonly SketchElement[]): string[] {
  return elements.map((element) => element.id);
}
