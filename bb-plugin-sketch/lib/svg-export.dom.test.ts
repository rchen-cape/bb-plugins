// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sceneToSvg } from "./svg-export";
import { arrow, freedraw, rect, shape, text, unsupported } from "./test-fixtures";

describe("sceneToSvg in the browser", () => {
  it("produces well-formed SVG that a DOM parser accepts", () => {
    const elements = [
      rect(0, 0, 100, 50, { backgroundColor: "#a5d8ff", fillStyle: "hachure" }),
      shape("ellipse", { x: 120, y: 0, width: 80, height: 50 }, { strokeStyle: "dashed" }),
      shape("diamond", { x: 220, y: 0, width: 80, height: 50 }),
      arrow({ x: 0, y: 100 }, { x: 200, y: 140 }, { startArrowhead: "dot", endArrowhead: "triangle" }),
      freedraw({ x: 0, y: 200 }, [[0, 0], [20, 10], [40, -5]]),
      text({ x: 0, y: 260 }, `Tom & "Jerry" <3`),
      unsupported("img", { x: 300, y: 200, width: 60, height: 60 }),
    ];
    const { svg, width, height } = sceneToSvg(elements, { padding: 16, background: "#ffffff", embedFont: true });
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const root = doc.documentElement;
    expect(root.getAttribute("width")).toBe(String(width));
    expect(root.getAttribute("height")).toBe(String(height));
    const texts = [...doc.getElementsByTagName("text")].map((node) => node.textContent);
    expect(texts).toContain(`Tom & "Jerry" <3`);
    expect(texts).toContain("image");
    expect(doc.getElementsByTagName("style")).toHaveLength(1);
  });
});
