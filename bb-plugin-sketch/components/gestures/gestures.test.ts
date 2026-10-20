import { describe, expect, it } from "vitest";
import { canUndo } from "../../lib/history";
import type { Point } from "../../lib/math";
import type { SketchElement } from "../../lib/scene";
import { screenToScene } from "../../lib/viewport";
import { byId, measure, rect, styleWith } from "../../lib/test-fixtures";
import { EditorController } from "../controller";
import { editSelected, finishEditing, updateEditing } from "../editing";
import { escape } from "../commands";
import { nudgeSelected } from "../scene-actions";
import { startGesture } from "./start";
import type { PointerInput } from "./types";
import { beginPinch, pinchView } from "./view";

type Modifiers = { shift?: boolean; alt?: boolean; mod?: boolean; pointerType?: string; pressure?: number; samples?: Point[] };

function input(at: Point, modifiers: Modifiers = {}): PointerInput {
  const sample = (p: Point) => ({ screen: p, scene: p, pressure: modifiers.pressure ?? 0.5 });
  return {
    ...sample(at),
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
    mod: modifiers.mod ?? false,
    pointerType: modifiers.pointerType ?? "mouse",
    samples: (modifiers.samples ?? [at]).map(sample),
  };
}

function editor(elements: readonly SketchElement[] = [], grid = false): EditorController {
  const controller = new EditorController({ elements, view: { scrollX: 0, scrollY: 0, zoom: 1 }, style: styleWith(), grid });
  controller.setMeasure(measure);
  return controller;
}

function gesture(controller: EditorController, from: Point, to: Point, modifiers: Modifiers = {}, button = 0, down: Modifiers = modifiers): void {
  const started = startGesture(controller, input(from, down), button);
  if (started === null) throw new Error("no gesture");
  controller.beginGesture(1, started);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  started.move(input(mid, modifiers));
  started.move(input(to, modifiers));
  controller.endGesture(1, input(to, modifiers));
}

function click(controller: EditorController, at: Point, modifiers: Modifiers = {}): void {
  gesture(controller, at, at, modifiers);
}

function ids(controller: EditorController): string[] {
  return [...controller.state.selectedIds];
}

describe("select tool gestures", () => {
  it("selects with a click on an outline and moves on drag, locking the axis with Shift", () => {
    const controller = editor([rect(100, 100, 100, 80, { id: "a" })]);
    click(controller, { x: 100, y: 120 });
    expect(ids(controller)).toEqual(["a"]);
    gesture(controller, { x: 150, y: 140 }, { x: 190, y: 150 }, { shift: true }, 0, {});
    expect(byId(controller.state.elements, "a")).toMatchObject({ x: 140, y: 100 });
    expect(canUndo(controller.state.history)).toBe(true);
  });

  it("does not select an unfilled shape from its empty middle", () => {
    const controller = editor([rect(100, 100, 100, 80, { id: "a" })]);
    click(controller, { x: 150, y: 140 });
    expect(ids(controller)).toEqual([]);
  });

  it("snaps moves to the grid", () => {
    const controller = editor([rect(100, 100, 100, 80, { id: "a" })], true);
    click(controller, { x: 100, y: 140 });
    gesture(controller, { x: 100, y: 140 }, { x: 113, y: 147 });
    expect(byId(controller.state.elements, "a")).toMatchObject({ x: 120, y: 100 });
  });

  it("duplicates with Alt-drag and moves the copy", () => {
    const controller = editor([rect(100, 100, 100, 80, { id: "a" })]);
    click(controller, { x: 100, y: 120 });
    gesture(controller, { x: 100, y: 120 }, { x: 160, y: 120 }, { alt: true });
    const [original, copy] = controller.state.elements;
    expect(original).toMatchObject({ id: "a", x: 100 });
    expect(copy).toMatchObject({ x: 160, y: 100 });
    expect(ids(controller)).toEqual([copy?.id]);
  });

  it("toggles with Shift-click and adds a Shift marquee", () => {
    const controller = editor([rect(0, 0, 50, 50, { id: "a" }), rect(100, 0, 50, 50, { id: "b" }), rect(200, 0, 50, 50, { id: "c" })]);
    click(controller, { x: 0, y: 10 });
    click(controller, { x: 100, y: 10 }, { shift: true });
    expect(ids(controller)).toEqual(["a", "b"]);
    click(controller, { x: 0, y: 10 }, { shift: true });
    expect(ids(controller)).toEqual(["b"]);
    gesture(controller, { x: 190, y: -10 }, { x: 260, y: 60 }, { shift: true });
    expect(ids(controller)).toEqual(["b", "c"]);
    gesture(controller, { x: -10, y: -10 }, { x: 60, y: 60 });
    expect(ids(controller)).toEqual(["a"]);
  });

  it("resizes from a corner handle", () => {
    const controller = editor([rect(100, 100, 100, 80, { id: "a" })]);
    click(controller, { x: 100, y: 140 });
    gesture(controller, { x: 204, y: 184 }, { x: 254, y: 224 });
    expect(byId(controller.state.elements, "a")).toMatchObject({ x: 100, y: 100, width: 150, height: 120 });
  });

  it("drags an arrow endpoint onto a shape and binds it", () => {
    const controller = editor([rect(300, 100, 100, 80, { id: "box" })]);
    controller.setTool("arrow");
    gesture(controller, { x: 0, y: 140 }, { x: 150, y: 140 });
    const arrowId = ids(controller)[0] ?? "";
    expect(controller.state.tool).toBe("select");
    gesture(controller, { x: 150, y: 140 }, { x: 350, y: 140 });
    const arrow = byId(controller.state.elements, arrowId);
    expect(arrow.type === "arrow" ? arrow.endBinding?.elementId : null).toBe("box");
    const box = byId(controller.state.elements, "box");
    expect(box.type === "rectangle" ? box.boundElements : null).toEqual([{ id: arrowId, type: "arrow" }]);
    expect(controller.state.bindTargetId).toBeNull();
  });
});

describe("drawing tools", () => {
  it("creates a shape, selects it and goes back to Select", () => {
    const controller = editor();
    controller.setTool("ellipse");
    gesture(controller, { x: 10, y: 10 }, { x: 110, y: 60 });
    const [created] = controller.state.elements;
    expect(created).toMatchObject({ type: "ellipse", x: 10, y: 10, width: 100, height: 50 });
    expect(ids(controller)).toEqual([created?.id]);
    expect(controller.state.tool).toBe("select");
  });

  it("makes squares with Shift and keeps the tool when locked", () => {
    const controller = editor();
    controller.setTool("rectangle");
    controller.toggleLock();
    gesture(controller, { x: 0, y: 0 }, { x: 100, y: 40 }, { shift: true });
    expect(controller.state.elements[0]).toMatchObject({ width: 100, height: 100 });
    expect(controller.state.tool).toBe("rectangle");
    expect(ids(controller)).toEqual([]);
  });

  it("creates nothing for a click", () => {
    const controller = editor();
    controller.setTool("diamond");
    click(controller, { x: 5, y: 5 });
    expect(controller.state.elements).toEqual([]);
    expect(canUndo(controller.state.history)).toBe(false);
  });

  it("binds a new arrow that starts inside a shape", () => {
    const controller = editor([rect(0, 0, 100, 100, { id: "box" })]);
    controller.setTool("arrow");
    gesture(controller, { x: 50, y: 50 }, { x: 300, y: 50 });
    const arrow = controller.state.elements.find((element) => element.type === "arrow");
    expect(arrow?.type === "arrow" ? arrow.startBinding?.elementId : null).toBe("box");
    expect(arrow?.x).toBeGreaterThanOrEqual(100);
  });

  it("draws pen strokes from every coalesced sample and stays on the pen", () => {
    const controller = editor();
    controller.setTool("draw");
    const started = startGesture(controller, input({ x: 0, y: 0 }), 0);
    if (started === null) throw new Error("no gesture");
    controller.beginGesture(1, started);
    started.move(input({ x: 30, y: 0 }, { samples: [{ x: 10, y: 0 }, { x: 20, y: 5 }, { x: 30, y: 0 }] }));
    controller.endGesture(1, input({ x: 40, y: 10 }));
    const [stroke] = controller.state.elements;
    expect(stroke?.type === "freedraw" ? stroke.points : null).toEqual([[0, 0], [10, 0], [20, 5], [30, 0], [40, 10]]);
    expect(controller.state.tool).toBe("draw");
  });

  it("uses pen pressure only for pen input", () => {
    const controller = editor();
    controller.setTool("draw");
    gesture(controller, { x: 0, y: 0 }, { x: 20, y: 0 }, { pointerType: "pen", pressure: 0.8 });
    const [stroke] = controller.state.elements;
    expect(stroke?.type === "freedraw" ? stroke.simulatePressure : null).toBe(false);
    expect(stroke?.type === "freedraw" ? stroke.pressures.length : 0).toBe(stroke?.type === "freedraw" ? stroke.points.length : -1);
  });
});

describe("eraser", () => {
  it("fades what it touches and deletes it on release", () => {
    const controller = editor([rect(0, 0, 50, 50, { id: "a" }), rect(200, 0, 50, 50, { id: "b" })]);
    controller.setTool("eraser");
    const started = startGesture(controller, input({ x: -20, y: 25 }), 0);
    if (started === null) throw new Error("no gesture");
    controller.beginGesture(1, started);
    started.move(input({ x: 25, y: 25 }));
    expect([...controller.state.erasing]).toEqual(["a"]);
    controller.endGesture(1, input({ x: 25, y: 25 }));
    expect(controller.state.elements.map((element) => element.id)).toEqual(["b"]);
    expect(controller.state.erasing.size).toBe(0);
  });

  it("cancels with Escape", () => {
    const controller = editor([rect(0, 0, 50, 50, { id: "a" })]);
    controller.setTool("eraser");
    const started = startGesture(controller, input({ x: 0, y: 25 }), 0);
    if (started === null) throw new Error("no gesture");
    controller.beginGesture(1, started);
    escape(controller);
    expect(controller.state.elements.map((element) => element.id)).toEqual(["a"]);
    expect(controller.state.erasing.size).toBe(0);
    expect(controller.state.tool).toBe("eraser");
  });
});

describe("panning", () => {
  it("pans with the middle button and the hand tool", () => {
    const controller = editor();
    gesture(controller, { x: 100, y: 100 }, { x: 150, y: 80 }, {}, 1);
    expect(controller.state.view).toMatchObject({ scrollX: 50, scrollY: -20 });
    controller.setTool("hand");
    gesture(controller, { x: 0, y: 0 }, { x: 10, y: 10 });
    expect(controller.state.view).toMatchObject({ scrollX: 60, scrollY: -10 });
  });

  it("zooms around the pinch midpoint", () => {
    const pinch = beginPinch({ scrollX: 0, scrollY: 0, zoom: 1 }, { x: 100, y: 100 }, { x: 200, y: 100 });
    const view = pinchView(pinch, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(view.zoom).toBe(2);
    const anchor = screenToScene(view, { x: 150, y: 100 });
    expect(anchor.x).toBeCloseTo(150);
    expect(anchor.y).toBeCloseTo(100);
  });
});

describe("text", () => {
  it("creates text with the text tool and drops it again when left empty", () => {
    const controller = editor();
    controller.setTool("text");
    click(controller, { x: 40, y: 40 });
    expect(controller.state.editing).not.toBeNull();
    expect(controller.state.tool).toBe("select");
    finishEditing(controller);
    expect(controller.state.elements).toEqual([]);
    expect(canUndo(controller.state.history)).toBe(false);
  });

  it("types a label into a shape, growing it, and undoes in one step", () => {
    const controller = editor([rect(0, 0, 60, 30, { id: "box" })]);
    click(controller, { x: 0, y: 15 });
    expect(editSelected(controller)).toBe(true);
    updateEditing(controller, "A much longer label than fits");
    finishEditing(controller);
    const box = byId(controller.state.elements, "box");
    expect(box.height).toBeGreaterThan(30);
    expect(ids(controller)).toEqual(["box"]);
    const label = controller.state.elements.find((element) => element.type === "text");
    expect(label?.type === "text" ? label.containerId : null).toBe("box");
    controller.undo();
    expect(controller.state.elements.map((element) => element.id)).toEqual(["box"]);
    expect(byId(controller.state.elements, "box").height).toBe(30);
  });
});

describe("keyboard actions", () => {
  it("nudges by 1, 5 or the grid size", () => {
    const controller = editor([rect(0, 0, 10, 10, { id: "a" })]);
    controller.select(["a"]);
    nudgeSelected(controller, 1, 0, false);
    nudgeSelected(controller, 0, 1, true);
    expect(byId(controller.state.elements, "a")).toMatchObject({ x: 1, y: 5 });
    controller.toggleGrid();
    nudgeSelected(controller, 1, 0, true);
    expect(byId(controller.state.elements, "a")).toMatchObject({ x: 21 });
  });

  it("applies style to the selection and remembers it for new elements", () => {
    const controller = editor([rect(0, 0, 10, 10, { id: "a" })]);
    controller.select(["a"]);
    controller.setStyle({ strokeColor: "#e03131" });
    expect(byId(controller.state.elements, "a")).toMatchObject({ strokeColor: "#e03131" });
    expect(controller.state.style.strokeColor).toBe("#e03131");
    controller.setStyle({ opacity: 40 }, true);
    expect(byId(controller.state.history.present.elements, "a")).toMatchObject({ opacity: 100 });
    controller.commit();
    expect(byId(controller.state.history.present.elements, "a")).toMatchObject({ opacity: 40 });
  });
});
