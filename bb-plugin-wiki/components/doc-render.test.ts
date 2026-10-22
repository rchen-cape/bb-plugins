import { describe, expect, it } from "vitest";
import type { DocSummary } from "../contract";
import { MARKER_LINE, newDocContent } from "../lib/markdown-doc";
import {
  createResolver,
  describeWikiEmbed,
  describeWikiLink,
  htmlMediaLine,
  htmlMediaUrl,
  leadingTitleSpan,
  markdownImageUrl,
  mediaUrl,
  noteDateLabel,
  parseMarkerAttributes,
  parseThreadHref,
  parseWikiHref,
  parseWikiLink,
  resolveAssetPath,
  sourceMarkerLabel,
  threadHref,
  wikiHref,
  type WikiLinkContext,
} from "./doc-render";

function doc(slug: string, title: string, extra: Partial<DocSummary> = {}): DocSummary {
  return { slug, title, type: "topic", aliases: [], tag: slug.split("/").at(-1) ?? slug, updatedAt: "2026-10-14T10:00:00.000Z", headings: [], ...extra };
}

const DOCS = [
  doc("adding-config-catalog", "Adding config catalog", { type: "process", aliases: ["cc", "config-catalog"] }),
  doc("unified-notification", "Unified notification", { type: "project" }),
  doc("team/onboarding", "Onboarding"),
];

const resolve = createResolver(DOCS);
const asset = (path: string) => `/api/v1/plugins/wiki/http/asset?path=${encodeURIComponent(path)}`;

function context(docSlug: string, ownHeadings: readonly string[] = []): WikiLinkContext {
  return { resolve, docSlug, ownHeadings: () => ownHeadings };
}

function lines(text: string): (index: number) => string | null {
  const all = text.split("\n");
  return (index) => all[index] ?? null;
}

function markerLabel(line: string) {
  const match = MARKER_LINE.exec(line);
  return match === null ? null : sourceMarkerLabel(parseMarkerAttributes(match[1] ?? ""));
}

describe("createResolver", () => {
  it("resolves by slug, then title, then alias, then tag, ignoring case", () => {
    expect(resolve("unified-notification")?.slug).toBe("unified-notification");
    expect(resolve("ADDING CONFIG CATALOG")?.slug).toBe("adding-config-catalog");
    expect(resolve("CC")?.slug).toBe("adding-config-catalog");
    expect(resolve("Config Catalog")?.slug).toBe("adding-config-catalog");
    expect(resolve("onboarding")?.slug).toBe("team/onboarding");
    expect(resolve("team/onboarding")?.title).toBe("Onboarding");
    expect(resolve("nothing here")).toBeNull();
    expect(resolve("  ")).toBeNull();
  });

  it("prefers a slug match over another doc's title", () => {
    const tricky = createResolver([doc("alpha", "beta"), doc("beta", "Gamma")]);
    expect(tricky("beta")?.slug).toBe("beta");
  });
});

describe("parseWikiLink", () => {
  it("splits target, heading and label", () => {
    expect(parseWikiLink("Doc")).toEqual({ target: "Doc", heading: null, label: null });
    expect(parseWikiLink("Doc#Global token")).toEqual({ target: "Doc", heading: "Global token", label: null });
    expect(parseWikiLink("Doc|the doc")).toEqual({ target: "Doc", heading: null, label: "the doc" });
    expect(parseWikiLink(" Doc # Setup | here ")).toEqual({ target: "Doc", heading: "Setup", label: "here" });
    expect(parseWikiLink("#Local")).toEqual({ target: "", heading: "Local", label: null });
  });
});

describe("wiki hrefs", () => {
  it("round-trips slugs with folders, spaces and anchors", () => {
    const href = wikiHref("team/My notes", "global-token");
    expect(href).toBe("#wiki/team/My%20notes#global-token");
    expect(parseWikiHref(href)).toEqual({ slug: "team/My notes", anchor: "global-token" });
    expect(parseWikiHref("#wiki/plain")).toEqual({ slug: "plain", anchor: null });
    expect(parseWikiHref("#wiki/")).toBeNull();
    expect(parseWikiHref("https://example.invalid")).toBeNull();
    expect(parseThreadHref(threadHref("thr_abc"))).toBe("thr_abc");
    expect(parseThreadHref("#wiki/x")).toBeNull();
  });
});

describe("describeWikiLink", () => {
  it("links resolved docs and labels them like the old reader", () => {
    expect(describeWikiLink("Unified notification", context("x"))).toEqual({ label: "Unified notification", href: "#wiki/unified-notification", missing: null });
    expect(describeWikiLink("cc", context("x")).href).toBe("#wiki/adding-config-catalog");
    expect(describeWikiLink("cc#Global token", context("x"))).toEqual({
      label: "cc › Global token",
      href: "#wiki/adding-config-catalog#global-token",
      missing: null,
    });
    expect(describeWikiLink("cc#Global token|the token step", context("x")).label).toBe("the token step");
    expect(describeWikiLink("#Setup", context("team/onboarding")).href).toBe("#wiki/team/onboarding#setup");
  });

  it("explains a link to a doc that does not exist yet", () => {
    expect(describeWikiLink("Billing <v2>", context("x"))).toEqual({ label: "Billing <v2>", href: null, missing: "No Wiki doc named “Billing <v2>” yet" });
  });

  it("uses the anchors search gives, with the open doc's own headings for self links", () => {
    const docs = [doc("runbook", "Runbook", { headings: ["Runbook", "Setup!", "Setup"] }), doc("other", "Other", { headings: ["Intro", "Limits!", "Limits"] })];
    const own: WikiLinkContext = { resolve: createResolver(docs), docSlug: "runbook", ownHeadings: () => ["Runbook", "Setup!", "Setup", "Setup"] };
    expect(describeWikiLink("Other#limits", own).href).toBe("#wiki/other#limits-1");
    expect(describeWikiLink("Other#Limits!", own).href).toBe("#wiki/other#limits");
    expect(describeWikiLink("Other#Missing part", own).href).toBe("#wiki/other#missing-part");
    expect(describeWikiLink("#Setup", own).href).toBe("#wiki/runbook#setup-1");
    expect(describeWikiLink("Runbook#setup!", own).href).toBe("#wiki/runbook#setup");
  });
});

describe("media", () => {
  it("resolves embeds into the assets folder unless they name a folder", () => {
    expect(describeWikiEmbed("diagram.png", "x")).toEqual({ relPath: "assets/diagram.png", alt: "diagram.png" });
    expect(describeWikiEmbed("clip.mp4|The demo", "team/doc")).toEqual({ relPath: "assets/clip.mp4", alt: "The demo" });
    expect(describeWikiEmbed("../img/a.png", "team/sub/doc")).toEqual({ relPath: "team/img/a.png", alt: "../img/a.png" });
  });

  it("serves media through the plugin asset URL, escaping parentheses", () => {
    expect(mediaUrl("wiki", "assets/a (1).png")).toBe(asset("assets/a (1).png").replace("(", "%28").replace(")", "%29"));
  });

  it("loads relative markdown images and video from the Wiki, and leaves other files as links", () => {
    expect(markdownImageUrl("wiki", "assets/flow%20chart.png", "x")).toBe(asset("assets/flow chart.png"));
    expect(markdownImageUrl("wiki", "<b c.png>", "x")).toBe(asset("b c.png"));
    expect(markdownImageUrl("wiki", "../img/a.png", "team/onboarding")).toBe(asset("img/a.png"));
    expect(markdownImageUrl("wiki", "assets/demo.mov", "x")).toBe(asset("assets/demo.mov"));
    expect(markdownImageUrl("wiki", "notes.md", "x")).toBeNull();
    expect(markdownImageUrl("wiki", "https://cdn.invalid/a.png", "x")).toBe("https://cdn.invalid/a.png");
    expect(markdownImageUrl("wiki", "/api/v1/x.png", "x")).toBe("/api/v1/x.png");
    expect(markdownImageUrl("wiki", "javascript:alert(1)", "x")).toBeNull();
  });

  it("reads one media tag per line and resolves its first non-empty src", () => {
    expect(htmlMediaLine('<video controls src="assets/a.mp4"></video>')).toEqual({ video: true, src: "assets/a.mp4", alt: "" });
    expect(htmlMediaLine('  <img alt="x" src="" src="pic.png">')).toEqual({ video: false, src: "pic.png", alt: "x" });
    expect(htmlMediaLine('<IMG SRC="a&amp;b.png">')).toEqual({ video: false, src: "a&b.png", alt: "" });
    expect(htmlMediaLine('<img > src="a.png"')).toBeNull();
    expect(htmlMediaLine('Text <img src="a.png">')).toBeNull();
    expect(htmlMediaUrl("wiki", "assets/a.mp4", "x")).toBe(asset("assets/a.mp4"));
    expect(htmlMediaUrl("wiki", "/api/v1/x.png", "x")).toBe("/api/v1/x.png");
  });

  it("resolves asset paths against the doc folder", () => {
    expect(resolveAssetPath("assets/x.png", "team/doc")).toBe("assets/x.png");
    expect(resolveAssetPath("./pic.png", "team/doc")).toBe("team/pic.png");
    expect(resolveAssetPath("../pic.png", "team/sub/doc")).toBe("team/pic.png");
    expect(resolveAssetPath("pic.png")).toBe("pic.png");
  });
});

describe("source marker labels", () => {
  it("names notes, thread, agent, upload and manual sources", () => {
    expect(markerLabel('<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->')).toEqual({
      parts: [{ text: "from 10-14-26 notes" }],
      title: "Added 2026-10-15",
    });
    expect(markerLabel('<!-- wiki:source thread="thr_abc" title="Debug &quot;push&quot;" added="2026-10-15" -->')).toEqual({
      parts: [{ text: "from " }, { text: "“Debug \"push\"”", threadLink: "#wiki-thread/thr_abc" }],
      title: "Added 2026-10-15",
    });
    expect(markerLabel('<!-- wiki:source agent thread="thr_x" title="Agent run" added="2026-10-15" -->')?.parts).toEqual([
      { text: "from an agent in " },
      { text: "“Agent run”", threadLink: "#wiki-thread/thr_x" },
    ]);
    expect(markerLabel('<!-- wiki:source upload="demo.mp4" added="2026-10-15" -->')?.parts).toEqual([{ text: "from demo.mp4" }]);
    expect(markerLabel("<!-- wiki:source manual -->")).toEqual({ parts: [{ text: "added by hand" }], title: null });
    expect(markerLabel('<!-- wiki:source notes="Time/9-02-26.md" -->')?.parts).toEqual([{ text: "from 09-02-26 notes" }]);
    expect(markerLabel('<!-- wiki:source notes="" -->')?.parts).toEqual([{ text: "from daily notes" }]);
    expect(markerLabel('<!-- wiki:source agent title="  Many   spaces " -->')?.parts).toEqual([{ text: "from an agent in " }, { text: "“Many spaces”" }]);
  });

  it.each([
    ["a byte order mark", "﻿"],
    ["a no-break space", " "],
    ["a form feed", "\f"],
    ["a vertical tab", "\v"],
  ])("is not a marker line when it starts with %s", (_label, lead) => {
    expect(markerLabel(`${lead}<!-- wiki:source notes="10-14-26.md" date="2026-10-14" added="2026-10-14" -->`)).toBeNull();
  });

  it("decodes every entity the marker writer escapes, without decoding twice", () => {
    expect(markerLabel('<!-- wiki:source thread="thr_abc" title="Line&#10;two &amp;lt;b&amp;gt; &#x41;" added="2026-10-15" -->')?.parts[1]).toEqual({
      text: "“Line two &lt;b&gt; A”",
      threadLink: "#wiki-thread/thr_abc",
    });
  });

  it("formats note dates as MM-DD-YY", () => {
    expect(noteDateLabel("2026-10-14")).toBe("10-14-26");
    expect(noteDateLabel("not a date")).toBe("not a date");
  });
});

describe("leadingTitleSpan", () => {
  it("finds the H1 that repeats the doc title and the blank lines around it", () => {
    const fresh = newDocContent({ title: "Token rotation", type: "topic", aliases: [] });
    const body = fresh.slice(fresh.indexOf("---\n", 4) + 4);
    expect(leadingTitleSpan(lines(body), "Token rotation")).toEqual({ start: 1, end: 3 });
    expect(leadingTitleSpan(lines("#   token  ROTATION  \n\nBody"), "Token rotation")).toEqual({ start: 0, end: 2 });
  });

  it("keeps a first H1 that differs from the title, and never takes a later one", () => {
    expect(leadingTitleSpan(lines("# Meeting notes\n\nBody"), "Q4 planning")).toBeNull();
    expect(leadingTitleSpan(lines("Intro\n\n# Q4 planning"), "Q4 planning")).toBeNull();
  });

  it("accepts closing hashes but not an indented code line", () => {
    expect(leadingTitleSpan(lines("# Token rotation ##  \n\nBody"), "Token rotation")).toEqual({ start: 0, end: 2 });
    expect(leadingTitleSpan(lines("    # Token rotation\n\nBody"), "Token rotation")).toBeNull();
    expect(leadingTitleSpan(lines(""), "Token rotation")).toBeNull();
  });
});
