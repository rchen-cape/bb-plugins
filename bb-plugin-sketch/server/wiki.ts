import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SendResult, WikiAvailability, WikiDestination, WikiDoc, WikiSuggestion } from "../contract.js";
import { WIKI_PLUGIN_ID } from "../lib/sketch.js";
import { errorMessage, SketchError } from "./errors.js";
import { pngName, sweepOutbox, withOutboxFile } from "./outbox.js";
import { isPng } from "./previews.js";
import { createInboxCheck } from "./wiki-inbox.js";
import { isUnknownMethod, WIKI_NOT_INSTALLED, WIKI_NOT_RUNNING, WIKI_TURNED_OFF, wikiAnswered, wikiFailure } from "./wiki-errors.js";

export const WIKI_TIMEOUT_MS = 15_000;
export const WIKI_SEND_TIMEOUT_MS = 120_000;
export const WIKI_SUGGESTION_LIMIT = 5;
export const WIKI_DEFAULT_HEADING = "Unsorted";

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "degraded"]);

const pluginListSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string(),
      status: z.string().catch("missing"),
      enabled: z.boolean().catch(true),
      version: z.string().catch(""),
      updatedAt: z.string().optional().catch(undefined),
    }),
  ),
});

const docsSchema = z.array(
  z.object({
    slug: z.string(),
    title: z.string(),
    type: z.string().catch("topic"),
    aliases: z.array(z.string()).catch([]),
    tag: z.string().catch(""),
    headings: z.array(z.string()).catch([]),
  }),
);

const suggestSchema = z.object({
  suggestions: z.array(
    z.object({ slug: z.string(), title: z.string(), heading: z.string().nullable().catch(null), reason: z.string().catch("") }),
  ),
});

const cardSchema = z.object({ id: z.string() });
const addedSchema = z.object({ slug: z.string(), title: z.string() });

type ListedPlugin = z.infer<typeof pluginListSchema>["plugins"][number];
export type WikiDocEntry = z.infer<typeof docsSchema>[number];

export type SendTarget =
  | { kind: "inbox"; proposal: { slug: string; heading: string } | null }
  | { kind: "doc"; slug: string; heading: string };

export interface SendRequest {
  name: string;
  png: Uint8Array;
  caption: string;
  note: string;
  target: SendTarget;
  threadId: string | null;
}

interface WikiDeps {
  bb: BbPluginApi;
  dataDir: () => string;
  log: BbPluginApi["log"];
}

function unavailable(reason: string): WikiAvailability {
  return { available: false, reason };
}

export function runningProblem(plugin: ListedPlugin | undefined): string | null {
  if (plugin === undefined) return WIKI_NOT_INSTALLED;
  if (!plugin.enabled || plugin.status === "disabled") return WIKI_TURNED_OFF;
  return RUNNING_STATUSES.has(plugin.status) ? null : WIKI_NOT_RUNNING;
}

export function targetOf(destination: WikiDestination): SendTarget {
  return destination.kind === "inbox" ? { kind: "inbox", proposal: null } : destination;
}

export function contractDoc(doc: WikiDocEntry): WikiDoc {
  return { slug: doc.slug, title: doc.title, type: doc.type, aliases: doc.aliases, tag: doc.tag, headings: doc.headings };
}

function mediaOf(request: SendRequest, file: string) {
  return [{ from: { kind: "path", path: file }, caption: request.caption }];
}

export function createWikiClient(deps: WikiDeps) {
  const signal = () => AbortSignal.timeout(WIKI_TIMEOUT_MS);
  const sendSignal = () => AbortSignal.timeout(WIKI_SEND_TIMEOUT_MS);
  const inbox = createInboxCheck(() =>
    deps.bb.sdk.plugins.callRpc({ pluginId: WIKI_PLUGIN_ID, method: "addCard", input: {}, outputSchema: z.unknown(), signal: signal() }),
  );

  async function listedWiki(): Promise<ListedPlugin | undefined> {
    const listed = pluginListSchema.parse(await deps.bb.sdk.plugins.list({ signal: signal() }));
    return listed.plugins.find((plugin) => plugin.id === WIKI_PLUGIN_ID);
  }

  async function availability(): Promise<WikiAvailability> {
    let plugin: ListedPlugin | undefined;
    try {
      plugin = await listedWiki();
    } catch (error) {
      return unavailable(`Couldn't check the Wiki plugin: ${errorMessage(error)}`);
    }
    const problem = runningProblem(plugin);
    if (problem !== null || plugin === undefined) return unavailable(problem ?? WIKI_NOT_INSTALLED);
    return { available: true, inbox: await inbox.supported(plugin) };
  }

  async function docs(): Promise<{ wiki: WikiAvailability; docs: WikiDocEntry[] }> {
    const wiki = await availability();
    if (!wiki.available) return { wiki, docs: [] };
    try {
      const found = await deps.bb.sdk.plugins.callRpc({
        pluginId: WIKI_PLUGIN_ID,
        method: "docs",
        input: { type: null },
        outputSchema: docsSchema,
        signal: signal(),
      });
      return { wiki, docs: found };
    } catch (error) {
      return { wiki: unavailable(wikiFailure(error, "docs").message), docs: [] };
    }
  }

  async function suggest(text: string, title: string | null): Promise<WikiSuggestion[]> {
    try {
      const found = await deps.bb.sdk.plugins.callRpc({
        pluginId: WIKI_PLUGIN_ID,
        method: "suggest",
        input: { text, title },
        outputSchema: suggestSchema,
        signal: signal(),
      });
      return found.suggestions
        .slice(0, WIKI_SUGGESTION_LIMIT)
        .map((suggestion) => ({ slug: suggestion.slug, title: suggestion.title, heading: suggestion.heading, reason: suggestion.reason }));
    } catch (error) {
      deps.log.debug(`Wiki suggestions failed: ${wikiFailure(error, "suggest").message}`);
      return [];
    }
  }

  async function addToDoc(request: SendRequest, slug: string, heading: string, file: string): Promise<SendResult> {
    const added = await deps.bb.sdk.plugins.callRpc({
      pluginId: WIKI_PLUGIN_ID,
      method: "addToDoc",
      input: {
        target: { kind: "existing", slug },
        heading,
        text: request.note,
        media: mediaOf(request, file),
        source: { kind: "upload", name: pngName(request.name) },
      },
      outputSchema: addedSchema,
      signal: sendSignal(),
    });
    return { kind: "doc", slug: added.slug, title: added.title };
  }

  async function addCard(request: SendRequest, proposal: { slug: string; heading: string } | null, file: string): Promise<SendResult> {
    try {
      const card = await deps.bb.sdk.plugins.callRpc({
        pluginId: WIKI_PLUGIN_ID,
        method: "addCard",
        input: {
          name: pngName(request.name),
          text: request.note,
          media: mediaOf(request, file),
          target: proposal === null ? null : { kind: "existing", slug: proposal.slug },
          heading: proposal === null ? null : proposal.heading,
          threadId: request.threadId,
        },
        outputSchema: cardSchema,
        signal: sendSignal(),
      });
      inbox.learn(true);
      return { kind: "inbox", cardId: card.id };
    } catch (error) {
      if (isUnknownMethod(error)) inbox.learn(false);
      throw error;
    }
  }

  async function sweepQuietly(): Promise<void> {
    try {
      await sweepOutbox(deps.dataDir());
    } catch (error) {
      deps.log.debug(`Couldn't clear old Wiki uploads: ${errorMessage(error)}`);
    }
  }

  async function send(request: SendRequest): Promise<SendResult> {
    if (!isPng(request.png)) throw new SketchError("not-png", "That image isn't a PNG.");
    const { target } = request;
    const method = target.kind === "doc" ? "addToDoc" : "addCard";
    await sweepQuietly();
    try {
      return await withOutboxFile(
        deps.dataDir(),
        request.name,
        request.png,
        (file) => (target.kind === "doc" ? addToDoc(request, target.slug, target.heading, file) : addCard(request, target.proposal, file)),
        { settled: wikiAnswered },
      );
    } catch (error) {
      throw wikiFailure(error, method, request.threadId !== null);
    }
  }

  return { availability, docs, suggest, send };
}

export type WikiClient = ReturnType<typeof createWikiClient>;
