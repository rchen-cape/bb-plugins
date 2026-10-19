import { describe, expect, it } from "vitest";
import type { Destination, DocSummary, DocTarget, TagSuggestion } from "../contract";
import {
  acceptTagSuggestion,
  createDestination,
  hasContentToAdd,
  headingOptions,
  isLineSelected,
  nextDestinationId,
  pendingSuggestions,
  retarget,
  selectLineRange,
  selectionLabel,
  selectionToSet,
  setToSelection,
  targetHeadings,
  targetTitle,
  toggleLine,
} from "./card-edit";

function destination(id: string, patch: Partial<Destination> = {}): Destination {
  return {
    id,
    include: true,
    target: { kind: "existing", slug: "unified-notification" },
    heading: "Unsorted",
    lineRanges: "all",
    role: "content",
    reason: "",
    ...patch,
  };
}

const DOCS = new Map<string, DocSummary>([
  [
    "unified-notification",
    {
      slug: "unified-notification",
      title: "Unified notification",
      type: "project",
      aliases: [],
      tag: "unified-notification",
      updatedAt: "2026-10-14T10:00:00.000Z",
      headings: ["Unified notification", "Global token", "Related"],
    },
  ],
]);

describe("line selections", () => {
  it("converts between ranges and line sets", () => {
    expect([...selectionToSet("all", 3)]).toEqual([0, 1, 2]);
    expect([...selectionToSet([{ start: 1, end: 2 }, { start: 4, end: 9 }], 6)]).toEqual([1, 2, 4, 5]);
    expect(setToSelection(new Set([0, 1, 2]), 3)).toBe("all");
    expect(setToSelection(new Set([4, 1, 2, 6]), 8)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 4 },
      { start: 6, end: 6 },
    ]);
    expect(setToSelection(new Set(), 3)).toBeNull();
    expect(setToSelection(new Set([7]), 3)).toBeNull();
  });

  it("toggles one line", () => {
    expect(toggleLine("all", 1, 4)).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 3 },
    ]);
    expect(toggleLine([{ start: 0, end: 0 }], 1, 2)).toBe("all");
    expect(toggleLine([{ start: 3, end: 3 }], 3, 5)).toBeNull();
  });

  it("adds a shift-click range in either direction", () => {
    expect(selectLineRange([{ start: 0, end: 0 }], 2, 4, 6)).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 4 },
    ]);
    expect(selectLineRange([{ start: 5, end: 5 }], 5, 0, 6)).toBe("all");
  });

  it("checks membership", () => {
    expect(isLineSelected("all", 9)).toBe(true);
    expect(isLineSelected([{ start: 1, end: 3 }], 3)).toBe(true);
    expect(isLineSelected([{ start: 1, end: 3 }], 4)).toBe(false);
  });

  it("labels selections with one-based line numbers", () => {
    expect(selectionLabel("all", 4)).toBe("all lines");
    expect(selectionLabel([{ start: 0, end: 3 }], 4)).toBe("all lines");
    expect(selectionLabel([{ start: 1, end: 4 }], 8)).toBe("lines 2–5");
    expect(selectionLabel([{ start: 2, end: 2 }], 8)).toBe("line 3");
    expect(selectionLabel([{ start: 0, end: 1 }, { start: 3, end: 3 }], 8)).toBe("lines 1–2, 4");
  });
});

describe("destinations", () => {
  it("creates destinations with unique ids and the right default heading", () => {
    const existing = [destination("dest_1"), destination("dest_3")];
    expect(nextDestinationId(existing)).toBe("dest_4");
    expect(nextDestinationId([destination("dest_2")])).toBe("dest_3");
    expect(createDestination(existing, { kind: "existing", slug: "x" })).toMatchObject({ id: "dest_4", heading: "Unsorted", lineRanges: "all", include: true });
    expect(createDestination([], { kind: "new", title: "Billing", type: "topic", aliases: [] })).toMatchObject({ id: "dest_1", heading: "Notes" });
  });

  it("keeps a chosen heading when the doc changes, but swaps default headings", () => {
    const fresh = retarget(destination("d", { heading: "Notes", target: { kind: "new", title: "X", type: "topic", aliases: [] } }), { kind: "existing", slug: "y" });
    expect(fresh.heading).toBe("Unsorted");
    expect(retarget(destination("d", { heading: "Global token" }), { kind: "existing", slug: "y" }).heading).toBe("Global token");
  });

  it("lists headings from the doc plus Unsorted, Related for links, and the current one", () => {
    const target: DocTarget = { kind: "existing", slug: "unified-notification" };
    expect(headingOptions(targetHeadings(target, DOCS), "unsorted", "content", target)).toEqual(["Unified notification", "Global token", "Related", "unsorted"]);
    expect(headingOptions([], "Custom", "link", target)).toEqual(["Unsorted", "Related", "Custom"]);
    expect(headingOptions([], "Notes", "content", { kind: "new", title: "X", type: "topic", aliases: [] })).toEqual(["Notes", "Unsorted"]);
  });

  it("names targets", () => {
    expect(targetTitle({ kind: "existing", slug: "unified-notification" }, DOCS)).toBe("Unified notification");
    expect(targetTitle({ kind: "existing", slug: "gone" }, DOCS)).toBe("gone");
    expect(targetTitle({ kind: "new", title: "Billing", type: "topic", aliases: [] }, DOCS)).toBe("Billing");
  });
});

describe("tag suggestions", () => {
  const suggestion = (tag: string, slug: string, score: number): TagSuggestion => ({ tag, slug, title: slug, score });

  it("switches the provisional new doc to the suggested doc and remembers the alias", () => {
    const draft = {
      destinations: [destination("dest_1", { include: false, heading: "Notes", target: { kind: "new", title: "Cc", type: "project", aliases: [] } })],
      rememberAliases: [],
    };
    const next = acceptTagSuggestion(draft, { tag: "cc", slug: "adding-config-catalog" });
    expect(next.destinations).toEqual([
      destination("dest_1", { include: true, heading: "Unsorted", target: { kind: "existing", slug: "adding-config-catalog" } }),
    ]);
    expect(next.rememberAliases).toEqual([{ tag: "cc", slug: "adding-config-catalog" }]);
  });

  it("adds a destination when nothing matches the tag", () => {
    const next = acceptTagSuggestion({ destinations: [destination("dest_1")], rememberAliases: [{ tag: "cc", slug: "old" }] }, { tag: "cc", slug: "adding-config-catalog" });
    expect(next.destinations.map((item) => item.target)).toEqual([
      { kind: "existing", slug: "unified-notification" },
      { kind: "existing", slug: "adding-config-catalog" },
    ]);
    expect(next.rememberAliases).toEqual([{ tag: "cc", slug: "adding-config-catalog" }]);
  });

  it("groups open suggestions by tag, best score first", () => {
    const groups = pendingSuggestions(
      [suggestion("cc", "a", 0.4), suggestion("cc", "b", 0.9), suggestion("np", "c", 1), suggestion("old", "d", 1)],
      [{ tag: "old", slug: "d" }],
      new Set(["np"]),
    );
    expect(groups).toEqual([{ tag: "cc", best: suggestion("cc", "b", 0.9), others: [suggestion("cc", "a", 0.4)] }]);
  });
});

describe("hasContentToAdd", () => {
  it("needs a content destination that is on or already added; a link line alone is not enough", () => {
    expect(hasContentToAdd([destination("dst_1", { include: false }), destination("dst_2", { role: "link" })])).toBe(false);
    expect(hasContentToAdd([destination("dst_1"), destination("dst_2", { role: "link" })])).toBe(true);
    expect(hasContentToAdd([destination("dst_1", { include: false, written: true }), destination("dst_2", { role: "link" })])).toBe(true);
    expect(hasContentToAdd([])).toBe(false);
  });
});
