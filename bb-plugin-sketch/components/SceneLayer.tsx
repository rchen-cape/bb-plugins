import { memo, useId, type ReactNode } from "react";
import type { Theme } from "../lib/colors.js";
import { renderModel, renderOrder } from "../lib/render.js";
import { groupProps, pathProps, textProps } from "../lib/render-props.js";
import type { SketchElement } from "../lib/scene.js";
import { GRID_SIZE } from "../lib/sketch.js";
import { viewTransform } from "../lib/viewport.js";
import { useEditor, useTheme } from "./editor-context";

const FADED_OPACITY = 0.25;
const GRID_MAJOR = 5;
const MIN_GRID_SPACING = 6;

type ElementViewProps = { readonly element: SketchElement; readonly theme: Theme; readonly faded: boolean };

export const ElementView = memo(function ElementView({ element, theme, faded }: ElementViewProps) {
  const model = renderModel(element);
  const group = groupProps(element);
  const opacity = faded ? (group.opacity ?? 1) * FADED_OPACITY : group.opacity;
  return (
    <g transform={group.transform} opacity={opacity} data-element-id={element.id} data-element-type={element.type}>
      {model.paths.map((path, index) => {
        const props = pathProps(path, theme);
        return (
          <path
            key={index}
            d={props.d}
            fill={props.fill}
            fillRule={props.fillRule}
            stroke={props.stroke}
            strokeWidth={props.strokeWidth}
            strokeLinecap={props.strokeLinecap}
            strokeLinejoin={props.strokeLinejoin}
            strokeDasharray={props.strokeDasharray}
          />
        );
      })}
      {model.texts.map((text, index) => {
        const props = textProps(text, theme);
        return text.lines.map((line, row) => (
          <text
            key={`${index}.${row}`}
            x={line.x}
            y={line.y}
            fontFamily={props.fontFamily}
            fontSize={props.fontSize}
            fill={props.fill}
            textAnchor={props.textAnchor}
            style={props.style}
          >
            {line.text}
          </text>
        ));
      })}
    </g>
  );
});

function isFaded(element: SketchElement, erasing: ReadonlySet<string>): boolean {
  if (erasing.size === 0) return false;
  if (erasing.has(element.id)) return true;
  return element.type === "text" && element.containerId !== null && erasing.has(element.containerId);
}

const ElementsLayer = memo(function ElementsLayer() {
  const elements = useEditor((state) => state.elements);
  const editingId = useEditor((state) => state.editing?.textId ?? null);
  const erasing = useEditor((state) => state.erasing);
  const theme = useTheme();
  return (
    <>
      {renderOrder(elements).map((element) =>
        element.isDeleted || element.id === editingId ? null : (
          <ElementView key={element.id} element={element} theme={theme} faded={isFaded(element, erasing)} />
        ),
      )}
    </>
  );
});

function ViewportGroup({ children }: { children: ReactNode }) {
  const view = useEditor((state) => state.view);
  return <g transform={viewTransform(view)}>{children}</g>;
}

function GridPattern({ id, spacing, offsetX, offsetY, className }: { id: string; spacing: number; offsetX: number; offsetY: number; className: string }) {
  return (
    <pattern id={id} width={spacing} height={spacing} x={offsetX} y={offsetY} patternUnits="userSpaceOnUse">
      <path d={`M ${spacing} 0 L 0 0 0 ${spacing}`} fill="none" strokeWidth={1} className={className} />
    </pattern>
  );
}

function GridLayer() {
  const grid = useEditor((state) => state.grid);
  const view = useEditor((state) => state.view);
  const baseId = useId();
  if (!grid) return null;
  const minor = GRID_SIZE * view.zoom;
  const major = minor * GRID_MAJOR;
  const offset = (scroll: number, spacing: number) => (((scroll * view.zoom) % spacing) + spacing) % spacing;
  const minorId = `${baseId}-minor`;
  const majorId = `${baseId}-major`;
  return (
    <g aria-hidden="true">
      <defs>
        <GridPattern id={minorId} spacing={minor} offsetX={offset(view.scrollX, minor)} offsetY={offset(view.scrollY, minor)} className="stroke-border opacity-50" />
        <GridPattern id={majorId} spacing={major} offsetX={offset(view.scrollX, major)} offsetY={offset(view.scrollY, major)} className="stroke-border" />
      </defs>
      {minor >= MIN_GRID_SPACING ? <rect width="100%" height="100%" fill={`url(#${minorId})`} /> : null}
      <rect width="100%" height="100%" fill={`url(#${majorId})`} />
    </g>
  );
}

export function SceneLayer() {
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" data-sketch-scene="">
      <GridLayer />
      <ViewportGroup>
        <ElementsLayer />
      </ViewportGroup>
    </svg>
  );
}
