import { hasPoints, localCenter, localToScene, rectangleRadius } from "./bounds.js";
import { boundsOfPoints, clamp, type Bounds } from "./math.js";
import { formatNumber, type ElementTransform, type RenderModel } from "./render-core.js";
import { freedrawModel } from "./render-freedraw.js";
import { linearModel, shapeModel, textModel, unsupportedModel } from "./render-shapes.js";
import type { SketchElement, StyledElement } from "./scene.js";
import { fontFamilyName } from "./text.js";

export {
  formatNumber,
  type ElementTransform,
  type RenderModel,
  type RenderPath,
  type RenderText,
  type RenderTextLine,
} from "./render-core.js";
export { strokeOutlinePath } from "./render-freedraw.js";
export { UNSUPPORTED_FILL, UNSUPPORTED_STROKE } from "./render-shapes.js";

const KEY_CACHE_LIMIT = 2000;
const PER_POINTS_LIMIT = 4;

const identityCache = new WeakMap<SketchElement, RenderModel>();
const keyCache = new Map<string, RenderModel>();
const pointsCache = new WeakMap<object, Map<string, RenderModel>>();

function buildModel(element: SketchElement): RenderModel {
  switch (element.type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      return shapeModel(element);
    case "arrow":
    case "line":
      return linearModel(element);
    case "freedraw":
      return freedrawModel(element);
    case "text":
      return textModel(element);
    case "unsupported":
      return unsupportedModel(element);
  }
}

function styleKeyParts(element: StyledElement): unknown[] {
  return [
    element.type,
    element.width,
    element.height,
    element.strokeColor,
    element.backgroundColor,
    element.fillStyle,
    element.strokeWidth,
    element.strokeStyle,
    element.roughness,
    element.seed,
    element.roundness?.type ?? null,
    element.roundness?.value ?? null,
  ];
}

export function shapeKey(element: SketchElement): string {
  switch (element.type) {
    case "unsupported":
      return JSON.stringify(["unsupported", element.originalType, element.width, element.height]);
    case "text":
      return JSON.stringify([
        ...styleKeyParts(element),
        element.text,
        element.fontSize,
        element.fontFamily,
        element.textAlign,
        element.lineHeight,
      ]);
    case "arrow":
    case "line":
      return JSON.stringify([...styleKeyParts(element), element.startArrowhead, element.endArrowhead, element.points.length]);
    case "freedraw":
      return JSON.stringify([...styleKeyParts(element), element.simulatePressure, element.pressures.length, element.points.length]);
    default:
      return JSON.stringify(styleKeyParts(element));
  }
}

function cachedByKey(key: string): RenderModel | undefined {
  const model = keyCache.get(key);
  if (model === undefined) return undefined;
  keyCache.delete(key);
  keyCache.set(key, model);
  return model;
}

function storeByKey(key: string, model: RenderModel): void {
  keyCache.set(key, model);
  if (keyCache.size <= KEY_CACHE_LIMIT) return;
  const oldest = keyCache.keys().next();
  if (oldest.done !== true) keyCache.delete(oldest.value);
}

function storeByPoints(anchor: object, key: string, model: RenderModel): void {
  const entries = pointsCache.get(anchor) ?? new Map<string, RenderModel>();
  entries.set(key, model);
  if (entries.size > PER_POINTS_LIMIT) {
    const oldest = entries.keys().next();
    if (oldest.done !== true) entries.delete(oldest.value);
  }
  pointsCache.set(anchor, entries);
}

export function renderModel(element: SketchElement): RenderModel {
  const known = identityCache.get(element);
  if (known !== undefined) return known;
  const key = shapeKey(element);
  const anchor = hasPoints(element) ? element.points : null;
  const cached = anchor === null ? cachedByKey(key) : pointsCache.get(anchor)?.get(key);
  const model = cached ?? buildModel(element);
  if (cached === undefined) {
    if (anchor === null) storeByKey(key, model);
    else storeByPoints(anchor, key, model);
  }
  identityCache.set(element, model);
  return model;
}

export function elementTransform(element: SketchElement): ElementTransform {
  const center = localCenter(element);
  const opacity = element.type === "unsupported" ? 1 : clamp(element.opacity, 0, 100) / 100;
  return { x: element.x, y: element.y, angle: element.angle, cx: center.x, cy: center.y, opacity };
}

export function transformAttribute(transform: ElementTransform): string {
  const translate = `translate(${formatNumber(transform.x)} ${formatNumber(transform.y)})`;
  if (transform.angle === 0) return translate;
  const degrees = (transform.angle * 180) / Math.PI;
  return `${translate} rotate(${formatNumber(degrees, 4)} ${formatNumber(transform.cx)} ${formatNumber(transform.cy)})`;
}

export function renderBounds(element: SketchElement): Bounds {
  const b = renderModel(element).bounds;
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  return boundsOfPoints(corners.map((corner) => localToScene(element, corner)));
}

export function usesHandFont(element: SketchElement): boolean {
  return element.type === "text" && fontFamilyName(element.fontFamily) === "hand" && element.text !== "";
}

function pathFromPoints(points: readonly { x: number; y: number }[]): string {
  return `${points.map((p, i) => `${i === 0 ? "M" : "L"}${formatNumber(p.x)} ${formatNumber(p.y)}`).join(" ")} Z`;
}

function insetRoundedRectangle(b: Bounds, radius: number): string {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const r = Math.min(radius, w / 2, h / 2);
  const x0 = formatNumber(b.minX);
  const y0 = formatNumber(b.minY);
  const x1 = formatNumber(b.maxX);
  const y1 = formatNumber(b.maxY);
  if (r <= 0) return `M${x0} ${y0} L${x1} ${y0} L${x1} ${y1} L${x0} ${y1} Z`;
  const f = (n: number): string => formatNumber(n);
  return [
    `M${f(b.minX + r)} ${y0} L${f(b.maxX - r)} ${y0} Q${x1} ${y0} ${x1} ${f(b.minY + r)}`,
    `L${x1} ${f(b.maxY - r)} Q${x1} ${y1} ${f(b.maxX - r)} ${y1}`,
    `L${f(b.minX + r)} ${y1} Q${x0} ${y1} ${x0} ${f(b.maxY - r)}`,
    `L${x0} ${f(b.minY + r)} Q${x0} ${y0} ${f(b.minX + r)} ${y0} Z`,
  ].join(" ");
}

export function highlightPath(element: SketchElement, inflate = 0): string {
  const w = Math.abs(element.width);
  const h = Math.abs(element.height);
  if (element.type === "ellipse") {
    const rx = formatNumber(w / 2 + inflate);
    const ry = formatNumber(h / 2 + inflate);
    const cy = formatNumber(h / 2);
    const left = formatNumber(-inflate);
    const right = formatNumber(w + inflate);
    return `M${left} ${cy} A${rx} ${ry} 0 1 0 ${right} ${cy} A${rx} ${ry} 0 1 0 ${left} ${cy} Z`;
  }
  if (element.type === "diamond") {
    return pathFromPoints([
      { x: w / 2, y: -inflate },
      { x: w + inflate, y: h / 2 },
      { x: w / 2, y: h + inflate },
      { x: -inflate, y: h / 2 },
    ]);
  }
  const b = hasPoints(element) ? boundsOfPoints(element.points.map(([x, y]) => ({ x, y }))) : { minX: 0, minY: 0, maxX: w, maxY: h };
  const inflated = { minX: b.minX - inflate, minY: b.minY - inflate, maxX: b.maxX + inflate, maxY: b.maxY + inflate };
  const radius = element.type === "rectangle" ? rectangleRadius(element) + (rectangleRadius(element) > 0 ? inflate : 0) : 0;
  return insetRoundedRectangle(inflated, radius);
}

function isLabelOf(element: SketchElement, containerId: string): boolean {
  return element.type === "text" && element.containerId === containerId;
}

export function renderOrder(elements: readonly SketchElement[]): readonly SketchElement[] {
  const ids = new Set(elements.map((element) => element.id));
  const labels = elements.filter((element) => element.type === "text" && element.containerId !== null && ids.has(element.containerId));
  if (labels.length === 0) return elements;
  const placed = new Set(labels.map((label) => label.id));
  const ordered: SketchElement[] = [];
  for (const element of elements) {
    if (placed.has(element.id)) continue;
    ordered.push(element);
    for (const label of labels) if (isLabelOf(label, element.id)) ordered.push(label);
  }
  const changed = ordered.some((element, index) => element !== elements[index]);
  return changed ? ordered : elements;
}
