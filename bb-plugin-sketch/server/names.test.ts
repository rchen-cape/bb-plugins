import { describe, expect, it } from "vitest";
import { clip, copyTitle, freeTitle, nameKey, sanitizeTitle, sketchIdOf, takenKey, withSuffix } from "./names";
import { pngFileName, pngName } from "./outbox";

const taken = (...names: string[]) => new Set(names.map(nameKey));

describe("sketch names", () => {
  it("turns any title into a safe file name", () => {
    expect(sanitizeTitle("Plan")).toBe("Plan");
    expect(sanitizeTitle("  Q3:  plan/ideas  ")).toBe("Q3- plan-ideas");
    expect(sanitizeTitle('a\\b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
    expect(sanitizeTitle("line\nbreak\ttab")).toBe("line break tab");
    expect(sanitizeTitle("...dots")).toBe("dots");
    expect(sanitizeTitle("Flow.EXCALIDRAW")).toBe("Flow");
    expect(sanitizeTitle("///")).toBe("-");
    expect(sanitizeTitle("   ")).toBe("Untitled");
    expect(sanitizeTitle(".excalidraw")).toBe("Untitled");
    expect(sanitizeTitle("x".repeat(300))).toHaveLength(120);
  });

  it("never splits an emoji when clipping", () => {
    const title = `${"a".repeat(119)}😀`;
    expect(clip(title, 120)).toBe("a".repeat(119));
    expect(withSuffix(`${"b".repeat(117)}😀`, " 2")).toBe(`${"b".repeat(117)} 2`);
  });

  it("numbers taken titles case-insensitively", () => {
    expect(freeTitle("Plan", taken())).toBe("Plan");
    expect(freeTitle("Plan", taken("plan"))).toBe("Plan 2");
    expect(freeTitle("Plan", taken("PLAN", "plan 2", "Plan 3"))).toBe("Plan 4");
    expect(freeTitle("Untitled", taken("Untitled"))).toBe("Untitled 2");
    expect(freeTitle("x".repeat(120), taken("x".repeat(120)))).toBe(`${"x".repeat(118)} 2`);
  });

  it("names copies like Finder does", () => {
    expect(copyTitle("Plan", taken("Plan"))).toBe("Plan copy");
    expect(copyTitle("Plan", taken("Plan", "Plan copy"))).toBe("Plan copy 2");
    expect(copyTitle("Plan copy", taken("Plan", "Plan copy"))).toBe("Plan copy 2");
    expect(copyTitle("Plan copy 2", taken("Plan", "Plan copy", "plan copy 2"))).toBe("Plan copy 3");
    expect(copyTitle("Photocopy", taken("Photocopy"))).toBe("Photocopy copy");
  });

  it("reads sketch ids from file names", () => {
    expect(sketchIdOf("Plan.excalidraw")).toBe("Plan");
    expect(sketchIdOf(".Plan.excalidraw")).toBeNull();
    expect(sketchIdOf("Plan.excalidraw.tmp")).toBeNull();
    expect(sketchIdOf("Plan.EXCALIDRAW")).toBeNull();
    expect(sketchIdOf(" Plan.excalidraw")).toBeNull();
    expect(sketchIdOf(".excalidraw")).toBeNull();
    expect(takenKey("Plan.EXCALIDRAW")).toBe("plan");
    expect(takenKey("notes.md")).toBeNull();
  });

  it("makes safe PNG names for the Wiki", () => {
    expect(pngName("Plan")).toBe("Plan.png");
    expect(pngName("shot.PNG")).toBe("shot.png");
    expect(pngName(".png")).toBe("sketch.png");
    expect(pngFileName("../a/b: c")).toBe("-a-b- c.png");
    expect(pngFileName("...")).toBe("sketch.png");
    expect(pngFileName("x".repeat(300))).toBe(`${"x".repeat(100)}.png`);
  });
});
