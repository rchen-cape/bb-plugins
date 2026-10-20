import { useEffect, type RefObject } from "react";
import type { Point } from "../lib/math.js";
import { addWheelZoom, wheelDeltaPx, zoomAt, type Viewport } from "../lib/viewport.js";
import type { EditorController } from "./controller";
import { panView, zoomBy } from "./view-actions";

type PendingWheel = { dx: number; dy: number; zoomFactor: number; point: Point };

function gestureScale(event: Event): number | null {
  return "scale" in event && typeof event.scale === "number" ? event.scale : null;
}

export function useCanvasWheel(ref: RefObject<HTMLElement | null>, controller: EditorController): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let pending: PendingWheel | null = null;
    let frame: number | null = null;
    let gestureStart: { view: Viewport; point: Point } | null = null;

    const apply = () => {
      frame = null;
      const next = pending;
      pending = null;
      if (next === null) return;
      if (next.zoomFactor !== 1) zoomBy(controller, next.zoomFactor, next.point);
      if (next.dx !== 0 || next.dy !== 0) panView(controller, next.dx, next.dy);
    };

    const localPoint = (event: { clientX: number; clientY: number }): Point => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dx = wheelDeltaPx(event.deltaX, event.deltaMode, element.clientHeight);
      const dy = wheelDeltaPx(event.deltaY, event.deltaMode, element.clientHeight);
      const current = pending ?? { dx: 0, dy: 0, zoomFactor: 1, point: localPoint(event) };
      if (event.ctrlKey || event.metaKey) current.zoomFactor = addWheelZoom(current.zoomFactor, dy);
      else if (event.shiftKey && dx === 0) current.dx -= dy;
      else {
        current.dx -= dx;
        current.dy -= dy;
      }
      current.point = localPoint(event);
      pending = current;
      frame ??= typeof requestAnimationFrame === "function" ? requestAnimationFrame(apply) : null;
      if (frame === null) apply();
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const point = "clientX" in event && "clientY" in event && typeof event.clientX === "number" && typeof event.clientY === "number"
        ? localPoint({ clientX: event.clientX, clientY: event.clientY })
        : { x: element.clientWidth / 2, y: element.clientHeight / 2 };
      gestureStart = { view: controller.state.view, point };
    };

    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = gestureScale(event);
      if (gestureStart === null || scale === null) return;
      controller.setView(zoomAt(gestureStart.view, gestureStart.view.zoom * scale, gestureStart.point));
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureStart = null;
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [ref, controller]);
}
