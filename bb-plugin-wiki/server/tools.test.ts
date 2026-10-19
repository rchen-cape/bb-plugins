import { describe, expect, it } from "vitest";
import { MARK_END, MARK_START } from "../lib/wiki";
import { DESCRIPTION_TOOL, ROUTES_TOOL } from "./routing";
import { ADD_TOOL, GET_TOOL, SEARCH_TOOL, plainSnippet, renderSourceMarkers, searchText, toolsFor } from "./tools";

describe("renderSourceMarkers", () => {
  it("turns marker lines into source lines and leaves code alone", () => {
    const text = [
      '<!-- wiki:source thread="thr_1" title="Rate limits" added="2026-10-15" -->',
      "Use a token bucket.",
      "```",
      '<!-- wiki:source manual added="2026-10-15" -->',
      "```",
    ].join("\n");
    expect(renderSourceMarkers(text)).toBe(
      ["(source: from thread “Rate limits”)", "Use a token bucket.", "```", '<!-- wiki:source manual added="2026-10-15" -->', "```"].join("\n"),
    );
  });
});

describe("search text", () => {
  it("marks matches and lists docs before sections", () => {
    expect(plainSnippet(`a ${MARK_START}token${MARK_END}\n b`)).toBe("a **token** b");
    const text = searchText({
      docs: [{ slug: "global-token", title: "Global token", type: "topic", aliases: [], tag: "global-token", updatedAt: "", headings: [], matched: "title" }],
      sections: [{ slug: "global-token", title: "Global token", type: "topic", heading: "", headingPath: "", anchor: "", snippet: "intro" }],
      total: 1,
    });
    expect(text).toBe(
      ["Docs (slug, type, title):", "global-token\ttopic\tGlobal token", "Sections (slug#anchor, heading, snippet):", "global-token\tGlobal token\tintro"].join("\n"),
    );
    expect(searchText({ docs: [], sections: [], total: 0 })).toBe("No Wiki docs match.");
  });
});

describe("toolsFor", () => {
  it("picks tools from the job metadata", () => {
    expect(toolsFor({ wikiJob: "route", jobId: "job_x" }).tools).toEqual([SEARCH_TOOL, GET_TOOL, ROUTES_TOOL]);
    expect(toolsFor({ wikiJob: "describe" })).toEqual({ tools: [DESCRIPTION_TOOL], skills: [] });
    expect(toolsFor(null)).toEqual({ tools: [SEARCH_TOOL, GET_TOOL, ADD_TOOL], skills: ["wiki"] });
  });
});
