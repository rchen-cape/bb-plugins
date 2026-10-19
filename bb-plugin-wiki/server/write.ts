import type { DocTarget } from "../contract.js";
import { todayInZone } from "../lib/daily-notes.js";
import { formatSourceMarker, type SourceMarker } from "../lib/markdown-doc.js";
import type { WikiContext } from "./context.js";

export interface AppendInput {
  target: DocTarget;
  heading: string;
  block: string;
}

export interface AppendResult {
  slug: string;
  title: string;
  created: boolean;
}

export function sourceBlock(marker: SourceMarker, text: string): string {
  return `${formatSourceMarker(marker)}\n${text}`;
}

export async function todayIso(ctx: Pick<WikiContext, "settings">, now: Date = new Date()): Promise<string> {
  return todayInZone((await ctx.settings()).timezone, now);
}

function titleOf(ctx: WikiContext, slug: string, fallback: string): string {
  return ctx.store.getDoc(slug)?.title ?? fallback;
}

export async function appendToTarget(ctx: WikiContext, input: AppendInput): Promise<AppendResult> {
  const { target, heading, block } = input;
  return ctx.vault.runExclusive(async () => {
    if (target.kind === "existing") {
      await ctx.vault.appendBlock(target.slug, heading, block);
      return { slug: target.slug, title: titleOf(ctx, target.slug, target.slug), created: false };
    }
    const { slug } = await ctx.vault.createDoc(
      { title: target.title, type: target.type, aliases: target.aliases },
      { heading, block },
    );
    return { slug, title: titleOf(ctx, slug, target.title), created: true };
  });
}
