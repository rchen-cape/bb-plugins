import { describe, expect, it } from "vitest";
import { translateElement, updateElement } from "./elements";
import {
  elementTransform,
  highlightPath,
  renderBounds,
  renderModel,
  renderOrder,
  shapeKey,
  strokeOutlinePath,
  transformAttribute,
  usesHandFont,
} from "./render";
import { arrow, freedraw, linear, rect, shape, text, unsupported } from "./test-fixtures";

function moveCount(d: string): number {
  return (d.match(/M/g) ?? []).length;
}

describe("shapes", () => {
  it("draws a rough outline with the stroke color", () => {
    const model = renderModel(rect(0, 0, 100, 60, { strokeColor: "#e03131" }));
    expect(model.paths).toHaveLength(1);
    expect(model.paths[0]).toMatchObject({ fill: null, stroke: "#e03131", strokeWidth: 2, dash: null, lineCap: "round" });
    expect(moveCount(model.paths[0]?.d ?? "")).toBe(8);
  });

  it("draws crisp single strokes at roughness 0", () => {
    const model = renderModel(rect(0, 0, 100, 60, { roughness: 0 }));
    const d = model.paths[0]?.d ?? "";
    expect(moveCount(d)).toBe(4);
    expect(d.startsWith("M0 0 C")).toBe(true);
    expect(d).toContain("100 0");
    const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThanOrEqual(100);
  });

  it("is deterministic per seed", () => {
    const a = rect(0, 0, 100, 60, { seed: 42 });
    const b = rect(0, 0, 100, 60, { seed: 42 });
    const c = rect(0, 0, 100, 60, { seed: 43 });
    expect(renderModel(a).paths[0]?.d).toBe(renderModel(b).paths[0]?.d);
    expect(renderModel(a).paths[0]?.d).not.toBe(renderModel(c).paths[0]?.d);
  });

  it("fills solid backgrounds under the stroke", () => {
    const model = renderModel(rect(0, 0, 100, 60, { backgroundColor: "#a5d8ff", fillStyle: "solid" }));
    expect(model.paths.map((path) => [path.fill, path.stroke])).toEqual([
      ["#a5d8ff", null],
      [null, "#1e1e1e"],
    ]);
  });

  it("draws hachure fills as background-colored strokes of half width", () => {
    const model = renderModel(rect(0, 0, 100, 60, { backgroundColor: "#ffc9c9", fillStyle: "hachure", strokeWidth: 4 }));
    expect(model.paths[0]).toMatchObject({ fill: null, stroke: "#ffc9c9", strokeWidth: 2 });
    const cross = renderModel(rect(0, 0, 100, 60, { backgroundColor: "#ffc9c9", fillStyle: "cross-hatch" }));
    expect(cross.paths[0]?.stroke).toBe("#ffc9c9");
  });

  it("dashes and dots non-solid strokes with a slightly wider single stroke", () => {
    const dashed = renderModel(rect(0, 0, 100, 60, { strokeStyle: "dashed" })).paths[0];
    expect(dashed).toMatchObject({ dash: [8, 10], strokeWidth: 2.5 });
    expect(moveCount(dashed?.d ?? "")).toBe(4);
    expect(renderModel(rect(0, 0, 100, 60, { strokeStyle: "dotted", strokeWidth: 4 })).paths[0]?.dash).toEqual([1.5, 10]);
  });

  it("draws rounded rectangles, rounded diamonds and ellipses", () => {
    expect(renderModel(rect(0, 0, 100, 60, { roundness: { type: 3 } })).paths.length).toBeGreaterThan(0);
    expect(renderModel(shape("diamond", { x: 0, y: 0, width: 100, height: 60 })).paths.length).toBeGreaterThan(0);
    expect(renderModel(shape("diamond", { x: 0, y: 0, width: 100, height: 60 }, { roundness: null })).paths.length).toBeGreaterThan(0);
    expect(renderModel(shape("ellipse", { x: 0, y: 0, width: 100, height: 60 }, {}, { roughness: 0 })).paths).toHaveLength(1);
  });

  it("never emits NaN for empty shapes", () => {
    for (const type of ["rectangle", "diamond", "ellipse"] as const) {
      const model = renderModel(shape(type, { x: 0, y: 0, width: 0, height: 0 }));
      for (const path of model.paths) expect(path.d).not.toContain("NaN");
    }
  });
});

describe("linear elements", () => {
  it("adds an arrowhead at the end", () => {
    const model = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { roughness: 0 }));
    expect(model.paths).toHaveLength(3);
    expect(model.paths.every((path) => path.stroke === "#1e1e1e")).toBe(true);
    const plain = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { roughness: 0, endArrowhead: null }));
    expect(plain.paths).toHaveLength(1);
  });

  it("fills triangle, circle and diamond heads with the stroke color", () => {
    for (const head of ["triangle", "dot", "circle", "diamond"]) {
      const model = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { endArrowhead: head, roughness: 0 }));
      expect(model.paths.some((path) => path.fill === "#1e1e1e")).toBe(true);
    }
    const outline = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { endArrowhead: "triangle_outline", roughness: 0 }));
    expect(outline.paths.some((path) => path.fill === "#1e1e1e")).toBe(false);
  });

  it("draws bars and unknown heads as two strokes", () => {
    const bar = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { endArrowhead: "bar", roughness: 0 }));
    expect(bar.paths).toHaveLength(3);
    const unknown = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { endArrowhead: "crowfoot_many", roughness: 0 }));
    expect(unknown.paths).toHaveLength(3);
  });

  it("points the arrowhead back along the line", () => {
    const model = renderModel(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { roughness: 0, startArrowhead: "arrow", endArrowhead: null }));
    const head = model.paths[1]?.d ?? "";
    const xs = (head.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(25);
  });

  it("does not draw arrowheads on lines", () => {
    const model = renderModel(linear("line", { x: 0, y: 0 }, [[0, 0], [100, 0]], { endArrowhead: "arrow", roughness: 0 }));
    expect(model.paths).toHaveLength(1);
  });

  it("fills closed lines with a background", () => {
    const loop = linear("line", { x: 0, y: 0 }, [[0, 0], [100, 0], [100, 100], [0, 0]], { backgroundColor: "#b2f2bb", roundness: null });
    expect(renderModel(loop).paths.some((path) => path.fill === "#b2f2bb")).toBe(true);
  });
});

describe("freedraw", () => {
  it("draws one filled outline with perfect-freehand", () => {
    const model = renderModel(freedraw({ x: 0, y: 0 }, [[0, 0], [10, 5], [30, 10], [60, 0]]));
    expect(model.paths).toHaveLength(1);
    expect(model.paths[0]).toMatchObject({ fill: "#1e1e1e", stroke: null });
    expect(model.paths[0]?.d.startsWith("M ")).toBe(true);
    expect(model.paths[0]?.d.endsWith("Z")).toBe(true);
    expect(model.bounds.maxX).toBeGreaterThan(60);
  });

  it("uses pen pressure when it was recorded", () => {
    const simulated = freedraw({ x: 0, y: 0 }, [[0, 0], [30, 0], [60, 0]]);
    const pressed = { ...simulated, simulatePressure: false, pressures: [0.1, 1, 0.1] };
    expect(renderModel(pressed).paths[0]?.d).not.toBe(renderModel(simulated).paths[0]?.d);
  });

  it("draws a dot for a single point", () => {
    expect(renderModel(freedraw({ x: 0, y: 0 }, [[0, 0]])).paths[0]?.d.length).toBeGreaterThan(10);
  });

  it("fills closed strokes with a background", () => {
    const loop = freedraw({ x: 0, y: 0 }, [[0, 0], [50, 0], [50, 50], [0, 50], [0, 2]], { backgroundColor: "#ffec99" });
    const model = renderModel(loop);
    expect(model.paths[0]?.fill).toBe("#ffec99");
    expect(model.paths[model.paths.length - 1]?.fill).toBe("#1e1e1e");
  });

  it("joins outline points with quadratic curves", () => {
    expect(strokeOutlinePath([[0, 0], [10, 0], [10, 10]])).toBe("M 0 0 Q 0 0 5 0 10 0 10 5 10 10 5 5 L 0 0 Z");
    expect(strokeOutlinePath([])).toBe("");
  });
});

describe("text", () => {
  it("lays out lines on baselines with the alignment anchor", () => {
    const label = text({ x: 0, y: 0 }, "one\ntwo", { textAlign: "center", width: 30, fontSize: 20 });
    const model = renderModel(label);
    expect(model.paths).toEqual([]);
    expect(model.texts[0]).toMatchObject({ anchor: "middle", fontSize: 20, fill: "#1e1e1e", handFont: true });
    expect(model.texts[0]?.lines.map((line) => [line.text, line.x])).toEqual([
      ["one", 15],
      ["two", 15],
    ]);
    expect(model.texts[0]?.lines[1]?.y).toBeCloseTo(42.62, 2);
    expect(renderModel(text({ x: 0, y: 0 }, "r", { textAlign: "right", width: 50 })).texts[0]?.lines[0]?.x).toBe(50);
  });

  it("knows which elements need the hand font", () => {
    expect(usesHandFont(text({ x: 0, y: 0 }, "a"))).toBe(true);
    expect(usesHandFont(text({ x: 0, y: 0 }, "a", { fontFamily: 2 }))).toBe(false);
    expect(usesHandFont(text({ x: 0, y: 0 }, ""))).toBe(false);
    expect(usesHandFont(rect(0, 0, 1, 1))).toBe(false);
  });
});

describe("unsupported elements", () => {
  it("draws a dashed placeholder with the original type", () => {
    const model = renderModel(unsupported("u", { x: 0, y: 0, width: 120, height: 80 }));
    expect(model.paths[0]).toMatchObject({ dash: [6, 4] });
    expect(model.texts[0]?.lines[0]).toMatchObject({ text: "image", x: 60 });
  });
});

describe("caching", () => {
  it("reuses the model when only the position changes", () => {
    const box = rect(0, 0, 100, 60);
    const moved = translateElement(box, 40, 40);
    expect(shapeKey(moved)).toBe(shapeKey(box));
    expect(renderModel(moved)).toBe(renderModel(box));
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(renderModel(translateElement(line, 5, 5))).toBe(renderModel(line));
  });

  it("rebuilds when the shape changes", () => {
    const box = rect(0, 0, 100, 60);
    expect(renderModel(updateElement(box, { width: 120 }))).not.toBe(renderModel(box));
    expect(renderModel(updateElement(box, { strokeColor: "#2f9e44" }))).not.toBe(renderModel(box));
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(renderModel(updateElement(line, { points: [[0, 0], [100, 0]] }))).not.toBe(renderModel(line));
  });
});

describe("transforms and bounds", () => {
  it("translates and rotates around the local center", () => {
    const box = rect(10, 20, 100, 50, { angle: Math.PI / 2, opacity: 40 });
    const transform = elementTransform(box);
    expect(transform).toEqual({ x: 10, y: 20, angle: Math.PI / 2, cx: 50, cy: 25, opacity: 0.4 });
    expect(transformAttribute(transform)).toBe("translate(10 20) rotate(90 50 25)");
    expect(transformAttribute(elementTransform(rect(1.234, 5, 1, 1)))).toBe("translate(1.23 5)");
    const line = arrow({ x: 0, y: 0 }, { x: -100, y: 50 });
    expect(elementTransform(line)).toMatchObject({ cx: -50, cy: 25 });
  });

  it("includes strokes and arrowheads in render bounds", () => {
    const box = renderBounds(rect(0, 0, 100, 100, { roughness: 0, strokeWidth: 4 }));
    expect(box.minX).toBeCloseTo(-2);
    expect(box.maxX).toBeCloseTo(102);
    const head = renderBounds(arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { roughness: 0 }));
    expect(head.minY).toBeLessThan(-5);
    expect(head.maxY).toBeGreaterThan(5);
    const turned = renderBounds(rect(0, 0, 100, 20, { roughness: 0, angle: Math.PI / 2 }));
    expect(turned.maxY - turned.minY).toBeCloseTo(102);
  });

  it("draws highlight outlines in local coordinates", () => {
    expect(highlightPath(rect(0, 0, 100, 50), 4)).toBe("M-4 -4 L104 -4 L104 54 L-4 54 Z");
    expect(highlightPath(shape("ellipse", { x: 0, y: 0, width: 100, height: 50 }), 0)).toContain("A50 25");
    expect(highlightPath(shape("diamond", { x: 0, y: 0, width: 100, height: 50 }), 0)).toBe("M50 0 L100 25 L50 50 L0 25 Z");
    expect(highlightPath(rect(0, 0, 100, 50, { roundness: { type: 3 } }), 0)).toContain("Q");
  });

  it("draws labels right after their containers", () => {
    const box = rect(0, 0, 10, 10);
    const label = text({ x: 0, y: 0 }, "a", { containerId: box.id });
    const other = rect(20, 20, 10, 10);
    expect(renderOrder([label, other, box]).map((element) => element.id)).toEqual([other.id, box.id, label.id]);
    const ordered = [box, label, other];
    expect(renderOrder(ordered)).toBe(ordered);
  });
});
