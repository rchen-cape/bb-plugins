import type { LinearEnd } from "../../lib/binding.js";
import { beginResize, dragEndpoint, pastDragThreshold, resizeTo } from "../../lib/gestures.js";
import { snapPoint } from "../../lib/math.js";
import type { HandleId } from "../../lib/resize.js";
import type { EditorController } from "../controller";
import type { Gesture, PointerInput } from "./types";

export function startResize(controller: EditorController, input: PointerInput, handle: HandleId): Gesture | null {
  const { elements, selectedIds } = controller.state;
  const gesture = beginResize(elements, selectedIds, handle, input.scene);
  if (gesture === null) return null;
  let moved = false;
  return {
    move(next) {
      if (!moved && !pastDragThreshold(input.screen, next.screen)) return;
      moved = true;
      const pointer = snapPoint(next.scene, controller.gridSize);
      controller.preview(resizeTo(gesture, pointer, { shift: next.shift, alt: next.alt }, controller.measure));
    },
    end(next) {
      this.move(next);
      controller.commit();
    },
    cancel() {
      controller.restore();
    },
  };
}

export function startEndpoint(controller: EditorController, input: PointerInput, linearId: string, end: LinearEnd): Gesture {
  const base = controller.state.elements;
  let moved = false;
  return {
    move(next) {
      if (!moved && !pastDragThreshold(input.screen, next.screen)) return;
      moved = true;
      const result = dragEndpoint(base, linearId, end, next.scene, {
        zoom: controller.zoom,
        shift: next.shift,
        bind: !next.mod,
        gridSize: controller.gridSize,
      });
      controller.store.set({ elements: result.elements, bindTargetId: result.bindTargetId });
    },
    end(next) {
      this.move(next);
      controller.store.set({ bindTargetId: null });
      controller.commit();
    },
    cancel() {
      controller.store.set({ bindTargetId: null });
      controller.restore();
    },
  };
}
