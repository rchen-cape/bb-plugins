import { describe, expect, it } from "vitest";
import { renderModel } from "./render";
import { groupProps, pathProps, textProps } from "./render-props";
import { rect, text } from "./test-fixtures";

describe("render props", () => {
  it("maps paths to SVG props with theme colors", () => {
    const model = renderModel(rect(0, 0, 100, 60, { backgroundColor: "#ffffff", strokeStyle: "dashed" }));
    const [fill, stroke] = model.paths;
    if (fill === undefined || stroke === undefined) throw new Error("missing paths");
    expect(pathProps(fill, "light")).toMatchObject({ fill: "#ffffff", stroke: "none", strokeWidth: undefined, strokeDasharray: undefined });
    expect(pathProps(fill, "dark").fill).toBe("#121212");
    expect(pathProps(stroke, "dark")).toMatchObject({
      fill: "none",
      stroke: "#d3d3d3",
      strokeWidth: 2.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeDasharray: "8 10",
    });
  });

  it("maps text runs and element groups", () => {
    const label = text({ x: 5, y: 6 }, "hi", { opacity: 50 });
    const run = renderModel(label).texts[0];
    if (run === undefined) throw new Error("missing text");
    expect(textProps(run, "dark")).toMatchObject({ fill: "#d3d3d3", textAnchor: "start", fontSize: 20, style: { whiteSpace: "pre" } });
    expect(groupProps(label)).toEqual({ transform: "translate(5 6)", opacity: 0.5 });
    expect(groupProps(rect(0, 0, 1, 1)).opacity).toBeUndefined();
  });
});
