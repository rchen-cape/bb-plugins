import { stat } from "node:fs/promises";
import type { SketchContext } from "./context.js";
import { scanEntries } from "./entries.js";
import { errorMessage } from "./errors.js";
import { stampOf } from "./files.js";
import { idOfFileName } from "./names.js";

export type Snapshot = ReadonlyMap<string, string>;
export type Warn = (message: string) => void;

export function changedNames(previous: Snapshot, next: Snapshot): string[] {
  const names = new Set([...previous.keys(), ...next.keys()]);
  return [...names].filter((name) => previous.get(name) !== next.get(name)).sort();
}

async function snapshotOf(root: string): Promise<Snapshot> {
  const entries = await scanEntries(root);
  return new Map(entries.map((entry) => [entry.fileName, stampOf(entry)]));
}

export async function folderIdentity(root: string): Promise<number | null> {
  try {
    const stats = await stat(root);
    return stats.isDirectory() ? stats.ino : null;
  } catch {
    return null;
  }
}

export function warnOnce(log: SketchContext["log"]): Warn {
  let last = "";
  return (message) => {
    if (message !== last) log.warn(message);
    last = message;
  };
}

export function createChecker(ctx: SketchContext, warn: Warn) {
  let snapshot: Snapshot | null = null;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;

  function publish(changed: readonly string[], next: Snapshot): void {
    for (const name of changed) if (!next.has(name)) ctx.previews.remove(idOfFileName(name));
    const only = changed.length === 1 ? changed[0] : undefined;
    ctx.publishChanged(only === undefined ? null : idOfFileName(only));
  }

  async function check(): Promise<void> {
    const next = await snapshotOf(await ctx.root());
    const previous = snapshot;
    snapshot = next;
    if (previous === null) return;
    const changed = changedNames(previous, next).filter((name) => !ctx.echo.consume(name, next.get(name) ?? null));
    if (changed.length > 0) publish(changed, next);
  }

  return {
    async baseline(): Promise<void> {
      try {
        const root = await ctx.root();
        snapshot = await snapshotOf(root);
        if ((await folderIdentity(root)) !== null) ctx.previews.retain([...snapshot.keys()].map(idOfFileName));
      } catch (error) {
        warn(`Sketch folder check failed: ${errorMessage(error)}`);
      }
    },
    request(): void {
      if (queued) return;
      queued = true;
      chain = chain.then(async () => {
        queued = false;
        try {
          await check();
        } catch (error) {
          warn(`Sketch folder check failed: ${errorMessage(error)}`);
        }
      });
    },
    idle(): Promise<void> {
      return chain;
    },
  };
}
