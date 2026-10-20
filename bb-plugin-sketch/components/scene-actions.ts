import {
  canGroup,
  canUngroup,
  deleteSelection,
  duplicateSelection,
  exportElements,
  groupSelection,
  nudgeSelection,
  reorderSelection,
  selectAll,
  ungroupSelection,
  type ZOrderMove,
} from "../lib/actions.js";
import { copySelection, pasteText } from "../lib/clipboard.js";
import type { Point } from "../lib/math.js";
import type { SketchElement } from "../lib/scene.js";
import { GRID_SIZE } from "../lib/sketch.js";
import type { EditorController } from "./controller";
import { sceneCenter } from "./view-actions";

export function hasSelection(controller: EditorController): boolean {
  return controller.state.selectedIds.size > 0;
}

function sceneState(controller: EditorController) {
  return { elements: controller.state.elements, selectedIds: controller.state.selectedIds };
}

export function deleteSelected(controller: EditorController): void {
  const next = deleteSelection(sceneState(controller));
  if (next.elements !== controller.state.elements) controller.commit(next);
}

export function duplicateSelected(controller: EditorController): void {
  const next = duplicateSelection(sceneState(controller));
  if (next.elements !== controller.state.elements) controller.commit(next);
}

export function reorderSelected(controller: EditorController, move: ZOrderMove): void {
  const { elements, selectedIds } = controller.state;
  const next = reorderSelection(elements, selectedIds, move);
  if (next !== elements) controller.commit({ elements: next });
}

export function groupSelected(controller: EditorController): void {
  const { elements, selectedIds } = controller.state;
  if (canGroup(elements, selectedIds)) controller.commit(groupSelection(sceneState(controller)));
}

export function ungroupSelected(controller: EditorController): void {
  const { elements, selectedIds } = controller.state;
  if (canUngroup(elements, selectedIds)) controller.commit(ungroupSelection(sceneState(controller)));
}

export function selectEverything(controller: EditorController): void {
  controller.setTool("select");
  controller.commit({ selectedIds: selectAll(controller.state.elements) });
}

export function nudgeSelected(controller: EditorController, dx: number, dy: number, big: boolean): void {
  const { elements, selectedIds, grid } = controller.state;
  if (selectedIds.size === 0) return;
  const step = big ? (grid ? GRID_SIZE : 5) : 1;
  const next = nudgeSelection(elements, selectedIds, { x: dx * step, y: dy * step });
  if (next !== elements) controller.commit({ elements: next });
}

export function copyText(controller: EditorController): string | null {
  return copySelection(controller.state.elements, controller.state.selectedIds);
}

export function cutSelected(controller: EditorController): string | null {
  const text = copyText(controller);
  if (text !== null) deleteSelected(controller);
  return text;
}

export function pastePoint(controller: EditorController): Point {
  return controller.pointerScene ?? sceneCenter(controller);
}

export function pasteInto(controller: EditorController, text: string, at: Point = pastePoint(controller)): boolean {
  const { elements, style } = controller.state;
  const result = pasteText(elements, text, at, { style, measure: controller.measure, gridSize: controller.gridSize });
  if (result === null) return false;
  controller.setTool("select");
  controller.commit(result);
  return true;
}

export function exportTargets(controller: EditorController): SketchElement[] {
  return exportElements(controller.state.elements, controller.state.selectedIds);
}
