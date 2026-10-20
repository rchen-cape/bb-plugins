import { mkdir, readdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  saveResultSchema,
  sketchDetailSchema,
  sketchSummarySchema,
  statusSchema,
  type SketchDetail,
  type SketchSummary,
} from "./contract";
import { rect, text } from "./lib/test-fixtures";
import { CHANGED_CHANNEL } from "./lib/sketch";
import { WATCH_SERVICE } from "./server";
import { fakePng, sceneText, setup, tempDir, type Setup } from "./server/test-support";

const PLAN = sceneText([rect(0, 0, 100, 60, { id: "box" }), text({ x: 10, y: 10 }, "Billing flow", { id: "label" })]);
const OTHER = sceneText([rect(5, 5, 20, 20, { id: "other" })]);

const listSchema = z.array(sketchSummarySchema);

async function create(rpc: Setup["rpc"], title: string | null, content: string | null = null): Promise<SketchDetail> {
  return sketchDetailSchema.parse(await rpc("create", { title, content }));
}

async function list(rpc: Setup["rpc"]): Promise<SketchSummary[]> {
  return listSchema.parse(await rpc("list", {}));
}

async function files(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

describe("sketch storage", () => {
  it("creates the folder on first write and numbers Untitled sketches", async () => {
    const { rpc, folder } = await setup();
    expect(await list(rpc)).toEqual([]);
    await expect(stat(folder)).rejects.toThrow();

    const first = await create(rpc, null);
    const second = await create(rpc, null);
    const third = await create(rpc, "untitled");
    expect([first.id, second.id, third.id]).toEqual(["Untitled", "Untitled 2", "untitled 3"]);
    expect(first).toMatchObject({ title: "Untitled", elementCount: 0 });
    expect(await files(folder)).toEqual(["Untitled 2.excalidraw", "Untitled.excalidraw", "untitled 3.excalidraw"]);
    expect(JSON.parse(await readFile(path.join(folder, "Untitled.excalidraw"), "utf8"))).toMatchObject({ type: "excalidraw", elements: [] });
  });

  it("lists sketches newest first with element counts and ignores everything else", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    await create(rpc, "Other", OTHER);
    await writeFile(path.join(folder, "Broken.excalidraw"), "{ nope");
    await writeFile(path.join(folder, ".hidden.excalidraw"), OTHER);
    await writeFile(path.join(folder, "notes.txt"), "hi");
    await mkdir(path.join(folder, "folder.excalidraw"));
    await symlink(path.join(folder, "Plan.excalidraw"), path.join(folder, "Link.excalidraw"));
    await utimes(path.join(folder, "Plan.excalidraw"), new Date("2026-01-03"), new Date("2026-01-03"));
    await utimes(path.join(folder, "Other.excalidraw"), new Date("2026-01-02"), new Date("2026-01-02"));
    await utimes(path.join(folder, "Broken.excalidraw"), new Date("2026-01-01"), new Date("2026-01-01"));

    const sketches = await list(rpc);
    expect(sketches.map((sketch) => [sketch.id, sketch.elementCount])).toEqual([
      ["Plan", 2],
      ["Other", 1],
      ["Broken", 0],
    ]);
    expect(sketches[0]).toMatchObject({ title: "Plan", updatedAt: "2026-01-03T00:00:00.000Z", sizeBytes: Buffer.byteLength(PLAN) });
  });

  it("gets the exact file with its sha256, and nothing for another case", async () => {
    const { rpc } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    const got = sketchDetailSchema.parse(await rpc("get", { id: "Plan" }));
    expect(got.content).toBe(PLAN);
    expect(got.sha256).toBe(created.sha256);
    expect(got.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await rpc("get", { id: "plan" })).toBeNull();
    expect(await rpc("get", { id: "Missing" })).toBeNull();
    await expect(rpc("get", { id: "../etc/passwd" })).rejects.toThrow();
  });

  it("refuses content that isn't an Excalidraw file and writes nothing", async () => {
    const { rpc, folder } = await setup();
    await expect(create(rpc, "Bad", "{ nope")).rejects.toThrow("This isn't valid JSON.");
    await expect(create(rpc, "Bad", JSON.stringify({ type: "something-else", elements: [] }))).rejects.toThrow("This is not an Excalidraw file.");
    await expect(stat(folder)).rejects.toThrow();
    const ok = await create(rpc, "Good", PLAN);
    await expect(rpc("save", { id: ok.id, content: "[]", expectedSha256: ok.sha256 })).rejects.toThrow("This is not an Excalidraw file.");
    expect(await readFile(path.join(folder, "Good.excalidraw"), "utf8")).toBe(PLAN);
  });

  it("turns titles into safe file names", async () => {
    const { rpc } = await setup();
    expect((await create(rpc, "Q3: plan/ideas")).id).toBe("Q3- plan-ideas");
    expect((await create(rpc, ".hidden")).id).toBe("hidden");
    expect((await create(rpc, "Flow.excalidraw")).id).toBe("Flow");
    expect((await create(rpc, "  spaced   out  ")).id).toBe("spaced out");
    await expect(create(rpc, "   ")).rejects.toThrow();
  });

  it("gives a taken title the next free number, case-insensitively", async () => {
    const { rpc } = await setup();
    await create(rpc, "Plan");
    expect((await create(rpc, "plan")).id).toBe("plan 2");
    expect((await create(rpc, "PLAN")).id).toBe("PLAN 3");
  });

  it("picks distinct names for concurrent creates", async () => {
    const { rpc, folder } = await setup();
    const created = await Promise.all(Array.from({ length: 6 }, () => create(rpc, null)));
    expect(new Set(created.map((sketch) => sketch.id)).size).toBe(6);
    expect(await files(folder)).toHaveLength(6);
  });
});

describe("saving", () => {
  it("writes when the sha matches and reports a conflict otherwise", async () => {
    const { rpc, folder } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    const written = saveResultSchema.parse(await rpc("save", { id: "Plan", content: OTHER, expectedSha256: created.sha256 }));
    expect(written.outcome).toBe("written");
    if (written.outcome !== "written") throw new Error("expected a write");
    expect(written.sha256).not.toBe(created.sha256);

    expect(await rpc("save", { id: "Plan", content: PLAN, expectedSha256: created.sha256 })).toEqual({ outcome: "conflict" });
    expect(await readFile(path.join(folder, "Plan.excalidraw"), "utf8")).toBe(OTHER);

    const forced = saveResultSchema.parse(await rpc("save", { id: "Plan", content: PLAN, expectedSha256: null }));
    expect(forced).toMatchObject({ outcome: "written", sha256: created.sha256 });
    expect(await readFile(path.join(folder, "Plan.excalidraw"), "utf8")).toBe(PLAN);
  });

  it("reports a conflict when the file is gone, and recreates it when the check is skipped", async () => {
    const { rpc, folder } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    await unlink(path.join(folder, "Plan.excalidraw"));
    expect(await rpc("save", { id: "Plan", content: OTHER, expectedSha256: created.sha256 })).toEqual({ outcome: "conflict" });
    expect(await rpc("save", { id: "Plan", content: OTHER, expectedSha256: null })).toMatchObject({ outcome: "written" });
    expect(await readFile(path.join(folder, "Plan.excalidraw"), "utf8")).toBe(OTHER);
  });

  it("never writes over a sketch whose name differs only in case", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    await expect(rpc("save", { id: "plan", content: OTHER, expectedSha256: null })).rejects.toThrow("Another sketch is already named “Plan”.");
    expect(await files(folder)).toEqual(["Plan.excalidraw"]);
    expect(await readFile(path.join(folder, "Plan.excalidraw"), "utf8")).toBe(PLAN);
  });

  it("skips writing identical content", async () => {
    const { rpc, folder, signals } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    const before = (await stat(path.join(folder, "Plan.excalidraw"))).mtimeMs;
    const published = signals().length;
    const result = await rpc("save", { id: "Plan", content: PLAN, expectedSha256: created.sha256 });
    expect(result).toEqual({ outcome: "written", sha256: created.sha256, updatedAt: created.updatedAt });
    expect((await stat(path.join(folder, "Plan.excalidraw"))).mtimeMs).toBe(before);
    expect(signals()).toHaveLength(published);
  });

  it("serializes concurrent saves and leaves no temp files", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    const contents = Array.from({ length: 8 }, (_, index) => sceneText([rect(index, index, 10, 10, { id: `r${index}` })]));
    await Promise.all(contents.map((content) => rpc("save", { id: "Plan", content, expectedSha256: null })));
    expect(await files(folder)).toEqual(["Plan.excalidraw"]);
    expect(contents).toContain(await readFile(path.join(folder, "Plan.excalidraw"), "utf8"));
  });

  it("publishes a change after every write", async () => {
    const { rpc, signals } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    await rpc("save", { id: "Plan", content: OTHER, expectedSha256: created.sha256 });
    await rpc("duplicate", { id: "Plan" });
    await rpc("rename", { id: "Plan copy", title: "Copy" });
    await rpc("delete", { id: "Copy" });
    expect(signals()).toEqual([{ id: "Plan" }, { id: "Plan" }, { id: "Plan copy" }, { id: "Plan copy", renamedTo: "Copy" }, { id: "Copy" }]);
    expect(CHANGED_CHANNEL).toBe("sketch-changed");
  });
});

describe("rename, duplicate and delete", () => {
  it("renames the file and refuses a name another sketch has, in any case", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    await create(rpc, "Other", OTHER);
    expect(sketchSummarySchema.parse(await rpc("rename", { id: "Plan", title: "Billing flow" }))).toMatchObject({ id: "Billing flow", elementCount: 2 });
    await expect(rpc("rename", { id: "Billing flow", title: "other" })).rejects.toThrow("A sketch named “Other” already exists.");
    await expect(rpc("rename", { id: "Missing", title: "Whatever" })).rejects.toThrow("No sketch is named “Missing”.");
    expect(await files(folder)).toEqual(["Billing flow.excalidraw", "Other.excalidraw"]);
  });

  it("allows a case-only rename of the same sketch", async () => {
    const { rpc, folder } = await setup();
    const created = await create(rpc, "plan", PLAN);
    expect(sketchSummarySchema.parse(await rpc("rename", { id: "plan", title: "Plan" })).id).toBe("Plan");
    expect(await files(folder)).toEqual(["Plan.excalidraw"]);
    expect(sketchDetailSchema.parse(await rpc("get", { id: "Plan" })).sha256).toBe(created.sha256);
    expect(sketchSummarySchema.parse(await rpc("rename", { id: "Plan", title: "Plan" })).id).toBe("Plan");
  });

  it("duplicates to <name> copy, then copy 2, keeping the content", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    const copies = [];
    for (const id of ["Plan", "Plan", "Plan copy"]) copies.push(sketchSummarySchema.parse(await rpc("duplicate", { id })).id);
    expect(copies).toEqual(["Plan copy", "Plan copy 2", "Plan copy 3"]);
    expect(await readFile(path.join(folder, "Plan copy 2.excalidraw"), "utf8")).toBe(PLAN);
    await expect(rpc("duplicate", { id: "Nope" })).rejects.toThrow("No sketch is named “Nope”.");
  });

  it("deletes the file and its preview", async () => {
    const { rpc, folder, host } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    await rpc("savePreview", { id: "Plan", sha256: created.sha256, png: fakePng().toString("base64") });
    expect(await rpc("delete", { id: "Plan" })).toEqual({ id: "Plan" });
    expect(await files(folder)).toEqual([]);
    expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM previews").get()).toEqual({ n: 0 });
    await expect(rpc("delete", { id: "Plan" })).rejects.toThrow("No sketch is named “Plan”.");
  });
});

describe("previews", () => {
  it("stores a preview only for the file's current sha", async () => {
    const { rpc } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    const png = fakePng().toString("base64");
    expect(await rpc("savePreview", { id: "Plan", sha256: "0".repeat(64), png })).toEqual({ stored: false });
    expect(await rpc("savePreview", { id: "Missing", sha256: created.sha256, png })).toEqual({ stored: false });
    expect(await rpc("savePreview", { id: "Plan", sha256: created.sha256, png })).toEqual({ stored: true });
  });

  it("refuses bytes that aren't a PNG", async () => {
    const { rpc } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    await expect(rpc("savePreview", { id: "Plan", sha256: created.sha256, png: Buffer.from("GIF89a-not-a-png").toString("base64") })).rejects.toThrow(
      "That image isn't a PNG.",
    );
    await expect(rpc("savePreview", { id: "Plan", sha256: created.sha256, png: "***" })).rejects.toThrow("rpc input validation failed");
  });

  it("follows renames and duplicates", async () => {
    const { rpc, cli, folder } = await setup();
    const created = await create(rpc, "Plan", PLAN);
    await rpc("savePreview", { id: "Plan", sha256: created.sha256, png: fakePng(8, 8).toString("base64") });
    await rpc("rename", { id: "Plan", title: "Flow" });
    await rpc("duplicate", { id: "Flow" });
    for (const name of ["Flow", "Flow copy"]) {
      const out = path.join(folder, "..", `${name}.png`);
      expect((await cli(["export", name, "--out", out])).exitCode).toBe(0);
      expect(await readFile(out)).toEqual(fakePng(8, 8));
    }
  });
});

describe("status and settings", () => {
  it("reports the folder, the count, and the Wiki", async () => {
    const { rpc, folder } = await setup();
    await create(rpc, "Plan", PLAN);
    expect(statusSchema.parse(await rpc("status", {}))).toEqual({ directory: folder, sketchCount: 1, wiki: { available: true, inbox: true } });
  });

  it("falls back to ~/Sketches when the stored folder is unusable", async () => {
    for (const sketchDirectory of ["relative/folder", "~", "/"]) {
      const { rpc } = await setup({ settings: { sketchDirectory } });
      expect(statusSchema.parse(await rpc("status", {})).directory).toBe("~/Sketches");
    }
  });

  it("moves to a new folder when the setting changes", async () => {
    const { host, rpc, signals } = await setup();
    await create(rpc, "Plan", PLAN);
    const other = path.join(await tempDir("sketch-other-"), "More sketches");
    await host.harness.behavior.setSettings({ sketchDirectory: other });
    expect(signals().at(-1)).toEqual({ id: null });
    expect(await list(rpc)).toEqual([]);
    expect(statusSchema.parse(await rpc("status", {}))).toMatchObject({ directory: other, sketchCount: 0 });
    expect((await create(rpc, null)).id).toBe("Untitled");
    expect(await files(other)).toEqual(["Untitled.excalidraw"]);
  });

  it("registers the watcher service", async () => {
    const { host } = await setup();
    expect(host.harness.inspection.registrations.services.map((service) => service.name)).toContain(WATCH_SERVICE);
  });
});
