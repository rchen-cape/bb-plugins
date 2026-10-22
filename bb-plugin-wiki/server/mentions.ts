import type { PluginMentionItem } from "@get-bb/plugin-sdk";
import type { DocSummary } from "../contract.js";
import type { WikiContext } from "./context.js";
import { TOOL_TEXT_LIMIT, docViewText, readDocView } from "./tools.js";

export const MENTION_PROVIDER = "wiki-docs";
export const MENTION_LIMIT = 20;

export function mentionItem(doc: DocSummary): PluginMentionItem {
  return { id: doc.slug, title: doc.title, subtitle: `${doc.type} · @${doc.tag}` };
}

export function mentionContext(text: string): string {
  return `The user attached this Wiki doc to their message. It is the doc's Markdown as saved in their Wiki.\n\n${text}`;
}

// A bare @ has nothing to match yet, so it offers the docs changed most recently.
function mentionDocs(ctx: WikiContext, query: string): DocSummary[] {
  if (query.trim() !== "") return ctx.store.search({ query, type: null, limit: MENTION_LIMIT }).docs;
  return ctx.store
    .listDocs(null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug))
    .slice(0, MENTION_LIMIT);
}

/*
 * The chat composer's @ menu lists Wiki docs. Picking one attaches the doc's
 * Markdown to the message for the agent, read when the message is sent, so
 * the agent gets the doc as it is then.
 */
export function registerMentions(ctx: WikiContext): void {
  ctx.bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER,
    label: "Wiki",
    search({ query }) {
      return mentionDocs(ctx, query).map(mentionItem);
    },
    async resolve(slug) {
      const result = await readDocView(ctx, slug, null);
      if (result.kind !== "found") throw new Error(`The Wiki doc "${slug}" no longer exists.`);
      return { context: mentionContext(docViewText(result.view, TOOL_TEXT_LIMIT)) };
    },
  });
}
