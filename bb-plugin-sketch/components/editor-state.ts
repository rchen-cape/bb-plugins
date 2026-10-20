import type { SketchStyle } from "../lib/elements.js";
import { createHistory, type History } from "../lib/history.js";
import type { Bounds, Point } from "../lib/math.js";
import type { SketchElement } from "../lib/scene.js";
import { DEFAULT_VIEWPORT, type Viewport, type ViewportSize } from "../lib/viewport.js";
import type { ToolId } from "./tools";

export type TextEdit = {
  readonly textId: string;
  readonly before: readonly SketchElement[];
  readonly beforeSelection: ReadonlySet<string>;
  readonly snapshot: readonly SketchElement[];
  readonly value: string;
};

export type EditorState = {
  readonly elements: readonly SketchElement[];
  readonly selectedIds: ReadonlySet<string>;
  readonly history: History;
  readonly view: Viewport;
  readonly size: ViewportSize;
  readonly tool: ToolId;
  readonly locked: boolean;
  readonly style: SketchStyle;
  readonly grid: boolean;
  readonly editing: TextEdit | null;
  readonly marquee: Bounds | null;
  readonly bindTargetId: string | null;
  readonly erasing: ReadonlySet<string>;
  readonly eraserTrail: readonly Point[];
  readonly eraserPointer: Point | null;
  readonly hoverCursor: string | null;
  readonly gestureActive: boolean;
  readonly panning: boolean;
  readonly spaceHeld: boolean;
};

export const NO_IDS: ReadonlySet<string> = new Set<string>();
export const NO_POINTS: readonly Point[] = [];

export type EditorInit = {
  readonly elements: readonly SketchElement[];
  readonly view: Viewport | null;
  readonly style: SketchStyle;
  readonly grid: boolean;
};

export function initialEditorState(init: EditorInit): EditorState {
  return {
    elements: init.elements,
    selectedIds: NO_IDS,
    history: createHistory({ elements: init.elements, selectedIds: NO_IDS }),
    view: init.view ?? DEFAULT_VIEWPORT,
    size: { width: 0, height: 0 },
    tool: "select",
    locked: false,
    style: init.style,
    grid: init.grid,
    editing: null,
    marquee: null,
    bindTargetId: null,
    erasing: NO_IDS,
    eraserTrail: NO_POINTS,
    eraserPointer: null,
    hoverCursor: null,
    gestureActive: false,
    panning: false,
    spaceHeld: false,
  };
}
