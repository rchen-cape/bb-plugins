import { describe, expect, it } from "vitest";
import type { WikiDoc, WikiSuggestion } from "../contract";
import type { WikiChoice } from "./storage";
import {
  destinationFor,
  effectiveKind,
  initialChoice,
  rememberedChoice,
  sendLabel,
  suggestText,
  wikiStatus,
  type WikiStatus,
} from "./wiki-destination";

const DOCS: WikiDoc[] = [
  { slug: "alpha", title: "Alpha", type: "project", aliases: [], tag: "", headings: ["Diagrams"] },
  { slug: "beta", title: "Beta", type: "topic", aliases: [], tag: "", headings: [] },
];
const BETA: WikiSuggestion = { slug: "beta", title: "Beta", heading: "Flows", reason: "mentions flows" };
const NO_CHOICE: WikiChoice = { kind: "inbox", slug: null, heading: null };
const READY: WikiStatus = { kind: "ready", inbox: true, docs: DOCS };

describe("wiki status", () => {
  it("tells loading, failed, unavailable and ready apart", () => {
    expect(wikiStatus({ value: undefined, error: null })).toEqual({ kind: "loading" });
    expect(wikiStatus({ value: undefined, error: "offline" })).toEqual({ kind: "failed", message: "offline" });
    expect(wikiStatus({ value: { wiki: { available: false, reason: "Off." }, docs: [] }, error: null })).toEqual({ kind: "unavailable", reason: "Off." });
    expect(wikiStatus({ value: { wiki: { available: true, inbox: false }, docs: DOCS }, error: "later failure" })).toEqual({ kind: "ready", inbox: false, docs: DOCS });
  });

  it("forces Doc when the Wiki can't take inbox cards", () => {
    expect(effectiveKind("inbox", { kind: "ready", inbox: false, docs: DOCS })).toBe("doc");
    expect(effectiveKind("inbox", READY)).toBe("inbox");
    expect(effectiveKind("inbox", { kind: "loading" })).toBe("inbox");
    expect(effectiveKind("doc", READY)).toBe("doc");
  });
});

describe("initial doc choice", () => {
  const settled = { list: [BETA], settled: true };

  it("waits for the docs, then prefers the remembered doc over suggestions", () => {
    const stored: WikiChoice = { kind: "doc", slug: "alpha", heading: "Diagrams" };
    expect(initialChoice({ docs: undefined, docsSettled: false, stored, suggestions: settled })).toBeUndefined();
    expect(initialChoice({ docs: DOCS, docsSettled: true, stored, suggestions: { list: [], settled: false } })).toEqual({ slug: "alpha", title: "Alpha", heading: "Diagrams" });
  });

  it("takes the first suggestion once suggestions have arrived", () => {
    expect(initialChoice({ docs: DOCS, docsSettled: true, stored: NO_CHOICE, suggestions: { list: [BETA], settled: false } })).toBeUndefined();
    expect(initialChoice({ docs: DOCS, docsSettled: true, stored: NO_CHOICE, suggestions: settled })).toEqual({ slug: "beta", title: "Beta", heading: "Flows" });
    expect(initialChoice({ docs: DOCS, docsSettled: true, stored: NO_CHOICE, suggestions: { list: [], settled: true } })).toBeNull();
    expect(initialChoice({ docs: undefined, docsSettled: true, stored: NO_CHOICE, suggestions: { list: [], settled: true } })).toBeNull();
  });

  it("ignores a remembered doc that no longer exists", () => {
    const stored: WikiChoice = { kind: "doc", slug: "gone", heading: null };
    expect(initialChoice({ docs: DOCS, docsSettled: true, stored, suggestions: settled })?.slug).toBe("beta");
  });
});

describe("destination", () => {
  const choice = { slug: "alpha", title: "Alpha", heading: null };

  it("needs a doc and a heading for Doc", () => {
    expect(destinationFor("inbox", null, "")).toEqual({ kind: "inbox" });
    expect(destinationFor("doc", null, "Unsorted")).toBeNull();
    expect(destinationFor("doc", choice, "")).toBeNull();
    expect(destinationFor("doc", choice, "Diagrams")).toEqual({ kind: "doc", slug: "alpha", heading: "Diagrams" });
  });

  it("labels the send button", () => {
    expect(sendLabel("inbox", null, false)).toBe("Send to inbox");
    expect(sendLabel("doc", null, false)).toBe("Add to doc");
    expect(sendLabel("doc", choice, false)).toBe("Add to Alpha");
    expect(sendLabel("doc", choice, true)).toBe("Sending…");
  });

  it("remembers the doc and heading, or keeps them when sending to the inbox", () => {
    const stored: WikiChoice = { kind: "doc", slug: "alpha", heading: "Diagrams" };
    expect(rememberedChoice({ kind: "inbox" }, stored)).toEqual({ kind: "inbox", slug: "alpha", heading: "Diagrams" });
    expect(rememberedChoice({ kind: "doc", slug: "beta", heading: "Flows" }, stored)).toEqual({ kind: "doc", slug: "beta", heading: "Flows" });
  });

  it("builds the suggestion text from the caption and note", () => {
    expect(suggestText("Login", "  ")).toBe("Login");
    expect(suggestText("Login", "Uses gRPC")).toBe("Login\n\nUses gRPC");
  });
});
