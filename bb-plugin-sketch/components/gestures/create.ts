import { createFreedraw, createLinear, createShape, updateElement } from "../../lib/elements.js";
import { appendFreedrawPoint, boxFromDrag, dragEndpoint, isTooSmall } from "../../lib/gestures.js";
import { snapPoint } from "../../lib/math.js";
import type { LinearType, ShapeElement, ShapeType, SketchElement } from "../../lib/scene.js";
import type { EditorController } from "../controller";
import { NO_IDS } from "../editor-state";
import { editAt } from "../editing";
import { TOUCH_SLOP, type Gesture, type PointerInput } from "./types";

function finishCreate(controller: EditorController, elements: readonly SketchElement[], created: SketchElement): void {
  if (isTooSmall(created, controller.zoom)) {
    controller.restore();
    return;
  }
  const locked = controller.state.locked;
  controller.commit({ elements, selectedIds: locked ? NO_IDS : new Set([created.id]) });
  controller.toolDone();
}

export function startShape(controller: EditorController, input: PointerInput, type: ShapeType): Gesture {
  const base = controller.state.elements;
  const origin = snapPoint(input.scene, controller.gridSize);
  let element: ShapeElement = createShape(type, { x: origin.x, y: origin.y, width: 0, height: 0 }, controller.state.style);
  controller.preview([...base, element], NO_IDS);
  return {
    move(next) {
      const pointer = snapPoint(next.scene, controller.gridSize);
      element = updateElement(element, boxFromDrag(origin, pointer, { shift: next.shift, alt: next.alt }));
      controller.preview([...base, element]);
    },
    end(next) {
      this.move(next);
      finishCreate(controller, [...base, element], element);
    },
    cancel() {
      controller.restore();
    },
  };
}

export function startLinear(controller: EditorController, input: PointerInput, type: LinearType): Gesture {
  const before = controller.state.elements;
  const start = snapPoint(input.scene, controller.gridSize);
  const created = createLinear(type, start, [[0, 0], [0, 0]], controller.state.style);
  const options = { zoom: controller.zoom, gridSize: controller.gridSize };
  const base = dragEndpoint([...before, created], created.id, "start", start, { ...options, shift: false, bind: true }).elements;
  let current = base;
  controller.preview(base, NO_IDS);
  return {
    move(next) {
      const result = dragEndpoint(base, created.id, "end", next.scene, { ...options, shift: next.shift, bind: !next.mod });
      current = result.elements;
      controller.store.set({ elements: current, bindTargetId: result.bindTargetId });
    },
    end(next) {
      this.move(next);
      controller.store.set({ bindTargetId: null });
      const element = current.find((candidate) => candidate.id === created.id);
      if (element === undefined) controller.restore();
      else finishCreate(controller, current, element);
    },
    cancel() {
      controller.store.set({ bindTargetId: null });
      controller.restore();
    },
  };
}

export function startFreedraw(controller: EditorController, input: PointerInput): Gesture {
  const base = controller.state.elements;
  const pen = input.pointerType === "pen";
  let element = createFreedraw(input.scene, controller.state.style, pen ? input.pressure : null);
  controller.preview([...base, element], NO_IDS);
  const add = (next: PointerInput) => {
    for (const sample of next.samples) element = appendFreedrawPoint(element, sample.scene, pen ? sample.pressure : null);
    controller.preview([...base, element]);
  };
  return {
    move: add,
    end(next) {
      add(next);
      controller.commit({ elements: [...base, element], selectedIds: NO_IDS });
    },
    cancel() {
      controller.restore();
    },
  };
}

export function startTextTool(controller: EditorController, input: PointerInput): Gesture {
  return {
    move() {
      return;
    },
    end() {
      editAt(controller, input.scene, input.pointerType === "touch" ? TOUCH_SLOP : undefined);
      controller.toolDone();
    },
    cancel() {
      return;
    },
  };
}
