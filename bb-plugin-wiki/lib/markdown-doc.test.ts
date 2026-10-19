import { describe, expect, it } from "vitest";
import {
  moveUnsortedBelowRule,
  renameDocContent,
  addAlias,
  dedent,
  describeSourceMarker,
  extractImageTargets,
  extractWikiLinks,
  formatSourceMarker,
  insertUnderHeading,
  listHeadings,
  newDocContent,
  parseDoc,
  parseSourceMarkers,
  rewriteImageTargets,
  type SourceMarker,
  splitSections,
  stripSourceMarkers,
  trimLineEnds,
} from "./markdown-doc";

const lines = (...parts: string[]) => parts.join("\n");

describe("parseDoc", () => {
  const doc = lines(
    "---",
    "title: Adding config catalog",
    "type: process            # project | topic | process",
    "aliases: [config-catalog, cc]",
    "---",
    "",
    "# Something else",
    "",
    "Body",
    "",
  );

  it("reads title, type, and aliases from frontmatter", () => {
    const parsed = parseDoc(doc, "adding-config-catalog");
    expect(parsed.meta).toEqual({ title: "Adding config catalog", type: "process", aliases: ["config-catalog", "cc"] });
    expect(parsed.title).toBe("Adding config catalog");
    expect(parsed.type).toBe("process");
    expect(parsed.aliases).toEqual(["config-catalog", "cc"]);
  });

  it("keeps the raw frontmatter block byte-for-byte and splits the body after it", () => {
    const parsed = parseDoc(doc, "x");
    expect(parsed.frontmatter).toBe(doc.slice(0, doc.indexOf("\n\n# Something") + 1));
    expect(parsed.frontmatter + parsed.body).toBe(doc);
    expect(parsed.body.startsWith("\n# Something else")).toBe(true);
  });

  it("accepts a BOM, CRLF line endings, and a ... closing fence", () => {
    const content = "\uFEFF---\r\ntitle: Windows\r\n...\r\nBody\r\n";
    const parsed = parseDoc(content, "x");
    expect(parsed.title).toBe("Windows");
    expect(parsed.frontmatter).toBe("\uFEFF---\r\ntitle: Windows\r\n...\r\n");
    expect(parsed.body).toBe("Body\r\n");
  });

  it("treats invalid YAML as no frontmatter", () => {
    const content = lines("---", "title: [unclosed", "---", "# Real title", "");
    const parsed = parseDoc(content, "x");
    expect(parsed.frontmatter).toBe("");
    expect(parsed.body).toBe(content);
    expect(parsed.title).toBe("Real title");
    expect(parsed.meta).toEqual({ title: null, type: null, aliases: [] });
  });

  it("treats YAML that is not a mapping as no frontmatter", () => {
    expect(parseDoc(lines("---", "- a", "- b", "---", "text"), "x").frontmatter).toBe("");
    expect(parseDoc(lines("---", "just words", "---", "text"), "x").frontmatter).toBe("");
  });

  it("treats duplicate keys as invalid frontmatter", () => {
    expect(parseDoc(lines("---", "title: A", "title: B", "---", ""), "file").title).toBe("File");
  });

  it("accepts an empty frontmatter block", () => {
    const parsed = parseDoc(lines("---", "---", "# Heading", ""), "x");
    expect(parsed.frontmatter).toBe("---\n---\n");
    expect(parsed.title).toBe("Heading");
  });

  it("ignores an opening fence that never closes", () => {
    const content = lines("---", "title: Never closed", "# Body title");
    const parsed = parseDoc(content, "x");
    expect(parsed.frontmatter).toBe("");
    expect(parsed.title).toBe("Body title");
  });

  it("refuses YAML alias bombs instead of expanding them", () => {
    const content = lines(
      "---",
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "title: Bomb",
      "---",
      "# Real",
    );
    const parsed = parseDoc(content, "x");
    expect(parsed.frontmatter).toBe("");
    expect(parsed.title).toBe("Real");
  });

  it("allows a few YAML aliases", () => {
    expect(parseDoc(lines("---", "base: &b Shared", "title: *b", "---", ""), "x").title).toBe("Shared");
  });

  it("falls back from frontmatter title to the first H1 outside code to the file name", () => {
    expect(parseDoc(lines("## Not h1", "```", "# In code", "```", "# Real H1 ##", ""), "x").title).toBe("Real H1");
    expect(parseDoc("No headings here\n", "unified-push").title).toBe("Unified push");
    expect(parseDoc("", "projects/unified_push.md").title).toBe("Unified push");
    expect(parseDoc(lines("---", "title: '   '", "---", "# From body"), "x").title).toBe("From body");
  });

  it("finds an H1 right after a BOM when there is no frontmatter", () => {
    const parsed = parseDoc("\uFEFF# Bom title\n", "x");
    expect(parsed.title).toBe("Bom title");
    expect(parsed.body).toBe("\uFEFF# Bom title\n");
  });

  it("stringifies numeric titles and collapses whitespace", () => {
    expect(parseDoc(lines("---", "title: 2026", "---", ""), "x").title).toBe("2026");
    expect(parseDoc(lines("---", 'title: "  Two\\n lines "', "---", ""), "x").title).toBe("Two lines");
  });

  it("defaults the type to topic and accepts any case", () => {
    expect(parseDoc(lines("---", "type: Process", "---", ""), "x").type).toBe("process");
    const unknown = parseDoc(lines("---", "type: epic", "---", ""), "x");
    expect(unknown.meta.type).toBeNull();
    expect(unknown.type).toBe("topic");
    expect(parseDoc("", "x").type).toBe("topic");
  });

  it("normalizes and dedupes aliases from lists, strings, and numbers", () => {
    expect(parseDoc(lines("---", "aliases: ['@CC', Config Catalog, cc, 42, {a: 1}, null]", "---", ""), "x").aliases).toEqual([
      "cc",
      "config-catalog",
      "42",
    ]);
    expect(parseDoc(lines("---", "aliases: cc, Config Catalog", "---", ""), "x").aliases).toEqual(["cc", "config-catalog"]);
    expect(parseDoc(lines("---", "aliases:", "  - one", "  - '@two'", "---", ""), "x").aliases).toEqual(["one", "two"]);
    expect(parseDoc(lines("---", "aliases: {a: 1}", "---", ""), "x").aliases).toEqual([]);
  });
});

describe("splitSections", () => {
  const body = lines(
    "Intro line",
    "",
    "# Doc",
    "",
    "Top text",
    "",
    "## Global Token",
    "",
    "Token text",
    "",
    "```md",
    "## Not heading",
    "```",
    "",
    "### Rotation",
    "rotate",
    "",
    "## Global Token",
    "",
    "again",
    "",
    "# Second",
    "~~~",
    "# no",
    "~~~",
    "",
  );

  it("splits a preamble and one section per heading with paths, anchors, and order", () => {
    expect(splitSections(body)).toEqual([
      { heading: "", headingPath: "", anchor: "", level: 0, ord: 0, body: "Intro line" },
      { heading: "Doc", headingPath: "Doc", anchor: "doc", level: 1, ord: 1, body: "Top text" },
      {
        heading: "Global Token",
        headingPath: "Doc > Global Token",
        anchor: "global-token",
        level: 2,
        ord: 2,
        body: "Token text\n\n```md\n## Not heading\n```",
      },
      {
        heading: "Rotation",
        headingPath: "Doc > Global Token > Rotation",
        anchor: "rotation",
        level: 3,
        ord: 3,
        body: "rotate",
      },
      { heading: "Global Token", headingPath: "Doc > Global Token", anchor: "global-token-1", level: 2, ord: 4, body: "again" },
      { heading: "Second", headingPath: "Second", anchor: "second", level: 1, ord: 5, body: "~~~\n# no\n~~~" },
    ]);
  });

  it("omits a blank preamble and returns nothing for an empty body", () => {
    expect(splitSections("\n\n# Only\ntext").map((section) => section.heading)).toEqual(["Only"]);
    expect(splitSections("")).toEqual([]);
    expect(splitSections("   \n\n")).toEqual([]);
  });

  it("keeps a document without headings as a single preamble section", () => {
    expect(splitSections("just text\n  indented\n")).toEqual([
      { heading: "", headingPath: "", anchor: "", level: 0, ord: 0, body: "just text\n  indented" },
    ]);
  });

  it("keeps empty heading sections", () => {
    expect(splitSections("## A\n## B\nb").map((section) => [section.heading, section.body])).toEqual([
      ["A", ""],
      ["B", "b"],
    ]);
  });

  it("recognizes only real ATX headings", () => {
    const headings = splitSections(
      lines(
        "#hashtag",
        "####### seven",
        "    # indented code",
        "   # Three spaces",
        "## C#",
        "## Title ##",
        "#\tTab",
        "## ",
        "##",
        "## Foo # bar",
      ),
    ).map((section) => section.heading);
    expect(headings).toEqual(["", "Three spaces", "C#", "Title", "Tab", "Foo # bar"]);
  });

  it("ignores headings in indented, nested, unclosed, and longer fences", () => {
    const text = lines(
      "# Top",
      "- item",
      "  ```",
      "  # inside list fence",
      "  ```",
      "````",
      "```",
      "# inside outer fence",
      "```",
      "````",
      "## After",
      "~~~",
      "# unclosed",
    );
    expect(splitSections(text).map((section) => section.heading)).toEqual(["Top", "After"]);
  });

  it("does not treat inline triple backticks as a fence", () => {
    expect(splitSections(lines("```inline``` code", "# Real")).map((section) => section.heading)).toEqual(["", "Real"]);
  });

  it("builds heading paths that pop back to shallower levels", () => {
    const paths = splitSections(lines("### Deep first", "# One", "### Three", "## Two", "#### Four", "# Next")).map(
      (section) => section.headingPath,
    );
    expect(paths).toEqual(["Deep first", "One", "One > Three", "One > Two", "One > Two > Four", "Next"]);
  });

  it("makes GitHub-style anchors and dedupes them", () => {
    const anchors = splitSections(
      lines(
        "## What's new? (v2.0)",
        "## Use `foo_bar` & [docs](http://x)",
        "## Café déjà",
        "## See [[Doc|the doc]]",
        "## foo",
        "## foo",
        "## foo",
        "## foo-1",
      ),
    ).map((section) => section.anchor);
    expect(anchors).toEqual(["whats-new-v20", "use-foo_bar--docs", "café-déjà", "see-the-doc", "foo", "foo-1", "foo-2", "foo-1-1"]);
  });

  it("keeps link text in anchors and leaves unclosed brackets as text", () => {
    expect(splitSections("# [a](b) and [c] and ![d](e and [f")[0]?.anchor).toBe("a-and-c-and-de-and-f");
    expect(splitSections("# ![img](x.png)[t](u) ([v](w))")[0]?.anchor).toBe("imgt-v");
  });

  it("strips closing hashes only after a space and never reads lines with other line breaks as headings", () => {
    const headings = splitSections(
      lines("# a\rb", "# a\u2028b", "## Spaced   ##  \t", "# #", "# a #b", "#  ##", "#\t\t", "### x\t###\t#"),
    ).map((section) => section.heading);
    expect(headings).toEqual(["", "Spaced", "#", "a #b", "##", "x\t###"]);
  });

  it("does not open a fence on a line with another line break", () => {
    expect(splitSections(lines("```\u2028x", "# After")).map((section) => section.heading)).toEqual(["", "After"]);
    expect(splitSections(lines("```x", "# Inside")).map((section) => section.heading)).toEqual([""]);
  });

  it("handles CRLF and a leading BOM", () => {
    expect(splitSections("\uFEFF# Title\r\nline one\r\nline two\r\n")).toEqual([
      { heading: "Title", headingPath: "Title", anchor: "title", level: 1, ord: 0, body: "line one\nline two" },
    ]);
  });
});

describe("listHeadings", () => {
  it("lists headings in order outside frontmatter and fences, deduped case-insensitively", () => {
    const content = lines(
      "---",
      "# yaml comment",
      "title: T",
      "---",
      "# T",
      "## Notes",
      "```",
      "## Fake",
      "```",
      "## notes",
      "### Deep",
      "",
    );
    expect(listHeadings(content)).toEqual(["T", "Notes", "Deep"]);
  });

  it("returns an empty list for a doc without headings", () => {
    expect(listHeadings("text only")).toEqual([]);
    expect(listHeadings("")).toEqual([]);
  });
});

describe("insertUnderHeading", () => {
  it("treats a fence opened on a list item line as code, adding no closer and finding no heading inside it", () => {
    const block = "- ```bash\n  # restart the worker\n  make restart\n  ```";
    const content = lines("# Doc", "", "## Unsorted", "", "## Later", "", "- later fact", "");
    const result = insertUnderHeading(content, "Unsorted", block);
    expect(result).toBe(lines("# Doc", "", "## Unsorted", "", "## Later", "", "- later fact", "", "---", "", "<!-- wiki:unsorted -->", "", block, ""));
    expect(listHeadings(result)).toEqual(["Doc", "Unsorted", "Later"]);
    expect(listHeadings(insertUnderHeading(content, "Later", "1. ```\n   # step\n   ```"))).toEqual(["Doc", "Unsorted", "Later"]);
  });

  it("does not let a list item fence line close an open fence", () => {
    const block = "```\n- ```\n# still code\n```";
    expect(insertUnderHeading("## Notes\n", "Notes", block)).toBe(`## Notes\n\n${block}\n`);
  });

  it("appends at the end of the section, before the next heading of the same level", () => {
    const content = lines("# Doc", "", "## Alpha", "", "first", "", "## Beta", "", "second", "");
    expect(insertUnderHeading(content, "Alpha", "new line")).toBe(
      lines("# Doc", "", "## Alpha", "", "first", "", "new line", "", "## Beta", "", "second", ""),
    );
  });

  it("goes after deeper subsections and stops at a higher-level heading", () => {
    const content = lines("## Alpha", "intro", "### Deep", "deep text", "# Top", "");
    expect(insertUnderHeading(content, "Alpha", "x")).toBe(lines("## Alpha", "intro", "### Deep", "deep text", "", "x", "", "# Top", ""));
  });

  it("matches the heading case-insensitively, trimmed, at any level", () => {
    const content = lines("# Doc", "### global token", "a", "### Other", "");
    expect(insertUnderHeading(content, "  Global Token ", "b")).toBe(lines("# Doc", "### global token", "a", "", "b", "", "### Other", ""));
    expect(insertUnderHeading(lines("## Global   token", ""), "global token", "c")).toBe(lines("## Global   token", "", "c", ""));
  });

  it("uses the first matching heading when several match", () => {
    const content = lines("## Notes", "one", "## Notes", "two", "");
    expect(insertUnderHeading(content, "notes", "x")).toBe(lines("## Notes", "one", "", "x", "", "## Notes", "two", ""));
  });

  it("appends at the end of the file with exactly one blank line before and one newline after", () => {
    expect(insertUnderHeading(lines("## Alpha", "", "first", "", "", ""), "Alpha", "x")).toBe(lines("## Alpha", "", "first", "", "x", ""));
    expect(insertUnderHeading("## Alpha\nfirst", "Alpha", "x")).toBe(lines("## Alpha", "first", "", "x", ""));
    expect(insertUnderHeading("## Alpha", "Alpha", "x")).toBe(lines("## Alpha", "", "x", ""));
  });

  it("normalizes blank lines between the block and the next heading", () => {
    const content = lines("## A", "a", "", "", "", "## B", "b");
    expect(insertUnderHeading(content, "A", "x")).toBe(lines("## A", "a", "", "x", "", "## B", "b"));
  });

  it("puts Unsorted text under a horizontal line at the end of the file", () => {
    const expected = lines("# Doc", "", "text", "", "---", "", "<!-- wiki:unsorted -->", "", "x", "");
    expect(insertUnderHeading(lines("# Doc", "", "text", ""), "Unsorted", "x")).toBe(expected);
    expect(insertUnderHeading(lines("# Doc", "", "text"), "Unsorted", "x")).toBe(expected);
    expect(insertUnderHeading(lines("# Doc", "", "text", "", "", ""), "Unsorted", "x")).toBe(expected);
  });

  it("creates the heading in an empty doc or a frontmatter-only doc", () => {
    expect(insertUnderHeading("", "Unsorted", "x")).toBe(lines("---", "", "<!-- wiki:unsorted -->", "", "x", ""));
    expect(insertUnderHeading("---\ntitle: T\n---\n", "Notes", "x")).toBe(lines("---", "title: T", "---", "", "## Notes", "", "x", ""));
    expect(insertUnderHeading("---\ntitle: T\n---", "Notes", "x")).toBe(lines("---", "title: T", "---", "", "## Notes", "", "x", ""));
    expect(insertUnderHeading("---\ntitle: T\n---\n\n\n", "Notes", "x")).toBe(lines("---", "title: T", "---", "", "## Notes", "", "x", ""));
  });

  it("defaults a blank heading to Unsorted and collapses whitespace in new headings", () => {
    expect(insertUnderHeading("# Doc\n", "   ", "x")).toBe(lines("# Doc", "", "---", "", "<!-- wiki:unsorted -->", "", "x", ""));
    expect(insertUnderHeading("# Doc\n", " Global\n token ", "x")).toBe(lines("# Doc", "", "## Global token", "", "x", ""));
  });

  it("never matches headings inside code fences", () => {
    const content = lines("# Doc", "```", "## Notes", "```", "");
    expect(insertUnderHeading(content, "Notes", "x")).toBe(lines("# Doc", "```", "## Notes", "```", "", "## Notes", "", "x", ""));
  });

  it("never touches or matches inside the frontmatter", () => {
    const frontmatter = "---\n# Notes\ntitle:    Spaced    \naliases: [ a ,b ]\n---\n";
    const result = insertUnderHeading(`${frontmatter}\n# T\n`, "Notes", "x");
    expect(result).toBe(`${frontmatter}\n# T\n\n## Notes\n\nx\n`);
  });

  it("keeps existing text before and after the insertion point unchanged", () => {
    const head = "---\ntitle: T\n---\n\n# T\n\n## A\n\n- keep  \n  trailing spaces\n";
    const tail = "## B\n\n<!-- wiki:source manual added=\"2026-10-15\" -->\nold\n";
    const result = insertUnderHeading(`${head}\n\n${tail}`, "A", "new");
    expect(result).toBe(`${head}\nnew\n\n${tail}`);
  });

  it("trims blank lines around the block but keeps its inner lines verbatim", () => {
    const result = insertUnderHeading("## A\n", "A", "\n\n  - item  \n\n    nested\n\n\n");
    expect(result).toBe("## A\n\n  - item  \n\n    nested\n");
  });

  it("leaves the doc unchanged for a blank block", () => {
    expect(insertUnderHeading("## A\n", "A", " \n\n\t")).toBe("## A\n");
    expect(insertUnderHeading("# Doc\n", "Missing", "")).toBe("# Doc\n");
  });

  it("keeps the doc's CRLF line endings", () => {
    const content = "# Doc\r\n\r\n## A\r\n\r\none\r\n\r\n## B\r\n";
    expect(insertUnderHeading(content, "A", "two\nthree")).toBe("# Doc\r\n\r\n## A\r\n\r\none\r\n\r\ntwo\r\nthree\r\n\r\n## B\r\n");
    expect(insertUnderHeading("# Doc\r\n", "New", "x\r\ny")).toBe("# Doc\r\n\r\n## New\r\n\r\nx\r\ny\r\n");
  });

  it("uses LF for a CRLF block in an LF doc", () => {
    expect(insertUnderHeading("## A\n", "A", "one\r\ntwo")).toBe("## A\n\none\ntwo\n");
  });

  it("closes an unclosed fence in the block so later headings stay headings", () => {
    const result = insertUnderHeading("## A\n\n## B\n", "A", "```sh\nls -la");
    expect(result).toBe("## A\n\n```sh\nls -la\n```\n\n## B\n");
    expect(listHeadings(result)).toEqual(["A", "B"]);
  });

  it("closes an unclosed fence at the end of the doc before appending", () => {
    expect(insertUnderHeading("## Code\n\n~~~~js\nconst a = 1;\n", "Code", "after")).toBe(
      "## Code\n\n~~~~js\nconst a = 1;\n~~~~\n\nafter\n",
    );
    const missing = insertUnderHeading("text\n```\ncode\n## Fake\n", "Fake", "x");
    expect(missing).toBe("text\n```\ncode\n## Fake\n```\n\n## Fake\n\nx\n");
    expect(listHeadings(missing)).toEqual(["Fake"]);
  });

  it("accumulates repeated appends in order", () => {
    let content = lines("# Doc", "", "## Notes", "", "## Later", "");
    content = insertUnderHeading(content, "Notes", "one");
    content = insertUnderHeading(content, "Notes", "two");
    expect(content).toBe(lines("# Doc", "", "## Notes", "", "one", "", "two", "", "## Later", ""));
  });

  it("builds a new doc from the template and the first block", () => {
    const content = newDocContent({ title: "Adding config catalog", type: "process", aliases: ["config-catalog", "@CC"] });
    expect(insertUnderHeading(content, "Notes", "- first fact")).toBe(
      lines(
        "---",
        "title: Adding config catalog",
        "type: process",
        "aliases: [config-catalog, cc]",
        "---",
        "",
        "# Adding config catalog",
        "",
        "## Notes",
        "",
        "- first fact",
        "",
      ),
    );
  });

  it("treats invalid frontmatter-looking text as body", () => {
    const content = "---\ntitle: [\n---\n";
    expect(insertUnderHeading(content, "Notes", "x")).toBe("---\ntitle: [\n---\n\n## Notes\n\nx\n");
  });

  it("keeps trailing spaces on the existing line before the insertion point", () => {
    expect(insertUnderHeading("## A\nfirst  \n\n\n## B\n", "A", "x")).toBe("## A\nfirst  \n\nx\n\n## B\n");
    expect(insertUnderHeading("## A\r\nfirst\t\r\n\r\n## B\r\n", "A", "x")).toBe("## A\r\nfirst\t\r\n\r\nx\r\n\r\n## B\r\n");
    expect(insertUnderHeading("## A\nfirst  \n  \n", "A", "x")).toBe("## A\nfirst  \n\nx\n");
    expect(insertUnderHeading("# Doc\nlast  ", "New", "x")).toBe("# Doc\nlast  \n\n## New\n\nx\n");
    expect(insertUnderHeading("## A\n```\ncode  \n", "A", "x")).toBe("## A\n```\ncode  \n```\n\nx\n");
  });

  it("treats a whitespace-only body as empty", () => {
    expect(insertUnderHeading("  \n\t\n", "Notes", "x")).toBe("## Notes\n\nx\n");
  });

  it("reuses a created heading whose text loses a closing # when parsed", () => {
    let content = "# Doc\n";
    content = insertUnderHeading(content, "Issue #", "one");
    content = insertUnderHeading(content, "Issue #", "two");
    content = insertUnderHeading(content, "issue", "three");
    expect(content).toBe("# Doc\n\n## Issue #\n\none\n\ntwo\n\nthree\n");
    expect(splitSections(content).map((section) => section.heading)).toEqual(["Doc", "Issue"]);
  });

  it("only ever adds lines, never edits or drops existing ones", () => {
    const docs = [
      "",
      "# Doc\n",
      "---\ntitle: T\naliases: [a]\n---\n\n# T\n\n## Notes\n\n- keep  \n  - nested\n\n## Later\n\ntext\\\n",
      "---\r\ntitle: T\r\n---\r\n# T\r\n\r\n## Notes\r\nold\t\r\n",
      "intro\n\n## Notes\n\n```js\nconst a = 1;  \n## Not a heading\n",
      "## notes\n\n\n\n### Deep\n\ndeep  \n\n# Top\n\n<!-- wiki:source manual added=\"2026-10-15\" -->\nkept\n",
      "﻿# Bom\n\nbody   ",
    ];
    const headings = ["Notes", "Missing", "Deep", "Top"];
    const blocks = ["- new fact", "line one\n\n  line two  ", "```sh\nls"];
    const nonBlank = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");
    const headingCount = (text: string) => splitSections(parseDoc(text, "x").body).filter((section) => section.level > 0).length;
    const isSubsequence = (small: readonly string[], big: readonly string[]) => {
      let index = 0;
      for (const line of big) if (line === small[index]) index += 1;
      return index === small.length;
    };
    for (const doc of docs) {
      for (const heading of headings) {
        for (const block of blocks) {
          const result = insertUnderHeading(doc, heading, block);
          expect(parseDoc(result, "x").frontmatter).toBe(parseDoc(doc, "x").frontmatter);
          expect(isSubsequence(nonBlank(doc), nonBlank(result))).toBe(true);
          expect(isSubsequence(nonBlank(block), nonBlank(result))).toBe(true);
          const added = nonBlank(result).length - nonBlank(doc).length - nonBlank(block).length;
          expect(added).toBeGreaterThanOrEqual(0);
          expect(added).toBeLessThanOrEqual(3);
          expect(headingCount(insertUnderHeading(result, heading, "again"))).toBe(headingCount(result));
        }
      }
    }
  });
});

describe("addAlias", () => {
  it("appends to a flow list and keeps every other byte", () => {
    const content = "---\ntitle:   Spaced   # keep\ntype: process\naliases: [config-catalog] # trailing\n---\n\nbody\n";
    expect(addAlias(content, "@CC")).toBe(
      "---\ntitle:   Spaced   # keep\ntype: process\naliases: [config-catalog, cc] # trailing\n---\n\nbody\n",
    );
  });

  it("rewrites a block list as a flow list in place", () => {
    const content = "---\naliases:\n  - one\n  - Two Words\ntitle: T\n---\n# T\n";
    expect(addAlias(content, "three")).toBe("---\naliases: [one, Two Words, three]\ntitle: T\n---\n# T\n");
  });

  it("adds the key at the end when it is missing", () => {
    expect(addAlias("---\ntitle: T\ntype: topic\n---\n# T\n", "cc")).toBe("---\ntitle: T\ntype: topic\naliases: [cc]\n---\n# T\n");
  });

  it("adds the key after a trailing block scalar", () => {
    const result = addAlias("---\nnotes: |\n  line one\n  line two\n---\n", "cc");
    expect(result).toBe("---\nnotes: |\n  line one\n  line two\naliases: [cc]\n---\n");
    expect(parseDoc(result, "x").aliases).toEqual(["cc"]);
  });

  it("fills an empty aliases value", () => {
    const result = addAlias("---\naliases:\ntitle: T\n---\n", "cc");
    expect(result).toBe("---\naliases: [cc]\ntitle: T\n---\n");
  });

  it("turns a comma-separated string into a list", () => {
    expect(addAlias("---\naliases: cc, Config Catalog\n---\n", "x")).toBe("---\naliases: [cc, Config Catalog, x]\n---\n");
  });

  it("is a no-op when the normalized alias is already present", () => {
    const content = "---\naliases: [Config Catalog, cc]\n---\n";
    expect(addAlias(content, "config-catalog")).toBe(content);
    expect(addAlias(content, "@CC")).toBe(content);
  });

  it("is a no-op for an alias with no usable characters", () => {
    expect(addAlias("# Doc\n", "@")).toBe("# Doc\n");
    expect(addAlias("# Doc\n", "!!!")).toBe("# Doc\n");
  });

  it("creates minimal frontmatter when there is none", () => {
    const result = addAlias("# Title\n\ntext\n", "Config Catalog");
    expect(result).toBe("---\naliases: [config-catalog]\n---\n\n# Title\n\ntext\n");
    expect(parseDoc(result, "x")).toMatchObject({ title: "Title", aliases: ["config-catalog"] });
    expect(addAlias("", "cc")).toBe("---\naliases: [cc]\n---\n");
    expect(addAlias("\n# T\n", "cc")).toBe("---\naliases: [cc]\n---\n\n# T\n");
  });

  it("keeps a BOM first", () => {
    expect(addAlias("\uFEFF# T\n", "cc")).toBe("\uFEFF---\naliases: [cc]\n---\n\n# T\n");
    expect(addAlias("\uFEFF---\ntitle: T\n---\n", "cc")).toBe("\uFEFF---\ntitle: T\naliases: [cc]\n---\n");
  });

  it("keeps CRLF line endings", () => {
    expect(addAlias("---\r\ntitle: T\r\n---\r\nbody\r\n", "cc")).toBe("---\r\ntitle: T\r\naliases: [cc]\r\n---\r\nbody\r\n");
    expect(addAlias("# T\r\n", "cc")).toBe("---\r\naliases: [cc]\r\n---\r\n\r\n# T\r\n");
  });

  it("keeps a ... closing fence", () => {
    expect(addAlias("---\ntitle: T\n...\nbody\n", "cc")).toBe("---\ntitle: T\naliases: [cc]\n...\nbody\n");
  });

  it("quotes existing aliases that need it so the YAML stays valid", () => {
    const result = addAlias('---\naliases: ["Q4: plan", "true", "1e5"]\n---\n', "x");
    expect(parseDoc(result, "x").aliases).toEqual(["q4-plan", "true", "1e5", "x"]);
  });

  it("falls back to re-serializing a flow-mapping frontmatter", () => {
    const result = addAlias("---\n{title: Flow, type: process}\n---\n# Body\n", "cc");
    expect(parseDoc(result, "x")).toMatchObject({ title: "Flow", type: "process", aliases: ["cc"] });
    expect(result.endsWith("---\n# Body\n")).toBe(true);
  });

  it("keeps comments and other keys in order", () => {
    const content = "---\n# heading comment\ntitle: T\naliases: [a]\n# between\ntype: topic\n---\n";
    expect(addAlias(content, "b")).toBe("---\n# heading comment\ntitle: T\naliases: [a, b]\n# between\ntype: topic\n---\n");
  });

  it("keeps YAML anchors on the aliases list valid", () => {
    const result = addAlias("---\naliases: &shared [a]\nrelated: *shared\ntitle: T\n---\n", "b");
    expect(parseDoc(result, "x")).toMatchObject({ title: "T", aliases: ["a", "b"] });
  });

  it("falls back to re-serializing instead of throwing on self-referencing YAML", () => {
    const content = "---\nself: &a\n  child: *a\ntitle: T\n---\nbody\n";
    const result = addAlias(content, "cc");
    expect(parseDoc(result, "x")).toMatchObject({ title: "T", aliases: ["cc"], body: "body\n" });
  });

  it("keeps the body, title, and type across many frontmatter shapes", () => {
    const docs = [
      "---\ntitle: T\ntype: process\n---\n\n# T\n\nbody  \n",
      "---\naliases: [a, b]\ntitle: T\n---\nbody",
      "---\naliases:\n  - a # first\n  - b\ntype: project\n---\n\nbody\n",
      "---\naliases: a, b\n---\n",
      "---\n  title: Indented\n  type: topic\n---\nbody\n",
      "---\nnote: |+\n  keep\n\ntitle: T\n---\nbody\n",
      "---\r\ntitle: T\r\naliases: [x]\r\n---\r\nbody\r\n",
      "---\n{title: Flow}\n---\nbody\n",
      "---\naliases: &list [a]\nother: *list\n---\nbody\n",
      "---\n# only a comment\n---\nbody\n",
    ];
    for (const doc of docs) {
      const before = parseDoc(doc, "x");
      const after = parseDoc(addAlias(doc, "New Alias"), "x");
      expect(after.body).toBe(before.body);
      expect(after.title).toBe(before.title);
      expect(after.type).toBe(before.type);
      expect(after.aliases).toEqual([...before.aliases, "new-alias"]);
      expect(addAlias(addAlias(doc, "New Alias"), "@new-alias")).toBe(addAlias(doc, "New Alias"));
    }
  });

  it("puts new frontmatter above text that only looks like frontmatter", () => {
    const content = "---\ntitle: [\n---\nbody\n";
    const result = addAlias(content, "cc");
    expect(result).toBe(`---\naliases: [cc]\n---\n\n${content}`);
    expect(parseDoc(result, "x").aliases).toEqual(["cc"]);
  });
});

describe("newDocContent", () => {
  it("renders the SPEC template", () => {
    expect(newDocContent({ title: "Unified notification", type: "project", aliases: [] })).toBe(
      "---\ntitle: Unified notification\ntype: project\naliases: []\n---\n\n# Unified notification\n",
    );
  });

  it("quotes titles that are not plain YAML strings", () => {
    for (const title of ["Q4: plan", "2026", "true", "#hash", "[x]", 'He said "hi"']) {
      expect(parseDoc(newDocContent({ title, type: "topic", aliases: [] }), "x").meta.title).toBe(title);
    }
  });

  it("normalizes aliases and collapses whitespace in the title", () => {
    const content = newDocContent({ title: "  Two\n  lines ", type: "topic", aliases: ["@CC", "cc", "Config Catalog"] });
    expect(content).toBe("---\ntitle: Two lines\ntype: topic\naliases: [cc, config-catalog]\n---\n\n# Two lines\n");
  });

  it("falls back to Untitled for a blank title", () => {
    expect(parseDoc(newDocContent({ title: "  ", type: "topic", aliases: [] }), "x").title).toBe("Untitled");
  });
});

describe("source markers", () => {
  const notes: SourceMarker = {
    kind: "notes",
    notePath: "Time/oct2026/10-14-26.md",
    noteDate: "2026-10-14",
    added: "2026-10-15",
  };

  it("formats every kind as in the SPEC", () => {
    expect(formatSourceMarker(notes)).toBe(
      '<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->',
    );
    expect(formatSourceMarker({ kind: "thread", threadId: "thr_abc", title: "Thread title", added: "2026-10-15" })).toBe(
      '<!-- wiki:source thread="thr_abc" title="Thread title" added="2026-10-15" -->',
    );
    expect(formatSourceMarker({ kind: "thread", threadId: "thr_abc", title: null, added: "2026-10-15" })).toBe(
      '<!-- wiki:source thread="thr_abc" added="2026-10-15" -->',
    );
    expect(formatSourceMarker({ kind: "upload", name: "name.mp4", added: "2026-10-15" })).toBe(
      '<!-- wiki:source upload="name.mp4" added="2026-10-15" -->',
    );
    expect(formatSourceMarker({ kind: "manual", added: "2026-10-15" })).toBe('<!-- wiki:source manual added="2026-10-15" -->');
    expect(formatSourceMarker({ kind: "agent", threadId: "thr_x", title: "T", added: "2026-10-15" })).toBe(
      '<!-- wiki:source agent thread="thr_x" title="T" added="2026-10-15" -->',
    );
  });

  it("escapes titles so they cannot break out of the comment", () => {
    const source: SourceMarker = {
      kind: "thread",
      threadId: "thr_1",
      title: 'He said "hi" --> <b>&amp;</b>\nnext --!>',
      added: "2026-10-15",
    };
    const marker = formatSourceMarker(source);
    expect(marker.indexOf("-->")).toBe(marker.length - 3);
    expect(marker).not.toContain("\n");
    expect(marker.slice(marker.indexOf('title="') + 7, marker.indexOf('" added'))).not.toContain('"');
    expect(parseSourceMarkers(marker)).toEqual([{ line: 0, source }]);
    expect(stripSourceMarkers(`a\n${marker}\nb`)).toBe("a\nb");
  });

  it("round-trips every kind", () => {
    const sources: SourceMarker[] = [
      notes,
      { kind: "thread", threadId: "thr_abc", title: "Ünïcode “quotes” & more", added: "2026-10-15" },
      { kind: "thread", threadId: "thr_abc", title: null, added: "2026-10-15" },
      { kind: "agent", threadId: "thr_x", title: null, added: "2026-10-15" },
      { kind: "upload", name: 'odd "name".mp4', added: "2026-10-15" },
      { kind: "manual", added: "2026-10-15" },
    ];
    const content = sources.map(formatSourceMarker).join("\n");
    expect(parseSourceMarkers(content).map((entry) => entry.source)).toEqual(sources);
  });

  it("finds markers on their own lines, outside code and frontmatter", () => {
    const content = lines(
      "---",
      "note: |",
      '  <!-- wiki:source manual added="fm" -->',
      "---",
      "# T",
      '<!-- wiki:source manual added="2026-10-15" -->',
      "Text",
      "```",
      '<!-- wiki:source manual added="code" -->',
      "```",
      '  <!-- wiki:source upload="a.mp4" added="2026-10-15" -->   ',
      'inline <!-- wiki:source manual added="inline" --> text',
      '<!-- wiki:source thread="" added="empty" -->',
      '<!-- wiki:source mystery added="unknown" -->',
      '<!-- wiki:sourcery manual added="prefix" -->',
      "",
    );
    expect(parseSourceMarkers(content)).toEqual([
      { line: 5, source: { kind: "manual", added: "2026-10-15" } },
      { line: 10, source: { kind: "upload", name: "a.mp4", added: "2026-10-15" } },
    ]);
  });

  it("counts lines the same way with CRLF", () => {
    const content = '# T\r\n\r\n<!-- wiki:source manual added="2026-10-15" -->\r\nx\r\n';
    expect(parseSourceMarkers(content)).toEqual([{ line: 2, source: { kind: "manual", added: "2026-10-15" } }]);
  });

  it("tolerates hand-written markers without an added date", () => {
    expect(parseSourceMarkers("<!--wiki:source manual-->")).toEqual([{ line: 0, source: { kind: "manual", added: "" } }]);
    expect(parseSourceMarkers('<!-- wiki:source notes="10-14-26.md" -->')).toEqual([
      { line: 0, source: { kind: "notes", notePath: "10-14-26.md", noteDate: "", added: "" } },
    ]);
  });

  it("prefers notes, then agent, then thread when several kinds appear", () => {
    expect(parseSourceMarkers('<!-- wiki:source thread="t" agent added="a" -->')[0]?.source).toEqual({
      kind: "agent",
      threadId: "t",
      title: null,
      added: "a",
    });
  });
});

describe("stripSourceMarkers", () => {
  const marker = formatSourceMarker({ kind: "manual", added: "2026-10-15" });

  it("removes marker lines with their line break", () => {
    expect(stripSourceMarkers(`a\n${marker}\nb`)).toBe("a\nb");
    expect(stripSourceMarkers(`${marker}\r\nb`)).toBe("b");
    expect(stripSourceMarkers(`a\n  ${marker}`)).toBe("a\n");
  });

  it("removes inline markers", () => {
    expect(stripSourceMarkers(`a ${marker} b`)).toBe("a  b");
  });

  it("removes inline markers only within one line and only for the exact keyword", () => {
    expect(stripSourceMarkers("a <!-- wiki:source x\nb --> c")).toBe("a <!-- wiki:source x\nb --> c");
    expect(stripSourceMarkers("a<!--wiki:source-->b<!-- wiki:sourcex -->c<!--\twiki:source <!-- y -->d")).toBe(
      "ab<!-- wiki:sourcex -->cd",
    );
  });

  it("removes marker fragments cut off at snippet edges", () => {
    expect(stripSourceMarkers('…ce notes="Time/x.md" date="2026-10-14" added="2026-10-15" -->\nGlobal token')).toBe(
      "…Global token",
    );
    expect(stripSourceMarkers('…15" -->\nnext')).toBe("…next");
    expect(stripSourceMarkers('Global token\n<!-- wiki:source notes="Ti…')).toBe("Global token…");
    expect(stripSourceMarkers("Global token <!-- wiki…")).toBe("Global token…");
  });

  it("leaves other comments and arrows alone", () => {
    expect(stripSourceMarkers("A --> B")).toBe("A --> B");
    expect(stripSourceMarkers("<!-- todo: later -->")).toBe("<!-- todo: later -->");
    expect(stripSourceMarkers("x <!-- todo…")).toBe("x <!-- todo…");
    expect(stripSourceMarkers('say "go" --> now')).toBe('say "go" --> now');
  });

  it("leaves arrows and quotes alone after a leading snippet ellipsis", () => {
    for (const text of ['…he said "go" --> now', "…click Settings --> Plugins", '…A["Start"] --> B["End"]', "…a --> b"]) {
      expect(stripSourceMarkers(text)).toBe(text);
    }
  });

  it("removes leading fragments cut inside a value, at a quote, or inside the keyword", () => {
    expect(stripSourceMarkers('…ad title" added="2026-10-15" -->\nnext')).toBe("…next");
    expect(stripSourceMarkers('…"2026-10-15" -->\nnext')).toBe("…next");
    expect(stripSourceMarkers('…-- wiki:source manual added="2026-10-15" -->\nnext')).toBe("…next");
    expect(stripSourceMarkers('…ded="2026-10-15" -->next')).toBe("…next");
  });
});

describe("describeSourceMarker", () => {
  it("labels each kind", () => {
    expect(
      describeSourceMarker({ kind: "notes", notePath: "Time/10-14-26.md", noteDate: "2026-10-14", added: "2026-10-15" }),
    ).toBe("from 10-14-26 notes");
    expect(describeSourceMarker({ kind: "thread", threadId: "t", title: "Title", added: "" })).toBe("from thread “Title”");
    expect(describeSourceMarker({ kind: "thread", threadId: "t", title: null, added: "" })).toBe("from a thread");
    expect(describeSourceMarker({ kind: "agent", threadId: "t", title: "Fix it", added: "" })).toBe("from agent in “Fix it”");
    expect(describeSourceMarker({ kind: "agent", threadId: "t", title: null, added: "" })).toBe("from an agent");
    expect(describeSourceMarker({ kind: "upload", name: "name.mp4", added: "" })).toBe("uploaded name.mp4");
    expect(describeSourceMarker({ kind: "manual", added: "" })).toBe("added manually");
  });

  it("falls back to the note file name when the date is not ISO", () => {
    expect(describeSourceMarker({ kind: "notes", notePath: "Time/10-14-26.md", noteDate: "", added: "" })).toBe(
      "from 10-14-26 notes",
    );
  });

  it("shortens long and multi-line titles", () => {
    const label = describeSourceMarker({ kind: "thread", threadId: "t", title: `${"word ".repeat(30)}\nend`, added: "" });
    expect(label.length).toBeLessThan(80);
    expect(label).not.toContain("\n");
    expect(label.endsWith("…”")).toBe(true);
  });
});

describe("extractWikiLinks", () => {
  it("parses every link form with positions", () => {
    const text = "See [[Unified notification]] and [[adding-config-catalog#Global token|the token]].\n![[diagram.png]] [[ Spaced | Label ]]";
    expect(extractWikiLinks(text)).toEqual([
      {
        raw: "[[Unified notification]]",
        target: "Unified notification",
        heading: null,
        label: null,
        embed: false,
        index: 4,
      },
      {
        raw: "[[adding-config-catalog#Global token|the token]]",
        target: "adding-config-catalog",
        heading: "Global token",
        label: "the token",
        embed: false,
        index: text.indexOf("[[adding"),
      },
      { raw: "![[diagram.png]]", target: "diagram.png", heading: null, label: null, embed: true, index: text.indexOf("![[") },
      { raw: "[[ Spaced | Label ]]", target: "Spaced", heading: null, label: "Label", embed: false, index: text.indexOf("[[ Spaced") },
    ]);
  });

  it("ignores links in fenced code, inline code, and HTML comments", () => {
    const text = lines(
      "`[[inline]]` ``a `[[double]]` b``",
      "```",
      "[[fenced]]",
      "```",
      "~~~",
      "[[tilde]]",
      "~~~",
      "<!-- [[commented]] -->",
      formatSourceMarker({ kind: "thread", threadId: "t", title: "about [[Doc]]", added: "" }),
      "[[Real]]",
    );
    expect(extractWikiLinks(text).map((link) => link.target)).toEqual(["Real"]);
  });

  it("keeps inline code within one line, pairs runs of equal length, and leaves an unclosed comment visible", () => {
    const text = lines("`a\r[[One]]` `` [[Two]] `` `x` [[Three]] ``` [[Four]]", "<!-- [[Hidden]]", "[[Also]] -->[[Shown]]<!-- [[Open]]");
    expect(extractWikiLinks(text).map((link) => link.target)).toEqual(["One", "Three", "Four", "Shown", "Open"]);
  });

  it("ignores links after an unclosed fence", () => {
    expect(extractWikiLinks("[[Before]]\n```\n[[After]]")).toHaveLength(1);
  });

  it("handles escaped pipes in tables, headings with empty parts, and empty targets", () => {
    expect(extractWikiLinks("| [[Table\\|alias]] |")[0]).toMatchObject({ target: "Table", label: "alias" });
    expect(extractWikiLinks("[[Doc#]] [[Doc|]]").map((link) => [link.heading, link.label])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(extractWikiLinks("[[#Only heading]] [[ ]] [[|label]]")).toEqual([]);
  });

  it("does not cross lines or nest brackets", () => {
    expect(extractWikiLinks("[[a\nb]]")).toEqual([]);
    expect(extractWikiLinks("[[[x]]]").map((link) => link.raw)).toEqual(["[[x]]"]);
  });

  it("keeps everything after the first # as the heading", () => {
    expect(extractWikiLinks("[[Doc#Part#Sub]]")[0]).toMatchObject({ target: "Doc", heading: "Part#Sub" });
  });
});

describe("image targets", () => {
  const text = lines(
    "![Shot](<images/shot 1.png>)",
    '![](./pic.png "Title")',
    "![alt [nested]](img(1).png)",
    "![[clip.mp4|300]]",
    "![[Some Doc]]",
    "![remote](https://cdn.local/a.png)",
    "![data](data:image/png;base64,AAAA)",
    "[link](not-image.png)",
    "`![](code.png)`",
    "```",
    "![](fenced.png)",
    "```",
    "![](my%20pic.png)",
    "![](./pic.png)",
    "![[ spaced.png ]]",
  );

  it("extracts local image and video targets once each, in order", () => {
    expect(extractImageTargets(text)).toEqual(["images/shot 1.png", "./pic.png", "img(1).png", "clip.mp4", "my pic.png", "spaced.png"]);
  });

  it("rewrites only the URL part of image embeds", () => {
    const map = new Map([
      ["./pic.png", "assets/pic-1234abcd.png"],
      ["images/shot 1.png", "assets/shot 1.png"],
      ["clip.mp4", "assets/clip.mp4"],
      ["my pic.png", "assets/my pic.png"],
      ["spaced.png", "assets/spaced.png"],
    ]);
    const asked: string[] = [];
    const result = rewriteImageTargets(text, (target) => {
      asked.push(target);
      return map.get(target) ?? null;
    });
    expect(result).toBe(
      lines(
        "![Shot](<assets/shot 1.png>)",
        '![](assets/pic-1234abcd.png "Title")',
        "![alt [nested]](img(1).png)",
        "![[assets/clip.mp4|300]]",
        "![[Some Doc]]",
        "![remote](https://cdn.local/a.png)",
        "![data](data:image/png;base64,AAAA)",
        "[link](not-image.png)",
        "`![](code.png)`",
        "```",
        "![](fenced.png)",
        "```",
        "![](<assets/my pic.png>)",
        "![](assets/pic-1234abcd.png)",
        "![[ assets/spaced.png ]]",
      ),
    );
    expect(asked).toEqual(["images/shot 1.png", "./pic.png", "img(1).png", "clip.mp4", "my pic.png", "./pic.png", "spaced.png"]);
  });

  it("returns the text unchanged when nothing maps", () => {
    expect(rewriteImageTargets(text, () => null)).toBe(text);
    expect(rewriteImageTargets("plain prose about pic.png", () => "x")).toBe("plain prose about pic.png");
  });

  it("wraps a new target that has parentheses", () => {
    expect(rewriteImageTargets("![a](b.png)", () => "assets/b (1).png")).toBe("![a](<assets/b (1).png>)");
  });

  it("finds absolute paths and several images on one line", () => {
    expect(extractImageTargets("![a](/Users/me/Notes/a.png) and ![b](b.gif)")).toEqual(["/Users/me/Notes/a.png", "b.gif"]);
  });

  it("never duplicates text when an embed sits inside an image destination", () => {
    expect(rewriteImageTargets("![a](![[x.png]]) tail", () => "assets/y.png")).toBe("![a](assets/y.png) tail");
    expect(rewriteImageTargets("![a](![[x.png]]) tail", (target) => (target === "x.png" ? "assets/x.png" : null))).toBe(
      "![a](![[assets/x.png]]) tail",
    );
  });

  it("keeps a target with an invalid percent escape as written", () => {
    expect(extractImageTargets("![a](100%.png)")).toEqual(["100%.png"]);
  });
});

describe("dedent", () => {
  it("removes the common indentation of non-blank lines", () => {
    expect(dedent(["  - a", "    - b", "", "  c"])).toEqual(["- a", "  - b", "", "c"]);
    expect(dedent(["\t- a", "\t\tb"])).toEqual(["- a", "\tb"]);
  });

  it("only removes indentation that every line shares exactly", () => {
    expect(dedent(["\t- a", "  b"])).toEqual(["\t- a", "  b"]);
    expect(dedent(["a", "  b"])).toEqual(["a", "  b"]);
  });

  it("empties whitespace-only lines and ignores them when measuring", () => {
    expect(dedent(["    a", " ", "    b"])).toEqual(["a", "", "b"]);
    expect(dedent(["   ", ""])).toEqual(["", ""]);
    expect(dedent([])).toEqual([]);
  });
});

describe("trimLineEnds", () => {
  it("drops spaces and tabs before every kind of line break and at the end", () => {
    expect(trimLineEnds("a \t\r\nb  \nc\t\u2028d \u2029e \r f  ")).toBe("a\r\nb\nc\u2028d\u2029e\r f");
  });

  it("keeps leading and inner whitespace and other space characters", () => {
    expect(trimLineEnds("  a  b \n\t")).toBe("  a  b \n");
    expect(trimLineEnds("")).toBe("");
  });
});

describe("renameDocContent", () => {
  const keep = { keepAliases: ["global-token"] };

  it("sets the frontmatter title, renames a matching first H1, and keeps the old name as an alias", () => {
    const content = ["---", "title: Global token", "type: topic", "aliases: [gt]", "---", "", "# Global token", "", "Body text.", ""].join("\n");
    const next = renameDocContent(content, { oldTitle: "Global token", title: "Rate limiting", ...keep });
    expect(next).toBe(["---", "title: Rate limiting", "type: topic", "aliases: [gt, global-token]", "---", "", "# Rate limiting", "", "Body text.", ""].join("\n"));
  });

  it("adds frontmatter when the doc has none and leaves a different H1 alone", () => {
    const content = "# Something else\n\nBody.\n";
    const next = renameDocContent(content, { oldTitle: "Old", title: "New name", ...keep });
    expect(next).toBe("---\ntitle: New name\naliases: [global-token]\n---\n\n# Something else\n\nBody.\n");
  });

  it("does not touch an H1 inside a code fence or later H1s", () => {
    const content = "---\ntitle: Old\n---\n\n```\n# Old\n```\n\n# Old\n\n# Old\n";
    const next = renameDocContent(content, { oldTitle: "Old", title: "New", keepAliases: [] });
    expect(next).toBe("---\ntitle: New\n---\n\n```\n# Old\n```\n\n# New\n\n# Old\n");
  });

  it("keeps CRLF line endings", () => {
    const content = "---\r\ntitle: Old\r\n---\r\n\r\n# Old\r\n";
    const next = renameDocContent(content, { oldTitle: "Old", title: "New", keepAliases: [] });
    expect(next).toBe("---\r\ntitle: New\r\n---\r\n\r\n# New\r\n");
  });
});

describe("service docs", () => {
  it("reads type: service from frontmatter", () => {
    expect(parseDoc("---\ntitle: Notification service\ntype: service\n---\n\n# Notification service\n", "notification-service").type).toBe("service");
  });
});

describe("unsorted line", () => {
  const RULE = ["---", "", "<!-- wiki:unsorted -->"];

  it("keeps adding Unsorted text at the bottom, under the one line", () => {
    const once = insertUnderHeading("# Doc\n\ntext\n", "Unsorted", "- a");
    const twice = insertUnderHeading(once, "unsorted", "- b");
    expect(twice).toBe(lines("# Doc", "", "text", "", ...RULE, "", "- a", "", "- b", ""));
  });

  it("puts text for a real heading above the line, including the last heading and new headings", () => {
    const doc = lines("# Doc", "", "## Setup", "", "first", "", ...RULE, "", "- loose", "");
    expect(insertUnderHeading(doc, "Setup", "second")).toBe(lines("# Doc", "", "## Setup", "", "first", "", "second", "", ...RULE, "", "- loose", ""));
    expect(insertUnderHeading(doc, "Limits", "x")).toBe(lines("# Doc", "", "## Setup", "", "first", "", "## Limits", "", "x", "", ...RULE, "", "- loose", ""));
  });

  it("ignores a plain --- rule and a marker inside a code fence", () => {
    const doc = lines("# Doc", "", "a", "", "---", "", "b", "", "```", "<!-- wiki:unsorted -->", "```", "");
    expect(insertUnderHeading(doc, "Unsorted", "x")).toBe(lines("# Doc", "", "a", "", "---", "", "b", "", "```", "<!-- wiki:unsorted -->", "```", "", ...RULE, "", "x", ""));
  });

  it("indexes text under the line as an Unsorted section and lists no Unsorted heading", () => {
    const doc = lines("# Doc", "", "## Setup", "", "first", "", ...RULE, "", "- loose", "");
    const sections = splitSections(doc);
    expect(sections.map((section) => [section.heading, section.body])).toEqual([
      ["Doc", ""],
      ["Setup", "first"],
      ["Unsorted", "- loose"],
    ]);
    expect(listHeadings(doc)).toEqual(["Doc", "Setup"]);
  });
});

describe("moveUnsortedBelowRule", () => {
  const RULE = ["---", "", "<!-- wiki:unsorted -->"];

  it("moves an Unsorted section below a new line and keeps the other sections above it", () => {
    const doc = lines("---", "title: T", "---", "", "# T", "", "## Unsorted", "", "<!-- wiki:source manual -->", "- loose", "", "## Setup", "", "steps", "");
    expect(moveUnsortedBelowRule(doc)).toBe(lines("---", "title: T", "---", "", "# T", "", "## Setup", "", "steps", "", ...RULE, "", "<!-- wiki:source manual -->", "- loose", ""));
  });

  it("merges several Unsorted sections and an existing line, keeping every line verbatim", () => {
    const doc = lines("# D", "", "## Unsorted", "", "- one", "", "## A", "", "a", "", "### unsorted", "", "- two", "", ...RULE, "", "- zero", "");
    const moved = moveUnsortedBelowRule(doc);
    expect(moved).toBe(lines("# D", "", "## A", "", "a", "", ...RULE, "", "- zero", "", "- one", "", "- two", ""));
    expect(moveUnsortedBelowRule(moved)).toBe(moved);
  });

  it("leaves docs without an Unsorted heading untouched, and keeps code fences intact", () => {
    const plain = lines("# D", "", "## A", "", "a", "");
    expect(moveUnsortedBelowRule(plain)).toBe(plain);
    const fenced = lines("# D", "", "## Unsorted", "", "```", "## not a heading", "```", "");
    expect(moveUnsortedBelowRule(fenced)).toBe(lines("# D", "", ...RULE, "", "```", "## not a heading", "```", ""));
  });
});
