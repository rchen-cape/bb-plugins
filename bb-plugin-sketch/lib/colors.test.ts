import { describe, expect, it } from "vitest";
import { darkColor, isTransparent, paint, parseColor } from "./colors";

describe("darkColor", () => {
  it("maps white to the dark canvas gray", () => {
    expect(darkColor("#ffffff")).toBe("#121212");
  });

  it("maps the default stroke to a light gray", () => {
    expect(darkColor("#1e1e1e")).toBe("#d3d3d3");
  });

  it("maps black to near white", () => {
    expect(darkColor("#000000")).toBe("#ededed");
  });

  it("keeps hue for colors by inverting and rotating 180 degrees", () => {
    expect(darkColor("#e03131")).toBe("#ff8383");
  });

  it("accepts short hex and keeps alpha", () => {
    expect(darkColor("#fff")).toBe("#121212");
    expect(darkColor("#ffffff80")).toBe("#12121280");
    expect(darkColor("#FFFFFF")).toBe("#121212");
  });

  it("accepts rgb() notation", () => {
    expect(darkColor("rgb(255, 255, 255)")).toBe("#121212");
    expect(darkColor("rgba(0 0 0 / 50%)")).toBe("#ededed80");
  });

  it("passes through transparent and unparsable values", () => {
    expect(darkColor("transparent")).toBe("transparent");
    expect(darkColor("red")).toBe("red");
    expect(darkColor("not a color")).toBe("not a color");
    expect(darkColor("#12345")).toBe("#12345");
  });

  it("is stable across calls", () => {
    expect(darkColor("#1971c2")).toBe(darkColor("#1971c2"));
  });
});

describe("paint", () => {
  it("returns none for transparent or missing paint", () => {
    expect(paint(null, "light")).toBe("none");
    expect(paint("transparent", "dark")).toBe("none");
    expect(paint("#00000000", "light")).toBe("none");
  });

  it("maps colors only in the dark theme", () => {
    expect(paint("#1e1e1e", "light")).toBe("#1e1e1e");
    expect(paint("#1e1e1e", "dark")).toBe("#d3d3d3");
  });
});

describe("parseColor and isTransparent", () => {
  it("parses hex forms", () => {
    expect(parseColor("#a5d8ff")).toEqual({ r: 165, g: 216, b: 255, a: null });
    expect(parseColor("#0f08")).toEqual({ r: 0, g: 255, b: 0, a: 136 });
    expect(parseColor("rgb(300, 0, 0)")).toBeNull();
  });

  it("knows transparent values", () => {
    expect(isTransparent("transparent")).toBe(true);
    expect(isTransparent(" Transparent ")).toBe(true);
    expect(isTransparent("#ffffff00")).toBe(true);
    expect(isTransparent("#ffffff")).toBe(false);
  });
});
