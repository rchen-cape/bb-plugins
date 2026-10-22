import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./server/cli.js";
import { createWikiContext, type WikiContext } from "./server/context.js";
import { registerHttp } from "./server/http.js";
import { registerMaintenance } from "./server/maintenance.js";
import { registerMentions } from "./server/mentions.js";
import { registerRouting } from "./server/routing.js";
import { registerRpc } from "./server/rpc.js";
import { registerSchedule } from "./server/schedule.js";
import { registerTools } from "./server/tools.js";

export { rpcContract } from "./contract.js";

export const WATCH_SERVICE = "watch-wiki";
const INITIAL_SYNC_BUDGET_MS = 10_000;

type Registrar = (ctx: WikiContext) => void | Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerWatcher(ctx: WikiContext): void {
  ctx.bb.background.service(WATCH_SERVICE, {
    start: (signal) => ctx.vault.watch(signal, ctx.publishChanged),
  });
}

function registerCommitFlush(ctx: WikiContext): void {
  ctx.bb.onDispose(() => ctx.vault.closeCommits());
}

const REGISTRARS: readonly Registrar[] = [
  registerCommitFlush,
  registerWatcher,
  registerRpc,
  registerTools,
  registerMentions,
  registerCli,
  registerHttp,
  registerRouting,
  registerSchedule,
  registerMaintenance,
];

async function syncIndex(ctx: WikiContext): Promise<void> {
  try {
    const { changed } = await ctx.vault.syncAll();
    if (changed > 0) ctx.publishChanged();
  } catch (error) {
    ctx.log.warn(`Wiki index sync failed: ${errorMessage(error)}`);
  }
}

function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx = await createWikiContext(bb);
  for (const register of REGISTRARS) await register(ctx);
  await settleWithin(syncIndex(ctx), INITIAL_SYNC_BUDGET_MS);
}
