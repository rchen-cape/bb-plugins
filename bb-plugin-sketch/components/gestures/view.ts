import { distance, type Point } from "../../lib/math.js";
import { clampZoom, panBy, screenToScene, type Viewport } from "../../lib/viewport.js";
import type { EditorController } from "../controller";
import type { Gesture, PointerInput } from "./types";

export function startPan(controller: EditorController, input: PointerInput): Gesture {
  const startView = controller.state.view;
  const start = input.screen;
  controller.store.set({ panning: true });
  const stop = () => controller.store.set({ panning: false });
  return {
    move(next) {
      controller.setView(panBy(startView, next.screen.x - start.x, next.screen.y - start.y));
    },
    end(next) {
      this.move(next);
      stop();
    },
    cancel: stop,
  };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export type Pinch = { readonly view: Viewport; readonly mid: Point; readonly spread: number };

export function beginPinch(view: Viewport, a: Point, b: Point): Pinch {
  return { view, mid: midpoint(a, b), spread: Math.max(1, distance(a, b)) };
}

export function pinchView(pinch: Pinch, a: Point, b: Point): Viewport {
  const zoom = clampZoom((pinch.view.zoom * Math.max(1, distance(a, b))) / pinch.spread);
  const anchor = screenToScene(pinch.view, pinch.mid);
  const mid = midpoint(a, b);
  return { zoom, scrollX: mid.x / zoom - anchor.x, scrollY: mid.y / zoom - anchor.y };
}
