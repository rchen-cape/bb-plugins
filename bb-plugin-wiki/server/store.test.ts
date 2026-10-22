import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { Destination } from "../contract";
import { tagForSlug } from "../lib/slug";
import { MARK_END, MARK_START } from "../lib/wiki";
import type { IndexedDoc, IndexedSection } from "./index-types";
import { createStore, ftsQuery, stripHighlightDelimiters, type NewCard, type SearchInput } from "./store";

const MARKER = '<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->';

function setup() {
  const host = createFakePluginHost({ pluginId: "wiki" });
  const warnings: string[] = [];
  const store = createStore(host.bb.storage, { warn: (message) => warnings.push(message) });
  const db = host.bb.storage.database();
  const search = (input: Partial<SearchInput>) => store.search({ query: "", type: null, limit: 50, ...input });
  return { host, store, db, warnings, search };
}

function section(heading: string, body: string, ord: number): IndexedSection {
  return { heading, headingPath: heading, anchor: heading.toLowerCase().replace(/\s+/g, "-"), level: heading === "" ? 0 : 2, ord, body };
}

function doc(input: Partial<IndexedDoc> & Pick<IndexedDoc, "slug" | "title">, ...bodies: Array<[string, string]>): IndexedDoc {
  const sections = bodies.map(([heading, body], ord) => section(heading, body, ord));
  return {
    type: "topic",
    aliases: [],
    tag: tagForSlug(input.slug),
    path: `/wiki/${input.slug}.md`,
    mtimeMs: 1_760_000_000_000,
    size: 100,
    sha256: `sha-${input.slug}`,
    headings: sections.map((entry) => entry.heading).filter((heading) => heading !== ""),
    sections,
    links: [],
    ...input,
  };
}

function checkFtsIntegrity(db: ReturnType<typeof setup>["db"]) {
  db.prepare("INSERT INTO sections_fts (sections_fts, rank) VALUES ('integrity-check', 1)").run();
  db.prepare("INSERT INTO sections_words (sections_words, rank) VALUES ('integrity-check', 1)").run();
}

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: "d1",
    include: true,
    target: { kind: "existing", slug: "unified-notification" },
    heading: "Unsorted",
    lineRanges: "all",
    role: "content",
    reason: "Tagged @unified-notification.",
    ...overrides,
  };
}

function newCard(overrides: Partial<NewCard> = {}): NewCard {
  return {
    status: "pending",
    source: { kind: "notes", notePath: "Time/oct2026/10-14-26.md", noteDate: "2026-10-14", unitHash: "hash-1" },
    text: "- shipped the token refresh\n  - behind a flag",
    lines: ["- shipped the token refresh", "  - behind a flag"],
    tags: ["unified-notification"],
    rule: "tag",
    reason: "Tagged @unified-notification.",
    destinations: [destination()],
    tagSuggestions: [{ tag: "un", slug: "unified-notification", title: "Unified notification", score: 0.8 }],
    rememberAliases: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ftsQuery", () => {
  it("prefix-matches bare words and keeps quoted phrases exact", () => {
    expect(ftsQuery('regis "update location" CCR-I')).toBe('"regis"* "update location" "CCR I"*');
  });

  it("drops FTS syntax and empty input", () => {
    expect(ftsQuery('AND ( ) * " NEAR')).toBe('"AND"* "NEAR"*');
    expect(ftsQuery("  ")).toBeNull();
    expect(ftsQuery("()")).toBeNull();
  });
});

describe("docs", () => {
  it("round-trips a doc with its path, hash, and exact fractional file stamp", () => {
    const { store } = setup();
    store.upsertDoc(
      doc(
        { slug: "areas/config-catalog", title: "Config catalog", type: "process", aliases: ["cc"], mtimeMs: 1_760_000_000_123.456, size: 42 },
        ["", "intro"],
        ["Steps", "do it"],
      ),
    );
    expect(store.getDoc("areas/config-catalog")).toEqual({
      slug: "areas/config-catalog",
      title: "Config catalog",
      type: "process",
      aliases: ["cc"],
      tag: "config-catalog",
      updatedAt: new Date(1_760_000_000_123).toISOString(),
      headings: ["Steps"],
      path: "/wiki/areas/config-catalog.md",
      sha256: "sha-areas/config-catalog",
    });
    expect(store.stamps()).toEqual([{ slug: "areas/config-catalog", mtimeMs: 1_760_000_000_123.456, size: 42 }]);
    expect(store.getDoc("missing")).toBeNull();
    expect(store.getDoc("Areas/Config-Catalog")).toBeNull();
  });

  it("lists docs by title case-insensitively, filters by type, and counts them", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "b", title: "beta", type: "project" }));
    store.upsertDoc(doc({ slug: "a", title: "Alpha", type: "topic" }));
    store.upsertDoc(doc({ slug: "c", title: "Gamma", type: "project" }));
    expect(store.listDocs(null).map((entry) => entry.title)).toEqual(["Alpha", "beta", "Gamma"]);
    expect(store.listDocs("project").map((entry) => entry.slug)).toEqual(["b", "c"]);
    expect(store.listDocs("process")).toEqual([]);
    expect(store.docCount()).toBe(3);
  });

  it("replaces sections on re-index without leaving stale full-text rows", () => {
    const { store, db, search } = setup();
    store.upsertDoc(doc({ slug: "push", title: "Push gateway" }, ["Alpha", "alphabetical ordering"], ["Beta", "beta testing"]));
    store.upsertDoc(doc({ slug: "push", title: "Notification service" }, ["Gamma", "gamma rays"]));
    expect(search({ query: "alphabetical" }).total).toBe(0);
    expect(search({ query: "beta" }).total).toBe(0);
    expect(search({ query: "gateway" }).total).toBe(0);
    expect(search({ query: "gamma" }).sections.map((hit) => [hit.slug, hit.heading, hit.title])).toEqual([
      ["push", "Gamma", "Notification service"],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sections").get()).toEqual({ count: 1 });
    expect(() => checkFtsIntegrity(db)).not.toThrow();
  });

  it("removes a doc with its sections and links", () => {
    const { store, db, search } = setup();
    store.upsertDoc(doc({ slug: "target", title: "Target" }, ["", "landing zone"]));
    store.upsertDoc(
      doc({ slug: "source", title: "Source doc", links: [{ targetText: "Target", heading: "Related" }] }, ["Related", "see target zebra"]),
    );
    expect(store.backlinks("target")).toEqual([{ slug: "source", title: "Source doc", heading: "Related" }]);
    expect(store.removeDoc("source")).toBe(true);
    expect(store.removeDoc("source")).toBe(false);
    expect(store.getDoc("source")).toBeNull();
    expect(search({ query: "zebra" }).total).toBe(0);
    expect(store.backlinks("target")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM links").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sections WHERE slug = 'source'").get()).toEqual({ count: 0 });
    expect(store.stamps().map((stamp) => stamp.slug)).toEqual(["target"]);
    expect(() => checkFtsIntegrity(db)).not.toThrow();
  });

  it("applies a changed doc type to doc and section filters on re-index", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "push", title: "Push" }, ["", "kiwi rollout"]));
    store.upsertDoc(doc({ slug: "push", title: "Push", type: "project" }, ["", "kiwi rollout"]));
    expect(search({ query: "kiwi", type: "topic" }).total).toBe(0);
    expect(search({ query: "kiwi", type: "project" }).sections.map((hit) => [hit.slug, hit.type])).toEqual([["push", "project"]]);
    expect(search({ query: "push", type: "topic" }).docs).toEqual([]);
    expect(search({ type: "topic" }).sections).toEqual([]);
    expect(store.listDocs("project").map((entry) => entry.slug)).toEqual(["push"]);
    expect(store.allTags()).toEqual([{ tag: "push", title: "Push", type: "project", aliases: [] }]);
  });

  it("builds catalog excerpts from the first non-empty section without source markers", () => {
    const { store } = setup();
    const long = `${MARKER}\n${"word ".repeat(80)}`;
    store.upsertDoc(doc({ slug: "old", title: "Old", mtimeMs: 1_000 }, ["", "  "], ["Old", "first   real\n\ntext"]));
    store.upsertDoc(doc({ slug: "new", title: "New", mtimeMs: 2_000 }, ["New", ""], ["Notes", long]));
    store.upsertDoc(doc({ slug: "empty", title: "Empty", mtimeMs: 500 }));
    const catalog = store.catalog(10);
    expect(catalog.map((entry) => entry.slug)).toEqual(["new", "old", "empty"]);
    expect(catalog[1]?.excerpt).toBe("first real text");
    expect(catalog[0]?.excerpt.length).toBeLessThanOrEqual(160);
    expect(catalog[0]?.excerpt).toMatch(/^word word/);
    expect(catalog[0]?.excerpt).not.toContain("wiki:source");
    expect(catalog[2]?.excerpt).toBe("");
    expect(store.catalog(1).map((entry) => entry.slug)).toEqual(["new"]);
  });
});

describe("search", () => {
  it("ranks a title match above a body mention", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "misc", title: "Misc" }, ["Log", "Talked about the deployment once."]));
    store.upsertDoc(doc({ slug: "pipeline", title: "Deployment pipeline" }, ["Overview", "How releases go out."]));
    expect(search({ query: "deployment" }).sections.map((hit) => hit.slug)).toEqual(["pipeline", "misc"]);
  });

  it("stems words so deploy finds deployment and deployed", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "release", title: "Release" }, ["", "The deployment went out on Monday."]));
    store.upsertDoc(doc({ slug: "infra", title: "Infra" }, ["", "We deployed the cluster."]));
    store.upsertDoc(doc({ slug: "other", title: "Other" }, ["", "Nothing relevant here."]));
    expect(search({ query: "deploy" }).sections.map((hit) => hit.slug).sort()).toEqual(["infra", "release"]);
    expect(search({ query: "deploying" }).sections.map((hit) => hit.slug)).toEqual(["infra"]);
    expect(search({ query: "deployments" }).sections.map((hit) => hit.slug)).toEqual(["release"]);
  });

  it("matches partially typed words", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "org", title: "Teams" }, ["", "The organization chart changed."]));
    store.upsertDoc(doc({ slug: "ims", title: "IMS" }, ["Flow", "REGISTER via the P-CSCF during registration."]));
    for (const query of ["organ", "organi", "organiza", "organization"]) {
      expect(search({ query }).sections.map((hit) => hit.slug)).toEqual(["org"]);
    }
    expect(search({ query: "organiza" }).sections[0]?.snippet).toContain(`${MARK_START}organization`);
    expect(search({ query: "regis" }).sections.map((hit) => hit.slug)).toEqual(["ims"]);
    expect(search({ query: '"p cscf"' }).sections.map((hit) => hit.slug)).toEqual(["ims"]);
  });

  it("highlights snippets and never returns or matches source markers", () => {
    const { store, search } = setup();
    store.upsertDoc(
      doc(
        { slug: "push", title: "Push" },
        ["Rollout", `${MARKER}\n- Rolled the gateway out to staging\n\n${MARKER}\n- Gateway is live`],
        ["Thread", '<!-- wiki:source thread="thr_1" title="Debug session" added="2026-10-15" -->\nfrom a thread'],
      ),
    );
    const hits = search({ query: "gateway" });
    expect(hits.sections).toHaveLength(1);
    expect(hits.sections[0]?.snippet).toContain(`${MARK_START}gateway`);
    expect(hits.sections[0]?.snippet).not.toContain("<!--");
    expect(hits.sections[0]?.snippet).not.toContain("wiki:source");
    for (const query of ["source", "added", "notes", "oct2026", "thr_1", "debug"]) {
      expect(search({ query }).total).toBe(0);
    }
  });

  it("drops highlight control characters found in doc text so only real matches are marked", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "ctl", title: "Control" }, ["", `a ${MARK_START}fake${MARK_END} highlight about kiwi`]));
    expect(search({ query: "kiwi" }).sections[0]?.snippet).toBe(`a fake highlight about ${MARK_START}kiwi${MARK_END}`);
    expect(search({ query: "" }).sections[0]?.snippet).toBe("a fake highlight about kiwi");
    expect(store.catalog(1)[0]?.excerpt).toBe("a fake highlight about kiwi");
  });

  it("drops ==highlight== delimiters from snippets and excerpts but keeps a lone ==", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "hl", title: "Highlights" }, ["", "Use ==the kiwi== token, and a==b==c too, but x == y and if (p==q) stay."]));
    expect(search({ query: "kiwi" }).sections[0]?.snippet).toBe(`Use the ${MARK_START}kiwi${MARK_END} token, and abc too, but x == y and if (p==q) stay.`);
    expect(search({ query: "" }).sections[0]?.snippet).toBe("Use the kiwi token, and abc too, but x == y and if (p==q) stay.");
    expect(store.catalog(1)[0]?.excerpt).toBe("Use the kiwi token, and abc too, but x == y and if (p==q) stay.");
    expect(stripHighlightDelimiters("==one\n\ntwo== ===three=== ==four==")).toBe("==one\n\ntwo== ===three=== four");
  });

  it("keeps == inside code spans, code blocks, link targets and URLs", () => {
    const { store, search } = setup();
    expect(stripHighlightDelimiters("`a==b` and `c==d`, ``e`==f`` ==g==")).toBe("`a==b` and `c==d`, ``e`==f`` g");
    expect(stripHighlightDelimiters("```js\nif (x==1 && y==2) {}\n```\n==after==")).toBe("```js\nif (x==1 && y==2) {}\n```\nafter");
    expect(stripHighlightDelimiters("~~~\na==b==c\n\nd==e==f\n~~~")).toBe("~~~\na==b==c\n\nd==e==f\n~~~");
    expect(stripHighlightDelimiters("==lead==\n\n    x==1==y\n\n    z==2==w\n\n==tail==")).toBe("lead\n\n    x==1==y\n\n    z==2==w\n\ntail");
    expect(stripHighlightDelimiters("[link](http://h/?a==b) and c==d")).toBe("[link](http://h/?a==b) and c==d");
    expect(stripHighlightDelimiters("see https://h/?q==v==w or <mailto:a==b==c> and www.h.io/?a==b== then ==x==")).toBe(
      "see https://h/?q==v==w or <mailto:a==b==c> and www.h.io/?a==b== then x",
    );
    store.upsertDoc(doc({ slug: "code", title: "Code" }, ["", "Run `a==b` then ==kiwi==.\n\n```\nif (x==1 && y==2) {}\n```"]));
    expect(search({ query: "kiwi" }).sections[0]?.snippet).toBe(`Run \`a==b\` then ${MARK_START}kiwi${MARK_END}. \`\`\` if (x==1 && y==2) {} \`\`\``);
    expect(store.catalog(1)[0]?.excerpt).toBe("Run `a==b` then kiwi. ``` if (x==1 && y==2) {} ```");
  });

  it("indexes bodies without trailing spaces on any line and with at most one blank line in a row", () => {
    const { store, db } = setup();
    store.upsertDoc(doc({ slug: "ws", title: "Spacing" }, ["", "  one \t\r\ntwo  \u2028three\t\n\n\n\n  four  \n"]));
    expect(db.prepare("SELECT body FROM sections WHERE slug = 'ws'").get()).toEqual({ body: "one\r\ntwo\u2028three\n\n  four" });
  });

  it("indexes a long body with adversarial whitespace quickly", () => {
    const { store, db } = setup();
    const body = `a${" ".repeat(200_000)}b\n${"<!-- wiki:source ".repeat(10_000)}`;
    const start = performance.now();
    store.upsertDoc(doc({ slug: "long", title: "Long" }, ["", body]));
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(db.prepare("SELECT length(body) AS size FROM sections WHERE slug = 'long'").get()).toEqual({ size: body.trimEnd().length });
  });

  it("returns a docs group with exact, prefix, then substring matches", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "adding-config-catalog", title: "Adding config catalog", aliases: ["config-catalog", "cc"] }));
    store.upsertDoc(doc({ slug: "config", title: "Config" }));
    store.upsertDoc(doc({ slug: "configuration-guide", title: "Configuration guide", type: "process" }));
    const result = search({ query: "config" });
    expect(result.docs.map((hit) => [hit.slug, hit.matched])).toEqual([
      ["config", "title"],
      ["configuration-guide", "title"],
      ["adding-config-catalog", "alias"],
    ]);
    expect(search({ query: "CC" }).docs.map((hit) => [hit.slug, hit.matched])).toEqual([["adding-config-catalog", "alias"]]);
    expect(search({ query: "config catalog" }).docs.map((hit) => hit.matched)).toEqual(["alias"]);
    expect(search({ query: "config", type: "process" }).docs.map((hit) => hit.slug)).toEqual(["configuration-guide"]);
  });

  it("caps the docs group at eight", () => {
    const { store, search } = setup();
    for (let index = 0; index < 12; index += 1) store.upsertDoc(doc({ slug: `note-${index}`, title: `Note ${index}` }));
    expect(search({ query: "note" }).docs).toHaveLength(8);
    expect(search({ query: "note", limit: 3 }).docs).toHaveLength(3);
  });

  it("counts every matching section and applies the type filter to sections", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "p", title: "Project", type: "project" }, ["One", "kiwi"], ["Two", "kiwi"], ["Three", "kiwi"]));
    store.upsertDoc(doc({ slug: "t", title: "Topic", type: "topic" }, ["One", "kiwi"]));
    const limited = search({ query: "kiwi", limit: 2 });
    expect(limited.sections).toHaveLength(2);
    expect(limited.total).toBe(4);
    const projects = search({ query: "kiwi", type: "project" });
    expect(projects.total).toBe(3);
    expect(new Set(projects.sections.map((hit) => hit.type))).toEqual(new Set(["project"]));
  });

  it("lists recently updated docs' first sections for an empty query", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "older", title: "Older", mtimeMs: 1_000 }, ["Intro", "older body"]));
    store.upsertDoc(doc({ slug: "newer", title: "Newer", type: "project", mtimeMs: 3_000 }, ["Newer", ""], ["Notes", `${MARKER}\nnewer body`]));
    store.upsertDoc(doc({ slug: "bare", title: "Bare", mtimeMs: 2_000 }));
    const result = search({ query: "   " });
    expect(result.docs).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.sections.map((hit) => [hit.slug, hit.heading, hit.snippet])).toEqual([
      ["newer", "Notes", "newer body"],
      ["bare", "", ""],
      ["older", "Intro", "older body"],
    ]);
    expect(search({ type: "project" }).sections.map((hit) => hit.slug)).toEqual(["newer"]);
    expect(search({ limit: 1 }).sections).toHaveLength(1);
  });

  it("handles queries full of FTS syntax and unusual characters", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "x", title: "Café notes" }, ["", "C++ and naïve résumé 日本語 tests"]));
    for (const query of ["()", '"', '""', "AND OR NOT", "*", "NEAR(", "a-b", "🎉", "-", "^title", "col:value", "'"]) {
      expect(() => search({ query })).not.toThrow();
    }
    expect(search({ query: "cafe" }).sections.map((hit) => hit.slug)).toEqual(["x"]);
    expect(search({ query: "resume" }).total).toBe(1);
    expect(search({ query: "C++" }).total).toBe(1);
  });
});

describe("link resolution", () => {
  function linkFixture() {
    const context = setup();
    const { store } = context;
    store.upsertDoc(doc({ slug: "projects/apollo", title: "Apollo program", aliases: ["moon"] }));
    store.upsertDoc(doc({ slug: "moon", title: "Lunar notes" }));
    store.upsertDoc(doc({ slug: "gemini", title: "Apollo" }));
    store.upsertDoc(doc({ slug: "notes/rocket", title: "Rocket log" }));
    store.upsertDoc(doc({ slug: "engines", title: "Engines", aliases: ["rocket"] }));
    store.upsertDoc(doc({ slug: "areas/thermal-tiles", title: "Heat shield" }));
    return context;
  }

  it("resolves slug, then title, then alias, then tag, case-insensitively", () => {
    const { store } = linkFixture();
    expect(store.resolveLink("moon")).toEqual({ slug: "moon", heading: null });
    expect(store.resolveLink("apollo")).toEqual({ slug: "gemini", heading: null });
    expect(store.resolveLink("APOLLO  PROGRAM")).toEqual({ slug: "projects/apollo", heading: null });
    expect(store.resolveLink("Rocket")).toEqual({ slug: "engines", heading: null });
    expect(store.resolveLink("Thermal Tiles")).toEqual({ slug: "areas/thermal-tiles", heading: null });
    expect(store.resolveLink("AREAS/Thermal-Tiles")).toEqual({ slug: "areas/thermal-tiles", heading: null });
  });

  it("splits headings and labels and rejects unknown or empty targets", () => {
    const { store } = linkFixture();
    expect(store.resolveLink("Apollo program#Launch Day")).toEqual({ slug: "projects/apollo", heading: "Launch Day" });
    expect(store.resolveLink(" Heat shield # Tiles |the tiles")).toEqual({ slug: "areas/thermal-tiles", heading: "Tiles" });
    expect(store.resolveLink("Heat shield#")).toEqual({ slug: "areas/thermal-tiles", heading: null });
    expect(store.resolveLink("Nowhere")).toBeNull();
    expect(store.resolveLink("#Only heading")).toBeNull();
    expect(store.resolveLink("  ")).toBeNull();
  });

  it("resolves tags by doc tag before alias and sees new docs immediately", () => {
    const { store } = linkFixture();
    expect(store.resolveTag("@Rocket")).toBe("notes/rocket");
    expect(store.resolveTag("moon")).toBe("moon");
    expect(store.resolveTag("thermal-tiles")).toBe("areas/thermal-tiles");
    expect(store.resolveTag("unified-push")).toBeNull();
    expect(store.resolveTag("@")).toBeNull();
    store.upsertDoc(doc({ slug: "unified-push", title: "Unified push" }));
    expect(store.resolveTag("unified-push")).toBe("unified-push");
    store.removeDoc("unified-push");
    expect(store.resolveTag("unified-push")).toBeNull();
  });

  it("follows alias edits when a doc is re-indexed", () => {
    const { store, search } = setup();
    store.upsertDoc(doc({ slug: "adding-config-catalog", title: "Adding config catalog", aliases: ["cc"] }));
    store.upsertDoc(doc({ slug: "other", title: "Other" }));
    expect(store.resolveTag("@cc")).toBe("adding-config-catalog");
    expect(store.resolveLink("CC")).toEqual({ slug: "adding-config-catalog", heading: null });
    store.upsertDoc(doc({ slug: "adding-config-catalog", title: "Adding config catalog", aliases: [] }));
    store.upsertDoc(doc({ slug: "other", title: "Other", aliases: ["cc"] }));
    expect(store.resolveTag("cc")).toBe("other");
    expect(store.resolveLink("cc")).toEqual({ slug: "other", heading: null });
    expect(search({ query: "cc" }).docs.map((hit) => [hit.slug, hit.matched])).toEqual([["other", "alias"]]);
    expect(store.allTags()).toEqual([
      { tag: "adding-config-catalog", title: "Adding config catalog", type: "topic", aliases: [] },
      { tag: "other", title: "Other", type: "topic", aliases: ["cc"] },
    ]);
  });
});

describe("backlinks", () => {
  it("lists distinct linking docs and headings, skipping self links", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "target", title: "Target", links: [{ targetText: "Target", heading: "Self" }] }));
    store.upsertDoc(
      doc({
        slug: "zeta",
        title: "Zeta",
        links: [
          { targetText: "target", heading: "Related" },
          { targetText: "Target#Intro", heading: "Related" },
          { targetText: "Target|label", heading: "Log" },
        ],
      }),
    );
    store.upsertDoc(doc({ slug: "alpha", title: "alpha", links: [{ targetText: "TARGET", heading: "" }] }));
    expect(store.backlinks("target")).toEqual([
      { slug: "alpha", title: "alpha", heading: "" },
      { slug: "zeta", title: "Zeta", heading: "Log" },
      { slug: "zeta", title: "Zeta", heading: "Related" },
    ]);
  });

  it("re-resolves links when the target doc appears, is renamed, or is removed", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "project", title: "Project", links: [{ targetText: "Global token", heading: "Related" }] }));
    expect(store.backlinks("token")).toEqual([]);
    store.upsertDoc(doc({ slug: "token", title: "Global token" }));
    expect(store.backlinks("token")).toEqual([{ slug: "project", title: "Project", heading: "Related" }]);
    store.upsertDoc(doc({ slug: "token", title: "Refresh token" }));
    expect(store.backlinks("token")).toEqual([]);
    store.upsertDoc(doc({ slug: "token", title: "Global token" }));
    store.removeDoc("token");
    expect(store.backlinks("token")).toEqual([]);
  });

  it("drops backlinks once the linking doc no longer links and ignores blank targets", () => {
    const { store, db } = setup();
    store.upsertDoc(doc({ slug: "target", title: "Target" }));
    store.upsertDoc(
      doc({ slug: "source", title: "Source", links: [{ targetText: "Target", heading: "Related" }, { targetText: "  ", heading: "Log" }] }),
    );
    expect(store.backlinks("target")).toEqual([{ slug: "source", title: "Source", heading: "Related" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM links").get()).toEqual({ count: 1 });
    store.upsertDoc(doc({ slug: "source", title: "Source" }));
    expect(store.backlinks("target")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM links").get()).toEqual({ count: 0 });
  });

  it("keeps resolved links across a store reload", () => {
    const { host, store } = setup();
    store.upsertDoc(doc({ slug: "a", title: "A", links: [{ targetText: "B", heading: "Related" }] }));
    store.upsertDoc(doc({ slug: "b", title: "B" }));
    const reloaded = createStore(host.bb.storage);
    expect(reloaded.backlinks("b")).toEqual([{ slug: "a", title: "A", heading: "Related" }]);
    expect(reloaded.docCount()).toBe(2);
  });
});

describe("allTags", () => {
  it("returns one entry per tag sorted by tag, with normalized sorted aliases", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "zulu", title: "Zulu", type: "project", aliases: ["Zed", "zulu", "@alpha-z", "zed"] }));
    store.upsertDoc(doc({ slug: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["config-catalog", "cc"] }));
    store.upsertDoc(doc({ slug: "archive/zulu", title: "Old Zulu", aliases: ["old"] }));
    expect(store.allTags()).toEqual([
      { tag: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] },
      { tag: "zulu", title: "Old Zulu", type: "topic", aliases: ["old"] },
    ]);
    expect(store.resolveTag("zulu")).toBe("archive/zulu");
  });
});

describe("similarSections", () => {
  it("finds sections sharing distinctive terms and ranks rarer overlaps first", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "push", title: "Push notifications" }, ["Tokens", "APNs device tokens rotate after reinstall."]));
    store.upsertDoc(doc({ slug: "billing", title: "Billing" }, ["Invoices", "Invoices are generated monthly for customers."]));
    store.upsertDoc(doc({ slug: "oncall", title: "Oncall" }, ["Pages", "Customers page the oncall engineer."]));
    const similar = store.similarSections("Today the device tokens stopped working after a reinstall for some customers", 5);
    expect(similar[0]).toMatchObject({ slug: "push", title: "Push notifications", type: "topic", heading: "Tokens" });
    expect(similar[0]?.score).toBeGreaterThan(0);
    expect(similar.map((hit) => hit.slug)).toContain("billing");
    expect(store.similarSections("this that with from would", 5)).toEqual([]);
    expect(store.similarSections("unrelatedword nothingmatches", 5)).toEqual([]);
    expect(store.similarSections("", 5)).toEqual([]);
    expect(store.similarSections("customers", 1)).toHaveLength(1);
  });

  it("ignores source marker terms in the input text", () => {
    const { store } = setup();
    store.upsertDoc(doc({ slug: "notes-doc", title: "Daily notes process" }, ["", "How notes are added."]));
    expect(store.similarSections(`${MARKER}\nunrelatedword`, 5)).toEqual([]);
  });
});

describe("cards", () => {
  it("round-trips a card through the database", () => {
    const { store } = setup();
    const card = store.createCard(newCard());
    expect(card.id).toMatch(/^card_[a-z0-9]{8}$/);
    expect(card.createdAt).toBe(card.updatedAt);
    expect(store.getCard(card.id)).toEqual(card);
    expect(store.getCard("card_00000000")).toBeNull();
    const agentCard = store.createCard(
      newCard({
        status: "routing",
        source: { kind: "agent", threadId: "thr_1", threadTitle: null },
        rule: "none",
        destinations: [destination({ target: { kind: "new", title: "Unified push", type: "project", aliases: [] }, include: false, lineRanges: [{ start: 0, end: 1 }] })],
        rememberAliases: [{ tag: "un", slug: "unified-notification" }],
      }),
    );
    expect(store.getCard(agentCard.id)).toEqual(agentCard);
    expect(agentCard.id).not.toBe(card.id);
  });

  it("creates a card under an id picked ahead of time, once", () => {
    const { store } = setup();
    const id = store.newCardId();
    expect(id).toMatch(/^card_[a-z0-9]{8}$/);
    const upload = store.createCard(newCard({ source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId: null } }), id);
    expect(upload.id).toBe(id);
    expect(store.getCard(id)).toEqual(upload);
    expect(() => store.createCard(newCard(), id)).toThrow();
    expect(store.newCardId()).not.toBe(id);
  });

  it("rejects an invalid card without storing it", () => {
    const { store } = setup();
    expect(() => store.createCard(newCard({ destinations: [destination({ heading: "" })] }))).toThrow();
    expect(() => store.createCard(newCard({ source: { kind: "notes", notePath: "x.md", noteDate: "10-14-26", unitHash: "h" } }))).toThrow();
    expect(store.openCount()).toBe(0);
    expect(store.listCards("open")).toEqual([]);
  });

  it("lists open cards oldest first and closed cards newest first", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = setup();
    vi.setSystemTime(1_000);
    const first = store.createCard(newCard({ status: "pending" }));
    const second = store.createCard(newCard({ status: "routing" }));
    vi.setSystemTime(2_000);
    const third = store.createCard(newCard({ status: "pending" }));
    const accepted = store.createCard(newCard());
    const skipped = store.createCard(newCard());
    vi.setSystemTime(3_000);
    store.updateCard(accepted.id, { status: "accepted" });
    vi.setSystemTime(4_000);
    store.updateCard(first.id, { status: "accepted" });
    store.updateCard(skipped.id, { status: "skipped" });
    expect(store.listCards("open").map((card) => card.id)).toEqual([second.id, third.id]);
    expect(store.listCards("accepted").map((card) => card.id)).toEqual([first.id, accepted.id]);
    expect(store.listCards("skipped").map((card) => card.id)).toEqual([skipped.id]);
    expect(store.openCount()).toBe(2);
  });

  it("caps closed card lists at 200", () => {
    const { store } = setup();
    for (let index = 0; index < 205; index += 1) store.createCard(newCard({ status: "skipped" }));
    expect(store.listCards("skipped")).toHaveLength(200);
    expect(store.listCards("open")).toEqual([]);
  });

  it("patches only the given fields and bumps updatedAt", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { store } = setup();
    const card = store.createCard(newCard({ status: "routing" }));
    vi.setSystemTime(5_000);
    const routed = [destination({ id: "d2", heading: "Global token", reason: "Claude Code picked it." })];
    const updated = store.updateCard(card.id, { status: "pending", rule: "agent", destinations: routed, reason: "Routed by Claude Code." });
    expect(updated).toEqual({
      ...card,
      status: "pending",
      rule: "agent",
      reason: "Routed by Claude Code.",
      destinations: routed,
      updatedAt: new Date(5_000).toISOString(),
    });
    expect(store.getCard(card.id)).toEqual(updated);
    expect(store.updateCard(card.id, { rememberAliases: [{ tag: "gt", slug: "global-token" }] })?.rememberAliases).toEqual([
      { tag: "gt", slug: "global-token" },
    ]);
    expect(store.updateCard("card_00000000", { status: "skipped" })).toBeNull();
  });

  it("rejects an invalid patch and leaves the stored card unchanged", () => {
    const { store } = setup();
    const card = store.createCard(newCard());
    expect(() => store.updateCard(card.id, { destinations: [destination({ lineRanges: [{ start: 3, end: 1 }] })] })).toThrow();
    expect(store.getCard(card.id)).toEqual(card);
  });

  it("skips a corrupt row instead of failing the whole list", () => {
    const { store, db, warnings } = setup();
    const good = store.createCard(newCard());
    const broken = store.createCard(newCard());
    const wrongShape = store.createCard(newCard());
    db.prepare("UPDATE cards SET destinations = '{not json' WHERE id = ?").run(broken.id);
    db.prepare(`UPDATE cards SET source = '{"kind":"email"}' WHERE id = ?`).run(wrongShape.id);
    expect(store.listCards("open").map((card) => card.id)).toEqual([good.id]);
    expect(store.getCard(broken.id)).toBeNull();
    expect(store.updateCard(broken.id, { status: "skipped" })).toBeNull();
    expect(warnings.some((message) => message.includes(broken.id) && message.includes("destinations"))).toBe(true);
    expect(warnings.some((message) => message.includes(wrongShape.id) && message.includes("source"))).toBe(true);
  });

  it("assigns cards to routing jobs", () => {
    const { store } = setup();
    const a = store.createCard(newCard({ status: "routing" }));
    const b = store.createCard(newCard({ status: "routing" }));
    store.createCard(newCard({ status: "routing" }));
    expect(store.setCardJob(a.id, "job_aaaaaaaa")).toBe(true);
    expect(store.setCardJob(b.id, "job_aaaaaaaa")).toBe(true);
    expect(store.setCardJob("card_00000000", "job_aaaaaaaa")).toBe(false);
    expect(store.cardsForJob("job_aaaaaaaa").map((card) => card.id)).toEqual([a.id, b.id]);
    expect(store.setCardJob(b.id, null)).toBe(true);
    expect(store.cardsForJob("job_aaaaaaaa").map((card) => card.id)).toEqual([a.id]);
    expect(store.cardsForJob("job_bbbbbbbb")).toEqual([]);
  });
});

describe("units and notes_seen", () => {
  it("tracks unit status and keeps the first-seen time on upsert", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { store } = setup();
    expect(store.getUnit("h1")).toBeNull();
    store.upsertUnit({ hash: "h1", notePath: "a/10-14-26.md", noteDate: "2026-10-14", status: "pending", cardId: null });
    vi.setSystemTime(9_000);
    store.upsertUnit({ hash: "h1", notePath: "b/10-14-26.md", noteDate: "2026-10-14", status: "pending", cardId: "card_aaaaaaaa" });
    expect(store.getUnit("h1")).toEqual({
      hash: "h1",
      notePath: "b/10-14-26.md",
      noteDate: "2026-10-14",
      status: "pending",
      cardId: "card_aaaaaaaa",
      seenAt: new Date(1_000).toISOString(),
    });
    expect(store.setUnitStatus("h1", "accepted")).toBe(true);
    expect(store.getUnit("h1")?.status).toBe("accepted");
    expect(store.setUnitStatus("missing", "skipped")).toBe(false);
  });

  it("treats an unknown stored unit status as pending so the unit still blocks re-ingest", () => {
    const { store, db } = setup();
    store.upsertUnit({ hash: "h1", notePath: "n.md", noteDate: "2026-10-14", status: "skipped", cardId: null });
    db.prepare("UPDATE units SET status = 'weird' WHERE hash = 'h1'").run();
    expect(store.getUnit("h1")?.status).toBe("pending");
  });

  it("stores note stamps exactly and overwrites them", () => {
    const { store } = setup();
    expect(store.noteStamp("Time/10-14-26.md")).toBeNull();
    store.setNoteStamp("Time/10-14-26.md", 1_760_000_000_000.25, 120);
    expect(store.noteStamp("Time/10-14-26.md")).toEqual({ mtimeMs: 1_760_000_000_000.25, size: 120 });
    store.setNoteStamp("Time/10-14-26.md", 1_760_000_000_500, 0);
    expect(store.noteStamp("Time/10-14-26.md")).toEqual({ mtimeMs: 1_760_000_000_500, size: 0 });
  });
});

describe("jobs", () => {
  it("runs a job through thread assignment and completion", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { store } = setup();
    const job = store.createJob({ kind: "route", payload: { cardIds: ["card_aaaaaaaa"] } });
    expect(job).toEqual({
      id: expect.stringMatching(/^job_[a-z0-9]{8}$/),
      kind: "route",
      threadId: null,
      status: "running",
      payload: { cardIds: ["card_aaaaaaaa"] },
      result: null,
      error: null,
      createdAt: new Date(1_000).toISOString(),
      finishedAt: null,
    });
    expect(store.getJob(job.id)).toEqual(job);
    expect(store.setJobThread(job.id, "thr_1")).toBe(true);
    expect(store.setJobThread("job_00000000", "thr_9")).toBe(false);
    expect(store.jobForThread("thr_1")?.id).toBe(job.id);
    expect(store.jobForThread("thr_2")).toBeNull();
    expect(store.runningJobs().map((entry) => entry.id)).toEqual([job.id]);
    vi.setSystemTime(2_000);
    expect(store.finishJob(job.id, { status: "done", result: "3 routes" })).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ status: "done", result: "3 routes", error: null, finishedAt: new Date(2_000).toISOString() });
    expect(store.runningJobs()).toEqual([]);
  });

  it("ignores a second finish so a late idle event cannot overwrite a timeout", () => {
    const { store } = setup();
    const job = store.createJob({ kind: "describe", payload: undefined });
    expect(job.payload).toBeNull();
    expect(store.finishJob(job.id, { status: "failed", error: "timed out" })).toBe(true);
    expect(store.finishJob(job.id, { status: "done", result: "late" })).toBe(false);
    expect(store.getJob(job.id)).toMatchObject({ status: "failed", result: null, error: "timed out" });
    expect(store.finishJob("job_00000000", { status: "done" })).toBe(false);
    expect(store.getJob("job_00000000")).toBeNull();
  });

  it("lists running jobs oldest first and finds the latest job for a thread", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store } = setup();
    vi.setSystemTime(1_000);
    const first = store.createJob({ kind: "route", payload: null });
    vi.setSystemTime(2_000);
    const second = store.createJob({ kind: "route", payload: null });
    store.setJobThread(first.id, "thr_1");
    store.setJobThread(second.id, "thr_1");
    expect(store.runningJobs().map((job) => job.id)).toEqual([first.id, second.id]);
    expect(store.jobForThread("thr_1")?.id).toBe(second.id);
  });

  it("skips a job row with an unknown kind and logs it", () => {
    const { store, db, warnings } = setup();
    const job = store.createJob({ kind: "route", payload: { a: 1 } });
    db.prepare("UPDATE jobs SET kind = 'mystery' WHERE id = ?").run(job.id);
    expect(store.getJob(job.id)).toBeNull();
    expect(store.runningJobs()).toEqual([]);
    expect(warnings.some((message) => message.includes(job.id))).toBe(true);
  });
});

describe("migrations", () => {
  it("can open the same database twice without re-running migrations", () => {
    const { host, store } = setup();
    store.upsertDoc(doc({ slug: "kept", title: "Kept" }, ["", "persisted body"]));
    store.createCard(newCard());
    const again = createStore(host.bb.storage);
    expect(again.getDoc("kept")?.title).toBe("Kept");
    expect(again.openCount()).toBe(1);
    expect(again.search({ query: "persisted", type: null, limit: 5 }).total).toBe(1);
  });
});
