import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloneElements,
  createFreedraw,
  createLinear,
  createShape,
  createText,
  DEFAULT_SKETCH_STYLE,
  edgesOf,
  parseSketchStyle,
  roundnessFor,
  textOriginAt,
  translateElement,
  updateElement,
  withAbsolutePoints,
} from "./elements";
import { arrow, byId, measure, rect, styleWith, text, unsupported } from "./test-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("factories", () => {
  it("creates shapes with Excalidraw defaults", () => {
    const shape = createShape("rectangle", { x: 1, y: 2, width: 30, height: 40 }, DEFAULT_SKETCH_STYLE);
    expect(shape).toMatchObject({
      type: "rectangle",
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      angle: 0,
      version: 1,
      isDeleted: false,
      groupIds: [],
      boundElements: null,
      roundness: { type: 3 },
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    });
    expect(shape.seed).toBeGreaterThan(0);
    expect(shape.id).toMatch(/^[0-9A-Za-z]{20}$/);
  });

  it("maps edges to roundness per type", () => {
    expect(roundnessFor("rectangle", "round")).toEqual({ type: 3 });
    expect(roundnessFor("diamond", "round")).toEqual({ type: 2 });
    expect(roundnessFor("arrow", "round")).toEqual({ type: 2 });
    expect(roundnessFor("ellipse", "round")).toBeNull();
    expect(roundnessFor("rectangle", "sharp")).toBeNull();
    expect(edgesOf(null)).toBe("sharp");
    expect(edgesOf({ type: 3 })).toBe("round");
  });

  it("normalizes linear points so the first one is the origin", () => {
    const line = createLinear("line", { x: 10, y: 10 }, [[5, 5], [25, -5]], DEFAULT_SKETCH_STYLE);
    expect(line).toMatchObject({ x: 15, y: 15, width: 20, height: 10, points: [[0, 0], [20, -10]] });
    expect(line.startArrowhead).toBeNull();
    expect(line.endArrowhead).toBeNull();
    expect("elbowed" in line).toBe(false);
    const created = createLinear("arrow", { x: 0, y: 0 }, [[0, 0], [10, 0]], DEFAULT_SKETCH_STYLE);
    expect(created.endArrowhead).toBe("arrow");
    expect(created.elbowed).toBe(false);
    expect(created.startBinding).toBeNull();
  });

  it("starts freedraw strokes with one point and pressure mode", () => {
    expect(createFreedraw({ x: 3, y: 4 }, DEFAULT_SKETCH_STYLE, null)).toMatchObject({
      points: [[0, 0]],
      pressures: [],
      simulatePressure: true,
    });
    expect(createFreedraw({ x: 3, y: 4 }, DEFAULT_SKETCH_STYLE, 0.7)).toMatchObject({ pressures: [0.7], simulatePressure: false });
  });

  it("measures text", () => {
    const created = createText({ x: 0, y: 0 }, "ab\nabc", styleWith({ fontSize: 20 }), measure);
    expect(created).toMatchObject({ width: 30, height: 50, text: "ab\nabc", originalText: "ab\nabc", lineHeight: 1.25 });
    expect(created.containerId).toBeNull();
    expect(created.fontFamily).toBe(5);
  });

  it("places new text so the click is in the middle of the first line", () => {
    expect(textOriginAt({ x: 10, y: 100 }, { fontSize: 20 })).toEqual({ x: 10, y: 87.5 });
  });
});

describe("updateElement", () => {
  it("bumps version, picks a new nonce and stamps the time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const original = rect(0, 0, 10, 10, { version: 4, versionNonce: 1, updated: 1 });
    const updated = updateElement(original, { width: 20 });
    expect(updated.width).toBe(20);
    expect(updated.version).toBe(5);
    expect(updated.versionNonce).not.toBe(1);
    expect(updated.updated).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(original.width).toBe(10);
  });

  it("translates without touching points", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 10, y: 10 });
    const moved = translateElement(line, 5, 5);
    expect(moved.x).toBe(5);
    expect(moved.type === "arrow" && moved.points).toBe(line.points);
    expect(translateElement(line, 0, 0)).toBe(line);
  });

  it("bakes rotation into absolute points", () => {
    const line = arrow({ x: 0, y: 0 }, { x: 100, y: 0 }, { angle: Math.PI / 2 });
    const baked = withAbsolutePoints(line, [
      { x: 50, y: -50 },
      { x: 50, y: 50 },
    ]);
    expect(baked.angle).toBe(0);
    expect(baked.x).toBe(50);
    expect(baked.y).toBe(-50);
    expect(baked.points).toEqual([[0, 0], [0, 100]]);
    expect(baked.height).toBe(100);
    const unchanged = arrow({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(withAbsolutePoints(unchanged, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(unchanged);
  });
});

describe("cloneElements", () => {
  it("remaps ids, seeds, groups, labels and bindings inside the set", () => {
    const box = rect(0, 0, 100, 100, { groupIds: ["g1", "g2"] });
    const label = text({ x: 0, y: 0 }, "hi", { containerId: box.id, groupIds: ["g1", "g2"] });
    const target = rect(200, 0, 100, 100);
    const link = arrow({ x: 100, y: 50 }, { x: 200, y: 50 }, {
      startBinding: { elementId: box.id, focus: 0, gap: 4 },
      endBinding: { elementId: target.id, focus: 0, gap: 4 },
    });
    const boxWithBound = {
      ...box,
      boundElements: [
        { id: label.id, type: "text" as const },
        { id: link.id, type: "arrow" as const },
      ],
    };
    const { elements, idMap } = cloneElements([boxWithBound, label, link]);
    const [boxCopy, labelCopy, linkCopy] = elements;
    expect(new Set(elements.map((element) => element.id)).size).toBe(3);
    expect(boxCopy?.id).toBe(idMap.get(box.id));
    expect(boxCopy?.id).not.toBe(box.id);
    expect(boxCopy?.type !== "unsupported" && boxCopy?.seed).not.toBe(box.seed);
    expect(boxCopy?.groupIds).toHaveLength(2);
    expect(boxCopy?.groupIds).toEqual(labelCopy?.groupIds);
    expect(boxCopy?.groupIds).not.toContain("g1");
    expect(labelCopy?.type === "text" && labelCopy.containerId).toBe(boxCopy?.id);
    expect(boxCopy?.type !== "unsupported" && boxCopy?.boundElements).toEqual([
      { id: labelCopy?.id, type: "text" },
      { id: linkCopy?.id, type: "arrow" },
    ]);
    expect(linkCopy?.type === "arrow" && linkCopy.startBinding?.elementId).toBe(boxCopy?.id);
    expect(linkCopy?.type === "arrow" && linkCopy.endBinding).toBeNull();
  });

  it("drops a label's container outside the set", () => {
    const box = rect(0, 0, 10, 10);
    const label = text({ x: 0, y: 0 }, "x", { containerId: box.id });
    const { elements } = cloneElements([label]);
    expect(elements[0]?.type === "text" && elements[0].containerId).toBeNull();
  });

  it("copies unsupported elements with their raw data minus references", () => {
    const image = unsupported("img", { x: 0, y: 0, width: 10, height: 10 });
    const { elements } = cloneElements([{ ...image, raw: { ...image.raw, boundElements: [{ id: "x", type: "arrow" }] } }]);
    const copy = byId(elements, elements[0]?.id ?? "");
    expect(copy.type).toBe("unsupported");
    expect(copy.type === "unsupported" && copy.raw.fileId).toBe("file-1");
    expect(copy.type === "unsupported" && "boundElements" in copy.raw).toBe(false);
  });
});

describe("parseSketchStyle", () => {
  it("falls back per field", () => {
    expect(parseSketchStyle({ strokeWidth: 4, fillStyle: "bogus", fontFamily: 99, edges: "sharp" })).toEqual({
      ...DEFAULT_SKETCH_STYLE,
      strokeWidth: 4,
      edges: "sharp",
    });
    expect(parseSketchStyle("nope")).toEqual(DEFAULT_SKETCH_STYLE);
    expect(parseSketchStyle(null)).toEqual(DEFAULT_SKETCH_STYLE);
    expect(parseSketchStyle({ endArrowhead: null, startArrowhead: "triangle" })).toMatchObject({ endArrowhead: null, startArrowhead: "triangle" });
  });
});
