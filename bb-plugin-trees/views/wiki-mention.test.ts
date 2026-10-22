import { describe, expect, it } from "vitest";
import type { WikiDocRef } from "../src/wiki-links";
import { findMentionQuery, insertWikiLink, matchWikiDocs } from "./wiki-mention";

const DOCS: WikiDocRef[] = [
  { slug: "global-token", title: "Global token", type: "topic", tag: "global-token", aliases: ["gt"] },
  { slug: "token-rotation", title: "Token rotation", type: "process", tag: "token-rotation", aliases: [] },
  { slug: "retry-policy", title: "Retry policy", type: "process", tag: "retries", aliases: [] },
];

describe("findMentionQuery", () => {
  it("finds an @ at a line start or after a space, up to the caret", () => {
    expect(findMentionQuery("@glo", 4)).toEqual({ start: 0, query: "glo" });
    expect(findMentionQuery("first\nsee @to", 13)).toEqual({ start: 10, query: "to" });
    expect(findMentionQuery("see @", 5)).toEqual({ start: 4, query: "" });
  });

  it("ignores emails, finished words, and other lines", () => {
    expect(findMentionQuery("me@example", 10)).toBeNull();
    expect(findMentionQuery("@glo done", 9)).toBeNull();
    expect(findMentionQuery("@glo\nnext", 9)).toBeNull();
  });
});

describe("matchWikiDocs", () => {
  it("puts exact names first, then prefixes, then word starts", () => {
    expect(matchWikiDocs(DOCS, "gt").map((doc) => doc.slug)).toEqual(["global-token"]);
    expect(matchWikiDocs(DOCS, "token").map((doc) => doc.slug)).toEqual(["token-rotation", "global-token"]);
    expect(matchWikiDocs(DOCS, "retries").map((doc) => doc.slug)).toEqual(["retry-policy"]);
    expect(matchWikiDocs(DOCS, "zzz")).toEqual([]);
  });

  it("offers every doc for a bare @, up to the limit", () => {
    expect(matchWikiDocs(DOCS, "", 2)).toHaveLength(2);
  });
});

describe("insertWikiLink", () => {
  it("replaces the @query with the link and puts the caret after it", () => {
    const text = "Use @glo now";
    expect(insertWikiLink({ text, caret: 8, mention: { start: 4, query: "glo" }, slug: "global-token" })).toEqual({
      text: "Use [[global-token]] now",
      caret: 21,
    });
  });
});
