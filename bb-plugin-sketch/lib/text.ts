import { EXCALIFONT_FAMILY } from "./excalifont.js";
import type { Point } from "./math.js";
import type { ShapeElement, ShapeType, TextAlign, TextElement, VerticalAlign } from "./scene.js";
import { FONT_FAMILIES, LINE_HEIGHT, type FontFamilyName } from "./sketch.js";

export type MeasureText = (text: string, font: string) => number;

export const LABEL_PADDING = 5;

const FONT_STACKS: Record<FontFamilyName, string> = {
  hand: `${EXCALIFONT_FAMILY}, 'Segoe UI Emoji', 'Apple Color Emoji', ui-sans-serif, system-ui, sans-serif`,
  normal: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  code: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
};

const FONT_METRICS: Record<FontFamilyName, { ascender: number; descender: number }> = {
  hand: { ascender: 0.886, descender: 0.374 },
  normal: { ascender: 1577 / 2048, descender: 471 / 2048 },
  code: { ascender: 1900 / 2048, descender: 480 / 2048 },
};

const HAND_FAMILIES = new Set<number>([1, FONT_FAMILIES.hand]);
const CODE_FAMILIES = new Set<number>([FONT_FAMILIES.code, 8]);

export function fontFamilyName(fontFamily: number): FontFamilyName {
  if (HAND_FAMILIES.has(fontFamily)) return "hand";
  if (CODE_FAMILIES.has(fontFamily)) return "code";
  return "normal";
}

export function fontStack(fontFamily: number): string {
  return FONT_STACKS[fontFamilyName(fontFamily)];
}

export function fontString(fontSize: number, fontFamily: number): string {
  return `${fontSize}px ${fontStack(fontFamily)}`;
}

export function textFont(element: Pick<TextElement, "fontSize" | "fontFamily">): string {
  return fontString(element.fontSize, element.fontFamily);
}

export function lineHeightPx(fontSize: number, lineHeight: number = LINE_HEIGHT): number {
  return fontSize * lineHeight;
}

export function baselineOffset(fontSize: number, fontFamily: number, lineHeight: number = LINE_HEIGHT): number {
  const metrics = FONT_METRICS[fontFamilyName(fontFamily)];
  const ascent = fontSize * metrics.ascender;
  const descent = fontSize * metrics.descender;
  const gap = (lineHeightPx(fontSize, lineHeight) - ascent - descent) / 2;
  return ascent + gap;
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

function breakWord(word: string, font: string, maxWidth: number, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = current + char;
    if (current !== "" && measure(candidate, font) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  pieces.push(current);
  return pieces;
}

function wrapLine(line: string, font: string, maxWidth: number, measure: MeasureText): string[] {
  if (measure(line, font) <= maxWidth) return [line];
  const tokens = line.match(/\s+|\S+/g) ?? [];
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current + token;
    if (measure(candidate, font) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (/^\s+$/.test(token)) {
      if (current !== "") lines.push(current.trimEnd());
      current = "";
      continue;
    }
    if (current.trim() !== "") lines.push(current.trimEnd());
    if (measure(token, font) <= maxWidth) {
      current = token;
      continue;
    }
    const pieces = breakWord(token, font, maxWidth, measure);
    lines.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1] ?? "";
  }
  if (current !== "" || lines.length === 0) lines.push(current.trimEnd());
  return lines;
}

export function wrapText(text: string, font: string, maxWidth: number, measure: MeasureText): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return text;
  return splitLines(text)
    .flatMap((line) => wrapLine(line, font, maxWidth, measure))
    .join("\n");
}

export type TextMetrics = { readonly width: number; readonly height: number };

export function measureTextBlock(
  text: string,
  fontSize: number,
  fontFamily: number,
  lineHeight: number,
  measure: MeasureText,
): TextMetrics {
  const font = fontString(fontSize, fontFamily);
  const lines = splitLines(text);
  const width = lines.reduce((widest, line) => Math.max(widest, measure(line, font)), 0);
  return { width, height: lines.length * lineHeightPx(fontSize, lineHeight) };
}

export function labelMaxWidth(container: Pick<ShapeElement, "type" | "width">): number {
  if (container.type === "ellipse") return Math.round((container.width / 2) * Math.SQRT2) - LABEL_PADDING * 2;
  if (container.type === "diamond") return Math.round(container.width / 2) - LABEL_PADDING * 2;
  return container.width - LABEL_PADDING * 2;
}

export function labelMaxHeight(container: Pick<ShapeElement, "type" | "height">): number {
  if (container.type === "ellipse") return Math.round((container.height / 2) * Math.SQRT2) - LABEL_PADDING * 2;
  if (container.type === "diamond") return Math.round(container.height / 2) - LABEL_PADDING * 2;
  return container.height - LABEL_PADDING * 2;
}

export function labelInnerOrigin(container: Pick<ShapeElement, "type" | "x" | "y" | "width" | "height">): Point {
  let offsetX = LABEL_PADDING;
  let offsetY = LABEL_PADDING;
  if (container.type === "ellipse") {
    offsetX += (container.width / 2) * (1 - Math.SQRT2 / 2);
    offsetY += (container.height / 2) * (1 - Math.SQRT2 / 2);
  }
  if (container.type === "diamond") {
    offsetX += container.width / 4;
    offsetY += container.height / 4;
  }
  return { x: container.x + offsetX, y: container.y + offsetY };
}

export function containerSizeForLabel(dimension: number, type: ShapeType): number {
  const size = Math.ceil(dimension);
  const padding = LABEL_PADDING * 2;
  if (type === "ellipse") return Math.round(((size + padding) / Math.SQRT2) * 2);
  if (type === "diamond") return 2 * (size + padding);
  return size + padding;
}

export function labelPosition(
  container: Pick<ShapeElement, "type" | "x" | "y" | "width" | "height">,
  label: { width: number; height: number; textAlign: TextAlign; verticalAlign: VerticalAlign },
): Point {
  const origin = labelInnerOrigin(container);
  const maxWidth = labelMaxWidth(container);
  const maxHeight = labelMaxHeight(container);
  const y =
    label.verticalAlign === "top"
      ? origin.y
      : label.verticalAlign === "bottom"
        ? origin.y + maxHeight - label.height
        : origin.y + maxHeight / 2 - label.height / 2;
  const x =
    label.textAlign === "left"
      ? origin.x
      : label.textAlign === "right"
        ? origin.x + maxWidth - label.width
        : origin.x + maxWidth / 2 - label.width / 2;
  return { x, y };
}

export type LabelLayout = {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
};

export function computeLabelLayout(container: ShapeElement, label: TextElement, measure: MeasureText): LabelLayout {
  const maxWidth = labelMaxWidth(container);
  const text = wrapText(label.originalText, textFont(label), maxWidth, measure);
  const metrics = measureTextBlock(text, label.fontSize, label.fontFamily, label.lineHeight, measure);
  const containerHeight =
    metrics.height > labelMaxHeight(container) ? containerSizeForLabel(metrics.height, container.type) : container.height;
  const containerWidth =
    metrics.width > maxWidth ? containerSizeForLabel(metrics.width, container.type) : container.width;
  const grown = { ...container, width: containerWidth, height: containerHeight };
  const position = labelPosition(grown, { ...metrics, textAlign: label.textAlign, verticalAlign: label.verticalAlign });
  return { text, width: metrics.width, height: metrics.height, x: position.x, y: position.y, containerWidth, containerHeight };
}

export function approximateMeasure(text: string, font: string): number {
  const size = Number.parseFloat(font);
  const fontSize = Number.isFinite(size) ? size : 20;
  return [...text].length * fontSize * 0.55;
}

type MeasureContext = { font: string; measureText(text: string): { width: number } };

function isJsdom(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
}

function createMeasureContext(): MeasureContext | null {
  if (isJsdom()) return null;
  try {
    if (typeof document !== "undefined") return document.createElement("canvas").getContext("2d");
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1).getContext("2d");
    return null;
  } catch {
    return null;
  }
}

export function createCanvasMeasure(): MeasureText {
  let context: MeasureContext | null | undefined;
  let lastFont = "";
  return (text, font) => {
    if (context === undefined) context = createMeasureContext();
    if (context === null) return approximateMeasure(text, font);
    if (lastFont !== font) {
      context.font = font;
      lastFont = font;
    }
    return context.measureText(text).width;
  };
}
