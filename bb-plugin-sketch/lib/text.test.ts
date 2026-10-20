import { describe, expect, it } from "vitest";
import { measure, rect, shape, text } from "./test-fixtures";
import {
  approximateMeasure,
  baselineOffset,
  computeLabelLayout,
  containerSizeForLabel,
  fontFamilyName,
  fontStack,
  fontString,
  labelInnerOrigin,
  labelMaxHeight,
  labelMaxWidth,
  labelPosition,
  lineHeightPx,
  measureTextBlock,
  normalizeText,
  wrapText,
} from "./text";

const FONT = fontString(20, 5);

describe("fonts", () => {
  it("maps Excalidraw families to three stacks", () => {
    expect(fontFamilyName(5)).toBe("hand");
    expect(fontFamilyName(1)).toBe("hand");
    expect(fontFamilyName(2)).toBe("normal");
    expect(fontFamilyName(6)).toBe("normal");
    expect(fontFamilyName(3)).toBe("code");
    expect(fontFamilyName(8)).toBe("code");
    expect(fontFamilyName(999)).toBe("normal");
  });

  it("builds CSS font strings", () => {
    expect(fontStack(5).startsWith("Excalifont,")).toBe(true);
    expect(fontStack(3)).toContain("monospace");
    expect(fontStack(2)).toContain("sans-serif");
    expect(fontString(28, 2)).toBe(`28px ${fontStack(2)}`);
  });

  it("uses line height 1.25 and Excalidraw's baseline formula", () => {
    expect(lineHeightPx(20)).toBe(25);
    expect(baselineOffset(20, 5)).toBeCloseTo(17.62, 2);
    expect(baselineOffset(20, 2)).toBeGreaterThan(15);
    expect(baselineOffset(20, 2)).toBeLessThan(25);
  });
});

describe("wrapText", () => {
  it("keeps lines that fit", () => {
    expect(wrapText("hello", FONT, 100, measure)).toBe("hello");
  });

  it("breaks at spaces and drops the breaking space", () => {
    expect(wrapText("hello world foo", FONT, 110, measure)).toBe("hello world\nfoo");
  });

  it("breaks words that are wider than the box", () => {
    expect(wrapText("abcdefghijklmnop", FONT, 50, measure)).toBe("abcde\nfghij\nklmno\np");
  });

  it("keeps explicit newlines and first-line indentation", () => {
    expect(wrapText("  ab cd\nef", FONT, 50, measure)).toBe("  ab\ncd\nef");
    expect(wrapText("a\n\nb", FONT, 100, measure)).toBe("a\n\nb");
  });

  it("does not wrap without a usable width", () => {
    expect(wrapText("hello world", FONT, 0, measure)).toBe("hello world");
    expect(wrapText("hello world", FONT, Number.NaN, measure)).toBe("hello world");
  });

  it("splits by code points, not UTF-16 units", () => {
    expect(wrapText("😀😀😀", FONT, 20, measure)).toBe("😀😀\n😀");
  });
});

describe("text layout", () => {
  it("measures the widest line and line count", () => {
    expect(measureTextBlock("ab\nabcd", 20, 5, 1.25, measure)).toEqual({ width: 40, height: 50 });
    expect(measureTextBlock("", 20, 5, 1.25, measure)).toEqual({ width: 0, height: 25 });
  });

  it("normalizes pasted text", () => {
    expect(normalizeText("a\r\nb\rc\td")).toBe("a\nb\nc    d");
  });

  it("estimates widths without a canvas", () => {
    expect(approximateMeasure("abcd", "10px x")).toBeCloseTo(22);
  });
});

describe("container labels", () => {
  it("uses Excalidraw's inner box per container type", () => {
    expect(labelMaxWidth({ type: "rectangle", width: 200 })).toBe(190);
    expect(labelMaxWidth({ type: "ellipse", width: 200 })).toBe(131);
    expect(labelMaxWidth({ type: "diamond", width: 200 })).toBe(90);
    expect(labelMaxHeight({ type: "rectangle", height: 100 })).toBe(90);
    expect(labelMaxHeight({ type: "ellipse", height: 100 })).toBe(61);
    expect(labelMaxHeight({ type: "diamond", height: 100 })).toBe(40);
  });

  it("offsets the inner box origin", () => {
    expect(labelInnerOrigin({ type: "rectangle", x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 15, y: 25 });
    expect(labelInnerOrigin({ type: "diamond", x: 0, y: 0, width: 100, height: 80 })).toEqual({ x: 30, y: 25 });
    const ellipse = labelInnerOrigin({ type: "ellipse", x: 0, y: 0, width: 100, height: 100 });
    expect(ellipse.x).toBeCloseTo(5 + 50 * (1 - Math.SQRT2 / 2));
  });

  it("grows containers to fit a label", () => {
    expect(containerSizeForLabel(75, "rectangle")).toBe(85);
    expect(containerSizeForLabel(75, "diamond")).toBe(170);
    expect(containerSizeForLabel(75, "ellipse")).toBe(Math.round((85 / Math.SQRT2) * 2));
  });

  it("centers a label in its container", () => {
    const position = labelPosition(
      { type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
      { width: 50, height: 25, textAlign: "center", verticalAlign: "middle" },
    );
    expect(position).toEqual({ x: 75, y: 37.5 });
    const topLeft = labelPosition(
      { type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
      { width: 50, height: 25, textAlign: "left", verticalAlign: "top" },
    );
    expect(topLeft).toEqual({ x: 5, y: 5 });
  });

  it("wraps and grows taller containers", () => {
    const box = rect(0, 0, 60, 40);
    const label = text({ x: 0, y: 0 }, "", { originalText: "aaaa bbbb cccc", containerId: box.id, textAlign: "center", verticalAlign: "middle" });
    const layout = computeLabelLayout(box, label, measure);
    expect(layout.text).toBe("aaaa\nbbbb\ncccc");
    expect(layout.height).toBe(75);
    expect(layout.containerHeight).toBe(85);
    expect(layout.containerWidth).toBe(60);
    expect(layout.x).toBe(10);
    expect(layout.y).toBe(5);
  });

  it("keeps a short label on one line in an ellipse", () => {
    const ellipse = shape("ellipse", { x: 0, y: 0, width: 200, height: 100 });
    const label = text({ x: 0, y: 0 }, "", { originalText: "hi", containerId: ellipse.id, textAlign: "center", verticalAlign: "middle" });
    const layout = computeLabelLayout(ellipse, label, measure);
    expect(layout.text).toBe("hi");
    expect(layout.containerHeight).toBe(100);
    expect(layout.x + layout.width / 2).toBeCloseTo(100, 0);
    expect(layout.y + layout.height / 2).toBeCloseTo(50, 0);
  });
});
