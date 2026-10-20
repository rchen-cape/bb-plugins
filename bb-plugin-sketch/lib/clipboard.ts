import type { SceneState } from "./actions.js";
import { commonBounds } from "./bounds.js";
import { cloneElements, createText, type SketchStyle } from "./elements.js";
import { snapPoint, type Point } from "./math.js";
import { parseClipboard, serializeClipboard, type SketchElement } from "./scene.js";
import { normalizeSelection, selectedElements, withLabels } from "./selection.js";
import { normalizeText, type MeasureText } from "./text.js";

export const PASTE_TEXT_LIMIT = 100_000;

export type PasteOptions = {
  readonly style: SketchStyle;
  readonly measure: MeasureText;
  readonly gridSize: number | null;
};

export function clipboardElements(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): SketchElement[] {
  const normalized = normalizeSelection(elements, selectedIds);
  return selectedElements(elements, withLabels(elements, normalized));
}

export function copySelection(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): string | null {
  const copied = clipboardElements(elements, selectedIds);
  return copied.length === 0 ? null : serializeClipboard(copied);
}

function offsetTo(elements: readonly SketchElement[], at: Point, gridSize: number | null): Point {
  const bounds = commonBounds(elements);
  if (bounds === null) return { x: 0, y: 0 };
  const dx = at.x - (bounds.minX + bounds.maxX) / 2;
  const dy = at.y - (bounds.minY + bounds.maxY) / 2;
  const corner = snapPoint({ x: bounds.minX + dx, y: bounds.minY + dy }, gridSize);
  return { x: corner.x - bounds.minX, y: corner.y - bounds.minY };
}

export function placeElements(
  elements: readonly SketchElement[],
  incoming: readonly SketchElement[],
  at: Point,
  gridSize: number | null,
): SceneState {
  const { elements: clones } = cloneElements(incoming);
  const offset = offsetTo(clones, at, gridSize);
  const placed = clones.map((element) => ({ ...element, x: element.x + offset.x, y: element.y + offset.y }));
  const next = [...elements, ...placed];
  return { elements: next, selectedIds: normalizeSelection(next, placed.map((element) => element.id)) };
}

export function plainTextElement(text: string, at: Point, options: PasteOptions): SketchElement | null {
  const normalized = normalizeText(text).replace(/\n+$/, "");
  if (normalized.trim() === "") return null;
  const content = [...normalized].slice(0, PASTE_TEXT_LIMIT).join("");
  const draft = createText(at, content, options.style, options.measure);
  const corner = snapPoint({ x: at.x - draft.width / 2, y: at.y - draft.height / 2 }, options.gridSize);
  return { ...draft, x: corner.x, y: corner.y };
}

export function pasteText(
  elements: readonly SketchElement[],
  text: string,
  at: Point,
  options: PasteOptions,
): SceneState | null {
  const parsed = parseClipboard(text);
  if (parsed !== null) return parsed.length === 0 ? null : placeElements(elements, parsed, at, options.gridSize);
  const element = plainTextElement(text, at, options);
  if (element === null) return null;
  return { elements: [...elements, element], selectedIds: new Set([element.id]) };
}
