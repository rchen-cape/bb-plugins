import { describe, expect, it } from "vitest";
import type { SketchSummary } from "../contract";
import { defaultSketch, routeSketchId, sketchSubPath, titleFromFileName } from "./routes";

function summary(id: string): SketchSummary {
  return { id, title: id, updatedAt: "2026-10-19T10:00:00.000Z", elementCount: 0, sizeBytes: 0 };
}

describe("sketch routes", () => {
  it("leaves encoding to the host and decodes the host-encoded sub path once", () => {
    const hostEncode = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");
    for (const id of ["Login flow #2", "50% done", "Untitled 2", "Plan copy", "100%25 sure"]) {
      expect(sketchSubPath(id)).toBe(id);
      expect(routeSketchId(hostEncode(sketchSubPath(id)))).toBe(id);
    }
    expect(routeSketchId("/Plan/")).toBe("Plan");
  });

  it("treats empty and invalid sub paths as no sketch", () => {
    expect(routeSketchId("")).toBeNull();
    expect(routeSketchId("%E0%A4%A")).toBeNull();
    expect(routeSketchId(encodeURIComponent(".hidden"))).toBeNull();
    expect(routeSketchId("a%2Fb")).toBeNull();
  });

  it("opens the last sketch when it still exists, else the newest", () => {
    const sketches = [summary("Newest"), summary("Older")];
    expect(defaultSketch(sketches, "Older")).toBe("Older");
    expect(defaultSketch(sketches, "Gone")).toBe("Newest");
    expect(defaultSketch(sketches, null)).toBe("Newest");
    expect(defaultSketch([], null)).toBeNull();
  });

  it("turns a file name into a sketch title", () => {
    expect(titleFromFileName("Login flow.excalidraw", 120)).toBe("Login flow");
    expect(titleFromFileName("diagram.excalidraw.json", 120)).toBe("diagram");
    expect(titleFromFileName("a/b:c?.excalidraw", 120)).toBe("a b c");
    expect(titleFromFileName("..hidden.excalidraw", 120)).toBe("hidden");
    expect(titleFromFileName(".excalidraw", 120)).toBeNull();
    expect(titleFromFileName(`${"x".repeat(200)}.excalidraw`, 120)).toHaveLength(120);
  });
});
