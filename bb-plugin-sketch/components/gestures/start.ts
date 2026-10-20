import { selectedElements } from "../../lib/actions.js";
import { frameContains, selectionFrame, type Frame } from "../../lib/bounds.js";
import { linearEndAt } from "../../lib/gestures.js";
import { pickTarget } from "../../lib/hit.js";
import type { Point } from "../../lib/math.js";
import { handleAt, handleCursor, handlesFor, SELECTION_PADDING, type HandleId } from "../../lib/resize.js";
import { isLinear, type SketchElement } from "../../lib/scene.js";
import type { EditorController } from "../controller";
import type { EditorState } from "../editor-state";
import { startFreedraw, startLinear, startShape, startTextTool } from "./create";
import { startEraser } from "./erase";
import { startMarquee, startPress } from "./select";
import { startEndpoint, startResize } from "./transform";
import { TOUCH_SLOP, type Gesture, type PointerInput } from "./types";
import { startPan } from "./view";

export const MIDDLE_BUTTON = 1;

type SelectionTarget =
  | { readonly kind: "endpoint"; readonly id: string; readonly end: "start" | "end" }
  | { readonly kind: "handle"; readonly handle: HandleId; readonly frame: Frame }
  | { readonly kind: "element"; readonly id: string }
  | { readonly kind: "frame" }
  | { readonly kind: "none" };

function slopFor(pointerType: string): number | undefined {
  return pointerType === "touch" ? TOUCH_SLOP : undefined;
}

export function selectionTarget(state: EditorState, point: Point, pointerType: string): SelectionTarget {
  const { elements, selectedIds, view } = state;
  const zoom = view.zoom;
  const selected: SketchElement[] = selectedElements(elements, selectedIds);
  const single = selected.length === 1 ? selected[0] : undefined;
  if (single !== undefined && isLinear(single)) {
    const end = linearEndAt(single, point, zoom);
    if (end !== null) return { kind: "endpoint", id: single.id, end };
  }
  const frame = selectionFrame(selected);
  if (frame !== null) {
    const handle = handleAt(frame, handlesFor(selected), point, zoom);
    if (handle !== null) return { kind: "handle", handle, frame };
  }
  const id = pickTarget(elements, point, zoom, slopFor(pointerType));
  if (id !== null) return { kind: "element", id };
  if (frame !== null && frameContains(frame, point, SELECTION_PADDING / zoom)) return { kind: "frame" };
  return { kind: "none" };
}

function startSelect(controller: EditorController, input: PointerInput): Gesture {
  const target = selectionTarget(controller.state, input.scene, input.pointerType);
  switch (target.kind) {
    case "endpoint":
      return startEndpoint(controller, input, target.id, target.end);
    case "handle":
      return startResize(controller, input, target.handle) ?? startMarquee(controller, input);
    case "element":
      return startPress(controller, input, target.id);
    case "frame":
      return input.shift ? startMarquee(controller, input) : startPress(controller, input, null);
    case "none":
      return startMarquee(controller, input);
  }
}

export function startGesture(controller: EditorController, input: PointerInput, button: number): Gesture | null {
  const { tool, spaceHeld } = controller.state;
  if (button === MIDDLE_BUTTON || spaceHeld || tool === "hand") return startPan(controller, input);
  if (button !== 0) return null;
  switch (tool) {
    case "select":
      return startSelect(controller, input);
    case "rectangle":
    case "diamond":
    case "ellipse":
      return startShape(controller, input, tool);
    case "arrow":
    case "line":
      return startLinear(controller, input, tool);
    case "draw":
      return startFreedraw(controller, input);
    case "text":
      return startTextTool(controller, input);
    case "eraser":
      return startEraser(controller, input);
  }
}

export function hoverCursor(state: EditorState, point: Point, pointerType: string): string | null {
  if (state.tool !== "select" || state.spaceHeld) return null;
  const target = selectionTarget(state, point, pointerType);
  switch (target.kind) {
    case "endpoint":
      return "pointer";
    case "handle":
      return handleCursor(target.handle, target.frame.angle);
    case "element":
    case "frame":
      return "move";
    case "none":
      return null;
  }
}
