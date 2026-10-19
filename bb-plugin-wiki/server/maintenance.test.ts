import { mkdtemp, readdir, realpath, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createWikiContext } from "./context";
import { MAINTENANCE_INTERVAL_MS, MAINTENANCE_SERVICE, registerMaintenance } from "./maintenance";
import { saveUpload, uploadPath, uploadsDir } from "./media";

async function setup() {
  const wiki = await realpath(await mkdtemp(path.join(tmpdir(), "wiki-maintenance-")));
  const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: wiki, gitHistory: false } });
  const ctx = await createWikiContext(host.bb);
  return { ctx, harness: host.harness };
}

async function oldUpload(ctx: Awaited<ReturnType<typeof setup>>["ctx"], name: string): Promise<string> {
  const saved = await saveUpload(ctx, name, new Blob(["data"]).stream(), 4);
  const past = new Date(Date.now() - 25 * 60 * 60_000);
  const folder = uploadsDir(ctx);
  for (const entry of await readdir(folder)) {
    if (entry.startsWith(saved.uploadId)) await utimes(path.join(folder, entry), past, past);
  }
  return saved.uploadId;
}

describe("registerMaintenance", () => {
  it("cleans old uploads at start and again on every interval until aborted", async () => {
    const { ctx, harness } = await setup();
    const first = await oldUpload(ctx, "first.png");
    registerMaintenance(ctx, { intervalMs: 5 });
    expect(harness.inspection.registrations.services.map((service) => service.name)).toEqual([MAINTENANCE_SERVICE]);
    const service = harness.behavior.runService(MAINTENANCE_SERVICE);
    await vi.waitFor(async () => expect(await uploadPath(ctx, first)).toBeNull());
    const second = await oldUpload(ctx, "second.png");
    await vi.waitFor(async () => expect(await uploadPath(ctx, second)).toBeNull());
    service.controller.abort();
    await service.done;
    const removals = harness.inspection.logEntries.filter((entry) => entry.message === "Wiki removed 1 upload older than 24 hours.");
    expect(removals).toHaveLength(2);
  });

  it("runs hourly by default and stops promptly when aborted mid-wait", async () => {
    const { ctx, harness } = await setup();
    expect(MAINTENANCE_INTERVAL_MS).toBe(60 * 60_000);
    const upload = await oldUpload(ctx, "old.png");
    registerMaintenance(ctx);
    const service = harness.behavior.runService(MAINTENANCE_SERVICE);
    await vi.waitFor(async () => expect(await uploadPath(ctx, upload)).toBeNull());
    service.controller.abort();
    await service.done;
  });

  it("logs a failed cleanup and keeps running", async () => {
    const { ctx, harness } = await setup();
    let calls = 0;
    const broken = {
      ...ctx,
      dataDir: () => {
        calls += 1;
        throw new Error("no data folder");
      },
    };
    registerMaintenance(broken, { intervalMs: 2 });
    const service = harness.behavior.runService(MAINTENANCE_SERVICE);
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2));
    service.controller.abort();
    await service.done;
    const warnings = harness.inspection.logEntries.filter((entry) => entry.level === "warn");
    expect(warnings.length).toBeGreaterThan(1);
    expect(new Set(warnings.map((entry) => entry.message))).toEqual(new Set(["Wiki upload cleanup failed: no data folder"]));
  });
});
