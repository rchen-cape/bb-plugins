import { describe, expect, it } from "vitest";
import {
  attachedWikiDocsNote,
  linkedWikiRefs,
  resolveWikiTarget,
  wikiLinkTargets,
  withWikiDocs,
  type WikiDocRef,
} from "./wiki-links";

const DOCS: WikiDocRef[] = [
  {
    slug: "global-token",
    title: "Global token",
    type: "topic",
    tag: "global-token",
    aliases: ["gt"],
  },
  {
    slug: "retry-policy",
    title: "Retry policy",
    type: "process",
    tag: "retries",
    aliases: [],
  },
];

describe("wikiLinkTargets", () => {
  it("reads targets once each, without headings, labels, or embeds", () => {
    const text = [
      "See [[global-token]] and [[Retry policy#Backoff|backoff]].",
      "Again [[Global-Token]], and ![[diagram.png]] is an image.",
      "```",
      "[[in-code]]",
      "```",
    ].join("\n");
    expect(wikiLinkTargets(text)).toEqual(["global-token", "Retry policy"]);
  });
});

describe("resolveWikiTarget", () => {
  it("matches slug, then title, then alias, then tag", () => {
    expect(resolveWikiTarget(DOCS, "GLOBAL-TOKEN")?.slug).toBe("global-token");
    expect(resolveWikiTarget(DOCS, "retry policy")?.slug).toBe("retry-policy");
    expect(resolveWikiTarget(DOCS, "gt")?.slug).toBe("global-token");
    expect(resolveWikiTarget(DOCS, "@retries")?.slug).toBe("retry-policy");
    expect(resolveWikiTarget(DOCS, "nothing")).toBeNull();
  });

  it("drops unknown links and repeats of one doc", () => {
    expect(
      linkedWikiRefs(DOCS, "[[gt]] [[global-token]] [[missing]] [[retries]]").map(
        (doc) => doc.slug,
      ),
    ).toEqual(["global-token", "retry-policy"]);
  });
});

describe("withWikiDocs", () => {
  it("adds each linked doc after the note", () => {
    const text = withWikiDocs("# Plan\n\nUse [[gt]].\n", [
      { slug: "global-token", title: "Global token", content: "Refill 10/s.\n" },
    ]);
    expect(text).toBe(
      [
        "# Plan\n\nUse [[gt]].",
        "The Wiki docs this note links to follow, as saved in the Wiki.",
        "#### Wiki doc: Global token (global-token.md)",
        "Refill 10/s.",
      ].join("\n\n"),
    );
    expect(withWikiDocs("No links.", [])).toBe("No links.");
  });

  it("names each attached file and its link", () => {
    expect(
      attachedWikiDocsNote([
        { slug: "global-token", title: "Global token", content: "" },
      ]),
    ).toBe(
      "The Wiki docs the task links to are attached as Markdown files: global-token.md ([[global-token]]).",
    );
  });
});
