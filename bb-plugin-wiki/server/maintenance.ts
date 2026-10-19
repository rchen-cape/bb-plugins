import type { WikiContext } from "./context.js";
import { cleanupUploads } from "./media.js";

export const MAINTENANCE_SERVICE = "wiki-maintenance";
export const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

export interface MaintenanceOptions {
  intervalMs?: number;
}

type MaintenanceContext = Pick<WikiContext, "bb" | "dataDir" | "log">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanUploadsOnce(ctx: MaintenanceContext): Promise<void> {
  try {
    const removed = await cleanupUploads(ctx);
    if (removed > 0) ctx.log.info(`Wiki removed ${removed} upload${removed === 1 ? "" : "s"} older than 24 hours.`);
  } catch (error) {
    ctx.log.warn(`Wiki upload cleanup failed: ${errorMessage(error)}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function registerMaintenance(ctx: MaintenanceContext, options: MaintenanceOptions = {}): void {
  const intervalMs = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  ctx.bb.background.service(MAINTENANCE_SERVICE, {
    async start(signal) {
      while (!signal.aborted) {
        await cleanUploadsOnce(ctx);
        await sleep(intervalMs, signal);
      }
    },
  });
}
