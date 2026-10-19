import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../contract";
import { parseNoteUnits } from "../lib/daily-notes";
import { ROUTING_TIMEOUT_MS } from "../lib/wiki";
import { FALLBACK_REASON, createNotesCards } from "./cards";
import { createWikiContext, type WikiContext } from "./context";
import {
  DESCRIPTION_TOOL,
  JOB_PERMISSION_MODE,
  ROUTES_TOOL,
  handleThreadSettled,
  jobKindFromMetadata,
  recordDescription,
  recordDescriptionParams,
  recordRoutes,
  recordRoutesParams,
  recoverJobs,
  registerRouting,
  startDescribeJob,
  startRoutingJobs,
} from "./routing";

const DOCS: Record<string, string> = {
  "global-token.md": "---\ntitle: Global token\ntype: topic\n---\n\n# Global token\n\n## Setup\n\nRotate with the CLI.\n",
  "unified-notification.md": "---\ntitle: Unified notification\ntype: project\naliases: [un]\n---\n\n# Unified notification\n\n## Related\n",
};

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(root, { recursive: true })).map(String).sort()) {
    const full = path.join(root, entry);
    result[entry] = (await stat(full)).isFile() ? createHash("sha256").update(await readFile(full)).digest("hex") : "dir";
  }
  return result;
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-routing-wiki-");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki, gitHistory: false, routingAgent: true, timezone: "America/New_York", ...settings },
  });
  const ctx = await createWikiContext(host.bb);
  for (const [rel, content] of Object.entries(DOCS)) await put(wiki, rel, content);
  await ctx.vault.syncAll();
  const sdk = host.harness.inspection.sdk;
  let spawned = 0;
  sdk.stub("projects.list", () => [{ id: "proj_personal" }]);
  sdk.stub("threads.spawn", () => ({ id: `thr_${(spawned += 1)}` }));
  sdk.stub("threads.archive", () => ({}));
  sdk.stub("threads.stop", () => ({}));
  return { wiki, ctx, harness: host.harness, sdk };
}

function spawnArgs(sdk: Awaited<ReturnType<typeof setup>>["sdk"], index = 0): Record<string, unknown> {
  const args = sdk.callsTo("threads.spawn")[index]?.[0];
  if (typeof args !== "object" || args === null) throw new Error(`no spawn call ${index}`);
  return Object.fromEntries(Object.entries(args));
}

function expectLockedDown(args: Record<string, unknown>, sources: Record<string, string>): void {
  expect(args.permissionMode).toBe(JOB_PERMISSION_MODE);
  expect(JOB_PERMISSION_MODE).toBe("accept-edits");
  expect(["auto", "full"]).not.toContain(args.permissionMode);
  expect(args.executionInputSources).toEqual(sources);
}

async function routingCards(ctx: WikiContext, body: string): Promise<Card[]> {
  const knownTags = new Set(ctx.store.allTags().flatMap((entry) => [entry.tag, ...entry.aliases]));
  const content = `# Day\n\n### NOTES\n\n${body}\n`;
  const units = parseNoteUnits(content, { knownTags });
  return createNotesCards(ctx, units.map((unit) => ({ unit, notePath: "10-14-26.md", noteDate: "2026-10-14" })), { useAgent: true });
}

function cardIds(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

function routes(input: unknown) {
  return recordRoutesParams.parse(input);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tool parameters", () => {
  it("knows the job kind from thread metadata", () => {
    expect(jobKindFromMetadata({ wikiJob: "route", jobId: "job_1" })).toBe("route");
    expect(jobKindFromMetadata({ wikiJob: "describe" })).toBe("describe");
    expect(jobKindFromMetadata({ wikiJob: "other" })).toBeNull();
    expect(jobKindFromMetadata({})).toBeNull();
    expect(jobKindFromMetadata(null)).toBeNull();
  });

  it("parses routes with defaults and rejects malformed ones", () => {
    const parsed = routes({
      routes: [{ cardId: "card_abcd1234", destinations: [{ target: { newDoc: { title: "Push", type: "topic" } }, lineRanges: "all", reason: "r" }] }],
    });
    expect(parsed.routes[0]).toEqual({
      cardId: "card_abcd1234",
      destinations: [{ target: { newDoc: { title: "Push", type: "topic", aliases: [] } }, heading: "Unsorted", lineRanges: "all", reason: "r" }],
      tagMatches: [],
    });
    expect(recordRoutesParams.safeParse({ routes: [{ cardId: "c1", destinations: [] }] }).success).toBe(false);
    expect(recordRoutesParams.safeParse({ routes: [] }).success).toBe(false);
    const empty = { cardId: "card_abcd1234", destinations: [{ target: { slug: "x" }, lineRanges: [], reason: "" }] };
    expect(recordRoutesParams.safeParse({ routes: [empty] }).success).toBe(false);
    const both = { cardId: "card_abcd1234", destinations: [{ target: { slug: "x", newDoc: { title: "y", type: "topic" } }, lineRanges: "all", reason: "" }] };
    expect(recordRoutesParams.safeParse({ routes: [both] }).success).toBe(false);
    expect(recordDescriptionParams.safeParse({ description: "  " }).success).toBe(false);
  });
});

describe("startRoutingJobs", () => {
  it("spawns one hidden Claude Code thread in the personal project with the job in its metadata", async () => {
    const { ctx, sdk } = await setup();
    const cards = await routingCards(ctx, "@global-token\n- Push tokens rotate weekly\n  - at 3am\n\nUntagged idea");
    const jobIds = await startRoutingJobs(ctx, cards);
    expect(jobIds).toHaveLength(1);
    const args = spawnArgs(sdk);
    expect(args).toMatchObject({
      projectId: "proj_personal",
      environment: { type: "host", workspace: { type: "personal" } },
      providerId: "claude-code",
      visibility: "hidden",
      title: expect.stringMatching(/^Wiki routing \d{4}-\d{2}-\d{2}$/),
      pluginMetadata: { wikiJob: "route", jobId: jobIds[0] },
      originPluginId: "wiki",
    });
    expect(args).not.toHaveProperty("model");
    expectLockedDown(args, { providerId: "explicit", permissionMode: "explicit" });
    const prompt = String(args.prompt);
    expect(prompt).toContain(`Call ${ROUTES_TOOL} exactly once`);
    expect(prompt).toContain("Never write, rewrite, summarize");
    expect(prompt).toContain("Do not run shell commands, and do not read, create, edit or delete any files.");
    expect(prompt).toContain(`Use only the Wiki tools you were given: wiki_search, wiki_get and ${ROUTES_TOOL}.`);
    expect(prompt).toContain("`global-token` — Global token (topic) · headings: Global token; Setup");
    for (const card of cards) expect(prompt).toContain(`### ${card.id}`);
    expect(prompt).toContain("0 | - Push tokens rotate weekly\n1 |   - at 3am");
    expect(prompt).toContain("Tags: @global-token (doc `global-token`)");
    expect(ctx.store.getJob(jobIds[0] ?? "")).toMatchObject({ kind: "route", status: "running", threadId: "thr_1" });
    expect(cardIds(ctx.store.cardsForJob(jobIds[0] ?? ""))).toEqual(cardIds(cards));
  });

  it("passes the routing model when one is set", async () => {
    const { ctx, sdk } = await setup({ routingModel: "claude-sonnet-4-5" });
    await startRoutingJobs(ctx, await routingCards(ctx, "- Something"));
    expect(spawnArgs(sdk)).toMatchObject({ model: "claude-sonnet-4-5" });
    expectLockedDown(spawnArgs(sdk), { providerId: "explicit", model: "explicit", permissionMode: "explicit" });
  });

  it("falls back to rules when the personal project is missing", async () => {
    const { ctx, sdk } = await setup();
    sdk.stub("projects.list", () => [{ id: "proj_work" }]);
    const cards = await routingCards(ctx, "@global-token\n- Fact");
    expect(await startRoutingJobs(ctx, cards)).toEqual([]);
    expect(sdk.callsTo("threads.spawn")).toEqual([]);
    expect(ctx.store.getCard(cards[0]?.id ?? "")).toMatchObject({ status: "pending", reason: FALLBACK_REASON });
  });

  it("fails the job and falls back when the thread cannot start", async () => {
    const { ctx, sdk } = await setup();
    sdk.stub("threads.spawn", () => Promise.reject(new Error("provider offline")));
    const cards = await routingCards(ctx, "- Fact");
    const [jobId] = await startRoutingJobs(ctx, cards);
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ status: "failed", error: "Could not start the routing thread: provider offline" });
    expect(ctx.store.getCard(cards[0]?.id ?? "")?.status).toBe("pending");
  });

  it("runs batches of 60 one after another", async () => {
    const { ctx, sdk } = await setup();
    const body = Array.from({ length: 61 }, (_, index) => `- Item number ${index + 1}`).join("\n");
    const cards = await routingCards(ctx, body);
    expect(cards).toHaveLength(61);
    const jobIds = await startRoutingJobs(ctx, cards);
    expect(jobIds).toHaveLength(2);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(String(spawnArgs(sdk).title)).toMatch(/\(1 of 2\)$/);
    expect(ctx.store.cardsForJob(jobIds[0] ?? "")).toHaveLength(60);
    expect(ctx.store.cardsForJob(jobIds[1] ?? "")).toHaveLength(1);
    await handleThreadSettled(ctx, "thr_1", false, null);
    await vi.waitFor(() => expect(sdk.callsTo("threads.spawn")).toHaveLength(2));
    expect(String(spawnArgs(sdk, 1).title)).toMatch(/\(2 of 2\)$/);
    expect(spawnArgs(sdk, 1)).toMatchObject({ pluginMetadata: { wikiJob: "route", jobId: jobIds[1] } });
    expect(ctx.store.getJob(jobIds[1] ?? "")?.threadId).toBe("thr_2");
  });
});

describe("recordRoutes", () => {
  async function twoJobs() {
    const env = await setup();
    const mine = await routingCards(env.ctx, "@unified-notification\n- Global token rotates weekly\n  - via the CLI\n\n- Second item");
    const [jobId] = await startRoutingJobs(env.ctx, mine);
    const foreign = await routingCards(env.ctx, "- Somebody else's card");
    await startRoutingJobs(env.ctx, foreign);
    return { ...env, mine, foreign, jobId: jobId ?? "" };
  }

  it("applies valid routes from the job's thread and reports the rest so the agent can retry", async () => {
    const { ctx, mine, foreign, jobId, harness } = await twoJobs();
    const [first, second] = mine;
    const [other] = foreign;
    if (first === undefined || second === undefined || other === undefined) throw new Error("expected cards");
    const signals = harness.inspection.realtimeSignals.length;
    const summary = await recordRoutes(
      ctx,
      "thr_1",
      routes({
        routes: [
          { cardId: first.id, destinations: [{ target: { slug: "global-token" }, heading: "Setup", lineRanges: [{ start: 0, end: 1 }], reason: "How it works." }] },
          { cardId: other.id, destinations: [] },
          { cardId: second.id, destinations: [{ target: { slug: "global-token" }, lineRanges: [{ start: 0, end: 3 }], reason: "" }] },
          { cardId: first.id, destinations: [] },
        ],
      }),
    );
    expect(summary).toContain("Recorded routes for 1 of 4 cards.");
    expect(summary).toContain(`- ${other.id}: not one of the cards in this routing job.`);
    expect(summary).toContain(`- ${second.id}: Destination 1: lines 0-3 are outside this card's 1 line (0).`);
    expect(summary).toContain(`- ${first.id}: listed more than once`);
    expect(summary).toContain(`Still waiting for routes: ${second.id}.`);
    expect(ctx.store.getCard(first.id)).toMatchObject({ status: "pending", rule: "agent" });
    expect(ctx.store.getCard(first.id)?.destinations.map((destination) => [destination.target, destination.role])).toEqual([
      [{ kind: "existing", slug: "global-token" }, "content"],
      [{ kind: "existing", slug: "unified-notification" }, "link"],
    ]);
    expect(ctx.store.getCard(second.id)?.status).toBe("routing");
    expect(ctx.store.getCard(other.id)?.status).toBe("routing");
    expect(harness.inspection.realtimeSignals.length).toBe(signals + 1);
    const retry = await recordRoutes(ctx, "thr_1", routes({ routes: [{ cardId: second.id, destinations: [{ target: { slug: "global-token" }, lineRanges: "all", reason: "" }] }] }));
    expect(retry).toContain("Every card in this job is routed. You are done.");
    expect(ctx.store.getJob(jobId)?.status).toBe("done");
    await expect(recordRoutes(ctx, "thr_1", routes({ routes: [{ cardId: second.id, destinations: [] }] }))).rejects.toThrow("already finished");
  });

  it("only works in routing threads", async () => {
    const { ctx, mine } = await twoJobs();
    const call = routes({ routes: [{ cardId: mine[0]?.id ?? "", destinations: [] }] });
    await expect(recordRoutes(ctx, "thr_unknown", call)).rejects.toThrow(`${ROUTES_TOOL} only works in a Wiki routing thread`);
  });
});

describe("thread completion", () => {
  it("falls back when the routing thread goes idle without routes, then archives and stops it", async () => {
    const { ctx, harness, sdk } = await setup();
    registerRouting(ctx);
    const cards = await routingCards(ctx, "@global-token\n- A fact\n\n- Another");
    const [jobId] = await startRoutingJobs(ctx, cards);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_other" }), lastAssistantText: null });
    expect(sdk.callsTo("threads.archive")).toEqual([]);
    const { errors } = await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1" }), lastAssistantText: "done" });
    expect(errors).toEqual([]);
    for (const card of cards) expect(ctx.store.getCard(card.id)).toMatchObject({ status: "pending", reason: FALLBACK_REASON });
    expect(ctx.store.getCard(cards[0]?.id ?? "")?.destinations[0]?.target).toEqual({ kind: "existing", slug: "global-token" });
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ status: "done" });
    expect(sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_1" }]]);
    expect(sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_1" }]]);
  });

  it("marks the job failed when the thread fails", async () => {
    const { ctx, harness } = await setup();
    registerRouting(ctx);
    const [jobId] = await startRoutingJobs(ctx, await routingCards(ctx, "- A fact"));
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "rate limited" });
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ status: "failed", error: "rate limited" });
  });

  it("keeps going when archiving fails", async () => {
    const { ctx, sdk } = await setup();
    sdk.stub("threads.archive", () => Promise.reject(new Error("gone")));
    const [jobId] = await startRoutingJobs(ctx, await routingCards(ctx, "- A fact"));
    await handleThreadSettled(ctx, "thr_1", false, null);
    expect(ctx.store.getJob(jobId ?? "")?.status).toBe("done");
    expect(sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_1" }]]);
  });

  it("times out after 15 minutes and falls back to rules", async () => {
    const { ctx, sdk } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cards = await routingCards(ctx, "@global-token\n- Slow one");
    const [jobId] = await startRoutingJobs(ctx, cards);
    await vi.advanceTimersByTimeAsync(ROUTING_TIMEOUT_MS - 1000);
    expect(ctx.store.getJob(jobId ?? "")?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ status: "failed", error: "Timed out after 15 minutes." });
    expect(ctx.store.getCard(cards[0]?.id ?? "")).toMatchObject({ status: "pending", reason: FALLBACK_REASON });
    await vi.waitFor(() => expect(sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_1" }]]));
  });

  it("clears the timeout once the job settles", async () => {
    const { ctx } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [jobId] = await startRoutingJobs(ctx, await routingCards(ctx, "- Quick one"));
    expect(vi.getTimerCount()).toBe(1);
    await handleThreadSettled(ctx, "thr_1", false, null);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.store.getJob(jobId ?? "")?.status).toBe("done");
  });
});

describe("recoverJobs", () => {
  async function storedJob(ctx: WikiContext, threadId: string | null, body: string) {
    const cards = await routingCards(ctx, body);
    const job = ctx.store.createJob({ kind: "route", payload: {} });
    for (const card of cards) ctx.store.setCardJob(card.id, job.id);
    if (threadId !== null) ctx.store.setJobThread(job.id, threadId);
    return { job, cards };
  }

  it("settles finished or missing threads and re-arms timers for running ones", async () => {
    const { ctx, sdk } = await setup();
    const idle = await storedJob(ctx, "thr_idle", "- Idle card");
    const failed = await storedJob(ctx, "thr_failed", "- Failed card");
    const archived = await storedJob(ctx, "thr_archived", "- Archived card");
    const unstarted = await storedJob(ctx, null, "- Unstarted card");
    const running = await storedJob(ctx, "thr_running", "- Running card");
    const unknown = await storedJob(ctx, "thr_unknown", "- Unknown card");
    const startedAt = Date.now() - 14 * 60_000;
    sdk.stub("threads.get", ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_unknown") return Promise.reject(new Error("server busy"));
      if (threadId === "thr_idle") return makeThreadResponse({ id: threadId, status: "idle" });
      if (threadId === "thr_failed") return makeThreadResponse({ id: threadId, status: "error" });
      if (threadId === "thr_archived") return makeThreadResponse({ id: threadId, status: "active", archivedAt: 5 });
      return makeThreadResponse({ id: threadId, status: "active", createdAt: startedAt });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await recoverJobs(ctx);
    expect(ctx.store.getJob(idle.job.id)?.status).toBe("done");
    expect(ctx.store.getJob(failed.job.id)?.status).toBe("failed");
    expect(ctx.store.getJob(archived.job.id)?.status).toBe("done");
    expect(ctx.store.getJob(unstarted.job.id)).toMatchObject({ status: "failed", error: "The Wiki restarted before this job's thread started." });
    for (const entry of [idle, failed, archived, unstarted]) expect(ctx.store.getCard(entry.cards[0]?.id ?? "")?.status).toBe("pending");
    expect(sdk.callsTo("threads.archive").map(([args]) => args)).toEqual([{ threadId: "thr_idle" }, { threadId: "thr_failed" }, { threadId: "thr_archived" }]);
    expect(ctx.store.getJob(running.job.id)?.status).toBe("running");
    expect(ctx.store.getJob(unknown.job.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ctx.store.getJob(running.job.id)).toMatchObject({ status: "failed", error: "Timed out after 15 minutes." });
    expect(ctx.store.getCard(running.cards[0]?.id ?? "")?.status).toBe("pending");
    expect(ctx.store.getJob(unknown.job.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(ROUTING_TIMEOUT_MS);
    expect(ctx.store.getJob(unknown.job.id)?.status).toBe("failed");
  });

  it("runs at registration without blocking it", async () => {
    const { ctx, harness } = await setup();
    const { job } = await storedJob(ctx, null, "- Left over");
    registerRouting(ctx);
    expect(harness.inspection.registrations.threadEventHandlers["thread.idle"]).toBe(1);
    expect(harness.inspection.registrations.threadEventHandlers["thread.failed"]).toBe(1);
    await vi.waitFor(() => expect(ctx.store.getJob(job.id)?.status).toBe("failed"));
  });
});

describe("describe jobs", () => {
  async function image() {
    const folder = await tempDir("wiki-routing-img-");
    const file = path.join(folder, "diagram.png");
    await writeFile(file, "PNG");
    return file;
  }

  it("spawns a hidden thread with the image and stores the description without touching the Wiki", async () => {
    const { ctx, sdk, wiki } = await setup();
    const before = await snapshot(wiki);
    const file = await image();
    const { jobId } = await startDescribeJob(ctx, file);
    const args = spawnArgs(sdk);
    expect(args).toMatchObject({
      projectId: "proj_personal",
      visibility: "hidden",
      providerId: "claude-code",
      pluginMetadata: { wikiJob: "describe", jobId },
      input: [
        { type: "text", text: expect.stringContaining(`call ${DESCRIPTION_TOOL} once`), mentions: [] },
        { type: "localImage", path: file },
      ],
    });
    expect(args).not.toHaveProperty("prompt");
    expectLockedDown(args, { providerId: "explicit", permissionMode: "explicit" });
    const text = JSON.stringify(args.input);
    expect(text).toContain("Do not run shell commands, and do not read, create, edit or delete any files.");
    expect(text).toContain(`Use only the Wiki tool you were given, ${DESCRIPTION_TOOL}.`);
    await expect(recordRoutes(ctx, "thr_1", routes({ routes: [{ cardId: "card_abcd1234", destinations: [] }] }))).rejects.toThrow("only works in a Wiki routing thread");
    const reply = await recordDescription(ctx, "thr_1", recordDescriptionParams.parse({ description: "  A sequence diagram of token rotation.  " }));
    expect(reply).toContain("Saved the description");
    expect(ctx.store.getJob(jobId)).toMatchObject({ status: "done", result: "A sequence diagram of token rotation.", error: null });
    await handleThreadSettled(ctx, "thr_1", false, null);
    expect(ctx.store.getJob(jobId)?.status).toBe("done");
    expect(sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_1" }]]);
    expect(await snapshot(wiki)).toEqual(before);
  });

  it("fails when the thread ends without a description", async () => {
    const { ctx } = await setup();
    const { jobId } = await startDescribeJob(ctx, await image());
    await handleThreadSettled(ctx, "thr_1", false, null);
    expect(ctx.store.getJob(jobId)).toMatchObject({ status: "failed", error: "Claude Code finished without describing the image." });
    await expect(recordDescription(ctx, "thr_1", { description: "late" })).rejects.toThrow("already finished");
  });

  it("rejects paths that are not image files and records failures to start", async () => {
    const { ctx, sdk } = await setup();
    await expect(startDescribeJob(ctx, "relative.png")).rejects.toThrow("absolute path");
    await expect(startDescribeJob(ctx, path.join(await tempDir("wiki-routing-"), "missing.png"))).rejects.toThrow("There is no image file");
    await expect(startDescribeJob(ctx, path.join(await tempDir("wiki-routing-"), "notes.txt"))).rejects.toThrow("absolute path");
    sdk.stub("projects.list", () => []);
    const { jobId } = await startDescribeJob(ctx, await image());
    expect(ctx.store.getJob(jobId)?.status).toBe("failed");
    await expect(recordDescription(ctx, "thr_9", { description: "x" })).rejects.toThrow(`${DESCRIPTION_TOOL} only works in a Wiki image description thread`);
  });
});

describe("threads that never finish starting", () => {
  function hangingSpawn(sdk: Awaited<ReturnType<typeof setup>>["sdk"]) {
    const pending: Array<(thread: { id: string }) => void> = [];
    sdk.stub("threads.spawn", () => new Promise((resolve) => pending.push(resolve)));
    return (id: string) => pending.shift()?.({ id });
  }

  it("times out a routing job whose spawn hangs, so the ingest and the next batch move on", async () => {
    const { ctx, sdk } = await setup();
    const finish = hangingSpawn(sdk);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = Array.from({ length: 61 }, (_, index) => `- Item number ${index + 1}`).join("\n");
    const cards = await routingCards(ctx, body);
    let jobIds: string[] | null = null;
    const started = startRoutingJobs(ctx, cards).then((ids) => (jobIds = ids));
    await vi.advanceTimersByTimeAsync(ROUTING_TIMEOUT_MS + 1000);
    await started;
    const [first, second] = jobIds ?? [];
    expect(ctx.store.getJob(first ?? "")).toMatchObject({ status: "failed", error: "Timed out after 15 minutes." });
    expect(ctx.store.getCard(cards[0]?.id ?? "")).toMatchObject({ status: "pending", reason: FALLBACK_REASON });
    await vi.waitFor(() => expect(sdk.callsTo("threads.spawn")).toHaveLength(2));
    expect(ctx.store.getJob(second ?? "")?.status).toBe("running");
    finish("thr_late");
    await vi.waitFor(() => expect(sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_late" }]]));
    expect(sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_late" }]]);
    expect(ctx.store.jobForThread("thr_late")).toBeNull();
    expect(ctx.store.getJob(first ?? "")?.status).toBe("failed");
  });

  it("times out a describe job whose spawn hangs", async () => {
    const { ctx, sdk } = await setup();
    hangingSpawn(sdk);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const folder = await tempDir("wiki-routing-img-");
    const file = path.join(folder, "diagram.png");
    await writeFile(file, "PNG");
    let jobId: string | null = null;
    const started = startDescribeJob(ctx, file).then((result) => (jobId = result.jobId));
    await vi.waitFor(() => expect(sdk.callsTo("threads.spawn")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(ROUTING_TIMEOUT_MS + 1000);
    await started;
    expect(ctx.store.getJob(jobId ?? "")).toMatchObject({ status: "failed", error: "Timed out after 15 minutes." });
  });
});
