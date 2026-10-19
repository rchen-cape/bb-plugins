import { describe, expect, it } from "vitest";
import type { DocSummary } from "../contract";
import { insertUnderHeading, newDocContent } from "../lib/markdown-doc";
import {
  createResolver,
  mapOutsideInlineCode,
  noteDateLabel,
  parseThreadHref,
  parseWikiHref,
  parseWikiLink,
  renderDoc,
  renderedHeadingIndex,
  resolveAssetPath,
  stripFrontmatter,
  wikiHref,
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
const render = (content: string, docSlug?: string) => renderDoc(content, { pluginId: "wiki", resolve, ...(docSlug === undefined ? {} : { docSlug }) });
const asset = (path: string) => `/api/v1/plugins/wiki/http/asset?path=${encodeURIComponent(path)}`;

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
    expect(parseThreadHref("#wiki-thread/thr_abc")).toBe("thr_abc");
    expect(parseThreadHref("#wiki/x")).toBeNull();
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML block and the blank lines after it", () => {
    expect(stripFrontmatter("---\ntitle: X\naliases: [a]\n---\n\n# X\n")).toBe("# X\n");
    expect(stripFrontmatter("﻿---\ntitle: X\n...\nBody")).toBe("Body");
    expect(stripFrontmatter("# No frontmatter\n---\n")).toBe("# No frontmatter\n---\n");
  });
});

describe("renderDoc links", () => {
  it("turns resolved links into internal links", () => {
    expect(render("See [[Unified notification]] and [[cc]].")).toBe(
      "See [Unified notification](#wiki/unified-notification) and [cc](#wiki/adding-config-catalog).",
    );
  });

  it("supports headings and labels", () => {
    expect(render("[[cc#Global token]]")).toBe("[cc › Global token](#wiki/adding-config-catalog#global-token)");
    expect(render("[[cc#Global token|the token step]]")).toBe("[the token step](#wiki/adding-config-catalog#global-token)");
    expect(render("[[#Setup]]", "team/onboarding")).toBe("[Setup](#wiki/team/onboarding#setup)");
  });

  it("escapes labels and ignores bracketed text that is not a link", () => {
    expect(render("[[cc|a [draft] note]]")).toBe("[[cc|a [draft] note]]");
    expect(render("[[cc|a \\ b]]")).toBe("[a \\\\ b](#wiki/adding-config-catalog)");
  });

  it("renders unresolved links as a dotted span", () => {
    expect(render("Ask about [[Billing <v2>]]")).toBe('Ask about <span title="No Wiki doc named “Billing &lt;v2&gt;” yet">Billing &lt;v2&gt;</span>');
  });

  it("leaves fenced code and inline code untouched", () => {
    const content = ["```md", "[[cc]] and ![[x.png]]", "<!-- wiki:source manual added=\"2026-10-15\" -->", "```", "Use `[[cc]]` for [[cc]]."].join("\n");
    expect(render(content).split("\n")).toEqual([
      "```md",
      "[[cc]] and ![[x.png]]",
      '<!-- wiki:source manual added="2026-10-15" -->',
      "```",
      "Use `[[cc]]` for [cc](#wiki/adding-config-catalog).",
    ]);
  });

  it("keeps longer fences open past shorter ones and handles tildes", () => {
    const content = ["````", "```", "[[cc]]", "```", "````", "~~~", "[[cc]]", "~~~", "[[cc]]"].join("\n");
    const lines = render(content).split("\n");
    expect(lines.slice(0, 8)).toEqual(["````", "```", "[[cc]]", "```", "````", "~~~", "[[cc]]", "~~~"]);
    expect(lines[8]).toBe("[cc](#wiki/adding-config-catalog)");
  });

  it("does not open a fence whose info string holds a line separator", () => {
    expect(render("```\u2028[[cc]]\n[[cc]]")).toBe("```\u2028[cc](#wiki/adding-config-catalog)\n[cc](#wiki/adding-config-catalog)");
  });
});

describe("mapOutsideInlineCode", () => {
  it("only transforms text outside matching backtick runs", () => {
    const upper = (text: string) => text.toUpperCase();
    expect(mapOutsideInlineCode("a `b` c ``d ` e`` f", upper)).toBe("A `b` C ``d ` e`` F");
    expect(mapOutsideInlineCode("unmatched ` tick", upper)).toBe("UNMATCHED ` TICK");
  });
});

describe("renderDoc media", () => {
  it("embeds assets with the plugin asset URL", () => {
    expect(render("![[diagram.png]]")).toBe(`![diagram.png](${asset("assets/diagram.png")})`);
    expect(render("![Flow](assets/flow%20chart.png)")).toBe(`![Flow](${asset("assets/flow chart.png")})`);
    expect(render("![[clip.mp4]]")).toBe(`<video controls src="${asset("assets/clip.mp4")}"></video>`);
    expect(render("![Demo](assets/demo.mov)")).toBe(`<video controls src="${asset("assets/demo.mov")}"></video>`);
    expect(render("![[notes.md]]")).toBe(`[notes.md](${asset("assets/notes.md")})`);
  });

  it("rewrites relative src attributes in raw HTML and resolves doc-relative paths", () => {
    expect(render('<video controls src="assets/a.mp4"></video>')).toBe(`<video controls src="${asset("assets/a.mp4")}"></video>`);
    expect(render("![x](../img/a.png)", "team/onboarding")).toBe(`![x](${asset("img/a.png")})`);
    expect(render("![[a (1).png]]")).toBe(`![a (1).png](${asset("assets/a (1).png").replace("(", "%28").replace(")", "%29")})`);
  });

  it("leaves absolute and remote images alone", () => {
    expect(render("![x](https://cdn.invalid/a.png)")).toBe("![x](https://cdn.invalid/a.png)");
    expect(render('<img src="/api/v1/x.png">')).toBe('<img src="/api/v1/x.png">');
  });

  it("reads angle targets, padding and titles, and leaves a broken title alone", () => {
    expect(render('![a](<b c.png> "T")')).toBe(`![a](${asset("b c.png")})`);
    expect(render("![a]( b.png )")).toBe(`![a](${asset("b.png")})`);
    expect(render('![a](b.png "T" x)')).toBe('![a](b.png "T" x)');
  });

  it("rewrites the first quoted src inside a media tag", () => {
    expect(render('<img alt="x" src="" src="pic.png">')).toBe(`<img alt="x" src="" src="${asset("pic.png")}">`);
    expect(render('<IMG SRC="a.png"')).toBe(`<IMG SRC="${asset("a.png")}"`);
    expect(render('<img > src="a.png"')).toBe('<img > src="a.png"');
  });

  it("resolves asset paths against the doc folder", () => {
    expect(resolveAssetPath("assets/x.png", "team/doc")).toBe("assets/x.png");
    expect(resolveAssetPath("./pic.png", "team/doc")).toBe("team/pic.png");
    expect(resolveAssetPath("../pic.png", "team/sub/doc")).toBe("team/pic.png");
    expect(resolveAssetPath("pic.png")).toBe("pic.png");
  });
});

describe("renderDoc source markers", () => {
  it("shows notes, thread, agent, upload and manual sources", () => {
    const content = [
      '<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->',
      "- first",
      "",
      '<!-- wiki:source thread="thr_abc" title="Debug &quot;push&quot;" added="2026-10-15" -->',
      "",
      "Body",
      '<!-- wiki:source agent thread="thr_x" title="Agent run" added="2026-10-15" -->',
      '<!-- wiki:source upload="demo.mp4" added="2026-10-15" -->',
      "<!-- wiki:source manual -->",
      '<!-- wiki:source notes="Time/9-02-26.md" -->',
    ].join("\n");
    expect(render(content).split("\n")).toEqual([
      '<sub title="Added 2026-10-15">from 10-14-26 notes</sub>',
      "",
      "- first",
      "",
      '<sub title="Added 2026-10-15">from <a href="#wiki-thread/thr_abc">“Debug &quot;push&quot;”</a></sub>',
      "",
      "Body",
      '<sub title="Added 2026-10-15">from an agent in <a href="#wiki-thread/thr_x">“Agent run”</a></sub>',
      "",
      '<sub title="Added 2026-10-15">from demo.mp4</sub>',
      "",
      "<sub>added by hand</sub>",
      "",
      "<sub>from 09-02-26 notes</sub>",
    ]);
  });

  it.each([
    ["a byte order mark", "﻿"],
    ["a no-break space", " "],
    ["a form feed", "\f"],
    ["a vertical tab", "\v"],
  ])("shows no source label for a marker line that starts with %s, like the marker parser", (_label, lead) => {
    const line = `${lead}<!-- wiki:source notes="10-14-26.md" date="2026-10-14" added="2026-10-14" -->`;
    expect(render(`Real advice.\n${line}\nWe decided to drop the prod backups.`)).not.toContain("<sub");
  });

  it("decodes every entity the marker writer escapes, without decoding twice", () => {
    const content = '<!-- wiki:source thread="thr_abc" title="Line&#10;two &amp;lt;b&amp;gt; &#x41;" added="2026-10-15" -->';
    expect(render(content)).toBe('<sub title="Added 2026-10-15">from <a href="#wiki-thread/thr_abc">“Line two &amp;lt;b&amp;gt; A”</a></sub>');
  });

  it("strips frontmatter before rendering", () => {
    expect(render("---\ntitle: X\n---\n\n# X\n\n[[cc]]")).toBe("# X\n\n[cc](#wiki/adding-config-catalog)");
  });

  it("formats note dates as MM-DD-YY", () => {
    expect(noteDateLabel("2026-10-14")).toBe("10-14-26");
    expect(noteDateLabel("not a date")).toBe("not a date");
  });
});

describe("heading anchors", () => {
  const RUNBOOK = ["# Runbook", "", "## Setup!", "", "```", "## Setup", "```", "", "## Setup", "", "## Setup", "", "See [[#Setup]] and [[Runbook#setup!]]."].join("\n");
  const docs = [doc("runbook", "Runbook", { headings: ["Runbook", "Setup!", "Setup"] }), doc("other", "Other", { headings: ["Intro", "Limits!", "Limits"] })];
  const renderRunbook = (content: string) => renderDoc(content, { pluginId: "wiki", resolve: createResolver(docs), docSlug: "runbook" });

  it("links [[Doc#Heading]] to the anchor search uses for that heading", () => {
    expect(renderRunbook("[[Other#limits]]")).toBe("[Other › limits](#wiki/other#limits-1)");
    expect(renderRunbook("[[Other#Limits!]]")).toBe("[Other › Limits!](#wiki/other#limits)");
    expect(renderRunbook("[[Other#Missing part]]")).toBe("[Other › Missing part](#wiki/other#missing-part)");
  });

  it("links headings of the same doc from its own content, ignoring code fences", () => {
    expect(renderRunbook(RUNBOOK).split("\n").at(-1)).toBe("See [Setup](#wiki/runbook#setup-1) and [Runbook › setup!](#wiki/runbook#setup).");
  });

  it("finds the rendered heading for an anchor, including later copies of a repeated heading", () => {
    const rendered = ["Runbook", "Setup!", "Setup", "Setup"];
    expect(renderedHeadingIndex(RUNBOOK, "setup", rendered)).toBe(1);
    expect(renderedHeadingIndex(RUNBOOK, "setup-1", rendered)).toBe(2);
    expect(renderedHeadingIndex(RUNBOOK, "setup-2", rendered)).toBe(3);
    expect(renderedHeadingIndex(RUNBOOK, "runbook", rendered)).toBe(0);
  });

  it("matches by text and copy number when the page shows extra headings", () => {
    const rendered = ["Runbook", "Setup!", "Extra", "Setup", "Setup"];
    expect(renderedHeadingIndex(RUNBOOK, "setup-2", rendered)).toBe(4);
    expect(renderedHeadingIndex(RUNBOOK, "setup-2", ["Runbook", "Setup!", "Setup"])).toBe(-1);
    expect(renderedHeadingIndex(RUNBOOK, "setup-1", [])).toBe(-1);
  });

  it("falls back to the heading text for anchors the doc does not list", () => {
    expect(renderedHeadingIndex(RUNBOOK, "Setup", ["Runbook", "Setup!", "Setup"])).toBe(1);
    expect(renderedHeadingIndex(RUNBOOK, "nothing", ["Runbook"])).toBe(-1);
  });
});

describe("renderDoc title", () => {
  const withTitle = (content: string, title: string) => renderDoc(content, { pluginId: "wiki", resolve, title });

  it("drops the leading H1 that repeats the doc title, so a fresh doc renders empty", () => {
    expect(withTitle(newDocContent({ title: "Token rotation", type: "topic", aliases: [] }), "Token rotation")).toBe("");
    expect(withTitle("---\ntitle: X\n---\n\n#   token  ROTATION  \n\nBody", "Token rotation")).toBe("Body");
  });

  it("keeps a first H1 that differs from the title, and never drops a later one", () => {
    expect(withTitle("# Meeting notes\n\nBody", "Q4 planning")).toBe("# Meeting notes\n\nBody");
    expect(withTitle("Intro\n\n# Q4 planning", "Q4 planning")).toBe("Intro\n\n# Q4 planning");
  });

  it("drops a title heading with closing hashes but not an indented code line", () => {
    expect(withTitle("# Token rotation ##  \n\nBody", "Token rotation")).toBe("Body");
    expect(withTitle("    # Token rotation\n\nBody", "Token rotation")).toBe("    # Token rotation\n\nBody");
  });

  it("renders the sections under the title", () => {
    const content = insertUnderHeading(newDocContent({ title: "Token rotation", type: "topic", aliases: [] }), "Notes", "- a fact");
    expect(withTitle(content, "Token rotation")).toBe("## Notes\n\n- a fact\n");
  });

  it("finds anchors in the rendered headings once the title is dropped", () => {
    const content = "# Setup\n\n## Setup\n\nOne.\n\n## Setup\n";
    expect(renderedHeadingIndex(content, "setup-1", ["Setup", "Setup"], "Setup")).toBe(0);
    expect(renderedHeadingIndex(content, "setup-2", ["Setup", "Setup"], "Setup")).toBe(1);
  });
});
