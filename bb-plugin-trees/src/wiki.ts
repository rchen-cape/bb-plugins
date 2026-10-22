import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LinkedWikiDoc, WikiDocRef } from "./wiki-links.js";

export const WIKI_PLUGIN_ID = "wiki";
const WIKI_TIMEOUT_MS = 10_000;

const docsSchema = z.array(
  z
    .object({
      slug: z.string().min(1),
      title: z.string(),
      type: z.string().catch(""),
      tag: z.string().catch(""),
      aliases: z.array(z.string()).catch([]),
    })
    .loose(),
);

const docSchema = z
  .object({ slug: z.string().min(1), title: z.string(), content: z.string() })
  .loose()
  .nullable();

/**
 * The Wiki plugin's docs, read through its RPC. The Wiki is another plugin
 * that may be missing or turned off, so neither call throws: no Wiki reads
 * as no docs.
 */
export interface WikiDocs {
  /** Every doc, or null when the Wiki could not be asked. */
  list(): Promise<WikiDocRef[] | null>;
  /** One doc's saved Markdown, or null when it is gone or unreachable. */
  read(slug: string): Promise<LinkedWikiDoc | null>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWikiDocs(bb: Pick<BbPluginApi, "sdk" | "log">): WikiDocs {
  const signal = () => AbortSignal.timeout(WIKI_TIMEOUT_MS);
  return {
    async list() {
      try {
        const docs = await bb.sdk.plugins.callRpc({
          pluginId: WIKI_PLUGIN_ID,
          method: "docs",
          input: { type: null },
          outputSchema: docsSchema,
          signal: signal(),
        });
        return docs.map(({ slug, title, type, tag, aliases }) => ({
          slug,
          title,
          type,
          tag,
          aliases,
        }));
      } catch (error) {
        bb.log.warn(
          `Project Trees could not list the Wiki's docs: ${errorText(error)}`,
        );
        return null;
      }
    },
    async read(slug) {
      try {
        const doc = await bb.sdk.plugins.callRpc({
          pluginId: WIKI_PLUGIN_ID,
          method: "doc",
          input: { slug },
          outputSchema: docSchema,
          signal: signal(),
        });
        return doc === null
          ? null
          : { slug: doc.slug, title: doc.title, content: doc.content };
      } catch (error) {
        bb.log.warn(
          `Project Trees could not read the Wiki doc ${slug}: ${errorText(error)}`,
        );
        return null;
      }
    },
  };
}
