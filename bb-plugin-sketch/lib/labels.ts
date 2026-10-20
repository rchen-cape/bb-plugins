import { addBoundElement, applyOverlay, updateBoundArrows } from "./binding.js";
import { deleteElements } from "./delete.js";
import { createText, elementMap, updateElement, type SketchStyle } from "./elements.js";
import { isShape, type ShapeElement, type SketchElement, type TextElement } from "./scene.js";
import { labelIndex, labelOf } from "./selection.js";
import { computeLabelLayout, measureTextBlock, normalizeText, type MeasureText } from "./text.js";

export type FittedLabel = { readonly container: ShapeElement; readonly label: TextElement };

const EPSILON = 1e-6;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

export function fitLabel(container: ShapeElement, label: TextElement, measure: MeasureText): FittedLabel {
  const layout = computeLabelLayout(container, label, measure);
  const grown = !near(layout.containerWidth, container.width) || !near(layout.containerHeight, container.height);
  const nextContainer = grown
    ? updateElement(container, { width: layout.containerWidth, height: layout.containerHeight })
    : container;
  const moved =
    label.text !== layout.text ||
    !near(label.width, layout.width) ||
    !near(label.height, layout.height) ||
    !near(label.x, layout.x) ||
    !near(label.y, layout.y) ||
    label.angle !== container.angle;
  const nextLabel = moved
    ? updateElement(label, {
        text: layout.text,
        width: layout.width,
        height: layout.height,
        x: layout.x,
        y: layout.y,
        angle: container.angle,
      })
    : label;
  return { container: nextContainer, label: nextLabel };
}

export function relayoutLabels(
  elements: readonly SketchElement[],
  containerIds: Iterable<string>,
  measure: MeasureText,
): readonly SketchElement[] {
  const byId = elementMap(elements);
  const changes = new Map<string, SketchElement>();
  const grown = new Set<string>();
  const labels = labelIndex(elements);
  for (const id of containerIds) {
    const container = byId.get(id);
    if (container === undefined || !isShape(container)) continue;
    const label = labels.get(container.id);
    if (label === undefined) continue;
    const fitted = fitLabel(container, label, measure);
    if (fitted.container !== container) {
      changes.set(container.id, fitted.container);
      grown.add(container.id);
    }
    if (fitted.label !== label) changes.set(label.id, fitted.label);
  }
  return updateBoundArrows(applyOverlay(elements, changes), grown);
}

function insertAfter(elements: readonly SketchElement[], anchorId: string, element: SketchElement): SketchElement[] {
  const index = elements.findIndex((candidate) => candidate.id === anchorId);
  if (index < 0) return [...elements, element];
  return [...elements.slice(0, index + 1), element, ...elements.slice(index + 1)];
}

export function ensureLabel(
  elements: readonly SketchElement[],
  containerId: string,
  style: SketchStyle,
  measure: MeasureText,
): { elements: readonly SketchElement[]; labelId: string } | null {
  const container = elements.find((element) => element.id === containerId);
  if (container === undefined || !isShape(container) || container.isDeleted) return null;
  const existing = labelOf(container, elements);
  if (existing !== null) return { elements, labelId: existing.id };
  const created = createText({ x: container.x, y: container.y }, "", style, measure, {
    containerId: container.id,
    textAlign: "center",
    verticalAlign: "middle",
  });
  const linked = addBoundElement(container, { id: created.id, type: "text" });
  const fitted = fitLabel(isShape(linked) ? linked : container, { ...created, angle: container.angle }, measure);
  const replaced = elements.map((element) => (element.id === container.id ? fitted.container : element));
  const next = insertAfter(replaced, container.id, fitted.label);
  return { elements: updateBoundArrows(next, new Set([container.id])), labelId: fitted.label.id };
}

export function beginTextEdit(
  elements: readonly SketchElement[],
  elementId: string,
  style: SketchStyle,
  measure: MeasureText,
): { elements: readonly SketchElement[]; textId: string } | null {
  const element = elements.find((candidate) => candidate.id === elementId);
  if (element === undefined || element.isDeleted) return null;
  if (element.type === "text") return { elements, textId: element.id };
  const labeled = ensureLabel(elements, elementId, style, measure);
  return labeled === null ? null : { elements: labeled.elements, textId: labeled.labelId };
}

function freeTextUpdate(element: TextElement, text: string, measure: MeasureText): TextElement {
  const metrics = measureTextBlock(text, element.fontSize, element.fontFamily, element.lineHeight, measure);
  const growth = element.width - metrics.width;
  const shift = element.textAlign === "center" ? growth / 2 : element.textAlign === "right" ? growth : 0;
  const unchanged =
    element.text === text &&
    element.originalText === text &&
    element.containerId === null &&
    near(element.width, metrics.width) &&
    near(element.height, metrics.height);
  if (unchanged) return element;
  return updateElement(element, {
    text,
    originalText: text,
    containerId: null,
    width: metrics.width,
    height: metrics.height,
    x: element.x + shift,
  });
}

export function commitText(
  elements: readonly SketchElement[],
  textId: string,
  value: string,
  measure: MeasureText,
): { elements: readonly SketchElement[]; deleted: boolean } {
  const element = elements.find((candidate) => candidate.id === textId);
  if (element === undefined || element.type !== "text") return { elements, deleted: false };
  const text = normalizeText(value);
  if (text.trim() === "") return { elements: deleteElements(elements, [textId]), deleted: true };
  const container = element.containerId === null ? undefined : elements.find((candidate) => candidate.id === element.containerId);
  if (container !== undefined && isShape(container) && !container.isDeleted) {
    const base = element.originalText === text ? element : updateElement(element, { originalText: text, text });
    const fitted = fitLabel(container, base, measure);
    if (fitted.label === element && fitted.container === container) return { elements, deleted: false };
    const next = applyOverlay(
      elements,
      new Map<string, SketchElement>([
        [fitted.label.id, fitted.label],
        [fitted.container.id, fitted.container],
      ]),
    );
    return { elements: fitted.container === container ? next : updateBoundArrows(next, new Set([container.id])), deleted: false };
  }
  const updated = freeTextUpdate(element, text, measure);
  if (updated === element) return { elements, deleted: false };
  const next = elements.map((candidate) => (candidate.id === textId ? updated : candidate));
  return { elements: updateBoundArrows(next, new Set([textId])), deleted: false };
}
