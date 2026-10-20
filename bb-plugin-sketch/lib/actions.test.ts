import { describe, expect, it } from "vitest";
import {
  applyStyle,
  beginTextEdit,
  canGroup,
  canUngroup,
  captionFor,
  commitText,
  deleteSelection,
  duplicateSelection,
  ensureLabel,
  eraseElements,
  exportElements,
  groupSelection,
  normalizeSelection,
  nudgeSelection,
  reorderSelection,
  selectAll,
  selectionStyle,
  selectionStyleFields,
  styleFieldsFor,
  toggleSelection,
  ungroupSelection,
  type SceneState,
} from "./actions";
import { bindEnd } from "./binding";
import { absolutePoints } from "./bounds";
import type { SketchElement, TextElement } from "./scene";
import { arrow, byId, ids, measure, rect, shape, styleWith, text } from "./test-fixtures";

function labeled(): { elements: readonly SketchElement[]; box: string; label: string } {
  const box = rect(0, 0, 100, 60);
  const created = ensureLabel([box], box.id, styleWith(), measure);
  if (created === null) throw new Error("no label");
  const committed = commitText(created.elements, created.labelId, "hello", measure);
  return { elements: committed.elements, box: box.id, label: created.labelId };
}

function textOf(elements: readonly SketchElement[], id: string): TextElement {
  const element = byId(elements, id);
  if (element.type !== "text") throw new Error("not text");
  return element;
}

function boundIds(elements: readonly SketchElement[], id: string): string[] {
  const element = byId(elements, id);
  return element.type === "unsupported" ? [] : (element.boundElements ?? []).map((entry) => entry.id);
}

describe("selection", () => {
  it("expands to outermost groups and maps labels to containers", () => {
    const { elements, box, label } = labeled();
    expect([...normalizeSelection(elements, [label])]).toEqual([box]);
    const a = rect(0, 0, 10, 10, { groupIds: ["inner", "outer"] });
    const b = rect(20, 0, 10, 10, { groupIds: ["outer"] });
    const c = rect(40, 0, 10, 10);
    expect([...normalizeSelection([a, b, c], [a.id])]).toEqual([a.id, b.id]);
    expect([...normalizeSelection([a, b, c], ["missing"])]).toEqual([]);
  });

  it("selects everything except labels", () => {
    const { elements, box } = labeled();
    expect([...selectAll(elements)]).toEqual([box]);
  });

  it("toggles whole groups with Shift-click", () => {
    const a = rect(0, 0, 10, 10, { groupIds: ["g"] });
    const b = rect(20, 0, 10, 10, { groupIds: ["g"] });
    const c = rect(40, 0, 10, 10);
    const all = [a, b, c];
    const withGroup = toggleSelection(all, new Set([c.id]), a.id);
    expect([...withGroup].sort()).toEqual([a.id, b.id, c.id].sort());
    expect([...toggleSelection(all, withGroup, b.id)]).toEqual([c.id]);
  });

  it("exports the selection with labels, or everything", () => {
    const { elements, box, label } = labeled();
    const other = rect(200, 0, 10, 10);
    const scene = [...elements, other];
    expect(ids(exportElements(scene, new Set([box])))).toEqual([box, label]);
    expect(ids(exportElements(scene, new Set()))).toEqual([box, label, other.id]);
  });

  it("builds a caption from texts and labels", () => {
    const { elements } = labeled();
    const scene = [...elements, text({ x: 0, y: 100 }, "  second\n line ")];
    expect(captionFor(scene)).toBe("hello · second line");
    expect(captionFor([text({ x: 0, y: 0 }, "x".repeat(300))])).toHaveLength(200);
    expect(captionFor([rect(0, 0, 1, 1)])).toBe("");
  });
});

describe("delete", () => {
  it("deletes containers with their labels and clears the selection", () => {
    const { elements, box } = labeled();
    const next = deleteSelection({ elements, selectedIds: new Set([box]) });
    expect(next.elements).toEqual([]);
    expect(next.selectedIds.size).toBe(0);
  });

  it("does nothing without a selection", () => {
    const state: SceneState = { elements: [rect(0, 0, 1, 1)], selectedIds: new Set() };
    expect(deleteSelection(state)).toBe(state);
  });

  it("erases containers when the eraser touches a label", () => {
    const { elements, label } = labeled();
    expect(eraseElements(elements, [label])).toEqual([]);
  });
});

describe("duplicate", () => {
  it("copies 10 px down-right above the originals and selects the copies", () => {
    const { elements, box, label } = labeled();
    const top = rect(500, 500, 10, 10);
    const scene = [...elements, top];
    const next = duplicateSelection({ elements: scene, selectedIds: new Set([box]) });
    expect(next.elements).toHaveLength(5);
    expect(next.elements[4]).toBe(top);
    const copy = next.elements[2];
    const copyLabel = next.elements[3];
    expect(copy?.x).toBe(10);
    expect(copy?.y).toBe(10);
    expect(copyLabel?.type === "text" && copyLabel.containerId).toBe(copy?.id);
    expect(copyLabel?.x).toBe((byId(scene, label).x ?? 0) + 10);
    expect([...next.selectedIds]).toEqual([copy?.id]);
    expect(boundIds(next.elements, copy?.id ?? "")).toEqual([copyLabel?.id]);
  });

  it("accepts a custom offset for Alt-drag", () => {
    const box = rect(0, 0, 10, 10);
    const next = duplicateSelection({ elements: [box], selectedIds: new Set([box.id]) }, { x: 0, y: 0 });
    expect(next.elements[1]?.x).toBe(0);
  });
});

describe("z-order", () => {
  const a = rect(0, 0, 10, 10);
  const b = rect(0, 0, 10, 10);
  const c = rect(0, 0, 10, 10);
  const d = rect(0, 0, 10, 10);
  const scene = [a, b, c, d];

  it("moves one step forward and backward", () => {
    expect(ids(reorderSelection(scene, new Set([b.id]), "forward"))).toEqual(ids([a, c, b, d]));
    expect(ids(reorderSelection(scene, new Set([b.id, c.id]), "forward"))).toEqual(ids([a, d, b, c]));
    expect(ids(reorderSelection(scene, new Set([c.id]), "backward"))).toEqual(ids([a, c, b, d]));
    expect(reorderSelection(scene, new Set([d.id]), "forward")).toBe(scene);
    expect(reorderSelection(scene, new Set([a.id]), "backward")).toBe(scene);
  });

  it("moves to the front and back", () => {
    expect(ids(reorderSelection(scene, new Set([a.id, c.id]), "front"))).toEqual(ids([b, d, a, c]));
    expect(ids(reorderSelection(scene, new Set([b.id, d.id]), "back"))).toEqual(ids([b, d, a, c]));
    expect(reorderSelection(scene, new Set([c.id, d.id]), "front")).toBe(scene);
  });

  it("keeps labels with their containers and groups together", () => {
    const { elements, box, label } = labeled();
    const other = rect(0, 0, 10, 10);
    const moved = reorderSelection([...elements, other], new Set([box]), "front");
    expect(ids(moved)).toEqual([other.id, box, label]);
    const g1 = rect(0, 0, 1, 1, { groupIds: ["g"] });
    const g2 = rect(0, 0, 1, 1, { groupIds: ["g"] });
    const loose = rect(0, 0, 1, 1);
    expect(ids(reorderSelection([g1, loose, g2], new Set([loose.id]), "back"))).toEqual(ids([loose, g1, g2]));
    expect(ids(reorderSelection([g1, g2, loose], new Set([g1.id]), "forward"))).toEqual(ids([loose, g1, g2]));
  });
});

describe("groups", () => {
  it("groups two or more units and keeps them contiguous", () => {
    const a = rect(0, 0, 1, 1);
    const between = rect(0, 0, 1, 1);
    const b = rect(0, 0, 1, 1);
    const state = { elements: [a, between, b], selectedIds: new Set([a.id, b.id]) };
    expect(canGroup(state.elements, state.selectedIds)).toBe(true);
    const grouped = groupSelection(state);
    expect(ids(grouped.elements)).toEqual(ids([between, a, b]));
    const groupId = grouped.elements[1]?.groupIds[0];
    expect(groupId).toBeDefined();
    expect(grouped.elements[2]?.groupIds).toEqual([groupId]);
    expect([...normalizeSelection(grouped.elements, [a.id])].sort()).toEqual([a.id, b.id].sort());
    expect(canGroup(grouped.elements, grouped.selectedIds)).toBe(false);
    expect(groupSelection(grouped)).toBe(grouped);
  });

  it("groups labels with their containers", () => {
    const { elements, box, label } = labeled();
    const other = rect(200, 0, 10, 10);
    const grouped = groupSelection({ elements: [...elements, other], selectedIds: new Set([box, other.id]) });
    expect(byId(grouped.elements, label).groupIds).toHaveLength(1);
  });

  it("ungroups the outermost group only", () => {
    const a = rect(0, 0, 1, 1, { groupIds: ["inner", "outer"] });
    const b = rect(0, 0, 1, 1, { groupIds: ["inner", "outer"] });
    const c = rect(0, 0, 1, 1, { groupIds: ["outer"] });
    const state = { elements: [a, b, c], selectedIds: new Set([a.id]) };
    expect(canUngroup(state.elements, state.selectedIds)).toBe(true);
    const next = ungroupSelection(state);
    expect(next.elements.map((element) => element.groupIds)).toEqual([["inner"], ["inner"], []]);
    expect([...next.selectedIds].sort()).toEqual([a.id, b.id, c.id].sort());
    const flat = { elements: [rect(0, 0, 1, 1)], selectedIds: new Set<string>() };
    expect(ungroupSelection(flat)).toBe(flat);
  });
});

describe("nudge", () => {
  it("moves the selection with labels and drags bound arrows along", () => {
    const { elements, box, label } = labeled();
    const target = rect(300, 0, 100, 60);
    const link = arrow({ x: 110, y: 30 }, { x: 290, y: 30 });
    let scene: readonly SketchElement[] = [...elements, target, link];
    scene = bindEnd(scene, link.id, "end", target.id);
    scene = bindEnd(scene, link.id, "start", box);
    const before = byId(scene, label).y;
    const next = nudgeSelection(scene, new Set([box]), { x: 0, y: 5 });
    expect(byId(next, box).y).toBe(5);
    expect(byId(next, label).y).toBe(before + 5);
    const moved = byId(next, link.id);
    expect(moved.type === "arrow" && absolutePoints(moved)[0]?.y).toBeGreaterThan(30);
    expect(nudgeSelection(scene, new Set(), { x: 1, y: 0 })).toBe(scene);
  });
});

describe("styles", () => {
  it("lists only the rows that apply", () => {
    expect(styleFieldsFor("ellipse")).not.toContain("edges");
    expect(styleFieldsFor("arrow")).toContain("endArrowhead");
    expect(styleFieldsFor("arrow")).not.toContain("backgroundColor");
    expect(styleFieldsFor("freedraw")).not.toContain("roughness");
    expect(styleFieldsFor("text")).toEqual(["strokeColor", "fontSize", "fontFamily", "textAlign", "opacity"]);
    expect(styleFieldsFor("unsupported")).toEqual([]);
    const { elements, box } = labeled();
    expect(selectionStyleFields(elements, new Set([box]))).toContain("fontSize");
  });

  it("reports shared and mixed values", () => {
    const a = rect(0, 0, 1, 1, { strokeWidth: 2, strokeColor: "#e03131" });
    const b = rect(0, 0, 1, 1, { strokeWidth: 4, strokeColor: "#e03131" });
    const head = arrow({ x: 0, y: 0 }, { x: 1, y: 1 }, { endArrowhead: "dot", strokeColor: "#e03131" });
    const style = selectionStyle([a, b, head], new Set([a.id, b.id, head.id]));
    expect(style.strokeColor).toEqual({ mixed: false, value: "#e03131" });
    expect(style.strokeWidth).toEqual({ mixed: true });
    expect(style.endArrowhead).toEqual({ mixed: false, value: "circle" });
    expect(style.fontSize).toBeUndefined();
    expect(selectionStyle([a], new Set()).strokeColor).toBeUndefined();
  });

  it("applies only the fields each element supports", () => {
    const box = rect(0, 0, 10, 10);
    const ellipse = shape("ellipse", { x: 0, y: 0, width: 10, height: 10 });
    const link = arrow({ x: 0, y: 0 }, { x: 10, y: 10 });
    const scene = [box, ellipse, link];
    const next = applyStyle(scene, new Set(ids(scene)), { backgroundColor: "#ffc9c9", edges: "sharp", endArrowhead: "triangle" }, measure);
    expect(byId(next, box.id)).toMatchObject({ backgroundColor: "#ffc9c9", roundness: null });
    expect(byId(next, ellipse.id)).toMatchObject({ backgroundColor: "#ffc9c9", roundness: null });
    expect(byId(next, link.id)).toMatchObject({ backgroundColor: "transparent", roundness: null, endArrowhead: "triangle" });
    expect(applyStyle(scene, new Set(ids(scene)), { fontSize: 36 }, measure)).toBe(scene);
    const rounded = applyStyle(next, new Set([box.id]), { edges: "round" }, measure);
    expect(byId(rounded, box.id)).toMatchObject({ roundness: { type: 3 } });
  });

  it("applies text fields to container labels and relayouts them", () => {
    const { elements, box, label } = labeled();
    const next = applyStyle(elements, new Set([box]), { fontSize: 36, strokeColor: "#1971c2" }, measure);
    const updated = textOf(next, label);
    expect(updated.fontSize).toBe(36);
    expect(updated.strokeColor).toBe("#1971c2");
    expect(updated.height).toBe(45);
    expect(byId(next, box).width).toBe(100);
    expect(updated.x + updated.width / 2).toBeCloseTo(50);
    const grown = applyStyle(elements, new Set([box]), { fontSize: 80 }, measure);
    expect(byId(grown, box).height).toBeGreaterThan(60);
  });

  it("keeps free text anchored when its font changes", () => {
    const free = text({ x: 100, y: 100 }, "abcd", { textAlign: "center" });
    const next = textOf(applyStyle([free], new Set([free.id]), { fontSize: 40 }, measure), free.id);
    expect(next.width).toBe(80);
    expect(next.x + next.width / 2).toBeCloseTo(free.x + free.width / 2);
    expect(next.y + next.height / 2).toBeCloseTo(free.y + free.height / 2);
  });
});

describe("text editing", () => {
  it("creates a centered label bound to its container", () => {
    const box = rect(0, 0, 100, 60);
    const created = ensureLabel([box], box.id, styleWith(), measure);
    if (created === null) throw new Error("no label");
    const label = textOf(created.elements, created.labelId);
    expect(label).toMatchObject({ containerId: box.id, textAlign: "center", verticalAlign: "middle", text: "" });
    expect(boundIds(created.elements, box.id)).toEqual([created.labelId]);
    expect(ids(created.elements)).toEqual([box.id, created.labelId]);
    expect(ensureLabel(created.elements, box.id, styleWith(), measure)?.labelId).toBe(created.labelId);
    expect(ensureLabel([arrow({ x: 0, y: 0 }, { x: 1, y: 1 })], "x", styleWith(), measure)).toBeNull();
  });

  it("starts editing text directly and shapes through their label", () => {
    const free = text({ x: 0, y: 0 }, "hi");
    expect(beginTextEdit([free], free.id, styleWith(), measure)?.textId).toBe(free.id);
    const box = rect(0, 0, 100, 60);
    const started = beginTextEdit([box], box.id, styleWith(), measure);
    expect(started?.elements).toHaveLength(2);
    expect(beginTextEdit([arrow({ x: 0, y: 0 }, { x: 1, y: 1 })], "nope", styleWith(), measure)).toBeNull();
  });

  it("wraps labels and grows the container when the text is taller", () => {
    const { elements, box, label } = labeled();
    const long = commitText(elements, label, "one two three four five six seven", measure);
    const updated = textOf(long.elements, label);
    expect(updated.originalText).toBe("one two three four five six seven");
    expect(updated.text.split("\n").length).toBeGreaterThan(2);
    expect(byId(long.elements, box).height).toBeGreaterThan(60);
    expect(long.deleted).toBe(false);
  });

  it("deletes empty text and unlinks it from its container", () => {
    const { elements, box, label } = labeled();
    const cleared = commitText(elements, label, "  \n ", measure);
    expect(cleared.deleted).toBe(true);
    expect(ids(cleared.elements)).toEqual([box]);
    expect(boundIds(cleared.elements, box)).toEqual([]);
  });

  it("resizes free text in place", () => {
    const free = text({ x: 10, y: 10 }, "ab");
    const next = commitText([free], free.id, "abcdef\nx", measure);
    expect(textOf(next.elements, free.id)).toMatchObject({ x: 10, width: 60, height: 50, text: "abcdef\nx", originalText: "abcdef\nx" });
    expect(commitText(next.elements, free.id, "abcdef\nx", measure).elements).toBe(next.elements);
  });

  it("re-aims arrows bound to free text that changed size", () => {
    const free = text({ x: 300, y: 0 }, "ab");
    const link = arrow({ x: 0, y: 12 }, { x: 290, y: 12 });
    const scene = bindEnd([free, link], link.id, "end", free.id);
    const next = commitText(scene, free.id, "a much longer text", measure);
    expect(next.elements.find((element) => element.id === link.id)).not.toBe(scene.find((element) => element.id === link.id));
  });
});
