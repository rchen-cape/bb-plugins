import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./server/cli.js";
import { createSketchContext, type SketchContext } from "./server/context.js";
import { errorMessage } from "./server/errors.js";
import { sweepTempFiles } from "./server/files.js";
import { OUTBOX_STALE_MS, sweepOutbox } from "./server/outbox.js";
import { registerRpc } from "./server/rpc.js";
import { WATCH_SERVICE, watchSketches } from "./server/watch.js";

export { rpcContract } from "./contract.js";
export { WATCH_SERVICE } from "./server/watch.js";

type Registrar = (ctx: SketchContext) => void;

async function sweepQuietly(ctx: SketchContext): Promise<void> {
  try {
    await sweepOutbox(ctx.dataDir());
    await sweepTempFiles(await ctx.root(), OUTBOX_STALE_MS);
  } catch (error) {
    ctx.log.warn(`Couldn't clear old Sketch temp files: ${errorMessage(error)}`);
  }
}

function registerWatcher(ctx: SketchContext): void {
  ctx.bb.background.service(WATCH_SERVICE, {
    start: async (signal) => {
      await sweepQuietly(ctx);
      await watchSketches(ctx, signal);
    },
  });
}

const REGISTRARS: readonly Registrar[] = [registerWatcher, registerRpc, registerCli];

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx = createSketchContext(bb);
  for (const register of REGISTRARS) register(ctx);
}
