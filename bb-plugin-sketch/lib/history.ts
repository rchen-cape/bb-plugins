import type { SketchElement } from "./scene.js";

export const HISTORY_LIMIT = 100;

export type Snapshot = {
  readonly elements: readonly SketchElement[];
  readonly selectedIds: ReadonlySet<string>;
};

export type History = {
  readonly past: readonly Snapshot[];
  readonly present: Snapshot;
  readonly future: readonly Snapshot[];
};

export function sameElements(a: readonly SketchElement[], b: readonly SketchElement[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((element, i) => element === b[i]);
}

function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function existingSelection(snapshot: Snapshot): Snapshot {
  const ids = new Set(snapshot.elements.map((element) => element.id));
  const kept = [...snapshot.selectedIds].filter((id) => ids.has(id));
  return kept.length === snapshot.selectedIds.size ? snapshot : { ...snapshot, selectedIds: new Set(kept) };
}

export function createHistory(snapshot: Snapshot): History {
  return { past: [], present: existingSelection(snapshot), future: [] };
}

export function commit(history: History, snapshot: Snapshot, limit: number = HISTORY_LIMIT): History {
  const next = existingSelection(snapshot);
  if (sameElements(history.present.elements, next.elements)) {
    if (sameSelection(history.present.selectedIds, next.selectedIds)) return history;
    return { ...history, present: next };
  }
  const past = [...history.past, history.present];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}
