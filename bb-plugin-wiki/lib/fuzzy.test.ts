import { describe, expect, it } from "vitest";
import { FUZZY_THRESHOLD, bestTitleMatches, matchTag, tagSimilarity, type FuzzyCandidate } from "./fuzzy";

function doc(slug: string, title: string, aliases: string[] = [], tag = slug.slice(slug.lastIndexOf("/") + 1)): FuzzyCandidate {
  return { slug, title, tag, aliases };
}

const CATALOG: FuzzyCandidate[] = [
  doc("adding-config-catalog", "Adding config catalog", ["config-catalog", "cc"]),
  doc("unified-notification", "Unified notification"),
  doc("multi-instance", "Multi instance"),
  doc("international-reporting", "International reporting"),
  doc("spam-bot", "Spam bot"),
  doc("rate-limits", "Rate limits"),
  doc("projects/widget-launch", "Widget launch", ["wl"]),
  doc("ai-tools", "AI tools"),
  doc("kubernetes", "Kubernetes"),
];

function slugs(matches: ReturnType<typeof matchTag>): string[] {
  return matches.map((match) => match.slug);
}

function scoreOf(tag: string, slug: string, candidates: FuzzyCandidate[] = CATALOG): number {
  return matchTag(tag, candidates, candidates.length).find((match) => match.slug === slug)?.score ?? 0;
}

describe("matchTag exact matches", () => {
  it("scores an exact tag 1", () => {
    expect(matchTag("unified-notification", CATALOG)[0]).toEqual({
      slug: "unified-notification",
      title: "Unified notification",
      score: 1,
    });
  });

  it("scores an exact alias 1", () => {
    expect(matchTag("cc", CATALOG)[0]).toEqual({ slug: "adding-config-catalog", title: "Adding config catalog", score: 1 });
    expect(matchTag("config-catalog", CATALOG)[0]?.score).toBe(1);
  });

  it("normalizes the query and the candidate keys", () => {
    expect(matchTag("@CC", CATALOG)[0]?.slug).toBe("adding-config-catalog");
    expect(matchTag("  @Unified-Notification ", CATALOG)[0]?.score).toBe(1);
    const messy = [doc("x", "X doc", ["@Config Catalog", " CC "], "X")];
    expect(matchTag("config-catalog", messy)[0]?.score).toBe(1);
    expect(matchTag("x", messy)[0]?.score).toBe(1);
  });

  it("uses the tag of a nested slug", () => {
    expect(matchTag("widget-launch", CATALOG)[0]).toEqual({ slug: "projects/widget-launch", title: "Widget launch", score: 1 });
  });

  it("scores a match on the slugified title just below exact", () => {
    const candidates = [doc("notes/un", "Unified Notifications")];
    expect(matchTag("unified-notifications", candidates)[0]?.score).toBe(0.95);
  });
});

describe("matchTag fuzzy matches", () => {
  it("finds acronyms of multi-word tags", () => {
    const candidates = [doc("config-catalog", "Config catalog"), doc("unified-notification", "Unified notification")];
    expect(matchTag("cc", candidates)[0]?.slug).toBe("config-catalog");
    expect(matchTag("un", candidates)[0]?.slug).toBe("unified-notification");
    expect(scoreOf("cc", "config-catalog", candidates)).toBeGreaterThanOrEqual(0.8);
    expect(scoreOf("un", "unified-notification", candidates)).toBeGreaterThanOrEqual(0.8);
  });

  it("finds an acronym of a run of words", () => {
    const candidates = [doc("adding-config-catalog", "Adding config catalog")];
    expect(scoreOf("cc", "adding-config-catalog", candidates)).toBeGreaterThan(0.6);
  });

  it("ranks the acronym match above a prefix match", () => {
    const candidates = [doc("unicorn", "Unicorn"), doc("unified-notification", "Unified notification")];
    expect(slugs(matchTag("un", candidates))).toEqual(["unified-notification", "unicorn"]);
  });

  it("scores typos highly", () => {
    expect(scoreOf("multi-instancing", "multi-instance")).toBeGreaterThanOrEqual(0.75);
    expect(scoreOf("unified-notifcation", "unified-notification")).toBeGreaterThanOrEqual(0.9);
    expect(scoreOf("internatinal-reporting", "international-reporting")).toBeGreaterThanOrEqual(0.9);
    expect(scoreOf("rate-limtis", "rate-limits")).toBeGreaterThanOrEqual(0.8);
    expect(matchTag("multi-instancing", CATALOG)[0]?.slug).toBe("multi-instance");
  });

  it("scores a shared first word moderately", () => {
    const score = scoreOf("unified-push", "unified-notification");
    expect(score).toBeGreaterThanOrEqual(0.5);
    expect(score).toBeLessThan(0.8);
    expect(matchTag("unified-push", CATALOG)[0]?.slug).toBe("unified-notification");
  });

  it("matches prefixes in either direction", () => {
    expect(matchTag("spam", CATALOG)[0]?.slug).toBe("spam-bot");
    expect(matchTag("international", CATALOG)[0]?.slug).toBe("international-reporting");
    expect(matchTag("rate-limits-v2", CATALOG)[0]?.slug).toBe("rate-limits");
    expect(scoreOf("unified", "unified-notification")).toBeGreaterThan(scoreOf("uni", "unified-notification"));
  });

  it("matches whole-word substrings", () => {
    expect(matchTag("notification", CATALOG)[0]?.slug).toBe("unified-notification");
    expect(matchTag("reporting", CATALOG)[0]?.slug).toBe("international-reporting");
  });

  it("matches reordered words", () => {
    expect(scoreOf("notification-unified", "unified-notification")).toBeGreaterThanOrEqual(0.85);
    expect(scoreOf("catalog-config", "adding-config-catalog")).toBeGreaterThan(0.7);
  });

  it("never scores a fuzzy match as exact", () => {
    const queries = ["unified-notifications", "notification-unified", "unified", "un", "multi-instancing", "catalog"];
    const scores = queries.flatMap((query) => matchTag(query, CATALOG, CATALOG.length).map((match) => match.score));
    expect(scores.length).toBeGreaterThanOrEqual(queries.length);
    expect(Math.max(...scores)).toBeLessThan(1);
  });
});

describe("matchTag noise control", () => {
  it("returns nothing for unrelated tags", () => {
    expect(matchTag("blockchain", CATALOG)).toEqual([]);
    expect(matchTag("zebra-crossing", CATALOG)).toEqual([]);
  });

  it("does not match short tags by edit distance or loose substrings", () => {
    const candidates = [doc("api-gateway", "API gateway"), doc("main", "Main"), doc("au", "Australia")];
    expect(matchTag("ai", candidates)).toEqual([]);
    expect(matchTag("ian", [doc("international", "International")])).toEqual([]);
  });

  it("keeps every score inside the threshold and 1", () => {
    for (const query of ["cc", "un", "spam", "unified-push", "multi", "rate", "widget", "ai", "kube"]) {
      for (const match of matchTag(query, CATALOG, CATALOG.length)) {
        expect(match.score).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
        expect(match.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not suggest words that only share a suffix", () => {
    const candidates = [doc("testing", "Testing"), doc("running", "Running")];
    expect(matchTag("meeting", candidates)).toEqual([]);
    expect(matchTag("planning", candidates)).toEqual([]);
  });

  it("allows about one typo per five characters", () => {
    expect(tagSimilarity("kubernets", "kubernetes")).toBeGreaterThanOrEqual(0.85);
    expect(tagSimilarity("recieve", "receive")).toBeGreaterThanOrEqual(0.85);
    expect(tagSimilarity("kbrnts", "kubernetes")).toBeLessThan(FUZZY_THRESHOLD);
  });

  it("returns nothing for an empty or symbol-only tag", () => {
    expect(matchTag("", CATALOG)).toEqual([]);
    expect(matchTag("@", CATALOG)).toEqual([]);
    expect(matchTag("---", CATALOG)).toEqual([]);
  });

  it("handles an empty catalog", () => {
    expect(matchTag("anything", [])).toEqual([]);
  });

  it("ignores empty aliases", () => {
    expect(matchTag("x", [doc("other", "Other", ["", "@"])])).toEqual([]);
  });
});

describe("matchTag ordering and limits", () => {
  const many = Array.from({ length: 6 }, (_, index) => doc(`slug-${5 - index}`, `Doc ${index}`, ["shared"]));

  it("returns at most 3 by default", () => {
    expect(matchTag("shared", many)).toHaveLength(3);
  });

  it("honours an explicit limit", () => {
    expect(matchTag("shared", many, 5)).toHaveLength(5);
    expect(matchTag("shared", many, 1)).toHaveLength(1);
    expect(matchTag("shared", many, 0)).toEqual([]);
    expect(matchTag("shared", many, -2)).toEqual([]);
    expect(matchTag("shared", many, Number.NaN)).toEqual([]);
    expect(matchTag("shared", many, 2.9)).toHaveLength(2);
  });

  it("breaks ties by slug", () => {
    expect(slugs(matchTag("shared", many, 6))).toEqual(["slug-0", "slug-1", "slug-2", "slug-3", "slug-4", "slug-5"]);
  });

  it("sorts by descending score", () => {
    const scores = matchTag("unified-notifications", CATALOG, CATALOG.length).map((match) => match.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("is independent of candidate order", () => {
    const reversed = [...CATALOG].reverse();
    for (const query of ["un", "cc", "spam", "unified-push", "multi"]) {
      expect(matchTag(query, reversed, 9)).toEqual(matchTag(query, CATALOG, 9));
    }
  });

  it("collapses duplicate slugs to their best score", () => {
    const duplicated = [doc("spam-bot", "Spam bot"), doc("spam-bot", "Spam bot", ["spam"])];
    expect(matchTag("spam", duplicated)).toEqual([{ slug: "spam-bot", title: "Spam bot", score: 1 }]);
  });

  it("rounds scores to three decimals", () => {
    for (const match of matchTag("unified-push", CATALOG, CATALOG.length)) {
      expect(Math.round(match.score * 1000) / 1000).toBe(match.score);
    }
  });
});

describe("tagSimilarity", () => {
  it("is 1 for equal tags after normalization", () => {
    expect(tagSimilarity("@Spam", "spam")).toBe(1);
  });

  it("is symmetric", () => {
    const pairs: Array<[string, string]> = [
      ["cc", "config-catalog"],
      ["multi-instancing", "multi-instance"],
      ["unified-push", "unified-notification"],
      ["spam", "spam-bot"],
    ];
    for (const [a, b] of pairs) {
      expect(tagSimilarity(a, b)).toBe(tagSimilarity(b, a));
    }
  });

  it("is 0 for empty input", () => {
    expect(tagSimilarity("", "spam")).toBe(0);
    expect(tagSimilarity("@", "")).toBe(0);
  });

  it("is low for unrelated tags", () => {
    expect(tagSimilarity("kubernetes", "spam-bot")).toBeLessThan(FUZZY_THRESHOLD);
  });
});

describe("bestTitleMatches", () => {
  it("finds docs by words of their title", () => {
    expect(bestTitleMatches("config catalog", CATALOG)[0]?.slug).toBe("adding-config-catalog");
    expect(bestTitleMatches("reporting international", CATALOG)[0]?.slug).toBe("international-reporting");
  });

  it("scores an exact title, slug, tag or alias 1", () => {
    expect(bestTitleMatches("Unified Notification", CATALOG)[0]).toEqual({
      slug: "unified-notification",
      title: "Unified notification",
      score: 1,
    });
    expect(bestTitleMatches("projects/widget-launch", CATALOG)[0]?.score).toBe(1);
    expect(bestTitleMatches("widget-launch", CATALOG)[0]?.score).toBe(1);
    expect(bestTitleMatches("WL", CATALOG)[0]?.slug).toBe("projects/widget-launch");
  });

  it("supports partial words while typing", () => {
    expect(bestTitleMatches("unified notif", CATALOG)[0]?.slug).toBe("unified-notification");
    expect(bestTitleMatches("Rate lim", CATALOG)[0]?.slug).toBe("rate-limits");
  });

  it("tolerates typos", () => {
    expect(bestTitleMatches("Internatinal reportng", CATALOG)[0]?.slug).toBe("international-reporting");
    expect(bestTitleMatches("multi instancing", CATALOG)[0]?.slug).toBe("multi-instance");
  });

  it("rewards covering every query word", () => {
    const candidates = [doc("config", "Config"), doc("adding-config-catalog", "Adding config catalog")];
    expect(bestTitleMatches("config catalog", candidates)[0]?.slug).toBe("adding-config-catalog");
  });

  it("returns up to 5 by default and honours a limit", () => {
    const many = Array.from({ length: 8 }, (_, index) => doc(`release-${index}`, `Release notes ${index}`));
    expect(bestTitleMatches("release notes", many)).toHaveLength(5);
    expect(bestTitleMatches("release notes", many, 2).map((match) => match.slug)).toEqual(["release-0", "release-1"]);
    expect(bestTitleMatches("release notes", many, 0)).toEqual([]);
  });

  it("returns nothing for empty or unrelated queries", () => {
    expect(bestTitleMatches("", CATALOG)).toEqual([]);
    expect(bestTitleMatches("  !!  ", CATALOG)).toEqual([]);
    expect(bestTitleMatches("quantum gardening", CATALOG)).toEqual([]);
  });
});
