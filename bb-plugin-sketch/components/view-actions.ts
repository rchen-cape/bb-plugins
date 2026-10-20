import { exportElements } from "../lib/actions.js";
import { commonBounds } from "../lib/bounds.js";
import type { Point } from "../lib/math.js";
import {
  fitBounds,
  MAX_ZOOM,
  nextZoomStep,
  panBy,
  screenToScene,
  zoomAt,
  type Viewport,
  type ViewportSize,
} from "../lib/viewport.js";

export type ViewHost = {
  readonly state: {
    readonly view: Viewport;
    readonly size: ViewportSize;
    readonly elements: Parameters<typeof commonBounds>[0];
    readonly selectedIds: ReadonlySet<string>;
  };
  setView(view: Viewport): void;
};

export function viewCenter(size: ViewportSize): Point {
  return { x: size.width / 2, y: size.height / 2 };
}

export function sceneCenter(host: ViewHost): Point {
  return screenToScene(host.state.view, viewCenter(host.state.size));
}

export function zoomStep(host: ViewHost, direction: 1 | -1): void {
  const { view, size } = host.state;
  host.setView(zoomAt(view, nextZoomStep(view.zoom, direction), viewCenter(size)));
}

export function resetZoom(host: ViewHost): void {
  const { view, size } = host.state;
  host.setView(zoomAt(view, 1, viewCenter(size)));
}

export function fitAll(host: ViewHost): void {
  const bounds = commonBounds(host.state.elements);
  if (bounds !== null) host.setView(fitBounds(bounds, host.state.size));
}

export function fitSelection(host: ViewHost): void {
  const { elements, selectedIds, size } = host.state;
  const bounds = commonBounds(exportElements(elements, selectedIds));
  if (bounds !== null) host.setView(fitBounds(bounds, size, { maxZoom: MAX_ZOOM }));
}

export function panView(host: ViewHost, dx: number, dy: number): void {
  host.setView(panBy(host.state.view, dx, dy));
}

export function zoomBy(host: ViewHost, factor: number, screenPoint: Point): void {
  const { view } = host.state;
  host.setView(zoomAt(view, view.zoom * factor, screenPoint));
}
