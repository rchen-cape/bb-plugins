import { isShape, type SketchElement, type TextElement } from "../lib/scene.js";
import { labelInnerOrigin, labelMaxWidth } from "../lib/text.js";
import { sceneToScreen, type Viewport } from "../lib/viewport.js";

export const CARET_SLACK = 4;

export type TextBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly wrap: boolean;
};

export function textBox(text: TextElement, elements: readonly SketchElement[], view: Viewport): TextBox {
  const container = text.containerId === null ? undefined : elements.find((element) => element.id === text.containerId);
  if (container !== undefined && isShape(container) && !container.isDeleted) {
    const inner = labelInnerOrigin(container);
    const width = labelMaxWidth(container);
    const corner = sceneToScreen(view, { x: inner.x, y: text.y });
    return { left: corner.x, top: corner.y, width: Math.max(1, width) * view.zoom, height: text.height * view.zoom, angle: container.angle, wrap: true };
  }
  const corner = sceneToScreen(view, { x: text.x, y: text.y });
  const shift = text.textAlign === "right" ? CARET_SLACK : text.textAlign === "center" ? CARET_SLACK / 2 : 0;
  return {
    left: corner.x - shift,
    top: corner.y,
    width: text.width * view.zoom + CARET_SLACK,
    height: text.height * view.zoom,
    angle: text.angle,
    wrap: false,
  };
}
