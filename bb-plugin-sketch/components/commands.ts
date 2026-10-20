import type { EditorController } from "./controller";
import { editSelected } from "./editing";
import type { KeyCommand } from "./keys";
import {
  deleteSelected,
  duplicateSelected,
  groupSelected,
  nudgeSelected,
  reorderSelected,
  selectEverything,
  ungroupSelected,
} from "./scene-actions";
import { fitAll, fitSelection, resetZoom, zoomStep } from "./view-actions";

export type EditorUi = {
  readonly send: () => void;
  readonly shortcuts: () => void;
  readonly copyPng: () => void;
  readonly restoreFocus: () => void;
};

export function escape(controller: EditorController): void {
  if (controller.cancelGesture()) return;
  controller.clearSelection();
  controller.setTool("select");
}

function editCommand(controller: EditorController, command: KeyCommand): boolean {
  switch (command.kind) {
    case "delete":
      deleteSelected(controller);
      return true;
    case "edit-text":
      editSelected(controller);
      return true;
    case "select-all":
      selectEverything(controller);
      return true;
    case "duplicate":
      duplicateSelected(controller);
      return true;
    case "undo":
      controller.undo();
      return true;
    case "redo":
      controller.redo();
      return true;
    case "group":
      groupSelected(controller);
      return true;
    case "ungroup":
      ungroupSelected(controller);
      return true;
    case "reorder":
      reorderSelected(controller, command.move);
      return true;
    case "nudge":
      nudgeSelected(controller, command.dx, command.dy, command.big);
      return true;
    default:
      return false;
  }
}

function viewCommand(controller: EditorController, command: KeyCommand): boolean {
  switch (command.kind) {
    case "fit-all":
      fitAll(controller);
      return true;
    case "fit-selection":
      fitSelection(controller);
      return true;
    case "zoom-reset":
      resetZoom(controller);
      return true;
    case "zoom":
      zoomStep(controller, command.direction);
      return true;
    case "grid":
      controller.toggleGrid();
      return true;
    default:
      return false;
  }
}

export function runCommand(controller: EditorController, command: KeyCommand, ui: EditorUi): void {
  if (editCommand(controller, command) || viewCommand(controller, command)) return;
  switch (command.kind) {
    case "tool":
      controller.setTool(command.tool);
      return;
    case "lock":
      controller.toggleLock();
      return;
    case "escape":
      escape(controller);
      return;
    case "space":
      controller.setSpaceHeld(true);
      return;
    case "copy-png":
      ui.copyPng();
      return;
    case "send":
      ui.send();
      return;
    case "shortcuts":
      ui.shortcuts();
      return;
  }
}
