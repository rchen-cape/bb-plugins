import { describe, expect, it } from "vitest";
import { anchorForHeading, headingAnchors, headingLineForAnchor, headingLines, headingSlug, parseDoc, splitSections } from "./markdown-doc";

const DOC = [
  "---",
  "title: Runbook",
  "# not a heading: frontmatter",
  "---",
  "",
  "# Runbook",
  "",
  "## Setup",
  "",
  "```md",
  "## Setup",
  "# Fenced",
  "```",
  "",
  "## Setup",
  "",
  "~~~",
  "## Setup",
  "~~~",
  "",
  "## Setup 1",
  "",
  "### Rate limits: `burst` & [[Global token|tokens]]",
  "",
  "## Setup",
].join("\n");

describe("headingAnchors", () => {
  it("numbers repeated headings and skips frontmatter and code fences", () => {
    expect(headingAnchors(DOC)).toEqual([
      { text: "Runbook", level: 1, anchor: "runbook" },
      { text: "Setup", level: 2, anchor: "setup" },
      { text: "Setup", level: 2, anchor: "setup-1" },
      { text: "Setup 1", level: 2, anchor: "setup-1-1" },
      { text: "Rate limits: `burst` & [[Global token|tokens]]", level: 3, anchor: "rate-limits-burst--tokens" },
      { text: "Setup", level: 2, anchor: "setup-2" },
    ]);
  });

  it("gives the same anchors as the sections search indexes", () => {
    const sections = splitSections(parseDoc(DOC, "runbook.md").body).filter((section) => section.heading !== "");
    expect(sections.map((section) => section.anchor)).toEqual(headingAnchors(DOC).map((heading) => heading.anchor));
  });

  it("reads a doc without frontmatter from the first line", () => {
    expect(headingAnchors("# A\n\n# A\n")).toEqual([
      { text: "A", level: 1, anchor: "a" },
      { text: "A", level: 1, anchor: "a-1" },
    ]);
    expect(headingAnchors("")).toEqual([]);
  });
});

describe("anchorForHeading", () => {
  it("returns the anchor of the first heading with that text, counting earlier collisions", () => {
    const headings = ["Setup!", "Setup", "Notes"];
    expect(anchorForHeading(headings, "setup")).toBe("setup-1");
    expect(anchorForHeading(headings, "Setup!")).toBe("setup");
    expect(anchorForHeading(headings, "  NOTES ")).toBe("notes");
  });

  it("falls back to the plain slug for a heading the doc does not have", () => {
    expect(anchorForHeading([], "Global token")).toBe("global-token");
    expect(anchorForHeading(["Other"], "rate-limits")).toBe("rate-limits");
  });
});

describe("headingSlug", () => {
  it("matches rendered heading text to the raw heading", () => {
    expect(headingSlug(" Setup Push ")).toBe(headingSlug("Setup [[Push]]"));
    expect(headingSlug("Rate limits: burst")).toBe(headingSlug("Rate limits: `burst`"));
  });
});

describe("headingLines", () => {
  it("gives each anchor's line in the whole file, counting the frontmatter", () => {
    const lines = DOC.split("\n");
    expect(headingLines(DOC).map(({ anchor, line }) => [anchor, lines[line]])).toEqual([
      ["runbook", "# Runbook"],
      ["setup", "## Setup"],
      ["setup-1", "## Setup"],
      ["setup-1-1", "## Setup 1"],
      ["rate-limits-burst--tokens", "### Rate limits: `burst` & [[Global token|tokens]]"],
      ["setup-2", "## Setup"],
    ]);
    expect(headingLines(DOC).map((heading) => heading.line)).toEqual([5, 7, 14, 20, 22, 24]);
  });

  it("counts lines from the top when there is no frontmatter, also with CRLF and a BOM", () => {
    expect(headingLines("﻿Intro\r\n\r\n## A\r\n").map((heading) => heading.line)).toEqual([2]);
    expect(headingLines("# A")).toEqual([{ text: "A", level: 1, anchor: "a", line: 0 }]);
  });
});

describe("headingLineForAnchor", () => {
  it("finds the line of an anchor, falling back to the heading text", () => {
    expect(headingLineForAnchor(DOC, "setup-2")).toBe(24);
    expect(headingLineForAnchor(DOC, "Setup")).toBe(7);
    expect(headingLineForAnchor(DOC, "missing")).toBeNull();
  });
});
