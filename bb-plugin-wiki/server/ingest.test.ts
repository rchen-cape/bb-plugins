import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_REASON, acceptCard } from "./cards";
import { FOLDER_OVERLAP_MESSAGE, createWikiContext } from "./context";
import { FIRST_RUN_KEY, listDailyNotes, runIngest, shiftIsoDate } from "./ingest";

const NOW = new Date("2026-10-15T15:00:00Z");
const DOCS: Record<string, string> = {
  "global-token.md": "---\ntitle: Global token\ntype: topic\n---\n\n# Global token\n\n## Unsorted\n",
  "unified-notification.md": "---\ntitle: Unified notification\ntype: project\naliases: [un]\n---\n\n# Unified notification\n",
};
const YESTERDAY = "@global-token\n- Push tokens rotate weekly\n  - rotation job runs at 3am\n\n- Mentioned @un in standup\n\n@skip\n- private thing";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

function noteContent(body: string): string {
  return `# Day\n\n## TODO\n- [ ] nothing here\n\n## NOTES\n\n${body}\n`;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(root, { recursive: true })).map(String).sort()) {
    const full = path.join(root, entry);
    const stats = await stat(full);
    result[entry] = stats.isFile() ? `${createHash("sha256").update(await readFile(full)).digest("hex")}:${stats.mtimeMs}` : `dir:${stats.mtimeMs}`;
  }
  return result;
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-ingest-wiki-");
  const notes = await tempDir("wiki-ingest-notes-");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki, notesDirectory: notes, gitHistory: false, routingAgent: false, timezone: "America/New_York", ...settings },
  });
  const ctx = await createWikiContext(host.bb);
  for (const [rel, content] of Object.entries(DOCS)) await put(wiki, rel, content);
  await ctx.vault.syncAll();
  await put(notes, "Time/oct2026/10-14-26.md", noteContent(YESTERDAY));
  await put(notes, "Time/oct2026/10-10-26.md", noteContent("- Read [[Global token]] docs"));
  await put(notes, "Time/oct2026/10-15-26.md", noteContent("@global-token\n- Today is still being written"));
  await put(notes, "Time/oct2026/10-16-26.md", noteContent("@global-token\n- Future plan"));
  await put(notes, "Time/sep2026/09-30-26.md", noteContent("@global-token\n- Older than the start date"));
  await put(notes, ".trash/10-13-26.md", noteContent("@global-token\n- Deleted note"));
  await put(notes, "node_modules/pkg/10-12-26.md", noteContent("@global-token\n- Not a note"));
  await put(notes, "Time/oct2026/ideas.md", noteContent("@global-token\n- Not a daily note"));
  return { wiki, notes, ctx, harness: host.harness, bb: host.bb };
}

function openTexts(ctx: Awaited<ReturnType<typeof setup>>["ctx"]): string[] {
  return ctx.store.listCards("open").map((card) => card.text);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shiftIsoDate", () => {
  it("moves across month and year boundaries", () => {
    expect(shiftIsoDate("2026-10-03", -7)).toBe("2026-09-26");
    expect(shiftIsoDate("2026-01-02", -7)).toBe("2025-12-26");
    expect(shiftIsoDate("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("listDailyNotes", () => {
  it("finds daily notes recursively, skipping dot-folders and node_modules", async () => {
    const { notes } = await setup();
    const listed = await listDailyNotes(notes);
    expect(listed?.map((note) => [note.relPath, note.date])).toEqual([
      ["Time/sep2026/09-30-26.md", "2026-09-30"],
      ["Time/oct2026/10-10-26.md", "2026-10-10"],
      ["Time/oct2026/10-14-26.md", "2026-10-14"],
      ["Time/oct2026/10-15-26.md", "2026-10-15"],
      ["Time/oct2026/10-16-26.md", "2026-10-16"],
    ]);
  });

  it("returns null for a missing folder", async () => {
    expect(await listDailyNotes(path.join(await tempDir("wiki-ingest-"), "absent"))).toBeNull();
  });
});

describe("runIngest", () => {
  it("creates one card per new unit from notes since the first run minus 7 days, never today or later", async () => {
    const { ctx, bb, harness } = await setup();
    const result = await runIngest(ctx, { since: null, useAgent: null });
    expect(result).toEqual({ notesScanned: 2, unitsFound: 3, cardsCreated: 3, jobIds: [] });
    expect(openTexts(ctx)).toEqual(["- Read [[Global token]] docs", "- Push tokens rotate weekly\n  - rotation job runs at 3am", "- Mentioned @un in standup"]);
    expect(await bb.storage.kv.get(FIRST_RUN_KEY)).toBe(NOW.toISOString());
    expect(ctx.store.listCards("open").map((card) => [card.rule, card.status])).toEqual([
      ["explicit-link", "pending"],
      ["tag", "pending"],
      ["tag", "pending"],
    ]);
    expect(harness.inspection.sdk.calls).toEqual([]);
  });

  it("reads a `### Notes:` heading and logs notes that have no NOTES section", async () => {
    const { ctx, notes, harness } = await setup();
    await put(notes, "Time/oct2026/10-13-26.md", "### Todos\n- [ ] x\n\n### Notes:\n\n@global-token\n- Colon heading fact\n\n### Next Todos\n- y\n");
    await put(notes, "Time/oct2026/10-12-26.md", "### TODO\n- only todos\n");
    await runIngest(ctx, { since: null, useAgent: false });
    expect(openTexts(ctx)).toContain("- Colon heading fact");
    const infos = harness.inspection.logEntries.filter((entry) => entry.level === "info").map((entry) => entry.message);
    expect(infos).toContain("Wiki found no NOTES section in Time/oct2026/10-12-26.md.");
    expect(infos.filter((message) => message.startsWith("Wiki found no NOTES section"))).toHaveLength(1);
  });

  it("is idempotent and only re-reads notes when they change or since is given", async () => {
    const { ctx } = await setup();
    await runIngest(ctx, { since: null, useAgent: false });
    expect(await runIngest(ctx, { since: null, useAgent: false })).toEqual({ notesScanned: 0, unitsFound: 0, cardsCreated: 0, jobIds: [] });
    expect(await runIngest(ctx, { since: "2026-10-01", useAgent: false })).toEqual({ notesScanned: 2, unitsFound: 3, cardsCreated: 0, jobIds: [] });
    expect(ctx.store.listCards("open")).toHaveLength(3);
  });

  it("creates exactly one new card when one bullet of an old note is edited", async () => {
    const { ctx, notes } = await setup();
    await runIngest(ctx, { since: null, useAgent: false });
    const file = path.join(notes, "Time/oct2026/10-14-26.md");
    await writeFile(file, noteContent(YESTERDAY.replace("rotate weekly", "rotate daily")));
    await utimes(file, new Date("2026-10-15T16:00:00Z"), new Date("2026-10-15T16:00:00Z"));
    const result = await runIngest(ctx, { since: null, useAgent: false });
    expect(result).toMatchObject({ notesScanned: 1, unitsFound: 2, cardsCreated: 1 });
    expect(openTexts(ctx).at(-1)).toBe("- Push tokens rotate daily\n  - rotation job runs at 3am");
  });

  it("never brings back skipped or accepted units", async () => {
    const { ctx } = await setup();
    await runIngest(ctx, { since: null, useAgent: false });
    const [first] = ctx.store.listCards("open");
    if (first === undefined) throw new Error("expected a card");
    await acceptCard(ctx, first.id);
    expect(await runIngest(ctx, { since: "2026-10-01", useAgent: false })).toMatchObject({ notesScanned: 2, cardsCreated: 0 });
    expect(ctx.store.listCards("open")).toHaveLength(2);
  });

  it("never writes to the notes folder", async () => {
    const { ctx, notes } = await setup();
    const before = await snapshot(notes);
    await runIngest(ctx, { since: null, useAgent: false });
    for (const card of ctx.store.listCards("open")) {
      if (card.destinations.some((destination) => destination.include)) await acceptCard(ctx, card.id);
    }
    await runIngest(ctx, { since: "2026-01-01", useAgent: false });
    expect(await snapshot(notes)).toEqual(before);
  });

  it("refuses to run when the Wiki and Notes folders overlap", async () => {
    const { ctx, notes, wiki, harness, bb } = await setup();
    const before = await snapshot(notes);
    await harness.behavior.setSettings({ wikiDirectory: path.join(notes, "Wiki") });
    await expect(runIngest(ctx, { since: null, useAgent: false })).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    await harness.behavior.setSettings({ wikiDirectory: wiki, notesDirectory: path.join(wiki, "Notes") });
    await expect(runIngest(ctx, { since: "2026-01-01", useAgent: false })).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    expect(ctx.store.listCards("open")).toEqual([]);
    expect(await bb.storage.kv.get(FIRST_RUN_KEY)).toBeUndefined();
    expect(await snapshot(notes)).toEqual(before);
  });

  it("honors ingestStartDate, then since, then the stored first run", async () => {
    const { ctx, bb } = await setup({ ingestStartDate: "2026-10-12" });
    expect(await runIngest(ctx, { since: null, useAgent: false })).toMatchObject({ notesScanned: 1, cardsCreated: 2 });
    expect(await bb.storage.kv.get(FIRST_RUN_KEY)).toBe(NOW.toISOString());
    expect(await runIngest(ctx, { since: "2026-09-01", useAgent: false })).toMatchObject({ notesScanned: 3, cardsCreated: 2 });
    const other = await setup();
    await other.bb.storage.kv.set(FIRST_RUN_KEY, "2026-10-07T12:00:00Z");
    expect(await runIngest(other.ctx, { since: null, useAgent: false })).toMatchObject({ notesScanned: 3, cardsCreated: 4 });
    expect(await other.bb.storage.kv.get(FIRST_RUN_KEY)).toBe("2026-10-07T12:00:00Z");
  });

  it("rejects a malformed since date", async () => {
    const { ctx } = await setup();
    await expect(runIngest(ctx, { since: "10-14-26", useAgent: false })).rejects.toThrow("YYYY-MM-DD");
  });

  it("returns an empty result when the notes folder is missing", async () => {
    const { ctx } = await setup({ notesDirectory: path.join(await tempDir("wiki-ingest-"), "nothing-here") });
    expect(await runIngest(ctx, { since: null, useAgent: false })).toEqual({ notesScanned: 0, unitsFound: 0, cardsCreated: 0, jobIds: [] });
  });

  it("runs one ingest at a time", async () => {
    const { ctx } = await setup();
    const results = await Promise.all([runIngest(ctx, { since: null, useAgent: false }), runIngest(ctx, { since: "2026-10-01", useAgent: false })]);
    expect(results.map((result) => result.cardsCreated)).toEqual([3, 0]);
    expect(ctx.store.listCards("open")).toHaveLength(3);
  });

  it("starts a routing job for non-link cards when the agent is on", async () => {
    const { ctx, harness } = await setup({ routingAgent: true });
    harness.inspection.sdk.stub("projects.list", () => [{ id: "proj_personal" }]);
    harness.inspection.sdk.stub("threads.spawn", () => ({ id: "thr_route" }));
    const result = await runIngest(ctx, { since: null, useAgent: null });
    expect(result.jobIds).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(ctx.store.listCards("open").map((card) => card.status)).toEqual(["pending", "routing", "routing"]);
    const [jobId] = result.jobIds;
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ kind: "route", status: "running", threadId: "thr_route" });
  });

  it("falls back to rules when the personal project is missing", async () => {
    const { ctx, harness } = await setup();
    harness.inspection.sdk.stub("projects.list", () => [{ id: "proj_other" }]);
    const result = await runIngest(ctx, { since: null, useAgent: true });
    expect(result.jobIds).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    const cards = ctx.store.listCards("open");
    expect(cards.map((card) => card.status)).toEqual(["pending", "pending", "pending"]);
    expect(cards.map((card) => card.reason).filter((reason) => reason === FALLBACK_REASON)).toHaveLength(2);
  });
});

describe("runIngest with unreadable notes", () => {
  it("skips a note it cannot read and picks it up once it can", async () => {
    const { ctx, notes } = await setup();
    const file = path.join(notes, "Time/oct2026/10-10-26.md");
    await chmod(file, 0o000);
    try {
      expect(await runIngest(ctx, { since: null, useAgent: false })).toMatchObject({ notesScanned: 1, cardsCreated: 2 });
    } finally {
      await chmod(file, 0o644);
    }
    expect(await runIngest(ctx, { since: null, useAgent: false })).toMatchObject({ notesScanned: 1, cardsCreated: 1 });
    expect(openTexts(ctx)).toContain("- Read [[Global token]] docs");
  });
});
