import { describe, expect, it } from "vitest";
import {
  currentInputDigest,
  dependencyProblem,
  isReachable,
  LAYOUT_MARGIN_X,
  LAYOUT_MARGIN_Y,
  layeredLayout,
  resolveNodeStates,
  topologicalOrder,
  type Graph,
  type GraphNode,
} from "./graph";

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    completion: "open",
    summary: "",
    artifactDigest: "",
    inputDigest: "",
    instruction: "",
    contextMode: "all_parents",
    handoff: "summary",
    customBrief: "",
    contextIncludes: [],
    ...overrides,
  };
}

function chain(nodes: GraphNode[], pairs: [string, string][]): Graph {
  return {
    nodes,
    edges: pairs.map(([parentId, childId]) => ({ parentId, childId })),
  };
}

function completed(id: string, graph: Graph): GraphNode {
  const target = graph.nodes.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`missing ${id}`);
  return target;
}

function settle(graph: Graph, ids: readonly string[]): Graph {
  let current = graph;
  for (const id of ids) {
    const nodes = current.nodes.map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            completion: "done" as const,
            summary: `${id} summary`,
            artifactDigest: `${id}-artifact`,
          }
        : candidate,
    );
    const withSummary: Graph = { nodes, edges: current.edges };
    current = {
      nodes: withSummary.nodes.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              inputDigest: currentInputDigest(withSummary, id),
            }
          : candidate,
      ),
      edges: withSummary.edges,
    };
  }
  return current;
}

describe("dependency validation", () => {
  const graph = chain(
    [node("a"), node("b"), node("c")],
    [
      ["a", "b"],
      ["b", "c"],
    ],
  );

  it("refuses a self dependency", () => {
    expect(dependencyProblem(graph, "a", "a")).toBe(
      "A task cannot depend on itself.",
    );
  });

  it("refuses a duplicate dependency", () => {
    expect(dependencyProblem(graph, "a", "b")).toBe(
      "That dependency already exists.",
    );
  });

  it("refuses an edge that closes a loop through a longer path", () => {
    expect(dependencyProblem(graph, "c", "a")).toBe(
      "That dependency would create a loop.",
    );
  });

  it("allows an edge that only adds a second parent", () => {
    expect(dependencyProblem(graph, "a", "c")).toBeNull();
  });

  it("reports reachability in the dependency direction only", () => {
    expect(isReachable(graph, "a", "c")).toBe(true);
    expect(isReachable(graph, "c", "a")).toBe(false);
  });
});

describe("state resolution", () => {
  it("blocks a task until every parent is finished", () => {
    const graph = chain(
      [node("spec"), node("research"), node("code")],
      [
        ["spec", "code"],
        ["research", "code"],
      ],
    );
    const states = resolveNodeStates(graph);
    expect(states.get("spec")).toBe("ready");
    expect(states.get("code")).toBe("blocked");

    const partly = settle(graph, ["spec"]);
    expect(resolveNodeStates(partly).get("code")).toBe("blocked");

    const ready = settle(partly, ["research"]);
    expect(resolveNodeStates(ready).get("code")).toBe("ready");
  });

  it("reports an explicitly started task as in progress", () => {
    const graph = chain([node("a", { completion: "working" })], []);
    expect(resolveNodeStates(graph).get("a")).toBe("in_progress");
  });

  it("marks a completed child stale when its parent's summary changes", () => {
    const base = settle(chain([node("a"), node("b")], [["a", "b"]]), [
      "a",
      "b",
    ]);
    expect(resolveNodeStates(base).get("b")).toBe("completed");

    const edited: Graph = {
      nodes: base.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, summary: "rewritten summary" }
          : candidate,
      ),
      edges: base.edges,
    };
    expect(resolveNodeStates(edited).get("a")).toBe("completed");
    expect(resolveNodeStates(edited).get("b")).toBe("stale");
  });

  it("propagates a stale warning to completed grandchildren", () => {
    const base = settle(
      chain(
        [node("a"), node("b"), node("c")],
        [
          ["a", "b"],
          ["b", "c"],
        ],
      ),
      ["a", "b", "c"],
    );
    const edited: Graph = {
      nodes: base.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, summary: "rewritten" }
          : candidate,
      ),
      edges: base.edges,
    };
    const states = resolveNodeStates(edited);
    expect(states.get("b")).toBe("stale");
    expect(states.get("c")).toBe("stale");
  });

  it("keeps a stale parent from blocking its children", () => {
    const base = settle(
      chain(
        [node("root"), node("a"), node("b")],
        [
          ["root", "a"],
          ["a", "b"],
        ],
      ),
      ["root", "a"],
    );
    const edited: Graph = {
      nodes: base.nodes.map((candidate) =>
        candidate.id === "root"
          ? { ...candidate, summary: "changed after completion" }
          : candidate,
      ),
      edges: base.edges,
    };
    const states = resolveNodeStates(edited);
    expect(states.get("a")).toBe("stale");
    expect(states.get("b")).toBe("ready");
  });

  /*
   * A reader never sees more of a parent than the parent hands over, so a
   * rewrite of a document only a summary is drawn from is nothing the child
   * read. Warning about it would be a warning about text it was never sent.
   */
  it("does not stale a child when a summary parent's document changed", () => {
    const graph = settle(chain([node("a"), node("b")], [["a", "b"]]), [
      "a",
      "b",
    ]);
    const edited: Graph = {
      nodes: graph.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, artifactDigest: "rewritten-file" }
          : candidate,
      ),
      edges: graph.edges,
    };
    expect(resolveNodeStates(edited).get("b")).toBe("completed");
  });

  it("stales a completed task when its own instruction changes", () => {
    const graph = settle(chain([node("a")], []), ["a"]);
    const edited: Graph = {
      nodes: graph.nodes.map((candidate) => ({
        ...candidate,
        instruction: "do something else",
      })),
      edges: graph.edges,
    };
    expect(resolveNodeStates(edited).get("a")).toBe("stale");
  });

  it("ignores custom includes that are not upstream of the task", () => {
    const graph = chain(
      [
        node("a"),
        node("unrelated", { summary: "noise" }),
        node("b", {
          contextMode: "custom",
          contextIncludes: ["a", "unrelated"],
        }),
      ],
      [["a", "b"]],
    );
    const withSummaries = settle(graph, ["a"]);
    const before = currentInputDigest(withSummaries, "b");
    const changedUnrelated: Graph = {
      nodes: withSummaries.nodes.map((candidate) =>
        candidate.id === "unrelated"
          ? { ...candidate, summary: "different noise" }
          : candidate,
      ),
      edges: withSummaries.edges,
    };
    expect(currentInputDigest(changedUnrelated, "b")).toBe(before);
  });

  /*
   * Staleness is the promise that a task is told when what it read changed.
   * A parent handing over its whole document is read through its artifact, so
   * that is the side the digest has to hash — hashing the summary instead
   * would leave the child reading an edit it was never warned about.
   */
  it("follows a parent's document when that is what it hands over", () => {
    const graph = chain(
      [node("a", { handoff: "full" }), node("b")],
      [["a", "b"]],
    );
    const settled = settle(settle(graph, ["a"]), ["b"]);
    expect(resolveNodeStates(settled).get("b")).toBe("completed");

    const editedDocument: Graph = {
      nodes: settled.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, artifactDigest: "a-artifact-v2" }
          : candidate,
      ),
      edges: settled.edges,
    };
    expect(resolveNodeStates(editedDocument).get("b")).toBe("stale");
  });

  it("ignores a summary the child will never be sent", () => {
    const graph = chain(
      [node("a", { handoff: "full" }), node("b")],
      [["a", "b"]],
    );
    const settled = settle(settle(graph, ["a"]), ["b"]);
    const rewrittenSummary: Graph = {
      nodes: settled.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, summary: "a completely different summary" }
          : candidate,
      ),
      edges: settled.edges,
    };
    expect(resolveNodeStates(rewrittenSummary).get("b")).toBe("completed");
  });

  it("stales a child when its parent switches what it hands over", () => {
    const graph = chain([node("a"), node("b")], [["a", "b"]]);
    const settled = settle(settle(graph, ["a"]), ["b"]);
    const switched: Graph = {
      nodes: settled.nodes.map((candidate) =>
        candidate.id === "a"
          ? { ...candidate, handoff: "full" as const }
          : candidate,
      ),
      edges: settled.edges,
    };
    expect(resolveNodeStates(switched).get("b")).toBe("stale");
  });

  it("does not recurse forever if stored edges contain a loop", () => {
    const graph = chain(
      [node("a"), node("b")],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(() => resolveNodeStates(graph)).not.toThrow();
  });
});

describe("ordering and layout", () => {
  const graph = chain(
    [node("a"), node("b"), node("c"), node("d")],
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
    ],
  );

  it("orders every parent before its children", () => {
    const order = topologicalOrder(graph);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    expect(order).toHaveLength(4);
  });

  it("puts each task below its deepest parent and spreads siblings", () => {
    const layout = layeredLayout(graph);
    const a = layout.get("a");
    const b = layout.get("b");
    const c = layout.get("c");
    const d = layout.get("d");
    expect(a?.y).toBe(LAYOUT_MARGIN_Y);
    expect(b?.y).toBe(c?.y);
    expect(b?.y).toBeGreaterThan(a?.y ?? 0);
    expect(b?.x).not.toBe(c?.x);
    expect(d?.y).toBeGreaterThan(b?.y ?? 0);
  });

  it("centers a narrow row against the widest one", () => {
    const layout = layeredLayout(graph);
    const a = layout.get("a");
    const b = layout.get("b");
    const c = layout.get("c");
    const d = layout.get("d");
    const rowOneCenter = ((b?.x ?? 0) + (c?.x ?? 0)) / 2;
    expect(a?.x).toBe(rowOneCenter);
    expect(d?.x).toBe(rowOneCenter);
  });

  it("insets a uniform graph from the canvas edges", () => {
    const uniform = chain([node("a"), node("b")], [["a", "b"]]);
    const layout = layeredLayout(uniform);
    expect(layout.get("a")?.x).toBe(LAYOUT_MARGIN_X);
    expect(layout.get("b")?.x).toBe(LAYOUT_MARGIN_X);
    expect(layout.get("a")?.y).toBe(LAYOUT_MARGIN_Y);
  });

  it("keeps every node when the stored edges are cyclic", () => {
    const cyclic = chain(
      [node("a"), node("b")],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(topologicalOrder(cyclic).sort()).toEqual(["a", "b"]);
  });

  it("digests a completed parent set deterministically", () => {
    const settled = settle(chain([node("a"), node("b")], [["a", "b"]]), ["a"]);
    expect(currentInputDigest(settled, "b")).toBe(
      currentInputDigest(settled, "b"),
    );
    expect(completed("a", settled).summary).toBe("a summary");
  });
});
