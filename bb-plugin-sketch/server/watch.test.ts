import { mkdir, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { rect } from "../lib/test-fixtures";
import plugin, { WATCH_SERVICE } from "../server";
import { createSketchContext, pluginDataDir, type SketchContext } from "./context";
import { fakePng, sceneText, tempDir } from "./test-support";
import { changedNames, isSketchEvent, nativeWatch, watchSketches, type WatchFactory, type WatchOptions } from "./watch";

const CONTENT = sceneText([rect(0, 0, 10, 10, { id: "r" })]);

interface Running {
  ctx: SketchContext;
  folder: string;
  signals: () => unknown[];
  stop: () => Promise<void>;
}

const running: Running[] = [];

afterEach(async () => {
  for (const watcher of running.splice(0)) await watcher.stop();
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeWatch(behavior: "ok" | "throw" = "ok") {
  let onEvent: ((fileName: string | null) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;
  let opens = 0;
  let closes = 0;
  const factory: WatchFactory = (_root, event, error) => {
    opens += 1;
    if (behavior === "throw") throw new Error("EMFILE: too many open files, watch");
    onEvent = event;
    onError = error;
    return {
      close: () => {
        closes += 1;
        onEvent = null;
        onError = null;
      },
    };
  };
  return {
    factory,
    emit: (fileName: string | null) => onEvent?.(fileName),
    fail: (error: unknown) => onError?.(error),
    watching: () => onEvent !== null,
    opens: () => opens,
    closes: () => closes,
  };
}

async function start(options: WatchOptions & { createFolder?: boolean } = {}): Promise<Running> {
  const base = await tempDir("sketch-watch-");
  const folder = path.join(base, "Sketches");
  if (options.createFolder !== false) await mkdir(folder);
  const host = createFakePluginHost({ pluginId: "sketch", settings: { sketchDirectory: folder } });
  const ctx = createSketchContext(host.bb);
  const controller = new AbortController();
  const done = watchSketches(ctx, controller.signal, { debounceMs: 60, pollMs: 10_000, ...options });
  const watcher: Running = {
    ctx,
    folder,
    signals: () => host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "sketch-changed").map((signal) => signal.payload),
    stop: async () => {
      controller.abort();
      await done;
    },
  };
  running.push(watcher);
  return watcher;
}

describe("watching the Sketch folder", () => {
  it("publishes a sketch changed outside bb by its id", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory });
    await waitUntil(watch.watching);
    await writeFile(path.join(watcher.folder, "Outside.excalidraw"), CONTENT);
    watch.emit("Outside.excalidraw");
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Outside" }]);
  });

  it("publishes one change for a burst of files", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory, debounceMs: 300 });
    await waitUntil(watch.watching);
    for (const name of ["A", "B", "C"]) {
      await writeFile(path.join(watcher.folder, `${name}.excalidraw`), CONTENT);
      watch.emit(`${name}.excalidraw`);
    }
    await waitUntil(() => watcher.signals().length > 0);
    await pause(500);
    expect(watcher.signals()).toEqual([{ id: null }]);
  });

  it("does not echo its own writes", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory });
    await waitUntil(watch.watching);
    const created = await watcher.ctx.store.create("Mine", CONTENT);
    watch.emit("Mine.excalidraw");
    await pause(120);
    await watcher.ctx.store.save("Mine", sceneText([]), created.sha256);
    watch.emit("Mine.excalidraw");
    await pause(120);
    await watcher.ctx.store.rename("Mine", "Ours");
    watch.emit("Mine.excalidraw");
    watch.emit("Ours.excalidraw");
    await pause(200);
    expect(watcher.signals()).toEqual([{ id: "Mine" }, { id: "Mine" }, { id: "Mine", renamedTo: "Ours" }]);
    await writeFile(path.join(watcher.folder, "Ours.excalidraw"), CONTENT);
    watch.emit("Ours.excalidraw");
    await waitUntil(() => watcher.signals().length > 3);
    expect(watcher.signals().at(-1)).toEqual({ id: "Ours" });
  });

  it("ignores events for dot files and other files", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory });
    await waitUntil(watch.watching);
    await pause(300);
    await writeFile(path.join(watcher.folder, "Quiet.excalidraw"), CONTENT);
    watch.emit(".Quiet.excalidraw.1a2b3c.tmp");
    watch.emit("notes.txt");
    await pause(200);
    expect(watcher.signals()).toEqual([]);
    watch.emit(null);
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Quiet" }]);
  });

  it("drops the image of a sketch deleted outside bb", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory });
    await waitUntil(watch.watching);
    const created = await watcher.ctx.store.create("Plan", CONTENT);
    watch.emit("Plan.excalidraw");
    await pause(300);
    await watcher.ctx.store.savePreview("Plan", created.sha256, fakePng());
    expect(watcher.ctx.previews.get("Plan")).not.toBeNull();
    await unlink(path.join(watcher.folder, "Plan.excalidraw"));
    watch.emit("Plan.excalidraw");
    await waitUntil(() => watcher.signals().length > 1);
    expect(watcher.signals()).toEqual([{ id: "Plan" }, { id: "Plan" }]);
    expect(watcher.ctx.previews.get("Plan")).toBeNull();
  });

  it("polls when the folder can't be watched", async () => {
    const watch = createFakeWatch("throw");
    const watcher = await start({ watchFactory: watch.factory, pollMs: 50 });
    await waitUntil(() => watch.opens() > 0);
    await writeFile(path.join(watcher.folder, "Polled.excalidraw"), CONTENT);
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Polled" }]);
    expect(watch.opens()).toBe(1);
  });

  it("polls after the watch breaks, then tries watching again", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory, pollMs: 50, retryMs: 400 });
    await waitUntil(watch.watching);
    watch.fail(new Error("watcher died"));
    expect(watch.watching()).toBe(false);
    await writeFile(path.join(watcher.folder, "Polled.excalidraw"), CONTENT);
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Polled" }]);
    expect(watch.opens()).toBe(1);
    await waitUntil(() => watch.opens() === 2);
    expect(watch.watching()).toBe(true);
  });

  it("starts watching a folder that appears later, and a replaced one", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory, createFolder: false, pollMs: 50 });
    await pause(150);
    expect(watch.opens()).toBe(0);
    await mkdir(watcher.folder);
    await writeFile(path.join(watcher.folder, "Later.excalidraw"), CONTENT);
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Later" }]);
    await waitUntil(() => watch.opens() === 1);

    await rm(watcher.folder, { recursive: true });
    await mkdir(watcher.folder);
    await waitUntil(() => watch.opens() === 2);
    expect(watch.closes()).toBe(1);
    await waitUntil(() => watcher.signals().length > 1);
    expect(watcher.signals().at(-1)).toEqual({ id: "Later" });
  });

  it("stops when aborted", async () => {
    const watch = createFakeWatch();
    const watcher = await start({ watchFactory: watch.factory });
    await waitUntil(watch.watching);
    await watcher.stop();
    running.splice(running.indexOf(watcher), 1);
    expect(watch.closes()).toBe(1);
    await writeFile(path.join(watcher.folder, "After.excalidraw"), CONTENT);
    watch.emit("After.excalidraw");
    await pause(150);
    expect(watcher.signals()).toEqual([]);
  });

  it("notices outside changes with the real fs.watch, or by polling where it isn't allowed", async () => {
    const watcher = await start({ watchFactory: nativeWatch, pollMs: 80 });
    await pause(150);
    await writeFile(path.join(watcher.folder, "Real.excalidraw"), CONTENT);
    await waitUntil(() => watcher.signals().length > 0);
    expect(watcher.signals()).toEqual([{ id: "Real" }]);
  });
});

describe("the watch service", () => {
  it("clears stale outbox folders and temp files, then runs until stopped", async () => {
    const base = await tempDir("sketch-service-");
    const folder = path.join(base, "Sketches");
    const host = createFakePluginHost({ pluginId: "sketch", settings: { sketchDirectory: folder } });
    await plugin(host.bb);
    const outbox = path.join(pluginDataDir(host.bb.storage), "outbox");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await mkdir(path.join(outbox, "stale"), { recursive: true });
    await mkdir(path.join(outbox, "fresh"), { recursive: true });
    await utimes(path.join(outbox, "stale"), old, old);
    await mkdir(folder);
    for (const name of [".Plan.excalidraw.0123456789ab.tmp", ".Fresh.excalidraw.0123456789ab.tmp", ".keep-me", "Plan.excalidraw"]) {
      await writeFile(path.join(folder, name), CONTENT);
    }
    await utimes(path.join(folder, ".Plan.excalidraw.0123456789ab.tmp"), old, old);
    await utimes(path.join(folder, ".keep-me"), old, old);
    const service = host.harness.behavior.runService(WATCH_SERVICE);
    await waitUntil(async () => (await readdir(outbox)).length === 1 && (await readdir(folder)).length === 3);
    expect(await readdir(outbox)).toEqual(["fresh"]);
    expect((await readdir(folder)).sort()).toEqual([".Fresh.excalidraw.0123456789ab.tmp", ".keep-me", "Plan.excalidraw"]);
    service.controller.abort();
    await service.done;
  });
});

describe("watch helpers", () => {
  it("filters events and diffs snapshots", () => {
    expect(isSketchEvent(null)).toBe(true);
    expect(isSketchEvent("Plan.excalidraw")).toBe(true);
    expect(isSketchEvent("Plan.EXCALIDRAW")).toBe(true);
    expect(isSketchEvent(".Plan.excalidraw.1a2b.tmp")).toBe(false);
    expect(isSketchEvent("notes.md")).toBe(false);
    const before = new Map([
      ["A.excalidraw", "1:1"],
      ["B.excalidraw", "1:1"],
    ]);
    const after = new Map([
      ["A.excalidraw", "1:1"],
      ["B.excalidraw", "2:1"],
      ["C.excalidraw", "1:1"],
    ]);
    expect(changedNames(before, after)).toEqual(["B.excalidraw", "C.excalidraw"]);
    expect(changedNames(after, new Map())).toEqual(["A.excalidraw", "B.excalidraw", "C.excalidraw"]);
  });
});
