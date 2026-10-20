import { beginTextEdit, commitText, normalizeSelection, selectedElements } from "../lib/actions.js";
import { createText, textOriginAt } from "../lib/elements.js";
import { editTargetAt } from "../lib/hit.js";
import type { Point } from "../lib/math.js";
import { isShape, type SketchElement, type TextElement } from "../lib/scene.js";
import type { EditorController } from "./controller";
import { NO_IDS } from "./editor-state";

export function isEditable(element: SketchElement | undefined): boolean {
  return element !== undefined && !element.isDeleted && (element.type === "text" || isShape(element));
}

function textOf(elements: readonly SketchElement[], id: string): TextElement | null {
  const found = elements.find((element) => element.id === id);
  return found?.type === "text" ? found : null;
}

export function startEditing(controller: EditorController, elementId: string): boolean {
  finishEditing(controller);
  const { elements, selectedIds, style } = controller.state;
  const result = beginTextEdit(elements, elementId, style, controller.measure);
  if (result === null) return false;
  const text = textOf(result.elements, result.textId);
  if (text === null) return false;
  controller.cancelGesture();
  controller.store.set({
    elements: result.elements,
    selectedIds: NO_IDS,
    editing: { textId: text.id, before: elements, beforeSelection: selectedIds, snapshot: result.elements, value: text.originalText },
  });
  return true;
}

export function createTextAt(controller: EditorController, point: Point): void {
  finishEditing(controller);
  const { elements, selectedIds, style } = controller.state;
  const text = createText(textOriginAt(point, style), "", style, controller.measure);
  const next = [...elements, text];
  controller.store.set({
    elements: next,
    selectedIds: NO_IDS,
    editing: { textId: text.id, before: elements, beforeSelection: selectedIds, snapshot: next, value: "" },
  });
}

export function updateEditing(controller: EditorController, value: string): void {
  const edit = controller.state.editing;
  if (edit === null) return;
  const elements = value.trim() === "" ? edit.snapshot : commitText(edit.snapshot, edit.textId, value, controller.measure).elements;
  controller.store.set({ editing: { ...edit, value }, elements });
}

function containerOf(elements: readonly SketchElement[], textId: string): string | null {
  return textOf(elements, textId)?.containerId ?? null;
}

export function finishEditing(controller: EditorController): void {
  const edit = controller.state.editing;
  if (edit === null) return;
  const result = commitText(edit.snapshot, edit.textId, edit.value, controller.measure);
  const created = !edit.before.some((element) => element.id === edit.textId);
  const containerId = containerOf(edit.snapshot, edit.textId);
  controller.store.set({ editing: null });
  if (result.deleted && created) {
    controller.commit({ elements: edit.before, selectedIds: containerId === null ? NO_IDS : new Set([containerId]) });
    return;
  }
  const selectedIds = result.deleted
    ? normalizeSelection(result.elements, containerId === null ? [] : [containerId])
    : normalizeSelection(result.elements, [edit.textId]);
  controller.commit({ elements: result.elements, selectedIds });
}

export function editSelected(controller: EditorController): boolean {
  const { elements, selectedIds } = controller.state;
  const selected = selectedElements(elements, selectedIds);
  const only = selected.length === 1 ? selected[0] : undefined;
  if (only === undefined || !isEditable(only)) return false;
  return startEditing(controller, only.id);
}

export function editAt(controller: EditorController, point: Point, slop?: number): void {
  const { elements } = controller.state;
  const id = editTargetAt(elements, point, controller.zoom, slop);
  const element = id === null ? undefined : elements.find((candidate) => candidate.id === id);
  if (element !== undefined && isEditable(element) && startEditing(controller, element.id)) return;
  createTextAt(controller, point);
}
