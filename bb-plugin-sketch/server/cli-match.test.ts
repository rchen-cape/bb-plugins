import { describe, expect, it } from "vitest";
import { matchSketch, matchWikiDoc } from "./cli-match";
import { WIKI_DOCS } from "./test-support";

const IDS = ["Billing", "billing", "Billing flow", "Billing review", "Roadmap"];

describe("matching sketch names", () => {
  it("prefers the exact name, then any case, then a unique prefix", () => {
    expect(matchSketch(IDS, "billing")).toEqual({ kind: "one", item: "billing" });
    expect(matchSketch(IDS, "BILLING FLOW")).toEqual({ kind: "one", item: "Billing flow" });
    expect(matchSketch(IDS, "road")).toEqual({ kind: "one", item: "Roadmap" });
    expect(matchSketch(IDS, " Roadmap ")).toEqual({ kind: "one", item: "Roadmap" });
    expect(matchSketch(IDS, "BILLING")).toEqual({ kind: "many", items: ["Billing", "billing"] });
    expect(matchSketch(IDS, "billing ")).toEqual({ kind: "one", item: "billing" });
    expect(matchSketch(IDS, "Billing f")).toEqual({ kind: "one", item: "Billing flow" });
    expect(matchSketch(IDS, "Bill")).toEqual({ kind: "many", items: ["Billing", "billing", "Billing flow", "Billing review"] });
    expect(matchSketch(IDS, "nope")).toEqual({ kind: "none" });
    expect(matchSketch(IDS, "")).toEqual({ kind: "none" });
  });
});

describe("matching Wiki docs", () => {
  it("matches a slug, title, alias, or @tag", () => {
    const slugOf = (ref: string) => {
      const match = matchWikiDoc(WIKI_DOCS, ref);
      return match.kind === "one" ? match.item.doc.slug : match.kind;
    };
    expect(slugOf("architecture")).toBe("architecture");
    expect(slugOf("ARCHITECTURE")).toBe("architecture");
    expect(slugOf("arch")).toBe("architecture");
    expect(slugOf("@billing-v2")).toBe("notes/billing-v2");
    expect(slugOf("notes/billing")).toBe("notes/billing");
    expect(slugOf("Billing")).toBe("notes/billing");
    expect(slugOf("Bill")).toBe("none");
  });

  it("splits Title#Heading", () => {
    expect(matchWikiDoc(WIKI_DOCS, "Architecture#Diagrams")).toMatchObject({ kind: "one", item: { doc: { slug: "architecture" }, heading: "Diagrams" } });
    expect(matchWikiDoc(WIKI_DOCS, "arch # Overview ")).toMatchObject({ kind: "one", item: { heading: "Overview" } });
    expect(matchWikiDoc(WIKI_DOCS, "Architecture#")).toMatchObject({ kind: "one", item: { heading: null } });
    expect(matchWikiDoc(WIKI_DOCS, "#Diagrams")).toEqual({ kind: "none" });
    expect(matchWikiDoc(WIKI_DOCS, "Nope#Diagrams")).toEqual({ kind: "none" });
  });
});
