import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../contract";
import { parseCardMediaLine } from "../lib/card-media";
import { acceptCard, createUploadCard, missingCardImages, previewCard } from "./cards";
import { createWikiContext } from "./context";

const DOC = "---\ntitle: Global token\ntype: topic\n---\n\n# Global token\n\n## Setup\n\nRotate with the CLI.\n";
const IMAGES = [
  { file: "a.png", caption: "See [[Roadmap]]" },
  { file: "b.png", caption: "a]b" },
  { file: "c.png", caption: "[0, 1)" },
];

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

function assetFor(file: string): string {
  return `assets/${file.replace(/\.png$/, "")}-${createHash("sha256").update(file).digest("hex").slice(0, 8)}.png`;
}

async function setup(gitHistory = false) {
  const wiki = await tempDir("wiki-upload-wiki-");
  const notes = await tempDir("wiki-upload-notes-");
  const files = await tempDir("wiki-upload-files-");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki, notesDirectory: notes, gitHistory, routingAgent: false, timezone: "America/New_York" },
  });
  const ctx = await createWikiContext(host.bb);
  await writeFile(path.join(wiki, "global-token.md"), DOC);
  await ctx.vault.syncAll();
  const image = async (file: string, caption: string) => {
    await writeFile(path.join(files, file), file);
    return { from: { kind: "path" as const, path: path.join(files, file) }, caption };
  };
  const media = await Promise.all(IMAGES.map(({ file, caption }) => image(file, caption)));
  const base = { name: "Roadmap.png", text: "", media, target: { kind: "existing" as const, slug: "global-token" }, heading: null, pluginId: "sketch", threadId: null };
  const cardMedia = (card: Card) => path.join(ctx.dataDir(), "card-media", card.id);
  const read = () => readFile(path.join(wiki, "global-token.md"), "utf8");
  const git = (...args: string[]) => execFileSync("git", ["-C", wiki, ...args], { encoding: "utf8" }).trim().split("\n");
  return { host, ctx, base, cardMedia, read, git };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T15:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upload card captions", () => {
  it("keeps captions with nested or unbalanced brackets on the card and rewrites their images into assets", async () => {
    const { ctx, base, read, git } = await setup(true);
    const card = await createUploadCard(ctx, base);
    expect(card.lines.flatMap((line) => parseCardMediaLine(line, card.id)?.caption ?? [])).toEqual(IMAGES.map((entry) => entry.caption));
    const [preview] = await previewCard(ctx, card.id);
    expect(preview?.patch).toContain(`+![See \\[\\[Roadmap\\]\\]](${assetFor("a.png")})`);
    expect(preview?.patch).not.toContain("card-media");
    await acceptCard(ctx, card.id);
    const doc = await read();
    expect(doc).toContain(`![See \\[\\[Roadmap\\]\\]](${assetFor("a.png")})\n\n![a\\]b](${assetFor("b.png")})\n\n![\\[0, 1)](${assetFor("c.png")})\n`);
    expect(doc).not.toContain("card-media");
    expect(git("show", "--name-only", "--format=", "HEAD").sort()).toEqual([...IMAGES.map((entry) => assetFor(entry.file)), "global-token.md"]);
  });

  it("lists a missing image even when its caption has brackets", async () => {
    const { ctx, base, cardMedia } = await setup();
    const card = await createUploadCard(ctx, base);
    await rm(path.join(cardMedia(card), "b.png"));
    expect(await missingCardImages(ctx, card.id)).toEqual([`card-media/${card.id}/b.png`]);
    await expect(acceptCard(ctx, card.id)).rejects.toThrow(`The image card-media/${card.id}/b.png is gone`);
  });
});

describe("upload cards sent from a thread", () => {
  it("records the thread and says an agent sent and placed the card", async () => {
    const { ctx, base } = await setup();
    const card = await createUploadCard(ctx, { ...base, threadId: "thr_agent" });
    expect(card).toMatchObject({
      source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId: "thr_agent" },
      rule: "picked",
      reason: "Sent from Sketch by an agent in a thread; review before adding.",
    });
    expect(card.destinations[0]?.reason).toBe("Chosen by an agent in Sketch when it was sent.");
    const loose = await createUploadCard(ctx, { ...base, pluginId: null, threadId: "thr_agent" });
    expect(loose.reason).toBe("Sent as an upload by an agent in a thread; review before adding.");
    expect(loose.destinations[0]?.reason).toBe("Chosen by an agent when it was sent.");
    expect(ctx.store.getCard(card.id)).toEqual(card);
  });

  it("reads cards stored before threads were recorded as sent by the user", async () => {
    const { host, ctx, base } = await setup();
    const card = await createUploadCard(ctx, base);
    const legacy = JSON.stringify({ kind: "upload", name: "Roadmap.png", pluginId: "sketch" });
    host.bb.storage.database().prepare("UPDATE cards SET source = ? WHERE id = ?").run(legacy, card.id);
    expect(ctx.store.getCard(card.id)?.source).toEqual({ kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId: null });
  });
});

describe("upload card media cleanup", () => {
  it("removes the card's images once the accept is written and committed", async () => {
    const { ctx, base, cardMedia, git } = await setup(true);
    const card = await createUploadCard(ctx, base);
    expect((await readdir(cardMedia(card))).sort()).toEqual(["a.png", "b.png", "c.png"]);
    expect((await acceptCard(ctx, card.id)).status).toBe("accepted");
    expect(git("log", "--format=%s")).toEqual(["Wiki: Roadmap.png → Global token"]);
    expect(await exists(cardMedia(card))).toBe(false);
  });

  it("still accepts the card when its images can't be removed", async () => {
    const { ctx, base, cardMedia, read } = await setup();
    const card = await createUploadCard(ctx, base);
    const root = path.dirname(cardMedia(card));
    await chmod(root, 0o500);
    try {
      expect((await acceptCard(ctx, card.id)).status).toBe("accepted");
    } finally {
      await chmod(root, 0o700);
    }
    expect(await read()).toContain(assetFor("a.png"));
    expect(await exists(cardMedia(card))).toBe(true);
  });

  it("keeps the images when the accept fails, so the card can be fixed and accepted later", async () => {
    const { ctx, base, cardMedia } = await setup();
    const card = await createUploadCard(ctx, base);
    await rm(path.join(cardMedia(card), "c.png"));
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("is gone");
    expect((await readdir(cardMedia(card))).sort()).toEqual(["a.png", "b.png"]);
  });
});
