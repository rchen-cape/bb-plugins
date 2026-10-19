import { describe, expect, it } from "vitest";
import { docSubPath, inboxSubPath, parseRoute, searchSubPath } from "./nav";

function hostEncoded(subPath: string): string {
  return subPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

describe("parseRoute", () => {
  it("reads every Wiki route from the panel sub-path", () => {
    expect(parseRoute("")).toEqual({ kind: "home" });
    expect(parseRoute("doc/unified-notification")).toEqual({ kind: "doc", slug: "unified-notification", anchor: null });
    expect(parseRoute("doc/team/onboarding#global-token")).toEqual({ kind: "doc", slug: "team/onboarding", anchor: "global-token" });
    expect(parseRoute("doc/")).toEqual({ kind: "home" });
    expect(parseRoute("inbox")).toEqual({ kind: "inbox", cardId: null });
    expect(parseRoute("/inbox/card_1a2b3c4d/")).toEqual({ kind: "inbox", cardId: "card_1a2b3c4d" });
    expect(parseRoute("search?q=global%20token")).toEqual({ kind: "search", query: "global token" });
    expect(parseRoute("search")).toEqual({ kind: "search", query: "" });
    expect(parseRoute("new")).toEqual({ kind: "new" });
    expect(parseRoute("something-else")).toEqual({ kind: "home" });
  });

  it("builds sub-paths that parse back", () => {
    expect(parseRoute(docSubPath("team/onboarding", "setup"))).toEqual({ kind: "doc", slug: "team/onboarding", anchor: "setup" });
    expect(docSubPath("x")).toBe("doc/x");
    expect(inboxSubPath()).toBe("inbox");
    expect(parseRoute(inboxSubPath("card_00000001"))).toEqual({ kind: "inbox", cardId: "card_00000001" });
    expect(parseRoute(hostEncoded(searchSubPath("a&b")))).toEqual({ kind: "search", query: "a&b" });
    expect(searchSubPath(" ")).toBe("search");
  });

  it("decodes the sub-path the way the host encodes it", () => {
    expect(hostEncoded(docSubPath("token-rotation", "global-token"))).toBe("doc/token-rotation%23global-token");
    expect(parseRoute(hostEncoded(docSubPath("token-rotation", "global-token")))).toEqual({ kind: "doc", slug: "token-rotation", anchor: "global-token" });
    expect(parseRoute(hostEncoded(docSubPath("Projects/Token Rotation")))).toEqual({ kind: "doc", slug: "Projects/Token Rotation", anchor: null });
    expect(parseRoute(hostEncoded(docSubPath("café/über", "naïve")))).toEqual({ kind: "doc", slug: "café/über", anchor: "naïve" });
    expect(parseRoute(hostEncoded(searchSubPath("token rotation")))).toEqual({ kind: "search", query: "token rotation" });
    expect(parseRoute(hostEncoded(inboxSubPath("card_00000001")))).toEqual({ kind: "inbox", cardId: "card_00000001" });
    expect(parseRoute("doc/100%")).toEqual({ kind: "doc", slug: "100%", anchor: null });
  });
});
