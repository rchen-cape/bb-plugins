import rough from "roughjs";
import { isTransparent } from "./colors.js";
import type { Bounds } from "./math.js";
import type { StyledElement } from "./scene.js";

export type RoughGenerator = ReturnType<typeof rough.generator>;
export type Drawable = ReturnType<RoughGenerator["rectangle"]>;
export type OpSet = Drawable["sets"][number];
export type Op = OpSet["ops"][number];
export type RoughOptions = NonNullable<Parameters<RoughGenerator["rectangle"]>[4]>;

export type RenderPath = {
  readonly d: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly dash: readonly number[] | null;
  readonly lineCap: "round" | "butt";
  readonly lineJoin: "round" | "miter";
  readonly fillRule: "nonzero" | "evenodd";
};

export type RenderTextLine = { readonly text: string; readonly x: number; readonly y: number };

export type RenderText = {
  readonly lines: readonly RenderTextLine[];
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fill: string;
  readonly anchor: "start" | "middle" | "end";
  readonly handFont: boolean;
};

export type RenderModel = {
  readonly paths: readonly RenderPath[];
  readonly texts: readonly RenderText[];
  readonly bounds: Bounds;
};

export type ElementTransform = {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly cx: number;
  readonly cy: number;
  readonly opacity: number;
};


export const PATH_PRECISION = 2;

export const generator: RoughGenerator = rough.generator();

export class BoundsBuilder {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(x: number, y: number, pad: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }

  addData(data: readonly number[], pad: number): void {
    for (let i = 0; i + 1 < data.length; i += 2) this.add(data[i] ?? 0, data[i + 1] ?? 0, pad);
  }

  result(): Bounds {
    if (this.minX > this.maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }
}

export function formatNumber(value: number, digits: number = PATH_PRECISION): string {
  if (!Number.isFinite(value)) return "0";
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return String(rounded === 0 ? 0 : rounded);
}

function dashArray(element: StyledElement): number[] | undefined {
  if (element.strokeStyle === "dashed") return [8, 8 + element.strokeWidth];
  if (element.strokeStyle === "dotted") return [1.5, 6 + element.strokeWidth];
  return undefined;
}

function adjustRoughness(element: StyledElement): number {
  const maxSize = Math.max(Math.abs(element.width), Math.abs(element.height));
  const minSize = Math.min(Math.abs(element.width), Math.abs(element.height));
  const roundable = element.type === "rectangle" || element.type === "diamond" || element.type === "arrow" || element.type === "line";
  const linear = element.type === "arrow" || element.type === "line";
  if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && element.roundness !== null && roundable) || (linear && maxSize >= 50)) {
    return element.roughness;
  }
  return Math.min(element.roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

export function roughOptions(element: StyledElement, continuousPath: boolean): RoughOptions {
  const solid = element.strokeStyle === "solid";
  const roughness = adjustRoughness(element);
  const crisp = roughness === 0;
  return {
    seed: element.seed === 0 ? 1 : element.seed,
    strokeLineDash: dashArray(element),
    disableMultiStroke: !solid || crisp,
    disableMultiStrokeFill: crisp,
    strokeWidth: solid ? element.strokeWidth : element.strokeWidth + 0.5,
    fillWeight: element.strokeWidth / 2,
    hachureGap: element.strokeWidth * 4,
    roughness,
    stroke: element.strokeColor,
    preserveVertices: continuousPath || element.roughness < 2,
  };
}

export function withFill(options: RoughOptions, element: StyledElement): RoughOptions {
  if (isTransparent(element.backgroundColor)) return options;
  return { ...options, fill: element.backgroundColor, fillStyle: element.fillStyle };
}

function fillSketchWidth(options: RoughOptions): number {
  const weight = options.fillWeight ?? -1;
  return weight >= 0 ? weight : (options.strokeWidth ?? 1) / 2;
}

function setPath(set: OpSet, drawable: Drawable, strokeColor: string, builder: BoundsBuilder): RenderPath | null {
  const d = generator.opsToPath(set, PATH_PRECISION);
  if (d === "") return null;
  const options = drawable.options;
  const fill = options.fill ?? null;
  const evenOdd = drawable.shape === "curve" || drawable.shape === "polygon";
  const base: Pick<RenderPath, "d" | "lineCap" | "lineJoin" | "fillRule"> = {
    d,
    lineCap: "round",
    lineJoin: "round",
    fillRule: "nonzero",
  };
  for (const op of set.ops) builder.addData(op.data, set.type === "fillPath" ? 0 : (options.strokeWidth ?? 1) / 2);
  if (set.type === "fillPath") {
    return { ...base, fill, stroke: null, strokeWidth: 0, dash: null, fillRule: evenOdd ? "evenodd" : "nonzero" };
  }
  if (set.type === "fillSketch") {
    return { ...base, fill: null, stroke: fill, strokeWidth: fillSketchWidth(options), dash: options.fillLineDash ?? null };
  }
  return { ...base, fill: null, stroke: strokeColor, strokeWidth: options.strokeWidth ?? 1, dash: options.strokeLineDash ?? null };
}

export function drawablePaths(drawables: readonly Drawable[], strokeColor: string, builder: BoundsBuilder): RenderPath[] {
  return drawables.flatMap((drawable) =>
    drawable.sets.flatMap((set) => {
      const path = setPath(set, drawable, strokeColor, builder);
      return path === null ? [] : [path];
    }),
  );
}
