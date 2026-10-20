import { describe, expect, it } from "vitest";
import { EXCALIFONT_FACES } from "./excalifont";
import { escapeXml, exportBounds, sceneToSvg } from "./svg-export";
import { arrow, rect, text, unsupported } from "./test-fixtures";

const OPTIONS = { padding: 16, background: "#ffffff", embedFont: true };

describe("sceneToSvg", () => {
  it("writes a standalone SVG sized to the content plus padding", () => {
    const { svg, width, height } = sceneToSvg([rect(10, 20, 100, 50, { roughness: 0, strokeWidth: 2 })], OPTIONS);
    expect(width).toBe(Math.ceil(102 + 32));
    expect(height).toBe(Math.ceil(52 + 32));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`);
    expect(svg).toContain(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    expect(svg).not.toContain("foreignObject");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("places content inside the padding", () => {
    const { svg } = sceneToSvg([rect(10, 20, 100, 50, { roughness: 0, strokeWidth: 2 })], { ...OPTIONS, padding: 10 });
    expect(svg).toContain('<g transform="translate(1 -9)"><g transform="translate(10 20)">');
  });

  it("omits the background when asked", () => {
    const { svg } = sceneToSvg([rect(0, 0, 10, 10)], { ...OPTIONS, background: null });
    expect(svg).not.toContain("<rect");
  });

  it("escapes text and attribute values", () => {
    const evil = text({ x: 0, y: 0 }, `<script>&"'</script>\u0007`, { strokeColor: `red" onload="alert(1)` });
    const { svg } = sceneToSvg([evil], OPTIONS);
    expect(svg).toContain("&lt;script&gt;&amp;&quot;&apos;&lt;/script&gt;</text>");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('onload="');
    expect(svg).toContain('fill="red&quot; onload=&quot;alert(1)"');
    expect(svg).not.toContain("\u0007");
    expect(escapeXml("a\uD800b\uDC00c\uFFFE")).toBe("abc");
    expect(escapeXml("tab\tnew\nline")).toBe("tab\tnew\nline");
    expect(escapeXml("😀")).toBe("😀");
  });

  it("writes one text node per line with the font stack and anchor", () => {
    const { svg } = sceneToSvg([text({ x: 0, y: 0 }, "one\ntwo", { textAlign: "center", width: 30 })], OPTIONS);
    expect(svg.match(/<text /g)).toHaveLength(2);
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain("font-family=\"Excalifont, &apos;Segoe UI Emoji&apos;");
    expect(svg).toContain('style="white-space: pre"');
  });

  it("embeds Excalifont only when hand-drawn text is present", () => {
    const hand = sceneToSvg([text({ x: 0, y: 0 }, "hi")], OPTIONS).svg;
    expect(hand).toContain("@font-face");
    expect(hand.match(/@font-face/g)).toHaveLength(EXCALIFONT_FACES.length);
    expect(hand).toContain(`data:font/woff2;base64,${EXCALIFONT_FACES[0]?.woff2Base64.slice(0, 40)}`);
    expect(sceneToSvg([text({ x: 0, y: 0 }, "hi", { fontFamily: 2 })], OPTIONS).svg).not.toContain("@font-face");
    expect(sceneToSvg([rect(0, 0, 10, 10)], OPTIONS).svg).not.toContain("@font-face");
    expect(sceneToSvg([text({ x: 0, y: 0 }, "hi")], { ...OPTIONS, embedFont: false }).svg).not.toContain("@font-face");
  });

  it("includes arrowheads and rotation in the bounds", () => {
    const flat = exportBounds([arrow({ x: 0, y: 0 }, { x: 200, y: 0 }, { roughness: 0 })]);
    expect(flat?.minY).toBeLessThan(-5);
    const turned = exportBounds([rect(0, 0, 100, 20, { roughness: 0, angle: Math.PI / 2 })]);
    expect(turned?.minY).toBeCloseTo(-41);
    expect(sceneToSvg([rect(0, 0, 100, 20, { roughness: 0, angle: Math.PI / 2 })], OPTIONS).svg).toContain("rotate(90 50 10)");
  });

  it("writes opacity and skips deleted elements", () => {
    const { svg } = sceneToSvg([rect(0, 0, 10, 10, { opacity: 50 }), rect(500, 500, 10, 10, { isDeleted: true })], OPTIONS);
    expect(svg).toContain('opacity="0.5"');
    expect(svg).not.toContain("translate(500 500)");
  });

  it("draws unsupported elements as placeholders and handles empty scenes", () => {
    expect(sceneToSvg([unsupported("u", { x: 0, y: 0, width: 50, height: 50 })], OPTIONS).svg).toContain('stroke-dasharray="6 4"');
    const empty = sceneToSvg([], OPTIONS);
    expect(empty.width).toBe(32);
    expect(empty.height).toBe(32);
    expect(sceneToSvg([], { ...OPTIONS, padding: Number.NaN }).width).toBe(1);
  });

  it("uses light colors and keeps z-order with labels after containers", () => {
    const box = rect(0, 0, 100, 50, { strokeColor: "#1e1e1e" });
    const label = text({ x: 30, y: 10 }, "label", { containerId: box.id });
    const { svg } = sceneToSvg([label, box], OPTIONS);
    expect(svg.indexOf('stroke="#1e1e1e"')).toBeLessThan(svg.indexOf("<text"));
    expect(svg).not.toContain("#d3d3d3");
  });
});
