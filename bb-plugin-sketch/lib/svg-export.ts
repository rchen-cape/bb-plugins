import { EXCALIFONT_FACES, EXCALIFONT_FAMILY } from "./excalifont.js";
import { unionBounds, type Bounds } from "./math.js";
import {
  elementTransform,
  formatNumber,
  renderBounds,
  renderModel,
  renderOrder,
  transformAttribute,
  usesHandFont,
  type RenderPath,
  type RenderText,
} from "./render.js";
import type { SketchElement } from "./scene.js";

type SvgExportOptions ={ padding: number; background: string | null; embedFont: boolean };
export type SvgExport = { svg: string; width: number; height: number };

const SVG_NS = "http://www.w3.org/2000/svg";
const SUSPECT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isXmlCodeUnit(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  return code >= 0x20 && code !== 0xfffe && code !== 0xffff;
}

export function stripInvalidXml(value: string): string {
  if (!SUSPECT_XML.test(value)) return value;
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(value.charCodeAt(i + 1))) {
        result += value.slice(i, i + 2);
        i += 1;
      }
      continue;
    }
    if (!isLowSurrogate(code) && isXmlCodeUnit(code)) result += value[i] ?? "";
  }
  return result;
}

export function escapeXml(value: string): string {
  return stripInvalidXml(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attributes(pairs: readonly (readonly [string, string | null])[]): string {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");
}

function paintValue(color: string | null): string {
  if (color === null) return "none";
  const trimmed = color.trim();
  return trimmed.toLowerCase() === "transparent" || trimmed === "" ? "none" : trimmed;
}

function pathMarkup(path: RenderPath): string {
  const stroked = path.stroke !== null;
  return `<path${attributes([
    ["d", path.d],
    ["fill", paintValue(path.fill)],
    ["fill-rule", path.fill !== null && path.fillRule === "evenodd" ? "evenodd" : null],
    ["stroke", paintValue(path.stroke)],
    ["stroke-width", stroked ? formatNumber(path.strokeWidth) : null],
    ["stroke-linecap", stroked ? path.lineCap : null],
    ["stroke-linejoin", stroked ? path.lineJoin : null],
    ["stroke-dasharray", stroked && path.dash !== null ? path.dash.map((n) => formatNumber(n)).join(" ") : null],
  ])}/>`;
}

function textMarkup(text: RenderText): string {
  return text.lines
    .filter((line) => line.text !== "")
    .map(
      (line) =>
        `<text${attributes([
          ["x", formatNumber(line.x)],
          ["y", formatNumber(line.y)],
          ["font-family", text.fontFamily],
          ["font-size", `${formatNumber(text.fontSize)}px`],
          ["fill", paintValue(text.fill)],
          ["text-anchor", text.anchor],
          ["style", "white-space: pre"],
          ["xml:space", "preserve"],
        ])}>${escapeXml(line.text)}</text>`,
    )
    .join("");
}

export function elementMarkup(element: SketchElement): string {
  const model = renderModel(element);
  const transform = elementTransform(element);
  const body = [...model.paths.map(pathMarkup), ...model.texts.map(textMarkup)].join("");
  if (body === "") return "";
  return `<g${attributes([
    ["transform", transformAttribute(transform)],
    ["opacity", transform.opacity < 1 ? formatNumber(transform.opacity, 3) : null],
  ])}>${body}</g>`;
}

export function exportBounds(elements: readonly SketchElement[]): Bounds | null {
  let result: Bounds | null = null;
  for (const element of elements) {
    if (element.isDeleted) continue;
    const bounds = renderBounds(element);
    result = result === null ? bounds : unionBounds(result, bounds);
  }
  return result;
}

export function fontFaceCss(): string {
  return EXCALIFONT_FACES.map((face) =>
    [
      "@font-face{",
      `font-family:"${EXCALIFONT_FAMILY}";`,
      `src:url(data:font/woff2;base64,${face.woff2Base64}) format("woff2");`,
      `unicode-range:${face.unicodeRange};`,
      "font-display:block;}",
    ].join(""),
  ).join("");
}

function backgroundMarkup(width: number, height: number, color: string): string {
  return `<rect${attributes([
    ["x", "0"],
    ["y", "0"],
    ["width", String(width)],
    ["height", String(height)],
    ["fill", paintValue(color)],
  ])}/>`;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function sceneToSvg(elements: readonly SketchElement[], options: SvgExportOptions): SvgExport {
  const visible = elements.filter((element) => !element.isDeleted);
  const padding = finiteNonNegative(options.padding);
  const bounds = exportBounds(visible) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  const width = Math.max(1, Math.ceil(contentWidth + padding * 2));
  const height = Math.max(1, Math.ceil(contentHeight + padding * 2));
  const offsetX = (width - contentWidth) / 2 - bounds.minX;
  const offsetY = (height - contentHeight) / 2 - bounds.minY;
  const font = options.embedFont && visible.some(usesHandFont) ? `<defs><style>${fontFaceCss()}</style></defs>` : "";
  const background = options.background === null ? "" : backgroundMarkup(width, height, options.background);
  const content = renderOrder(visible).map(elementMarkup).join("");
  const svg = [
    `<svg${attributes([
      ["xmlns", SVG_NS],
      ["version", "1.1"],
      ["width", String(width)],
      ["height", String(height)],
      ["viewBox", `0 0 ${width} ${height}`],
    ])}>`,
    font,
    background,
    `<g${attributes([["transform", `translate(${formatNumber(offsetX)} ${formatNumber(offsetY)})`]])}>${content}</g>`,
    "</svg>",
  ].join("");
  return { svg, width, height };
}
