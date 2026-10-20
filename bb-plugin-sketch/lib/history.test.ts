import { describe, expect, it } from "vitest";
import { updateElement } from "./elements";
import { HISTORY_LIMIT, canRedo, canUndo, commit, createHistory, redo, sameElements, undo, type Snapshot } from "./history";
import type { SketchElement } from "./scene";
import { rect } from "./test-fixtures";

function snap(elements: readonly SketchElement[], selected: string[] = []): Snapshot {
  return { elements, selectedIds: new Set(selected) };
}

describe("history", () => {
  const a = rect(0, 0, 10, 10);
  const b = rect(20, 0, 10, 10);

  it("records element changes and undoes them with their selection", () => {
    let history = createHistory(snap([a]));
    history = commit(history, snap([a, b], [b.id]));
    expect(canUndo(history)).toBe(true);
    history = undo(history);
    expect(history.present.elements).toEqual([a]);
    expect([...history.present.selectedIds]).toEqual([]);
    expect(canRedo(history)).toBe(true);
    history = redo(history);
    expect(history.present.elements).toEqual([a, b]);
    expect([...history.present.selectedIds]).toEqual([b.id]);
  });

  it("treats selection-only changes as part of the present state", () => {
    let history = createHistory(snap([a, b]));
    history = commit(history, snap([a, b], [a.id]));
    expect(history.past).toHaveLength(0);
    expect([...history.present.selectedIds]).toEqual([a.id]);
    const moved = updateElement(a, { x: 5 });
    history = commit(history, snap([moved, b], [a.id]));
    history = undo(history);
    expect([...history.present.selectedIds]).toEqual([a.id]);
    expect(history.present.elements[0]).toBe(a);
  });

  it("ignores identical commits", () => {
    const history = createHistory(snap([a]));
    expect(commit(history, snap([a]))).toBe(history);
    expect(commit(history, { elements: [...history.present.elements], selectedIds: new Set() })).toBe(history);
  });

  it("clears redo on a new change", () => {
    let history = createHistory(snap([a]));
    history = commit(history, snap([a, b]));
    history = undo(history);
    history = commit(history, snap([b]));
    expect(canRedo(history)).toBe(false);
    expect(redo(history)).toBe(history);
  });

  it("does nothing at either end", () => {
    const history = createHistory(snap([a]));
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it("keeps the last 100 steps", () => {
    let history = createHistory(snap([]));
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) history = commit(history, snap([rect(i, 0, 1, 1)]));
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    let steps = 0;
    while (canUndo(history)) {
      history = undo(history);
      steps += 1;
    }
    expect(steps).toBe(HISTORY_LIMIT);
    expect(history.present.elements[0]?.x).toBe(19);
  });

  it("drops selected ids that no longer exist", () => {
    const history = createHistory(snap([a], [a.id, "gone"]));
    expect([...history.present.selectedIds]).toEqual([a.id]);
  });

  it("compares element lists by identity", () => {
    expect(sameElements([a, b], [a, b])).toBe(true);
    expect(sameElements([a, b], [b, a])).toBe(false);
    expect(sameElements([a], [{ ...a }])).toBe(false);
  });
});
