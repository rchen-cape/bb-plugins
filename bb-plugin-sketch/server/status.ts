import type { SketchStatus, WikiAvailability, WikiDoc } from "../contract.js";
import type { SketchContext } from "./context.js";
import { displayFolder } from "./folder.js";
import { contractDoc } from "./wiki.js";

export async function statusOf(ctx: SketchContext): Promise<SketchStatus> {
  const root = await ctx.root();
  const [sketchCount, wiki] = await Promise.all([ctx.store.count(), ctx.wiki.availability()]);
  return { directory: displayFolder(root), sketchCount, wiki };
}

export async function wikiDocsOf(ctx: SketchContext): Promise<{ wiki: WikiAvailability; docs: WikiDoc[] }> {
  const { wiki, docs } = await ctx.wiki.docs();
  return { wiki, docs: docs.map(contractDoc) };
}
