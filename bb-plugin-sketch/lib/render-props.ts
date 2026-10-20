import { paint, type Theme } from "./colors.js";
import { formatNumber, type RenderPath, type RenderText } from "./render-core.js";
import { elementTransform, transformAttribute } from "./render.js";
import type { SketchElement } from "./scene.js";

export type PathProps = {
  readonly d: string;
  readonly fill: string;
  readonly fillRule: "nonzero" | "evenodd" | undefined;
  readonly stroke: string;
  readonly strokeWidth: number | undefined;
  readonly strokeLinecap: "round" | "butt" | undefined;
  readonly strokeLinejoin: "round" | "miter" | undefined;
  readonly strokeDasharray: string | undefined;
};

export type TextProps = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fill: string;
  readonly textAnchor: "start" | "middle" | "end";
  readonly style: { readonly whiteSpace: "pre" };
};

export type GroupProps = { readonly transform: string; readonly opacity: number | undefined };

export function pathProps(path: RenderPath, theme: Theme): PathProps {
  const stroked = path.stroke !== null;
  return {
    d: path.d,
    fill: paint(path.fill, theme),
    fillRule: path.fill !== null && path.fillRule === "evenodd" ? "evenodd" : undefined,
    stroke: paint(path.stroke, theme),
    strokeWidth: stroked ? path.strokeWidth : undefined,
    strokeLinecap: stroked ? path.lineCap : undefined,
    strokeLinejoin: stroked ? path.lineJoin : undefined,
    strokeDasharray: stroked && path.dash !== null ? path.dash.map((n) => formatNumber(n)).join(" ") : undefined,
  };
}

export function textProps(text: RenderText, theme: Theme): TextProps {
  return {
    fontFamily: text.fontFamily,
    fontSize: text.fontSize,
    fill: paint(text.fill, theme),
    textAnchor: text.anchor,
    style: { whiteSpace: "pre" },
  };
}

export function groupProps(element: SketchElement): GroupProps {
  const transform = elementTransform(element);
  return { transform: transformAttribute(transform), opacity: transform.opacity < 1 ? transform.opacity : undefined };
}
