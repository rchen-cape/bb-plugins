// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { approximateMeasure, createCanvasMeasure, fontString } from "./text";

describe("createCanvasMeasure", () => {
  it("falls back to an estimate where canvas can't measure", () => {
    const measure = createCanvasMeasure();
    const font = fontString(20, 5);
    expect(measure("hello", font)).toBe(approximateMeasure("hello", font));
  });
});
