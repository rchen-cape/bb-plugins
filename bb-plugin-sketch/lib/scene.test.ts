import { describe, expect, it } from "vitest";
import {
  elementToJson,
  emptyScene,
  parseClipboard,
  parseSceneFile,
  SceneFileError,
  serializeClipboard,
  serializeScene,
  type Scene,
} from "./scene";
import { arrow, freedraw, rect, text } from "./test-fixtures";

function sceneOf(elements: Scene["elements"]): Scene {
  return { elements, appState: { viewBackgroundColor: "#ffffff", gridSize: 20, custom: { keep: true } }, files: { f1: { mimeType: "image/png" } } };
}

describe("scene files", () => {
  it("round trips every supported element type", () => {
    const box = rect(0, 0, 100, 50, { boundElements: [{ id: "label", type: "text" }] });
    const label = text({ x: 5, y: 5 }, "Hello", { id: "label", containerId: box.id });
    const link = arrow({ x: 100, y: 25 }, { x: 200, y: 25 }, { startBinding: { elementId: box.id, focus: 0, gap: 4 } });
    const pen = freedraw({ x: 0, y: 0 }, [[0, 0], [5, 5]], { pressures: [0.5, 0.6], simulatePressure: false });
    const scene = sceneOf([box, label, link, pen]);
    const parsed = parseSceneFile(serializeScene(scene));
    expect(parsed.dropped).toBe(0);
    expect(parsed.scene.elements).toEqual(scene.elements);
    expect(parsed.scene.appState).toEqual(scene.appState);
    expect(parsed.scene.files).toEqual(scene.files);
  });

  it("writes the Excalidraw envelope", () => {
    const json: unknown = JSON.parse(serializeScene(emptyScene()));
    expect(json).toMatchObject({ type: "excalidraw", version: 2, source: "bb-plugin-sketch", elements: [], files: {} });
  });

  it("keeps unknown element types as unsupported and writes them back unchanged", () => {
    const image = {
      id: "img1",
      type: "image",
      x: 10.123,
      y: 20,
      width: 30,
      height: 40,
      angle: 0,
      fileId: "abc",
      status: "saved",
      scale: [1, 1],
      version: 3,
      versionNonce: 7,
      isDeleted: false,
      groupIds: [],
      strokeColor: "transparent",
    };
    const file = JSON.stringify({ type: "excalidraw", version: 2, elements: [image], appState: {}, files: { abc: { dataURL: "data:" } } });
    const parsed = parseSceneFile(file);
    const element = parsed.scene.elements[0];
    expect(element?.type).toBe("unsupported");
    expect(element?.type === "unsupported" && element.originalType).toBe("image");
    const written: unknown = JSON.parse(serializeScene(parsed.scene));
    expect(written).toMatchObject({ elements: [{ ...image, x: 10.12 }], files: { abc: { dataURL: "data:" } } });
  });

  it("drops deleted, duplicate and malformed elements", () => {
    const box = rect(0, 0, 10, 10, { id: "a" });
    const file = JSON.stringify({
      type: "excalidraw",
      elements: [box, { ...box }, { ...rect(0, 0, 1, 1), id: "b", isDeleted: true }, { type: "rectangle" }, 42],
    });
    const parsed = parseSceneFile(file);
    expect(parsed.scene.elements.map((element) => element.id)).toEqual(["a"]);
    expect(parsed).toMatchObject({ dropped: 3, placeholders: 0 });
    expect(parsed.scene.appState).toEqual({});
  });

  it("keeps a known element whose fields can't be read as a placeholder and writes it back unchanged", () => {
    const broken = { id: "t1", type: "text", x: 5, y: 6, width: 40, height: 20, fontSize: 20, angle: 0 };
    const shortArrow = { id: "a1", type: "arrow", x: 1, y: 2, points: [[0, 0]], strokeColor: "#e03131" };
    const parsed = parseSceneFile(JSON.stringify({ type: "excalidraw", elements: [broken, shortArrow, { type: "text", x: 1, y: 1 }] }));
    expect(parsed).toMatchObject({ dropped: 1, placeholders: 2 });
    expect(parsed.scene.elements.map((element) => element.type === "unsupported" && element.originalType)).toEqual(["text", "arrow"]);
    const written: unknown = JSON.parse(serializeScene(parsed.scene));
    expect(written).toMatchObject({ elements: [broken, shortArrow] });
  });

  it("gives an arrow without endArrowhead an arrow head, like Excalidraw", () => {
    const base = { x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] };
    const file = JSON.stringify({
      type: "excalidraw",
      elements: [
        { ...base, id: "plain", type: "arrow" },
        { ...base, id: "none", type: "arrow", endArrowhead: null },
        { ...base, id: "dot", type: "arrow", endArrowhead: "dot" },
        { ...base, id: "bad", type: "arrow", endArrowhead: 7 },
        { ...base, id: "line", type: "line" },
      ],
    });
    const heads = parseSceneFile(file).scene.elements.map((element) => element.type !== "unsupported" && "endArrowhead" in element && element.endArrowhead);
    expect(heads).toEqual(["arrow", null, "dot", null, null]);
  });

  it("fills defaults for missing style fields", () => {
    const file = JSON.stringify({ type: "excalidraw", elements: [{ id: "r", type: "rectangle", x: 0, y: 0, strokeWidth: -3 }] });
    const element = parseSceneFile(file).scene.elements[0];
    expect(element).toMatchObject({ width: 0, height: 0, strokeWidth: 2, roughness: 1, backgroundColor: "transparent", opacity: 100 });
  });

  it("rejects files that are not Excalidraw", () => {
    expect(() => parseSceneFile("{")).toThrow(SceneFileError);
    expect(() => parseSceneFile(JSON.stringify({ type: "other", elements: [] }))).toThrow("This is not an Excalidraw file.");
  });

  it("rounds coordinates to two decimals", () => {
    const json = elementToJson(arrow({ x: 0.123456, y: 1 }, { x: 10.98765, y: 1 }));
    expect(json.x).toBe(0.12);
    expect(json.points).toEqual([[0, 0], [10.86, 0]]);
    expect(json.lastCommittedPoint).toBeNull();
  });
});

describe("clipboard payloads", () => {
  it("round trips the Excalidraw clipboard format", () => {
    const box = rect(0, 0, 10, 10);
    const payload = serializeClipboard([box]);
    expect(JSON.parse(payload)).toMatchObject({ type: "excalidraw/clipboard", files: {} });
    expect(parseClipboard(payload)).toEqual([box]);
  });

  it("accepts whole scene files and rejects plain text", () => {
    const box = rect(0, 0, 10, 10);
    expect(parseClipboard(serializeScene(sceneOf([box])))).toEqual([box]);
    expect(parseClipboard("hello")).toBeNull();
    expect(parseClipboard(JSON.stringify({ hello: 1 }))).toBeNull();
  });
});

describe("freedraw files", () => {
  it("marks finished strokes with their last point like Excalidraw", () => {
    const json = elementToJson(freedraw({ x: 0, y: 0 }, [[0, 0], [5.555, 6]]));
    expect(json.lastCommittedPoint).toEqual([5.56, 6]);
  });
});
