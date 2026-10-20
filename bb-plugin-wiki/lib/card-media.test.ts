import { describe, expect, it } from "vitest";
import type { Card } from "../contract";
import {
  cardMediaPath,
  cardTextLine,
  imageAlt,
  isCardMediaTarget,
  isOwnCardMedia,
  parseCardMediaLine,
  pluginTitle,
  sentByAgent,
  uploadIcon,
  uploadOrigin,
} from "./card-media";
import { extractImageTargets, rewriteImageTargets } from "./markdown-doc";

const CARD = "card_1a2b3c4d";
const IMAGE = cardMediaPath(CARD, "roadmap.png");

describe("image captions", () => {
  it.each(["See [[Roadmap]]", "a]b", "[0, 1)", "a[b", "[[a] b]", "C:\\temp\\", "x \\] y", "plain"])(
    "writes %j so the card, the accept and the preview all read the same image",
    (caption) => {
      const line = `![${imageAlt(caption)}](${IMAGE})`;
      expect(parseCardMediaLine(line, CARD)).toEqual({ caption, path: IMAGE });
      expect(extractImageTargets(line)).toEqual([IMAGE]);
      expect(rewriteImageTargets(line, () => "assets/roadmap-1a2b3c4d.png")).toBe(`![${imageAlt(caption)}](assets/roadmap-1a2b3c4d.png)`);
    },
  );

  it("collapses whitespace and escapes only backslashes and brackets", () => {
    expect(imageAlt("  Q3\n [draft]\\v2 (final)  ")).toBe("Q3 \\[draft\\]\\\\v2 (final)");
  });

  it("does not read an image whose closing bracket is escaped", () => {
    expect(extractImageTargets(`![x\\](${IMAGE})`)).toEqual([]);
  });
});

function card(overrides: Partial<Card>): Card {
  return {
    id: CARD,
    status: "pending",
    source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId: null },
    text: "",
    lines: [],
    tags: [],
    rule: "none",
    reason: "",
    destinations: [],
    tagSuggestions: [],
    rememberAliases: [],
    createdAt: "2026-10-15T15:00:00.000Z",
    updatedAt: "2026-10-15T15:00:00.000Z",
    ...overrides,
  };
}

describe("cardTextLine", () => {
  it("skips the card's own image lines and falls back to the upload's name", () => {
    expect(cardTextLine(card({ lines: [`![Roadmap](${IMAGE})`] }))).toBe("Roadmap.png");
    expect(cardTextLine(card({ lines: ["", `![Roadmap](${IMAGE})`, "  - Q3 draft"] }))).toBe("  - Q3 draft");
  });

  it("keeps the first line of other cards as written", () => {
    const notes = card({ source: { kind: "notes", notePath: "a.md", noteDate: "2026-10-14", unitHash: "h" }, text: "- one", lines: ["", "- one"] });
    expect(cardTextLine(notes)).toBe("- one");
  });
});

describe("sentByAgent", () => {
  it("counts agent cards and uploads sent from a thread", () => {
    expect(sentByAgent({ kind: "agent", threadId: "thr_1", threadTitle: null })).toBe(true);
    expect(sentByAgent({ kind: "upload", name: "a.png", pluginId: "sketch", threadId: "thr_1" })).toBe(true);
    expect(sentByAgent({ kind: "upload", name: "a.png", pluginId: "sketch", threadId: null })).toBe(false);
    expect(sentByAgent({ kind: "notes", notePath: "a.md", noteDate: "2026-10-14", unitHash: "h" })).toBe(false);
  });
});

describe("parseCardMediaLine", () => {
  it("reads the caption and path of a card's own image line", () => {
    expect(parseCardMediaLine(`![Q3 \\[draft\\] roadmap](${cardMediaPath(CARD, "roadmap.png")})`, CARD)).toEqual({
      caption: "Q3 [draft] roadmap",
      path: "card-media/card_1a2b3c4d/roadmap.png",
    });
    expect(parseCardMediaLine(`![](card-media/${CARD}/a-2.webp)`, CARD)).toEqual({ caption: "", path: `card-media/${CARD}/a-2.webp` });
  });

  it.each([
    ["another card's image", "![x](card-media/card_99999999/roadmap.png)"],
    ["a nested path", `![x](card-media/${CARD}/sub/roadmap.png)`],
    ["the card folder itself", `![x](card-media/${CARD}/)`],
    ["an asset", "![x](assets/roadmap-1a2b3c4d.png)"],
    ["text around the image", `See ![x](card-media/${CARD}/roadmap.png) here`],
    ["a plain line", "Roadmap notes"],
  ])("ignores %s", (_label, line) => {
    expect(parseCardMediaLine(line, CARD)).toBeNull();
  });
});

describe("card media targets", () => {
  it("tells card media apart from other image targets", () => {
    expect(isCardMediaTarget(`card-media/${CARD}/a.png`)).toBe(true);
    expect(isCardMediaTarget("img/a.png")).toBe(false);
    expect(isOwnCardMedia(`card-media/${CARD}/a.png`, CARD)).toBe(true);
    expect(isOwnCardMedia(`card-media/${CARD}/../card_99999999/a.png`, CARD)).toBe(false);
    expect(isOwnCardMedia(`card-media/${CARD}`, CARD)).toBe(false);
  });
});

describe("upload labels", () => {
  it("title-cases the sending plugin's id", () => {
    expect(pluginTitle("sketch")).toBe("Sketch");
    expect(pluginTitle("pr-board")).toBe("Pr Board");
    expect(uploadOrigin("sketch")).toBe("From Sketch");
    expect(uploadOrigin(null)).toBe("Upload");
    expect(uploadIcon("sketch")).not.toBe(uploadIcon(null));
  });
});
