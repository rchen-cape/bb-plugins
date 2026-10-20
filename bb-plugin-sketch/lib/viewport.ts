import { clamp, type Bounds, type Point } from "./math.js";

export type Viewport = { readonly scrollX: number; readonly scrollY: number; readonly zoom: number };
export type ViewportSize = { readonly width: number; readonly height: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;
export const FIT_PADDING = 48;
export const DEFAULT_VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };

const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30];
const WHEEL_ZOOM_SPEED = 0.01;
const WHEEL_DELTA_LIMIT = 10;
const WHEEL_FRAME_ZOOM_LIMIT = 1.25;
const WHEEL_LINE_PX = 16;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function screenToScene(view: Viewport, p: Point): Point {
  return { x: p.x / view.zoom - view.scrollX, y: p.y / view.zoom - view.scrollY };
}

export function sceneToScreen(view: Viewport, p: Point): Point {
  return { x: (p.x + view.scrollX) * view.zoom, y: (p.y + view.scrollY) * view.zoom };
}

export function zoomAt(view: Viewport, zoom: number, screenPoint: Point): Viewport {
  const next = clampZoom(zoom);
  const anchor = screenToScene(view, screenPoint);
  return { zoom: next, scrollX: screenPoint.x / next - anchor.x, scrollY: screenPoint.y / next - anchor.y };
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, scrollX: view.scrollX + dx / view.zoom, scrollY: view.scrollY + dy / view.zoom };
}

export function centerOn(view: Viewport, scenePoint: Point, size: ViewportSize): Viewport {
  return {
    zoom: view.zoom,
    scrollX: size.width / 2 / view.zoom - scenePoint.x,
    scrollY: size.height / 2 / view.zoom - scenePoint.y,
  };
}

export type FitOptions = { readonly padding?: number; readonly maxZoom?: number };

export function fitBounds(bounds: Bounds, size: ViewportSize, options: FitOptions = {}): Viewport {
  const padding = options.padding ?? FIT_PADDING;
  const maxZoom = options.maxZoom ?? 1;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(Math.min(availableWidth / width, availableHeight / height, maxZoom));
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  return centerOn({ scrollX: 0, scrollY: 0, zoom }, center, size);
}

export function visibleSceneBounds(view: Viewport, size: ViewportSize): Bounds {
  const topLeft = screenToScene(view, { x: 0, y: 0 });
  const bottomRight = screenToScene(view, { x: size.width, y: size.height });
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
}

export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  const epsilon = 1e-6;
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + epsilon) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon) ?? MIN_ZOOM;
}

export function wheelDeltaPx(delta: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * WHEEL_LINE_PX;
  if (deltaMode === DOM_DELTA_PAGE) return delta * Math.max(1, pageHeight);
  return delta;
}

export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-clamp(deltaY, -WHEEL_DELTA_LIMIT, WHEEL_DELTA_LIMIT) * WHEEL_ZOOM_SPEED);
}

export function addWheelZoom(factor: number, deltaY: number): number {
  return clamp(factor * wheelZoomFactor(deltaY), 1 / WHEEL_FRAME_ZOOM_LIMIT, WHEEL_FRAME_ZOOM_LIMIT);
}

export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * wheelZoomFactor(deltaY));
}

export function viewTransform(view: Viewport): string {
  return `scale(${view.zoom}) translate(${view.scrollX} ${view.scrollY})`;
}
