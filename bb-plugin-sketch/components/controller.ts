import { applyStyle, normalizeSelection, type StylePatch } from "../lib/actions.js";
import type { SketchStyle } from "../lib/elements.js";
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "../lib/history.js";
import type { Point } from "../lib/math.js";
import type { SketchElement } from "../lib/scene.js";
import { GRID_SIZE } from "../lib/sketch.js";
import { createCanvasMeasure, type MeasureText } from "../lib/text.js";
import type { Viewport, ViewportSize } from "../lib/viewport.js";
import { initialEditorState, NO_IDS, NO_POINTS, type EditorInit, type EditorState } from "./editor-state";
import type { Gesture, PointerInput } from "./gestures/types";
import { Store } from "./store";
import { fitAll } from "./view-actions";
import { isDrawingTool, type ToolId } from "./tools";

export type CommitPatch = {
  readonly elements?: readonly SketchElement[];
  readonly selectedIds?: ReadonlySet<string>;
};

type ActiveGesture = { readonly pointerId: number; readonly gesture: Gesture };

export class EditorController {
  readonly store: Store<EditorState>;
  measure: MeasureText = createCanvasMeasure();
  pointerScene: Point | null = null;
  private active: ActiveGesture | null = null;
  private fitPending: boolean;

  constructor(init: EditorInit) {
    this.store = new Store(initialEditorState(init));
    this.fitPending = init.view === null && init.elements.length > 0;
  }

  get state(): EditorState {
    return this.store.get();
  }

  get gridSize(): number | null {
    return this.state.grid ? GRID_SIZE : null;
  }

  get zoom(): number {
    return this.state.view.zoom;
  }

  preview(elements: readonly SketchElement[], selectedIds?: ReadonlySet<string>): void {
    this.store.set(selectedIds === undefined ? { elements } : { elements, selectedIds });
  }

  commit(patch: CommitPatch = {}): void {
    const elements = patch.elements ?? this.state.elements;
    const selectedIds = patch.selectedIds ?? this.state.selectedIds;
    const history = commit(this.state.history, { elements, selectedIds });
    this.store.set({ elements, selectedIds: history.present.selectedIds, history });
  }

  restore(): void {
    const { present } = this.state.history;
    this.store.set({ elements: present.elements, selectedIds: present.selectedIds });
  }

  select(ids: Iterable<string>): void {
    this.commit({ selectedIds: normalizeSelection(this.state.elements, ids) });
  }

  clearSelection(): void {
    if (this.state.selectedIds.size > 0) this.commit({ selectedIds: NO_IDS });
  }

  load(elements: readonly SketchElement[], grid: boolean): void {
    this.cancelGesture();
    this.store.set({
      elements,
      grid,
      selectedIds: NO_IDS,
      history: createHistory({ elements, selectedIds: NO_IDS }),
      editing: null,
      marquee: null,
      bindTargetId: null,
      erasing: NO_IDS,
      eraserTrail: NO_POINTS,
    });
  }

  get busy(): boolean {
    return this.active !== null || this.state.editing !== null;
  }

  canUndo(): boolean {
    return !this.busy && canUndo(this.state.history);
  }

  canRedo(): boolean {
    return !this.busy && canRedo(this.state.history);
  }

  undo(): void {
    if (!this.busy) this.loadHistory(undo(this.state.history));
  }

  redo(): void {
    if (!this.busy) this.loadHistory(redo(this.state.history));
  }

  private loadHistory(history: History): void {
    if (history === this.state.history) return;
    this.store.set({ history, elements: history.present.elements, selectedIds: history.present.selectedIds });
  }

  setTool(tool: ToolId): void {
    this.cancelGesture();
    const clear = isDrawingTool(tool) || tool === "eraser";
    if (clear && this.state.selectedIds.size > 0) this.commit({ selectedIds: NO_IDS });
    this.store.set({ tool, hoverCursor: null, eraserPointer: null });
  }

  toolDone(): void {
    if (!this.state.locked) this.setTool("select");
  }

  toggleLock(): void {
    this.store.set({ locked: !this.state.locked });
  }

  toggleGrid(): void {
    this.store.set({ grid: !this.state.grid });
  }

  setSpaceHeld(spaceHeld: boolean): void {
    this.store.set({ spaceHeld });
  }

  setView(view: Viewport): void {
    this.store.set({ view });
  }

  setSize(size: ViewportSize): void {
    if (size.width <= 0 || size.height <= 0) return;
    const current = this.state.size;
    if (current.width === size.width && current.height === size.height) return;
    this.store.set({ size });
    if (this.fitPending) {
      this.fitPending = false;
      fitAll(this);
    }
  }

  setMeasure(measure: MeasureText): void {
    this.measure = measure;
  }

  setStyle(patch: StylePatch, transient = false): void {
    const style: SketchStyle = { ...this.state.style, ...patch };
    const { elements, selectedIds } = this.state;
    const next = selectedIds.size === 0 ? elements : applyStyle(elements, selectedIds, patch, this.measure);
    this.store.set({ style });
    if (next === elements) return;
    if (transient) this.preview(next);
    else this.commit({ elements: next });
  }

  hasGesture(): boolean {
    return this.active !== null;
  }

  gestureFor(pointerId: number): Gesture | null {
    return this.active?.pointerId === pointerId ? this.active.gesture : null;
  }

  beginGesture(pointerId: number, gesture: Gesture): void {
    this.active = { pointerId, gesture };
    this.store.set({ gestureActive: true });
  }

  endGesture(pointerId: number, input: PointerInput): void {
    const active = this.active;
    if (active === null || active.pointerId !== pointerId) return;
    this.active = null;
    active.gesture.end(input);
    this.store.set({ gestureActive: false });
  }

  cancelGesture(): boolean {
    const active = this.active;
    if (active === null) return false;
    this.active = null;
    active.gesture.cancel();
    this.store.set({ gestureActive: false });
    return true;
  }
}
