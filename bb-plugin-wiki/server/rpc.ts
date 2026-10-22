import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  type AddSource,
  type Card,
  type Destination,
  type DocDetail,
  type DocSummary,
  type DocTarget,
  type JobState,
  type MediaItem,
  type RememberAlias,
  type WikiStatus,
} from "../contract.js";
import { stripSourceMarkers, type SourceMarker } from "../lib/markdown-doc.js";
import { normalizeTag } from "../lib/slug.js";
import { LIMITS, truncate, type DocType } from "../lib/wiki.js";
import { acceptCard, createUploadCard, missingCardImages, previewCard, restoreCard, skipCard, updateCardDestinations } from "./cards.js";
import type { WikiContext } from "./context.js";
import { runImport, runIngest } from "./ingest.js";
import {
  embedFor,
  messageMedia,
  importUpload,
  readMediaText,
  resolveMediaSource,
  type EmbedKind,
} from "./media.js";
import { startDescribeJob } from "./routing.js";
import { readLastIngestDate } from "./schedule.js";
import { suggestDocs } from "./suggest.js";
import type { Store, StoredDoc } from "./store.js";
import { docRelPath, tagsFilePath } from "./vault.js";
import { appendToTarget, sourceBlock, todayIso } from "./write.js";

const COMMIT_TEXT = 60;
const TITLE_LINE_LIMIT = LIMITS.title * 5;

export interface AddToDocInput {
  target: DocTarget;
  heading: string;
  text: string;
  media: readonly MediaItem[];
  source: AddSource;
}

export interface ManualDocInput {
  title: string;
  type: DocType;
  aliases: readonly string[];
  body: string;
}

type PreparedMedia =
  | { kind: "text"; name: string; text: string }
  | { kind: "embed"; name: string; path: string; embed: EmbedKind; caption: string };

export function summaryOf(doc: DocSummary): DocSummary {
  return {
    slug: doc.slug,
    title: doc.title,
    type: doc.type,
    aliases: doc.aliases,
    tag: doc.tag,
    updatedAt: doc.updatedAt,
    headings: doc.headings,
  };
}

function requireDoc(store: Store, slug: string): StoredDoc {
  const doc = store.getDoc(slug);
  if (doc === null) throw new Error(`No Wiki doc "${slug}". Search the Wiki for the doc name and use its slug.`);
  return doc;
}

export async function statusOf(ctx: WikiContext): Promise<WikiStatus> {
  const settings = await ctx.settings();
  const root = await ctx.wikiRoot();
  return {
    wikiDirectory: root,
    notesDirectory: await ctx.notesRoot(),
    docCount: ctx.store.docCount(),
    inboxCount: ctx.store.openCount(),
    lastIngestDate: await readLastIngestDate(ctx),
    routingAgent: settings.routingAgent,
    gitHistory: settings.gitHistory,
    tagsFile: tagsFilePath(root),
  };
}

export async function docDetail(ctx: WikiContext, slug: string): Promise<DocDetail | null> {
  const file = await ctx.vault.readDoc(slug);
  if (file === null) return null;
  if (ctx.store.getDoc(slug)?.sha256 !== file.sha256) await ctx.vault.indexDoc(slug);
  const doc = ctx.store.getDoc(slug);
  if (doc === null) return null;
  return { ...summaryOf(doc), content: file.content, sha256: file.sha256, backlinks: ctx.store.backlinks(slug) };
}

export async function saveDoc(ctx: WikiContext, slug: string, content: string, expectedSha256: string | null) {
  const result = await ctx.vault.writeDoc(slug, content, expectedSha256);
  if (result.outcome === "conflict") return result;
  if (result.changed) {
    await ctx.vault.commitSoon(docRelPath(slug), () => `Wiki: edit ${ctx.store.getDoc(slug)?.title ?? slug}`);
    ctx.publishChanged();
  }
  return { outcome: result.outcome, sha256: result.sha256 };
}

export function assertFreeAliases(store: Store, aliases: readonly string[]): void {
  for (const alias of aliases) {
    const tag = normalizeTag(alias);
    const owner = tag === "" ? null : store.resolveTag(tag);
    if (owner !== null) throw new Error(`@${tag} already names "${store.getDoc(owner)?.title ?? owner}".`);
  }
}

function headingKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isInlineSpace(char: string): boolean {
  return char === " " || char === "\t";
}

function trimInlineEnd(text: string, from: number, floor: number): number {
  let end = from;
  while (end > floor && isInlineSpace(text.charAt(end - 1))) end -= 1;
  return end;
}

function titleHeading(line: string): string | undefined {
  let at = 0;
  while (at < 3 && line.charAt(at) === " ") at += 1;
  if (line.charAt(at) !== "#" || !isInlineSpace(line.charAt(at + 1)) || /[\n\r\u2028\u2029]/.test(line)) return undefined;
  let start = at + 1;
  while (isInlineSpace(line.charAt(start))) start += 1;
  const end = trimInlineEnd(line, line.length, start);
  let hashes = end;
  while (hashes > start && line.charAt(hashes - 1) === "#") hashes -= 1;
  const cut = trimInlineEnd(line, hashes, start);
  return line.slice(start, hashes < end && cut < hashes ? cut : end);
}

export function withoutTitleLine(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  const line = lines[first] ?? "";
  if (line.length > TITLE_LINE_LIMIT) return body;
  const heading = titleHeading(line);
  if (heading === undefined || headingKey(heading) !== headingKey(title)) return body;
  return lines.slice(first + 1).join("\n");
}

export async function createManualDoc(ctx: WikiContext, input: ManualDocInput): Promise<DocSummary> {
  const body = withoutTitleLine(input.body, input.title);
  const marker: SourceMarker = { kind: "manual", added: await todayIso(ctx) };
  const first = body.trim() === "" ? undefined : { heading: input.title, block: sourceBlock(marker, body) };
  return ctx.vault.runExclusive(async () => {
    assertFreeAliases(ctx.store, input.aliases);
    const { slug } = await ctx.vault.createDoc({ title: input.title, type: input.type, aliases: [...input.aliases] }, first);
    const doc = requireDoc(ctx.store, slug);
    await ctx.vault.commit(`Wiki: new doc ${doc.title}`, [docRelPath(slug)]);
    ctx.publishChanged();
    return summaryOf(doc);
  });
}

export async function addDocAlias(ctx: WikiContext, slug: string, alias: string): Promise<DocSummary> {
  const tag = normalizeTag(alias);
  if (tag === "") throw new Error("An alias needs at least one letter or digit.");
  const changed = await ctx.vault.runExclusive(async () => {
    const doc = requireDoc(ctx.store, slug);
    const owner = ctx.store.resolveTag(tag);
    if (owner !== null && owner !== slug) throw new Error(`@${tag} already names "${requireDoc(ctx.store, owner).title}".`);
    if (owner === slug) return false;
    await ctx.vault.addAlias(slug, tag);
    await ctx.vault.commit(`Wiki: alias @${tag} for ${doc.title}`, [docRelPath(slug)]);
    return true;
  });
  if (changed) ctx.publishChanged();
  return summaryOf(requireDoc(ctx.store, slug));
}

function retargetOpenCards(ctx: WikiContext, slug: string, replace: (destination: Destination) => Destination): boolean {
  let changed = false;
  for (const card of ctx.store.listCards("open")) {
    if (!card.destinations.some((destination) => destination.target.kind === "existing" && destination.target.slug === slug)) continue;
    const destinations = card.destinations.map((destination) =>
      destination.target.kind === "existing" && destination.target.slug === slug ? replace(destination) : destination,
    );
    if (ctx.store.updateCard(card.id, { destinations }) !== null) changed = true;
  }
  return changed;
}

export async function renameDoc(ctx: WikiContext, slug: string, title: string): Promise<DocSummary> {
  const clean = title.trim();
  if (clean === "") throw new Error("A doc needs a title.");
  const result = await ctx.vault.runExclusive(async () => {
    const before = requireDoc(ctx.store, slug);
    if (before.title === clean) return { slug, cardsChanged: false };
    await ctx.vault.commit(`Wiki: save ${before.title} before renaming it`, [docRelPath(slug)]);
    const renamed = await ctx.vault.renameDoc(slug, clean);
    const removed = renamed.slug === slug ? [] : [docRelPath(slug)];
    await ctx.vault.commit(`Wiki: rename ${before.title} → ${clean}`, renamed.paths, removed);
    const cardsChanged =
      renamed.slug !== slug &&
      retargetOpenCards(ctx, slug, (destination) => ({ ...destination, target: { kind: "existing", slug: renamed.slug } }));
    return { slug: renamed.slug, cardsChanged };
  });
  ctx.publishChanged();
  if (result.cardsChanged) ctx.publishInbox();
  return summaryOf(requireDoc(ctx.store, result.slug));
}

export async function deleteDoc(ctx: WikiContext, slug: string): Promise<{ slug: string; title: string }> {
  const result = await ctx.vault.runExclusive(async () => {
    const doc = requireDoc(ctx.store, slug);
    await ctx.vault.commit(`Wiki: save ${doc.title} before deleting it`, [docRelPath(slug)]);
    const { path } = await ctx.vault.deleteDoc(slug);
    await ctx.vault.commit(`Wiki: delete ${doc.title}`, [], [path]);
    const cardsChanged = retargetOpenCards(ctx, slug, (destination) =>
      destination.written === true
        ? destination
        : {
            ...destination,
            include: false,
            target: { kind: "new", title: doc.title, type: doc.type, aliases: [] },
            reason: `“${doc.title}” was deleted; turn this on to create it again.`,
          },
    );
    return { title: doc.title, cardsChanged };
  });
  ctx.publishChanged();
  if (result.cardsChanged) ctx.publishInbox();
  return { slug, title: result.title };
}

export async function tidyUnsorted(ctx: WikiContext): Promise<{ changed: string[] }> {
  const changed = await ctx.vault.runExclusive(async () => {
    const touched: string[] = [];
    for (const doc of ctx.store.listDocs(null)) {
      const before = ctx.store.getDoc(doc.slug)?.sha256;
      const { sha256 } = await ctx.vault.moveUnsorted(doc.slug);
      if (sha256 !== before) touched.push(doc.slug);
    }
    if (touched.length > 0) {
      await ctx.vault.commit(`Wiki: move Unsorted sections below the line in ${touched.length} doc${touched.length === 1 ? "" : "s"}`, touched.map(docRelPath));
    }
    return touched;
  });
  if (changed.length > 0) ctx.publishChanged();
  return { changed };
}

export async function threadTitle(ctx: WikiContext, threadId: string): Promise<string | null> {
  const thread = await ctx.bb.sdk.threads.get({ threadId }).catch(() => null);
  return thread?.title ?? thread?.titleFallback ?? null;
}

export async function markerFor(ctx: WikiContext, source: AddSource): Promise<SourceMarker> {
  const added = await todayIso(ctx);
  if (source.kind === "thread") return { kind: "thread", threadId: source.threadId, title: await threadTitle(ctx, source.threadId), added };
  if (source.kind === "upload") return { kind: "upload", name: source.name, added };
  return { kind: "manual", added };
}

async function prepareItem(ctx: WikiContext, item: MediaItem): Promise<PreparedMedia> {
  const media = await resolveMediaSource(ctx, item.from);
  if (media.kind === "image" || media.kind === "video") {
    return { kind: "embed", name: media.name, path: media.path, embed: media.kind, caption: item.caption };
  }
  return { kind: "text", name: media.name, text: await readMediaText(media.path, media.name, media.sizeBytes) };
}

async function prepareMedia(ctx: WikiContext, items: readonly MediaItem[]): Promise<PreparedMedia[]> {
  const prepared: PreparedMedia[] = [];
  for (const item of items) prepared.push(await prepareItem(ctx, item));
  return prepared;
}

async function mediaPart(ctx: WikiContext, item: PreparedMedia, assets: string[]): Promise<string> {
  if (item.kind === "text") return item.text;
  const { relPath } = await ctx.vault.copyAsset(item.path, item.name);
  assets.push(relPath);
  return embedFor(relPath, item.embed, item.caption);
}

async function assertTargetWritable(ctx: WikiContext, target: DocTarget): Promise<void> {
  if (target.kind === "new") return assertFreeAliases(ctx.store, target.aliases);
  if ((await ctx.vault.readDoc(target.slug)) === null) {
    throw new Error(`No Wiki doc "${target.slug}". Search the Wiki for the doc name and use its slug.`);
  }
}

function hasContent(text: string, media: readonly PreparedMedia[]): boolean {
  return text.trim() !== "" || media.some((item) => item.kind === "embed" || item.text.trim() !== "");
}

function commitLabel(text: string, media: readonly PreparedMedia[]): string {
  const line = stripSourceMarkers(text).split(/\r?\n/).find((entry) => entry.trim() !== "")?.trim();
  if (line !== undefined) return truncate(line.replace(/\s+/g, " "), COMMIT_TEXT);
  return truncate(media.map((item) => item.name).join(", "), COMMIT_TEXT);
}

function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

export async function addToDoc(ctx: WikiContext, input: AddToDocInput): Promise<{ slug: string; title: string }> {
  if (input.text.trim() === "" && input.media.length === 0) {
    throw new Error("Nothing to add: the text is empty and no media was chosen.");
  }
  const media = await prepareMedia(ctx, input.media);
  if (!hasContent(input.text, media)) throw new Error("Nothing to add: the chosen files are empty.");
  const marker = await markerFor(ctx, input.source);
  return ctx.vault.runExclusive(async () => {
    await assertTargetWritable(ctx, input.target);
    const assets: string[] = [];
    const parts = [input.text.trimEnd()];
    for (const item of media) parts.push(await mediaPart(ctx, item, assets));
    const body = joinParts(parts);
    const written = await appendToTarget(ctx, { target: input.target, heading: input.heading, block: sourceBlock(marker, body) });
    await ctx.vault.commit(`Wiki: ${commitLabel(input.text, media)} → ${written.title}`, [docRelPath(written.slug), ...assets]);
    ctx.publishChanged();
    return { slug: written.slug, title: written.title };
  });
}

export async function describeImage(ctx: WikiContext, from: MediaItem["from"]): Promise<{ jobId: string }> {
  const media = await resolveMediaSource(ctx, from);
  if (media.kind !== "image") throw new Error(`${media.name} is not an image, so Claude Code cannot describe it.`);
  return startDescribeJob(ctx, media.path);
}

export function jobState(ctx: WikiContext, jobId: string): JobState {
  const job = ctx.store.getJob(jobId);
  if (job === null) throw new Error(`No Wiki job ${jobId}.`);
  return { status: job.status, result: job.result, error: job.error };
}

export async function updateCard(ctx: WikiContext, id: string, destinations: Destination[], rememberAliases: RememberAlias[]): Promise<Card> {
  const card = await ctx.vault.runExclusive(async () => updateCardDestinations(ctx, id, destinations, rememberAliases));
  ctx.publishInbox();
  return card;
}

export async function reindex(ctx: WikiContext): Promise<{ docCount: number }> {
  const { changed } = await ctx.vault.syncAll();
  if (changed > 0) ctx.publishChanged();
  return { docCount: ctx.store.docCount() };
}

function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

export function friendlyError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error(`Invalid Wiki data: ${issueText(error)}`);
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function friendly<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    try {
      const result: Awaited<R> = await fn(...args);
      return result;
    } catch (error) {
      throw friendlyError(error);
    }
  };
}

function callerPluginId(context: ExperimentalPluginRpcHandlerContext): string | null {
  const caller = context.experimental_caller;
  return caller.kind === "plugin" ? caller.pluginId : null;
}

export function registerRpc(ctx: WikiContext): void {
  ctx.bb.rpc.register(rpcContract, {
    status: friendly(() => statusOf(ctx)),
    docs: friendly(({ type }) => ctx.store.listDocs(type)),
    doc: friendly(({ slug }) => docDetail(ctx, slug)),
    saveDoc: friendly(({ slug, content, expectedSha256 }) => saveDoc(ctx, slug, content, expectedSha256)),
    createDoc: friendly((input) => createManualDoc(ctx, input)),
    search: friendly((input) => ctx.store.search(input)),
    suggest: friendly(async ({ text, title }) => ({ suggestions: await suggestDocs(ctx, text, title) })),
    addToDoc: friendly((input) => addToDoc(ctx, input)),
    addCard: friendly((input, context) => createUploadCard(ctx, { ...input, pluginId: callerPluginId(context) })),
    inbox: friendly(({ status }) => ctx.store.listCards(status)),
    card: friendly(({ id }) => ctx.store.getCard(id)),
    updateCard: friendly(({ id, destinations, rememberAliases }) => updateCard(ctx, id, destinations, rememberAliases)),
    previewCard: friendly(({ id }) =>
      ctx.vault.runExclusive(async () => ({ previews: await previewCard(ctx, id), missingImages: await missingCardImages(ctx, id) })),
    ),
    acceptCard: friendly(({ id }) => acceptCard(ctx, id)),
    skipCard: friendly(({ id }) => skipCard(ctx, id)),
    restoreCard: friendly(({ id }) => restoreCard(ctx, id)),
    ingestNow: friendly(({ since, useAgent }) => runIngest(ctx, { since, useAgent })),
    importFolders: friendly(({ folders, useAgent }) => runImport(ctx, { folders, useAgent })),
    importUpload: friendly(({ uploadId }) => importUpload(ctx, uploadId)),
    messageMedia: friendly(async ({ threadId, messageSeq }) => ({ items: await messageMedia(ctx, threadId, messageSeq) })),
    describeImage: friendly(({ from }) => describeImage(ctx, from)),
    job: friendly(({ jobId }) => jobState(ctx, jobId)),
    addAlias: friendly(({ slug, alias }) => addDocAlias(ctx, slug, alias)),
    renameDoc: friendly(({ slug, title }) => renameDoc(ctx, slug, title)),
    deleteDoc: friendly(({ slug }) => deleteDoc(ctx, slug)),
    reindex: friendly(() => reindex(ctx)),
    tidyUnsorted: friendly(() => tidyUnsorted(ctx)),
  });
}

