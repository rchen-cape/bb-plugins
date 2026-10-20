import { cornerRadius, diamondVertices, rectangleRadius } from "./bounds.js";
import { isClosedLoop } from "./hit.js";
import { clamp } from "./math.js";
import { arrowheadDrawables } from "./render-arrowheads.js";
import {
  BoundsBuilder,
  drawablePaths,
  formatNumber,
  generator,
  roughOptions,
  withFill,
  type Drawable,
  type RenderModel,
  type RenderPath,
  type RenderText,
  type RoughOptions,
} from "./render-core.js";
import type { LinearElement, ShapeElement, TextElement, UnsupportedElement } from "./scene.js";
import { baselineOffset, fontFamilyName, fontStack, lineHeightPx, splitLines } from "./text.js";

export const UNSUPPORTED_STROKE = "#868e96";
export const UNSUPPORTED_FILL = "#f8f9fa";
const TEXT_SLACK = 2;

function roundedRectanglePath(w: number, h: number, r: number): string {
  return [
    `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r}`,
    `L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h}`,
    `L ${r} ${h} Q 0 ${h}, 0 ${h - r}`,
    `L 0 ${r} Q 0 0, ${r} 0`,
  ].join(" ");
}

function roundedDiamondPath(w: number, h: number, vr: number, hr: number): string {
  const [top, right, bottom, left] = diamondVertices(w, h);
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) return "";
  return [
    `M ${top.x + vr} ${top.y + hr} L ${right.x - vr} ${right.y - hr}`,
    `C ${right.x} ${right.y}, ${right.x} ${right.y}, ${right.x - vr} ${right.y + hr}`,
    `L ${bottom.x + vr} ${bottom.y - hr}`,
    `C ${bottom.x} ${bottom.y}, ${bottom.x} ${bottom.y}, ${bottom.x - vr} ${bottom.y - hr}`,
    `L ${left.x + vr} ${left.y + hr}`,
    `C ${left.x} ${left.y}, ${left.x} ${left.y}, ${left.x + vr} ${left.y - hr}`,
    `L ${top.x - vr} ${top.y + hr}`,
    `C ${top.x} ${top.y}, ${top.x} ${top.y}, ${top.x + vr} ${top.y + hr}`,
  ].join(" ");
}

function shapeDrawable(element: ShapeElement): Drawable {
  const w = element.width;
  const h = element.height;
  if (element.type === "ellipse") return generator.ellipse(w / 2, h / 2, w, h, withFill(roughOptions(element, false), element));
  if (element.type === "rectangle") {
    const r = rectangleRadius(element);
    if (r > 0) return generator.path(roundedRectanglePath(w, h, r), withFill(roughOptions(element, true), element));
    return generator.rectangle(0, 0, w, h, withFill(roughOptions(element, false), element));
  }
  if (element.roundness !== null && w > 0 && h > 0) {
    const vr = cornerRadius(Math.abs(w / 2), element.roundness);
    const hr = cornerRadius(Math.abs(h / 2), element.roundness);
    return generator.path(roundedDiamondPath(w, h, vr, hr), withFill(roughOptions(element, true), element));
  }
  const points = diamondVertices(w, h).map((p): [number, number] => [p.x, p.y]);
  return generator.polygon(points, withFill(roughOptions(element, false), element));
}

export function shapeModel(element: ShapeElement): RenderModel {
  const builder = new BoundsBuilder();
  const paths = drawablePaths([shapeDrawable(element)], element.strokeColor, builder);
  return { paths, texts: [], bounds: builder.result() };
}

function linearBase(element: LinearElement, options: RoughOptions): Drawable {
  const points = element.points.map(([x, y]): [number, number] => [x, y]);
  if (element.roundness !== null) return generator.curve(points, options);
  if (options.fill !== undefined) return generator.polygon(points, options);
  return generator.linearPath(points, options);
}

export function linearModel(element: LinearElement): RenderModel {
  const plain = roughOptions(element, false);
  const loopFill = element.type === "line" && isClosedLoop(element);
  const options = loopFill ? withFill(plain, element) : plain;
  const base = linearBase(element, options);
  const drawables = [base];
  if (element.type === "arrow") {
    if (element.startArrowhead !== null) drawables.push(...arrowheadDrawables(element, base, "start", element.startArrowhead, plain));
    if (element.endArrowhead !== null) drawables.push(...arrowheadDrawables(element, base, "end", element.endArrowhead, plain));
  }
  const builder = new BoundsBuilder();
  return { paths: drawablePaths(drawables, element.strokeColor, builder), texts: [], bounds: builder.result() };
}

function textAnchor(align: TextElement["textAlign"]): RenderText["anchor"] {
  if (align === "center") return "middle";
  if (align === "right") return "end";
  return "start";
}

export function textModel(element: TextElement): RenderModel {
  const lineHeight = lineHeightPx(element.fontSize, element.lineHeight);
  const baseline = baselineOffset(element.fontSize, element.fontFamily, element.lineHeight);
  const x = element.textAlign === "center" ? element.width / 2 : element.textAlign === "right" ? element.width : 0;
  const lines = splitLines(element.text).map((text, i) => ({ text, x, y: i * lineHeight + baseline }));
  const text: RenderText = {
    lines,
    fontFamily: fontStack(element.fontFamily),
    fontSize: element.fontSize,
    fill: element.strokeColor,
    anchor: textAnchor(element.textAlign),
    handFont: fontFamilyName(element.fontFamily) === "hand",
  };
  const height = Math.max(element.height, lines.length * lineHeight);
  const bounds = { minX: -TEXT_SLACK, minY: -TEXT_SLACK, maxX: element.width + TEXT_SLACK, maxY: height + TEXT_SLACK };
  return { paths: [], texts: element.text === "" ? [] : [text], bounds };
}

export function unsupportedModel(element: UnsupportedElement): RenderModel {
  const w = Math.max(1, Math.abs(element.width));
  const h = Math.max(1, Math.abs(element.height));
  const fontSize = clamp(Math.min(w, h) / 4, 8, 16);
  const box: RenderPath = {
    d: `M0 0 L${formatNumber(w)} 0 L${formatNumber(w)} ${formatNumber(h)} L0 ${formatNumber(h)} Z`,
    fill: UNSUPPORTED_FILL,
    stroke: UNSUPPORTED_STROKE,
    strokeWidth: 1,
    dash: [6, 4],
    lineCap: "butt",
    lineJoin: "miter",
    fillRule: "nonzero",
  };
  const label: RenderText = {
    lines: [{ text: element.originalType, x: w / 2, y: h / 2 + fontSize * 0.35 }],
    fontFamily: fontStack(2),
    fontSize,
    fill: UNSUPPORTED_STROKE,
    anchor: "middle",
    handFont: false,
  };
  return { paths: [box], texts: [label], bounds: { minX: -0.5, minY: -0.5, maxX: w + 0.5, maxY: h + 0.5 } };
}
