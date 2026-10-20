import { describe, expect, it } from "vitest";
import type { WikiDoc, WikiSuggestion } from "../contract";
import { docOptions, docScore, headingOptions, matchDocs, wikiCardHref, wikiDocHref } from "./wiki-docs";

function doc(slug: string, title: string, aliases: string[] = [], headings: string[] = [title]): WikiDoc {
  return { slug, title, type: "topic", aliases, tag: slug.replace(/\//g, "-"), headings };
}

const DOCS = [doc("auth", "Auth service", ["login"]), doc("onboarding", "Onboarding project"), doc("tokens", "Rotating tokens", ["secrets"]), doc("ops/runbook", "Ops runbook")];

describe("matchDocs", () => {
  it("ranks title prefix, then alias or tag prefix, then word prefix, then contains", () => {
    expect(matchDocs(DOCS, "auth").map((entry) => entry.slug)).toEqual(["auth"]);
    expect(matchDocs(DOCS, "log").map((entry) => entry.slug)).toEqual(["auth"]);
    expect(matchDocs(DOCS, "tok").map((entry) => entry.slug)).toEqual(["tokens"]);
    expect(matchDocs(DOCS, "o").map((entry) => entry.slug)).toEqual(["onboarding", "ops/runbook", "tokens", "auth"]);
    expect(matchDocs(DOCS, "zzz")).toEqual([]);
  });

  it("matches a doc's tag, with or without a leading @", () => {
    expect(matchDocs(DOCS, "ops-run").map((entry) => entry.slug)).toEqual(["ops/runbook"]);
    expect(matchDocs(DOCS, "@ops-run").map((entry) => entry.slug)).toEqual(["ops/runbook"]);
  });

  it("ignores case and accents, and lists everything by title for an empty query", () => {
    expect(docScore(doc("cafe", "Café notes"), "CAFE")).toBe(0);
    expect(matchDocs(DOCS, " ").map((entry) => entry.title)).toEqual(["Auth service", "Onboarding project", "Ops runbook", "Rotating tokens"]);
  });
});

describe("docOptions", () => {
  const suggestions: WikiSuggestion[] = [{ slug: "tokens", title: "Rotating tokens", heading: "Steps", reason: "Mentions tokens." }];

  it("puts suggestions first, marks the best match, and does not repeat them", () => {
    const options = docOptions(DOCS, suggestions, "");
    expect(options.map((option) => [option.slug, option.best, option.heading])).toEqual([
      ["tokens", true, "Steps"],
      ["auth", false, null],
      ["onboarding", false, null],
      ["ops/runbook", false, null],
    ]);
  });

  it("filters suggestions with the query too", () => {
    expect(docOptions(DOCS, suggestions, "auth").map((option) => option.slug)).toEqual(["auth"]);
    expect(docOptions(DOCS, suggestions, "rot").map((option) => [option.slug, option.best])).toEqual([["tokens", false]]);
  });
});

describe("headingOptions", () => {
  it("lists the doc headings, the preferred heading and Unsorted once each", () => {
    expect(headingOptions(doc("a", "A", [], ["A", "Plans", "unsorted"]), "Plans")).toEqual(["A", "Plans", "unsorted"]);
    expect(headingOptions(undefined, "New one")).toEqual(["New one", "Unsorted"]);
    expect(headingOptions(undefined, null)).toEqual(["Unsorted"]);
  });
});

describe("Wiki links", () => {
  it("builds in-app Wiki routes", () => {
    expect(wikiDocHref("ops/run book")).toBe("/plugins/wiki/wiki/doc/ops/run%20book");
    expect(wikiCardHref("card_00000001")).toBe("/plugins/wiki/wiki/inbox/card_00000001");
  });
});
