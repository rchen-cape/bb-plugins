import { watch as watchNative } from "node:fs";
import { SKETCH_EXTENSION } from "../lib/sketch.js";
import type { SketchContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { createChecker, folderIdentity, warnOnce } from "./watch-check.js";

export { changedNames } from "./watch-check.js";

export const WATCH_SERVICE = "watch-sketches";
export const WATCH_DEBOUNCE_MS = 300;
export const WATCH_POLL_MS = 5_000;
export const WATCH_RETRY_MS = 60_000;

export interface WatchHandle {
  close(): void;
}

export type WatchFactory = (root: string, onEvent: (fileName: string | null) => void, onError: (error: unknown) => void) => WatchHandle;

export interface WatchOptions {
  debounceMs?: number;
  pollMs?: number;
  retryMs?: number;
  watchFactory?: WatchFactory;
}

interface Watched {
  root: string;
  identity: number;
  handle: WatchHandle;
}

export const nativeWatch: WatchFactory = (root, onEvent, onError) => {
  const watcher = watchNative(root, { persistent: false }, (_event, fileName) => onEvent(fileName));
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

export function isSketchEvent(fileName: string | null): boolean {
  if (fileName === null) return true;
  return !fileName.startsWith(".") && fileName.toLowerCase().endsWith(SKETCH_EXTENSION);
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function debounce(run: () => void, ms: number) {
  let timer: NodeJS.Timeout | null = null;
  return {
    schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, ms);
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function createWatchSlot(watchFactory: WatchFactory, onChange: () => void, onFailure: (root: string, error: unknown) => void) {
  let watched: Watched | null = null;

  function close(): void {
    watched?.handle.close();
    watched = null;
  }

  function open(root: string, identity: number): boolean {
    let handle: WatchHandle | null = null;
    let failed = false;
    const fail = (error: unknown) => {
      if (handle !== null && watched?.handle !== handle) return;
      failed = true;
      if (handle !== null) close();
      onFailure(root, error);
    };
    try {
      handle = watchFactory(root, (fileName) => {
        if (isSketchEvent(fileName)) onChange();
      }, fail);
    } catch (error) {
      fail(error);
      return false;
    }
    if (failed) {
      handle.close();
      return false;
    }
    watched = { root, identity, handle };
    return true;
  }

  return { open, close, current: (): Watched | null => watched };
}

export async function watchSketches(ctx: SketchContext, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? WATCH_POLL_MS;
  const retryMs = options.retryMs ?? WATCH_RETRY_MS;
  const warn = warnOnce(ctx.log);
  const checker = createChecker(ctx, warn);
  const debounced = debounce(() => checker.request(), options.debounceMs ?? WATCH_DEBOUNCE_MS);
  let retryAt = 0;
  let lastRoot: string | null = null;
  const slot = createWatchSlot(options.watchFactory ?? nativeWatch, () => debounced.schedule(), (root, error) => {
    warn(`Can't watch ${root}, so Sketch checks it every ${Math.max(1, Math.round(pollMs / 1000))} s instead: ${errorMessage(error)}`);
    retryAt = Date.now() + retryMs;
    checker.request();
  });

  const tick = async () => {
    const root = await ctx.root().catch(() => null);
    const identity = root === null ? null : await folderIdentity(root);
    if (root !== lastRoot) {
      lastRoot = root;
      retryAt = 0;
    }
    const watched = slot.current();
    if (watched !== null && (watched.root !== root || watched.identity !== identity)) slot.close();
    const canOpen = slot.current() === null && root !== null && identity !== null && Date.now() >= retryAt;
    if (canOpen && slot.open(root, identity)) debounced.schedule();
    if (slot.current() === null) checker.request();
  };

  try {
    await checker.baseline();
    while (!signal.aborted) {
      await tick();
      await waitFor(pollMs, signal);
    }
  } finally {
    slot.close();
    debounced.cancel();
    await checker.idle();
  }
}
