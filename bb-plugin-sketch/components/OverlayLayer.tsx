import { useMemo } from "react";
import { selectedElements } from "../lib/actions.js";
import { frameCorners, selectionFrame } from "../lib/bounds.js";
import { linearEndHandles } from "../lib/gestures.js";
import type { Point } from "../lib/math.js";
import { elementTransform, highlightPath, transformAttribute } from "../lib/render.js";
import { HANDLE_SIZE, handlePositions, handlesFor, SELECTION_PADDING } from "../lib/resize.js";
import { isLinear, type SketchElement } from "../lib/scene.js";
import { viewTransform } from "../lib/viewport.js";
import { useEditor } from "./editor-context";

const ENDPOINT_RADIUS = 5;
const ERASER_RADIUS = 7;
const HIGHLIGHT_INFLATE = 4;

function points(list: readonly Point[]): string {
  return list.map((p) => `${p.x},${p.y}`).join(" ");
}

function SelectionBox({ elements, zoom }: { elements: readonly SketchElement[]; zoom: number }) {
  const only = elements.length === 1 ? elements[0] : undefined;
  if (only !== undefined && isLinear(only)) {
    const ends = linearEndHandles(only);
    if (ends === null) return null;
    return (
      <g data-selection="endpoints">
        {[ends.start, ends.end].map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={ENDPOINT_RADIUS / zoom}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            className="fill-background stroke-primary"
          />
        ))}
      </g>
    );
  }
  const frame = selectionFrame(elements);
  if (frame === null) return null;
  const outline = frameCorners(frame, SELECTION_PADDING / zoom);
  const handles = handlePositions(frame, zoom, handlesFor(elements));
  const size = HANDLE_SIZE / zoom;
  return (
    <g data-selection="box">
      {elements.length > 1
        ? elements.map((element) => {
            const own = selectionFrame([element]);
            if (own === null) return null;
            return (
              <polygon
                key={element.id}
                points={points(frameCorners(own, 1 / zoom))}
                fill="none"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
                className="stroke-primary opacity-40"
              />
            );
          })
        : null}
      <polygon points={points(outline)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-primary" />
      {handles.map(({ id, point }) => (
        <rect
          key={id}
          data-handle={id}
          x={point.x - size / 2}
          y={point.y - size / 2}
          width={size}
          height={size}
          rx={2 / zoom}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          transform={frame.angle === 0 ? undefined : `rotate(${(frame.angle * 180) / Math.PI} ${point.x} ${point.y})`}
          className="fill-background stroke-primary"
        />
      ))}
    </g>
  );
}

function BindHighlight({ target, zoom }: { target: SketchElement; zoom: number }) {
  return (
    <g transform={transformAttribute(elementTransform(target))} data-bind-target={target.id}>
      <path d={highlightPath(target, HIGHLIGHT_INFLATE / zoom)} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className="stroke-primary opacity-50" />
    </g>
  );
}

function Marquee({ zoom }: { zoom: number }) {
  const marquee = useEditor((state) => state.marquee);
  if (marquee === null) return null;
  return (
    <rect
      data-marquee=""
      x={marquee.minX}
      y={marquee.minY}
      width={marquee.maxX - marquee.minX}
      height={marquee.maxY - marquee.minY}
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
      className="fill-primary/5 stroke-primary"
      rx={1 / zoom}
    />
  );
}

function Eraser({ zoom }: { zoom: number }) {
  const trail = useEditor((state) => state.eraserTrail);
  const pointer = useEditor((state) => state.eraserPointer);
  const tool = useEditor((state) => state.tool);
  if (tool !== "eraser") return null;
  return (
    <g>
      {trail.length > 1 ? (
        <polyline
          points={points(trail)}
          fill="none"
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground opacity-30"
        />
      ) : null}
      {pointer === null ? null : (
        <circle cx={pointer.x} cy={pointer.y} r={ERASER_RADIUS / zoom} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-foreground" />
      )}
    </g>
  );
}

function Selection({ zoom }: { zoom: number }) {
  const elements = useEditor((state) => state.elements);
  const selectedIds = useEditor((state) => state.selectedIds);
  const editing = useEditor((state) => state.editing !== null);
  const bindTargetId = useEditor((state) => state.bindTargetId);
  const selected = useMemo(() => selectedElements(elements, selectedIds), [elements, selectedIds]);
  const target = bindTargetId === null ? undefined : elements.find((element) => element.id === bindTargetId);
  return (
    <>
      {editing || selected.length === 0 ? null : <SelectionBox elements={selected} zoom={zoom} />}
      {target === undefined ? null : <BindHighlight target={target} zoom={zoom} />}
    </>
  );
}

export function OverlayLayer() {
  const view = useEditor((state) => state.view);
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true" data-sketch-overlay="">
      <g transform={viewTransform(view)}>
        <Selection zoom={view.zoom} />
        <Marquee zoom={view.zoom} />
        <Eraser zoom={view.zoom} />
      </g>
    </svg>
  );
}
