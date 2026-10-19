import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { headingSchema, titleSchema, type SearchResult } from "../contract.js";
import { UNSORTED_MARKER, describeSourceMarker, parseDoc, parseSourceMarkers, splitSections, type DocSection } from "../lib/markdown-doc.js";
import { LIMITS, MARK_END, MARK_START, truncate } from "../lib/wiki.js";
import { createAgentCard } from "./cards.js";
import type { WikiContext } from "./context.js";
import {
  DESCRIPTION_TOOL,
  ROUTES_TOOL,
  jobKindFromMetadata,
  recordDescription,
  recordDescriptionParams,
  recordRoutes,
  recordRoutesParams,
} from "./routing.js";
import { threadTitle } from "./rpc.js";
import type { Store, StoredDoc } from "./store.js";

export const SEARCH_TOOL = "wiki_search";
export const GET_TOOL = "wiki_get";
export const ADD_TOOL = "wiki_add";
export const SKILL_NAME = "wiki";
export const TOOL_TEXT_LIMIT = 60_000;
const TOOL_RESULTS = 10;

export interface DocView {
  doc: StoredDoc;
  heading: string | null;
  headingPath: string | null;
  markdown: string;
}

export type DocViewResult = { kind: "found"; view: DocView } | { kind: "no-doc" } | { kind: "no-heading"; doc: StoredDoc; heading: string };

const docRefSchema = z.string().trim().min(1).max(LIMITS.slug + LIMITS.heading + 1);

const addFields = z.object({
  text: z
    .string()
    .max(LIMITS.text)
    .refine((value) => value.trim() !== "", "text is empty")
    .describe("The Markdown to file in the Wiki, self-contained and in the user's own terms"),
  doc: docRefSchema.optional().describe("Existing doc to file it under: slug, title, alias, or @tag"),
  heading: headingSchema.optional().describe('Heading inside that doc, e.g. "Decisions"; defaults to "Unsorted"'),
  title: titleSchema.optional().describe("Title for a new doc, when no existing doc fits"),
});

export function plainSnippet(snippet: string): string {
  return snippet.replaceAll(MARK_START, "**").replaceAll(MARK_END, "**").replace(/\s+/g, " ").trim();
}

export function searchLines(result: SearchResult): string[] {
  const docs = result.docs.map((doc) => [doc.slug, doc.type, doc.title].join("\t"));
  const sections = result.sections.map((hit) =>
    [hit.anchor === "" ? hit.slug : `${hit.slug}#${hit.anchor}`, hit.headingPath || hit.title, plainSnippet(hit.snippet)].join("\t"),
  );
  return [
    ...(docs.length === 0 ? [] : ["Docs (slug, type, title):", ...docs]),
    ...(sections.length === 0 ? [] : ["Sections (slug#anchor, heading, snippet):", ...sections]),
  ];
}

export function searchText(result: SearchResult): string {
  if (result.docs.length === 0 && result.sections.length === 0) return "No Wiki docs match.";
  return searchLines(result).join("\n");
}

export function renderSourceMarkers(text: string): string {
  const markers = new Map(parseSourceMarkers(text).map((entry) => [entry.line, entry.source]));
  return text
    .split("\n")
    .map((line, index) => {
      if (line.trim() === UNSORTED_MARKER) return "(unsorted notes below)";
      const source = markers.get(index);
      return source === undefined ? line : `(source: ${describeSourceMarker(source)})`;
    })
    .join("\n");
}

function headingKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function sectionIndex(sections: readonly DocSection[], heading: string): number {
  const key = headingKey(heading);
  const byText = sections.findIndex((section) => section.heading !== "" && headingKey(section.heading) === key);
  if (byText !== -1) return byText;
  return sections.findIndex((section) => section.heading !== "" && (headingKey(section.headingPath) === key || section.anchor === key));
}

function sectionMarkdown(sections: readonly DocSection[], start: number): string {
  const head = sections[start];
  if (head === undefined) return "";
  const parts: string[] = [];
  for (let index = start; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined || (index > start && section.level <= head.level)) break;
    parts.push([`${"#".repeat(Math.max(section.level, 1))} ${section.heading}`, section.body].filter((part) => part !== "").join("\n\n"));
  }
  return parts.join("\n\n");
}

export function resolveDocRef(store: Store, ref: string): { slug: string; heading: string | null } | null {
  const trimmed = ref.trim().replace(/^\[\[(.*)\]\]$/, "$1").trim();
  if (trimmed === "") return null;
  if (store.getDoc(trimmed) !== null) return { slug: trimmed, heading: null };
  return store.resolveLink(trimmed);
}

export async function readDocView(ctx: WikiContext, ref: string, heading: string | null): Promise<DocViewResult> {
  const resolved = resolveDocRef(ctx.store, ref);
  const doc = resolved === null ? null : ctx.store.getDoc(resolved.slug);
  const file = doc === null ? null : await ctx.vault.readDoc(doc.slug);
  if (doc === null || file === null) return { kind: "no-doc" };
  const wanted = heading ?? resolved?.heading ?? null;
  const body = parseDoc(file.content, doc.slug).body;
  if (wanted === null) return { kind: "found", view: { doc, heading: null, headingPath: null, markdown: renderSourceMarkers(body.trim()) } };
  const sections = splitSections(body);
  const index = sectionIndex(sections, wanted);
  const section = sections[index];
  if (section === undefined) return { kind: "no-heading", doc, heading: wanted };
  const markdown = renderSourceMarkers(sectionMarkdown(sections, index));
  return { kind: "found", view: { doc, heading: section.heading, headingPath: section.headingPath, markdown } };
}

export function docViewHeader(view: DocView): string {
  const { doc } = view;
  const aliases = doc.aliases.length === 0 ? "" : `; aliases: ${doc.aliases.join(", ")}`;
  const section = view.headingPath === null ? "" : `, section "${view.headingPath}"`;
  return `Wiki doc "${doc.title}" (slug ${doc.slug}, ${doc.type}, tag @${doc.tag}${aliases})${section}`;
}

export function docViewText(view: DocView, limit: number): string {
  const text = `${docViewHeader(view)}\n\n${view.markdown}`;
  if (text.length <= limit) return text;
  return `${truncate(text, limit)}\n\n(Truncated. Ask for one heading: ${view.doc.headings.slice(0, 20).join(", ")})`;
}

export function missingHeadingText(doc: StoredDoc, heading: string): string {
  const headings = doc.headings.length === 0 ? "it has no headings" : `its headings are: ${doc.headings.join(", ")}`;
  return `"${doc.title}" has no heading "${heading}"; ${headings}.`;
}

function toolError(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const JOB_THREAD_REFUSAL = "Wiki routing and image-description threads cannot change the Wiki or its inbox; record results with this job's own tool.";

export async function isJobThread(ctx: WikiContext, threadId: string): Promise<boolean> {
  if (ctx.store.jobForThread(threadId) !== null) return true;
  const metadata: unknown = await ctx.bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
  return jobKindFromMetadata(metadata) !== null;
}

export async function addAgentText(
  ctx: WikiContext,
  threadId: string,
  fields: { text: string; doc?: string | undefined; heading?: string | undefined; title?: string | undefined },
): Promise<string> {
  const card = await createAgentCard(ctx, {
    threadId,
    threadTitle: await threadTitle(ctx, threadId),
    text: fields.text,
    doc: fields.doc ?? null,
    heading: fields.heading ?? null,
    title: fields.title ?? null,
  });
  return `Added to the Wiki inbox for review: ${card.id}`;
}

const SEARCH_INSTRUCTIONS = `When the user asks what they know, wrote, or decided about something, search their Wiki first with ${SEARCH_TOOL}, then read the best doc or heading with ${GET_TOOL}. Cite the doc title.`;
const ADD_INSTRUCTIONS = `When the user asks to save something to the Wiki, call ${ADD_TOOL} with self-contained Markdown. It never edits a doc: it adds a review card to the Wiki inbox, and the user decides where it goes. Pass doc and heading when you know where it belongs. Never write files in the Wiki folder yourself.`;

function registerSearchTools(ctx: WikiContext): void {
  ctx.bb.agents.registerTool({
    name: SEARCH_TOOL,
    description:
      "Search the user's Wiki of topic, project, process, and service docs. Returns matching docs (slug, type, title) and sections (slug#anchor, heading, snippet).",
    instructions: SEARCH_INSTRUCTIONS,
    presentation: { label: { pending: "Searching the Wiki", completed: "Searched the Wiki" } },
    parameters: z.object({
      query: z.string().max(LIMITS.query).describe('Words to match; prefixes match too ("notif" finds "notification"). Empty lists recent docs'),
      limit: z.number().int().min(1).max(50).default(TOOL_RESULTS),
    }),
    execute({ query, limit }) {
      return searchText(ctx.store.search({ query, type: null, limit }));
    },
  });

  ctx.bb.agents.registerTool({
    name: GET_TOOL,
    description:
      "Read one Wiki doc, or one heading of it, as Markdown. Source comments become (source: …) lines that say where each block came from.",
    presentation: { label: { pending: "Reading the Wiki", completed: "Read the Wiki" } },
    parameters: z.object({
      doc: docRefSchema.describe('Doc slug, title, alias, or @tag; "Title#Heading" also works'),
      heading: headingSchema.optional().describe("Only this heading and its subheadings"),
    }),
    async execute({ doc, heading }) {
      const result = await readDocView(ctx, doc, heading ?? null);
      if (result.kind === "no-doc") return toolError(`No Wiki doc matches "${doc}". Find it with ${SEARCH_TOOL} first.`);
      if (result.kind === "no-heading") return toolError(missingHeadingText(result.doc, result.heading));
      return docViewText(result.view, TOOL_TEXT_LIMIT);
    },
  });
}

function registerAddTool(ctx: WikiContext): void {
  ctx.bb.agents.registerTool({
    name: ADD_TOOL,
    description:
      "Propose Markdown for the user's Wiki. It becomes a review card in the Wiki inbox, marked as written by an agent; nothing is written until the user accepts it.",
    instructions: ADD_INSTRUCTIONS,
    presentation: { label: { pending: "Adding to the Wiki inbox", completed: "Added to the Wiki inbox" } },
    parameters: addFields,
    async execute(fields, { threadId }) {
      if (await isJobThread(ctx, threadId)) return toolError(JOB_THREAD_REFUSAL);
      return addAgentText(ctx, threadId, fields);
    },
  });
}

function registerJobTools(ctx: WikiContext): void {
  ctx.bb.agents.registerTool({
    name: ROUTES_TOOL,
    description: "Record where each inbox unit of this Wiki routing job belongs. Only works in a Wiki routing thread.",
    instructions: `This thread routes daily-note units for the Wiki. Call ${ROUTES_TOOL} once with a route for every unit; you choose docs, headings, and line ranges, never text.`,
    presentation: { label: { pending: "Recording Wiki routes", completed: "Recorded Wiki routes" } },
    parameters: recordRoutesParams,
    execute(params, { threadId }) {
      return recordRoutes(ctx, threadId, params);
    },
  });

  ctx.bb.agents.registerTool({
    name: DESCRIPTION_TOOL,
    description: "Record a short description of the attached image for the Wiki. Only works in a Wiki image-description thread.",
    instructions: `This thread describes one image for a Wiki caption. Call ${DESCRIPTION_TOOL} once with a plain, factual description.`,
    presentation: { label: { pending: "Recording the description", completed: "Recorded the description" } },
    parameters: recordDescriptionParams,
    execute(params, { threadId }) {
      return recordDescription(ctx, threadId, params);
    },
  });
}

export function toolsFor(metadata: unknown): { tools: string[]; skills: string[] } {
  const kind = jobKindFromMetadata(metadata);
  if (kind === "route") return { tools: [SEARCH_TOOL, GET_TOOL, ROUTES_TOOL], skills: [SKILL_NAME] };
  if (kind === "describe") return { tools: [DESCRIPTION_TOOL], skills: [] };
  return { tools: [SEARCH_TOOL, GET_TOOL, ADD_TOOL], skills: [SKILL_NAME] };
}

export function registerTools(ctx: WikiContext): void {
  registerSearchTools(ctx);
  registerAddTool(ctx);
  registerJobTools(ctx);
  ctx.bb.agents.configure((context) => toolsFor(context.pluginMetadata));
}
