import { describe, expect, it } from "vitest";
import { rect } from "../lib/test-fixtures";
import { blobToBase64, downloadName, exportSvg, MAX_CANVAS_PIXELS, pixelSize, pngScale, withPixelSize } from "./export-png";

describe("PNG export helpers", () => {
  it("scales by 2 unless the canvas would get too big", () => {
    expect(pngScale(400, 300)).toBe(2);
    const scale = pngScale(4000, 4000);
    expect(scale).toBeLessThan(2);
    expect(4000 * 4000 * scale * scale).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
    expect(pixelSize(400, 300, 2)).toEqual({ width: 800, height: 600 });
  });

  it("rewrites only the root size of an exported SVG", () => {
    const svg = exportSvg([rect(0, 0, 100, 50)]);
    const scaled = withPixelSize(svg.svg, svg, { width: svg.width * 2, height: svg.height * 2 });
    expect(scaled).toContain(`width="${svg.width * 2}" height="${svg.height * 2}" viewBox="0 0 ${svg.width} ${svg.height}"`);
    expect(scaled.match(/viewBox/g)).toHaveLength(1);
  });

  it("encodes blobs as base64", async () => {
    expect(await blobToBase64(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]))).toBe("iVBORw==");
  });

  it("makes safe download names", () => {
    expect(downloadName("Login flow", "png")).toBe("Login flow.png");
    expect(downloadName("a/b:c", "svg")).toBe("a b c.svg");
    expect(downloadName("  ", "excalidraw")).toBe("sketch.excalidraw");
  });
});
