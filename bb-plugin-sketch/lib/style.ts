import { applyOverlay, updateBoundArrows } from "./binding.js";
import {
  ARROWHEADS,
  edgesOf,
  roundnessFor,
  updateElement,
  type Arrowhead,
  type SketchStyle,
} from "./elements.js";
import { fitLabel } from "./labels.js";
import {
  isShape,
  type ElementType,
  type LinearElement,
  type ShapeElement,
  type SketchElement,
  type StyledElement,
  type TextElement,
} from "./scene.js";
import { labelIndex, normalizeSelection, selectedElements } from "./selection.js";
import { measureTextBlock, type MeasureText } from "./text.js";

export type StyleField = keyof SketchStyle;
export type StylePatch = Partial<SketchStyle>;
export type StyleValue<K extends StyleField> = { readonly mixed: false; readonly value: SketchStyle[K] } | { readonly mixed: true };
export type StyleValues = { readonly [K in StyleField]?: StyleValue<K> };

export const STYLE_FIELDS: readonly StyleField[] = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "edges",
  "startArrowhead",
  "endArrowhead",
  "fontSize",
  "fontFamily",
  "textAlign",
  "opacity",
];

const SHAPE_FIELDS: readonly StyleField[] = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "edges",
  "opacity",
];
const ELLIPSE_FIELDS: readonly StyleField[] = SHAPE_FIELDS.filter((field) => field !== "edges");
const ARROW_FIELDS: readonly StyleField[] = [
  "strokeColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "edges",
  "startArrowhead",
  "endArrowhead",
  "opacity",
];
const LINE_FIELDS: readonly StyleField[] = SHAPE_FIELDS;
const FREEDRAW_FIELDS: readonly StyleField[] = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "opacity"];
const TEXT_FIELDS: readonly StyleField[] = ["strokeColor", "fontSize", "fontFamily", "textAlign", "opacity"];
const LABEL_FIELDS: readonly StyleField[] = ["fontSize", "fontFamily", "textAlign"];

export function styleFieldsFor(type: ElementType): readonly StyleField[] {
  switch (type) {
    case "rectangle":
    case "diamond":
      return SHAPE_FIELDS;
    case "ellipse":
      return ELLIPSE_FIELDS;
    case "arrow":
      return ARROW_FIELDS;
    case "line":
      return LINE_FIELDS;
    case "freedraw":
      return FREEDRAW_FIELDS;
    case "text":
      return TEXT_FIELDS;
    case "unsupported":
      return [];
  }
}

function inOrder(fields: ReadonlySet<StyleField>): StyleField[] {
  return STYLE_FIELDS.filter((field) => fields.has(field));
}

export function normalizeArrowhead(name: string | null): Arrowhead | null {
  if (name === null) return null;
  const base = name.endsWith("_outline") ? name.slice(0, -"_outline".length) : name;
  if (base === "dot") return "circle";
  return ARROWHEADS.find((known) => known === base) ?? "arrow";
}

type Getters = { readonly [K in StyleField]: (element: StyledElement) => SketchStyle[K] | undefined };

const GETTERS: Getters = {
  strokeColor: (element) => element.strokeColor,
  backgroundColor: (element) => element.backgroundColor,
  fillStyle: (element) => element.fillStyle,
  strokeWidth: (element) => element.strokeWidth,
  strokeStyle: (element) => element.strokeStyle,
  roughness: (element) => element.roughness,
  opacity: (element) => element.opacity,
  edges: (element) => edgesOf(element.roundness),
  startArrowhead: (element) => (element.type === "arrow" ? normalizeArrowhead(element.startArrowhead) : undefined),
  endArrowhead: (element) => (element.type === "arrow" ? normalizeArrowhead(element.endArrowhead) : undefined),
  fontSize: (element) => (element.type === "text" ? element.fontSize : undefined),
  fontFamily: (element) => (element.type === "text" ? element.fontFamily : undefined),
  textAlign: (element) => (element.type === "text" ? element.textAlign : undefined),
};

type Participant = { readonly element: StyledElement; readonly fields: readonly StyleField[] };

function participants(elements: readonly SketchElement[], ids: ReadonlySet<string>): Participant[] {
  const result: Participant[] = [];
  const labels = labelIndex(elements);
  for (const element of selectedElements(elements, normalizeSelection(elements, ids))) {
    if (element.type === "unsupported") continue;
    result.push({ element, fields: styleFieldsFor(element.type) });
    const label = isShape(element) ? labels.get(element.id) : undefined;
    if (label !== undefined) result.push({ element: label, fields: LABEL_FIELDS });
  }
  return result;
}

export function selectionStyleFields(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): StyleField[] {
  const fields = new Set<StyleField>();
  for (const entry of participants(elements, selectedIds)) for (const field of entry.fields) fields.add(field);
  return inOrder(fields);
}

function valueFor<K extends StyleField>(entries: readonly Participant[], field: K): StyleValue<K> | undefined {
  const getter: (element: StyledElement) => SketchStyle[K] | undefined = GETTERS[field];
  let found: { value: SketchStyle[K] } | null = null;
  let mixed = false;
  for (const entry of entries) {
    if (!entry.fields.includes(field)) continue;
    const value = getter(entry.element);
    if (value === undefined) continue;
    if (found === null) found = { value };
    else if (found.value !== value) mixed = true;
  }
  if (found === null) return undefined;
  return mixed ? { mixed: true } : { mixed: false, value: found.value };
}

export function selectionStyle(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): StyleValues {
  const entries = participants(elements, selectedIds);
  return {
    strokeColor: valueFor(entries, "strokeColor"),
    backgroundColor: valueFor(entries, "backgroundColor"),
    fillStyle: valueFor(entries, "fillStyle"),
    strokeWidth: valueFor(entries, "strokeWidth"),
    strokeStyle: valueFor(entries, "strokeStyle"),
    roughness: valueFor(entries, "roughness"),
    edges: valueFor(entries, "edges"),
    startArrowhead: valueFor(entries, "startArrowhead"),
    endArrowhead: valueFor(entries, "endArrowhead"),
    fontSize: valueFor(entries, "fontSize"),
    fontFamily: valueFor(entries, "fontFamily"),
    textAlign: valueFor(entries, "textAlign"),
    opacity: valueFor(entries, "opacity"),
  };
}

type CommonPatch = Partial<
  Pick<ShapeElement, "strokeColor" | "backgroundColor" | "fillStyle" | "strokeWidth" | "strokeStyle" | "roughness" | "opacity" | "roundness">
>;
type ArrowPatch = Partial<Pick<LinearElement, "startArrowhead" | "endArrowhead">>;
type TextPatch = Partial<Pick<TextElement, "fontSize" | "fontFamily" | "textAlign">>;

function commonPatch(element: StyledElement, fields: readonly StyleField[], patch: StylePatch): CommonPatch {
  const out: CommonPatch = {};
  const has = (field: StyleField): boolean => fields.includes(field);
  if (has("strokeColor") && patch.strokeColor !== undefined && patch.strokeColor !== element.strokeColor) out.strokeColor = patch.strokeColor;
  if (has("backgroundColor") && patch.backgroundColor !== undefined && patch.backgroundColor !== element.backgroundColor) {
    out.backgroundColor = patch.backgroundColor;
  }
  if (has("fillStyle") && patch.fillStyle !== undefined && patch.fillStyle !== element.fillStyle) out.fillStyle = patch.fillStyle;
  if (has("strokeWidth") && patch.strokeWidth !== undefined && patch.strokeWidth !== element.strokeWidth) out.strokeWidth = patch.strokeWidth;
  if (has("strokeStyle") && patch.strokeStyle !== undefined && patch.strokeStyle !== element.strokeStyle) out.strokeStyle = patch.strokeStyle;
  if (has("roughness") && patch.roughness !== undefined && patch.roughness !== element.roughness) out.roughness = patch.roughness;
  if (has("opacity") && patch.opacity !== undefined && patch.opacity !== element.opacity) out.opacity = patch.opacity;
  if (has("edges") && patch.edges !== undefined && patch.edges !== edgesOf(element.roundness)) {
    out.roundness = roundnessFor(element.type, patch.edges);
  }
  return out;
}

function arrowPatch(element: LinearElement, fields: readonly StyleField[], patch: StylePatch): ArrowPatch {
  const out: ArrowPatch = {};
  if (fields.includes("startArrowhead") && patch.startArrowhead !== undefined && patch.startArrowhead !== element.startArrowhead) {
    out.startArrowhead = patch.startArrowhead;
  }
  if (fields.includes("endArrowhead") && patch.endArrowhead !== undefined && patch.endArrowhead !== element.endArrowhead) {
    out.endArrowhead = patch.endArrowhead;
  }
  return out;
}

function textPatch(element: TextElement, fields: readonly StyleField[], patch: StylePatch): TextPatch {
  const out: TextPatch = {};
  if (fields.includes("fontSize") && patch.fontSize !== undefined && patch.fontSize !== element.fontSize) out.fontSize = patch.fontSize;
  if (fields.includes("fontFamily") && patch.fontFamily !== undefined && patch.fontFamily !== element.fontFamily) out.fontFamily = patch.fontFamily;
  if (fields.includes("textAlign") && patch.textAlign !== undefined && patch.textAlign !== element.textAlign) out.textAlign = patch.textAlign;
  return out;
}

function isEmpty(patch: object): boolean {
  return Object.keys(patch).length === 0;
}

function restyle(element: StyledElement, fields: readonly StyleField[], patch: StylePatch): StyledElement {
  const common = commonPatch(element, fields, patch);
  if (element.type === "text") {
    const merged = { ...common, ...textPatch(element, fields, patch) };
    return isEmpty(merged) ? element : updateElement(element, merged);
  }
  if (element.type === "arrow" || element.type === "line") {
    const merged = { ...common, ...arrowPatch(element, fields, patch) };
    return isEmpty(merged) ? element : updateElement(element, merged);
  }
  return isEmpty(common) ? element : updateElement<StyledElement>(element, common);
}

function remeasureFreeText(previous: TextElement, next: TextElement, measure: MeasureText): TextElement {
  if (previous.fontSize === next.fontSize && previous.fontFamily === next.fontFamily) return next;
  const metrics = measureTextBlock(next.text, next.fontSize, next.fontFamily, next.lineHeight, measure);
  const shift =
    previous.textAlign === "left" ? 0 : (previous.width - metrics.width) / (previous.textAlign === "center" ? 2 : 1);
  return {
    ...next,
    width: metrics.width,
    height: metrics.height,
    x: previous.x + shift,
    y: previous.y + (previous.height - metrics.height) / 2,
  };
}

const LABEL_PATCH_FIELDS: readonly StyleField[] = ["strokeColor", "opacity", ...LABEL_FIELDS];

type StyleChanges = { readonly changes: Map<string, SketchElement>; readonly resized: Set<string> };

function restyleFreeText(element: TextElement, patch: StylePatch, measure: MeasureText, out: StyleChanges): void {
  const restyled = restyle(element, TEXT_FIELDS, patch);
  if (restyled === element || restyled.type !== "text") return;
  const measured = remeasureFreeText(element, restyled, measure);
  out.changes.set(element.id, measured);
  if (measured.width !== element.width || measured.height !== element.height) out.resized.add(element.id);
}

function restyleContainer(
  container: ShapeElement,
  label: TextElement,
  patch: StylePatch,
  measure: MeasureText,
  out: StyleChanges,
): void {
  const restyled = restyle(container, styleFieldsFor(container.type), patch);
  const restyledLabel = restyle(label, LABEL_PATCH_FIELDS, patch);
  if (restyled === container && restyledLabel === label) return;
  const fitted = fitLabel(isShape(restyled) ? restyled : container, restyledLabel.type === "text" ? restyledLabel : label, measure);
  out.changes.set(fitted.container.id, fitted.container);
  out.changes.set(fitted.label.id, fitted.label);
  if (fitted.container.width !== container.width || fitted.container.height !== container.height) out.resized.add(container.id);
}

export function applyStyle(
  elements: readonly SketchElement[],
  selectedIds: ReadonlySet<string>,
  patch: StylePatch,
  measure: MeasureText,
): readonly SketchElement[] {
  const out: StyleChanges = { changes: new Map(), resized: new Set() };
  const labels = labelIndex(elements);
  for (const element of selectedElements(elements, normalizeSelection(elements, selectedIds))) {
    if (element.type === "unsupported") continue;
    if (element.type === "text") {
      restyleFreeText(element, patch, measure, out);
      continue;
    }
    const label = isShape(element) ? labels.get(element.id) : undefined;
    if (label !== undefined && isShape(element)) {
      restyleContainer(element, label, patch, measure, out);
      continue;
    }
    const restyled = restyle(element, styleFieldsFor(element.type), patch);
    if (restyled !== element) out.changes.set(element.id, restyled);
  }
  if (out.changes.size === 0) return elements;
  return updateBoundArrows(applyOverlay(elements, out.changes), out.resized);
}
