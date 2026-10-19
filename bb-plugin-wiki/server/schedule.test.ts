import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWikiContext } from "./context";
import {
  LAST_INGEST_KEY,
  SCHEDULE_SERVICE,
  localTimeOfDay,
  nextIngestDue,
  readLastIngestDate,
  registerSchedule,
  runDueIngest,
} from "./schedule";

const NEW_YORK = { ingestTime: "07:00", timezone: "America/New_York" };

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-schedule-wiki-");
  const notes = await tempDir("wiki-schedule-notes-");
  await mkdir(path.join(notes, "Time"), { recursive: true });
  await writeFile(path.join(notes, "Time", "10-14-26.md"), "# Day\n\n## NOTES\n\n- Something worth keeping\n");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki, notesDirectory: notes, gitHistory: false, routingAgent: false, ...NEW_YORK, ...settings },
  });
  const ctx = await createWikiContext(host.bb);
  return { ctx, harness: host.harness, bb: host.bb };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("localTimeOfDay", () => {
  it("formats 24-hour local time in the zone", () => {
    expect(localTimeOfDay(new Date("2026-10-15T04:05:00Z"), "America/New_York")).toBe("00:05");
    expect(localTimeOfDay(new Date("2026-10-15T22:30:00Z"), "Asia/Tokyo")).toBe("07:30");
  });
});

describe("nextIngestDue", () => {
  it("waits until the ingest time in the configured zone", () => {
    expect(nextIngestDue(new Date("2026-10-15T10:59:00Z"), NEW_YORK, null)).toBe(false);
    expect(nextIngestDue(new Date("2026-10-15T11:00:00Z"), NEW_YORK, null)).toBe(true);
    expect(nextIngestDue(new Date("2026-10-15T11:30:00Z"), { ...NEW_YORK, timezone: "America/Los_Angeles" }, null)).toBe(false);
  });

  it("runs once per local day and catches up on missed days", () => {
    const morning = new Date("2026-10-15T12:00:00Z");
    expect(nextIngestDue(morning, NEW_YORK, "2026-10-15")).toBe(false);
    expect(nextIngestDue(morning, NEW_YORK, "2026-10-14")).toBe(true);
    expect(nextIngestDue(morning, NEW_YORK, "2026-10-01")).toBe(true);
    expect(nextIngestDue(new Date("2026-10-15T10:00:00Z"), NEW_YORK, "2026-10-12")).toBe(false);
  });

  it("uses the local date, not the UTC date", () => {
    const lateEvening = new Date("2026-10-16T02:00:00Z");
    expect(nextIngestDue(lateEvening, NEW_YORK, "2026-10-15")).toBe(false);
    expect(nextIngestDue(lateEvening, { ...NEW_YORK, timezone: "Asia/Tokyo" }, "2026-10-15")).toBe(true);
  });

  it("treats midnight as 00:00 and an empty zone as the system zone", () => {
    expect(nextIngestDue(new Date("2026-10-15T04:00:00Z"), { ingestTime: "00:00", timezone: "America/New_York" }, "2026-10-14")).toBe(true);
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const hour of [0, 6, 12, 18]) {
      const now = new Date(Date.UTC(2026, 9, 15, hour, 30));
      expect(nextIngestDue(now, { ingestTime: "07:00", timezone: "" }, "2026-10-14")).toBe(
        nextIngestDue(now, { ingestTime: "07:00", timezone: system }, "2026-10-14"),
      );
    }
  });
});

describe("runDueIngest", () => {
  it("ingests when due, then records today as the last ingest date", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T12:00:00Z") });
    const { ctx, bb } = await setup();
    const result = await runDueIngest(ctx, new Date());
    expect(result).toMatchObject({ notesScanned: 1, cardsCreated: 1 });
    expect(await bb.storage.kv.get(LAST_INGEST_KEY)).toBe("2026-10-15");
    expect(await readLastIngestDate(ctx)).toBe("2026-10-15");
    expect(await runDueIngest(ctx, new Date())).toBeNull();
  });

  it("does nothing when the daily ingest is off or not yet due", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T12:00:00Z") });
    const off = await setup({ ingestEnabled: false });
    expect(await runDueIngest(off.ctx, new Date())).toBeNull();
    expect(off.ctx.store.openCount()).toBe(0);
    const early = await setup({ ingestTime: "09:00" });
    expect(await runDueIngest(early.ctx, new Date())).toBeNull();
    expect(await early.bb.storage.kv.get(LAST_INGEST_KEY)).toBeUndefined();
  });

  it("ignores a malformed stored date", async () => {
    const { ctx, bb } = await setup();
    await bb.storage.kv.set(LAST_INGEST_KEY, "yesterday");
    expect(await readLastIngestDate(ctx)).toBeNull();
  });
});

describe("registerSchedule", () => {
  it("runs the due ingest from a background service until aborted", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T12:00:00Z") });
    const { ctx, harness, bb } = await setup();
    registerSchedule(ctx, { intervalMs: 5 });
    expect(harness.inspection.registrations.services.map((service) => service.name)).toEqual([SCHEDULE_SERVICE]);
    const service = harness.behavior.runService(SCHEDULE_SERVICE);
    await vi.waitFor(() => expect(ctx.store.openCount()).toBe(1));
    await vi.waitFor(async () => expect(await bb.storage.kv.get(LAST_INGEST_KEY)).toBe("2026-10-15"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.controller.abort();
    await service.done;
    expect(harness.inspection.logEntries.filter((entry) => entry.message.startsWith("Wiki daily ingest:"))).toHaveLength(1);
  });

  it("logs a repeating failure once and keeps running", async () => {
    const { ctx, harness } = await setup();
    let calls = 0;
    const broken = {
      ...ctx,
      settings: async () => {
        calls += 1;
        throw new Error("settings unavailable");
      },
    };
    registerSchedule(broken, { intervalMs: 2 });
    const service = harness.behavior.runService(SCHEDULE_SERVICE);
    await vi.waitFor(() => expect(calls).toBeGreaterThan(3));
    service.controller.abort();
    await service.done;
    const warnings = harness.inspection.logEntries.filter((entry) => entry.level === "warn");
    expect(warnings.map((entry) => entry.message)).toEqual(["Wiki daily ingest failed: settings unavailable"]);
  });
});
