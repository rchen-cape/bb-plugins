import { describe, expect, it } from "vitest";
import { upstreamNodeIds } from "./model";

const nodes = [
  { id: "a", dependsOn: [] },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["b"] },
  { id: "unrelated", dependsOn: [] },
];

describe("upstreamNodeIds", () => {
  it("walks the whole ancestor chain, not just direct parents", () => {
    expect(upstreamNodeIds(nodes, "c").sort()).toEqual(["a", "b"]);
  });

  it("excludes the task itself and anything not upstream", () => {
    expect(upstreamNodeIds(nodes, "b")).toEqual(["a"]);
    expect(upstreamNodeIds(nodes, "a")).toEqual([]);
  });

  it("terminates on a cyclic dependency list", () => {
    const cyclic = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    expect(upstreamNodeIds(cyclic, "a").sort()).toEqual(["a", "b"]);
  });

  it("ignores a dependency on a task that is no longer present", () => {
    expect(upstreamNodeIds([{ id: "a", dependsOn: ["gone"] }], "a")).toEqual([
      "gone",
    ]);
  });
});
