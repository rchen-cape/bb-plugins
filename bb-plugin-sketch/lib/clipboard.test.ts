import { describe, expect, it } from "vitest";
import { bindEnd } from "./binding";
import { commonBounds } from "./bounds";
import { clipboardElements, copySelection, pasteText, plainTextElement } from "./clipboard";
import { parseClipboard, serializeClipboard, type SketchElement } from "./scene";
import { arrow, measure, rect, styleWith, text } from "./test-fixtures";

const OPTIONS = { style: styleWith(), measure, gridSize: null };

function labeledScene(): { elements: readonly SketchElement[]; box: string; label: string; link: string; other: string } {
  const box = rect(0, 0, 100, 50, { groupIds: ["g"] });
  const label = text({ x: 30, y: 12 }, "hi", { containerId: box.id, groupIds: ["g"] });
  const other = rect(300, 0, 100, 50);
  const link = arrow({ x: 110, y: 25 }, { x: 290, y: 25 });
  let elements: readonly SketchElement[] = [{ ...box, boundElements: [{ id: label.id, type: "text" }] }, label, other, link];
  elements = bindEnd(elements, link.id, "start", box.id);
  elements = bindEnd(elements, link.id, "end", other.id);
  return { elements, box: box.id, label: label.id, link: link.id, other: other.id };
}

describe("copy", () => {
  it("copies the selection with labels in the Excalidraw clipboard format", () => {
    const { elements, box, label } = labeledScene();
    const payload = copySelection(elements, new Set([box]));
    expect(payload).not.toBeNull();
    const parsed = parseClipboard(payload ?? "");
    expect(parsed?.map((element) => element.id)).toEqual([box, label]);
    expect(clipboardElements(elements, new Set([label])).map((element) => element.id)).toEqual([box, label]);
    expect(copySelection(elements, new Set())).toBeNull();
  });
});

describe("paste", () => {
  it("remaps ids, seeds, groups, labels and bindings and centers on the point", () => {
    const { elements, box, link, other } = labeledScene();
    const payload = copySelection(elements, new Set([box, link, other])) ?? "";
    const pasted = pasteText(elements, payload, { x: 1000, y: 1000 }, OPTIONS);
    if (pasted === null) throw new Error("nothing pasted");
    const added = pasted.elements.slice(elements.length);
    expect(added).toHaveLength(4);
    const oldIds = new Set(elements.map((element) => element.id));
    expect(added.every((element) => !oldIds.has(element.id))).toBe(true);
    const bounds = commonBounds(added);
    expect(((bounds?.minX ?? 0) + (bounds?.maxX ?? 0)) / 2).toBeCloseTo(1000);
    expect(((bounds?.minY ?? 0) + (bounds?.maxY ?? 0)) / 2).toBeCloseTo(1000);
    const [boxCopy, labelCopy, otherCopy, linkCopy] = added;
    expect(boxCopy?.groupIds).toHaveLength(1);
    expect(boxCopy?.groupIds[0]).not.toBe("g");
    expect(labelCopy?.type === "text" && labelCopy.containerId).toBe(boxCopy?.id);
    expect(linkCopy?.type === "arrow" && linkCopy.startBinding?.elementId).toBe(boxCopy?.id);
    expect(linkCopy?.type === "arrow" && linkCopy.endBinding?.elementId).toBe(otherCopy?.id);
    expect(boxCopy?.type !== "unsupported" && boxCopy?.seed).not.toBe(elements[0]?.type !== "unsupported" && elements[0]?.seed);
    expect([...pasted.selectedIds].sort()).toEqual([boxCopy?.id, otherCopy?.id, linkCopy?.id].sort());
  });

  it("drops bindings to elements that were not copied", () => {
    const { elements, link } = labeledScene();
    const payload = copySelection(elements, new Set([link])) ?? "";
    const pasted = pasteText(elements, payload, { x: 0, y: 0 }, OPTIONS);
    const copy = pasted?.elements[pasted.elements.length - 1];
    expect(copy?.type === "arrow" && copy.startBinding).toBeNull();
    expect(copy?.type === "arrow" && copy.endBinding).toBeNull();
  });

  it("snaps the pasted top-left corner to the grid", () => {
    const payload = serializeClipboard([rect(0, 0, 40, 40)]);
    const pasted = pasteText([], payload, { x: 103, y: 97 }, { ...OPTIONS, gridSize: 20 });
    expect(pasted?.elements[0]?.x).toBe(80);
    expect(pasted?.elements[0]?.y).toBe(80);
  });

  it("pastes plain text as a centered text element", () => {
    const pasted = pasteText([], "Hello\r\nworld\n", { x: 100, y: 100 }, OPTIONS);
    const element = pasted?.elements[0];
    expect(element?.type).toBe("text");
    expect(element?.type === "text" && element.text).toBe("Hello\nworld");
    expect(element?.x).toBe(100 - 25);
    expect(element?.y).toBe(100 - 25);
    expect([...(pasted?.selectedIds ?? [])]).toEqual([element?.id]);
    expect(plainTextElement("   \n ", { x: 0, y: 0 }, OPTIONS)).toBeNull();
    expect(pasteText([], "", { x: 0, y: 0 }, OPTIONS)).toBeNull();
  });

  it("accepts payloads with elements Sketch can't draw and ignores empty payloads", () => {
    const payload = JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [{ id: "f1", type: "frame", x: 0, y: 0, width: 100, height: 100, name: "Frame" }],
      files: {},
    });
    const pasted = pasteText([], payload, { x: 0, y: 0 }, OPTIONS);
    expect(pasted?.elements[0]?.type).toBe("unsupported");
    expect(pasted?.elements[0]?.id).not.toBe("f1");
    expect(pasteText([], JSON.stringify({ type: "excalidraw/clipboard", elements: [] }), { x: 0, y: 0 }, OPTIONS)).toBeNull();
  });
});
