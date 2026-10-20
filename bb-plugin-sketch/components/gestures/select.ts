import { duplicateSelection, normalizeSelection, toggleSelection } from "../../lib/actions.js";
import { beginMove, lockAxis, moveTo, pastDragThreshold, snapMoveDelta, type MoveGesture } from "../../lib/gestures.js";
import { elementsInMarquee } from "../../lib/hit.js";
import { boundsFromCorners, subtractPoints, type Point } from "../../lib/math.js";
import { selectionUnitCount } from "../../lib/selection.js";
import type { EditorController } from "../controller";
import { NO_IDS } from "../editor-state";
import type { Gesture, PointerInput } from "./types";

export function startMarquee(controller: EditorController, input: PointerInput): Gesture {
  const start = input.scene;
  const base = input.shift ? controller.state.selectedIds : NO_IDS;
  controller.store.set({ selectedIds: base, marquee: boundsFromCorners(start, start) });
  return {
    move(next) {
      const marquee = boundsFromCorners(start, next.scene);
      const elements = controller.state.elements;
      const inside = elementsInMarquee(elements, marquee);
      controller.store.set({ marquee, selectedIds: normalizeSelection(elements, [...base, ...inside]) });
    },
    end(next) {
      this.move(next);
      controller.store.set({ marquee: null });
      controller.commit();
    },
    cancel() {
      controller.store.set({ marquee: null });
      controller.restore();
    },
  };
}

function pressSelection(controller: EditorController, hitId: string | null, shift: boolean): { selection: ReadonlySet<string>; wasSelected: boolean } {
  const { elements, selectedIds } = controller.state;
  if (hitId === null) return { selection: selectedIds, wasSelected: true };
  const unit = normalizeSelection(elements, [hitId]);
  const wasSelected = unit.size > 0 && [...unit].every((id) => selectedIds.has(id));
  if (wasSelected) return { selection: selectedIds, wasSelected };
  return { selection: shift ? toggleSelection(elements, selectedIds, hitId) : unit, wasSelected };
}

function clickSelection(controller: EditorController, hitId: string | null, shift: boolean): ReadonlySet<string> {
  const { elements, selectedIds } = controller.state;
  if (hitId === null) return shift || selectionUnitCount(elements, selectedIds) <= 1 ? selectedIds : NO_IDS;
  if (shift) return toggleSelection(elements, selectedIds, hitId);
  return normalizeSelection(elements, [hitId]);
}

function beginDrag(controller: EditorController, duplicate: boolean): MoveGesture {
  const { elements, selectedIds } = controller.state;
  if (!duplicate) return beginMove(elements, selectedIds);
  const copy = duplicateSelection({ elements, selectedIds }, { x: 0, y: 0 });
  controller.preview(copy.elements, copy.selectedIds);
  return beginMove(copy.elements, copy.selectedIds);
}

function dragDelta(controller: EditorController, move: MoveGesture, start: Point, input: PointerInput): Point {
  const raw = subtractPoints(input.scene, start);
  const locked = input.shift ? lockAxis(raw) : raw;
  return snapMoveDelta(move.elements, move.movedIds, locked, controller.gridSize);
}

export function startPress(controller: EditorController, input: PointerInput, hitId: string | null): Gesture {
  const { selection, wasSelected } = pressSelection(controller, hitId, input.shift);
  controller.store.set({ selectedIds: selection });
  let move: MoveGesture | null = null;
  return {
    move(next) {
      if (move === null) {
        if (!pastDragThreshold(input.screen, next.screen)) return;
        move = beginDrag(controller, input.alt);
      }
      controller.preview(moveTo(move, dragDelta(controller, move, input.scene, next)));
    },
    end(next) {
      this.move(next);
      if (move !== null) {
        controller.commit();
        return;
      }
      controller.commit({ selectedIds: wasSelected ? clickSelection(controller, hitId, input.shift) : selection });
    },
    cancel() {
      controller.restore();
    },
  };
}
