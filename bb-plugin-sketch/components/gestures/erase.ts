import { eraseElements, normalizeSelection } from "../../lib/actions.js";
import { elementsAlongPath } from "../../lib/hit.js";
import type { Point } from "../../lib/math.js";
import type { EditorController } from "../controller";
import { NO_IDS, NO_POINTS } from "../editor-state";
import type { Gesture, PointerInput } from "./types";

const TRAIL_LENGTH = 16;

export function startEraser(controller: EditorController, input: PointerInput): Gesture {
  const elements = controller.state.elements;
  const zoom = controller.zoom;
  const ids = new Set<string>(elementsAlongPath(elements, input.scene, input.scene, zoom));
  let last: Point = input.scene;
  let trail: readonly Point[] = [input.scene];
  controller.store.set({ erasing: new Set(ids), eraserTrail: trail, eraserPointer: input.scene });
  const add = (next: PointerInput) => {
    for (const sample of next.samples) {
      for (const id of elementsAlongPath(elements, last, sample.scene, zoom)) ids.add(id);
      last = sample.scene;
      trail = [...trail, sample.scene].slice(-TRAIL_LENGTH);
    }
    controller.store.set({ erasing: new Set(ids), eraserTrail: trail, eraserPointer: next.scene });
  };
  const clear = () => controller.store.set({ erasing: NO_IDS, eraserTrail: NO_POINTS });
  return {
    move: add,
    end(next) {
      add(next);
      clear();
      if (ids.size === 0) return;
      const erased = eraseElements(elements, ids);
      controller.commit({ elements: erased, selectedIds: normalizeSelection(erased, controller.state.selectedIds) });
    },
    cancel: clear,
  };
}
