import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  aliasSchema,
  aliasesSchema,
  cardIdSchema,
  docTypeSchema,
  headingSchema,
  lineSelectionSchema,
  slugSchema,
  titleSchema,
  type Card,
  type DocTarget,
} from "../contract.js";
import { formatNoteDateShort } from "../lib/daily-notes.js";
import { DEFAULT_HEADING, LIMITS, ROUTING_TIMEOUT_MS, mediaKindOf, truncate } from "../lib/wiki.js";
import { FALLBACK_REASON, applyRoutes, fallbackToRules, type CardRoutes } from "./cards.js";
import type { WikiContext } from "./context.js";
import type { CatalogDoc, Job, JobKind } from "./store.js";
import { todayIso } from "./write.js";

export const ROUTES_TOOL = "wiki_record_routes";
export const DESCRIPTION_TOOL = "wiki_record_description";
const SEARCH_TOOL = "wiki_search";
const GET_TOOL = "wiki_get";
export const PERSONAL_PROJECT_ID = "proj_personal";
export const ROUTING_PROVIDER_ID = "claude-code";
export const JOB_PERMISSION_MODE = "accept-edits";

const CATALOG_HEADINGS = 20;
const CATALOG_HEADING_LENGTH = 60;
const TIMEOUT_MINUTES = Math.round(ROUTING_TIMEOUT_MS / 60_000);
const TOOL_LIMITS = "Do not run shell commands, and do not read, create, edit or delete any files.";

const routeTargetSchema = z.union([
  z.object({ slug: slugSchema.describe("Slug of an existing Wiki doc, exactly as listed in the catalog or search results.") }).strict(),
  z
    .object({
      newDoc: z
        .object({
          title: titleSchema,
          type: docTypeSchema,
          aliases: aliasesSchema.default([]),
        })
        .strict()
        .describe("A new doc, only when no existing doc fits."),
    })
    .strict(),
]);

const routeDestinationParams = z.object({
  target: routeTargetSchema,
  heading: headingSchema.default(DEFAULT_HEADING).describe('Heading in the doc to add the lines under; "Unsorted" when none fits.'),
  lineRanges: lineSelectionSchema.describe('"all", or 0-based inclusive ranges of the card\'s numbered lines, like [{"start":0,"end":1}].'),
  reason: z.string().max(LIMITS.reason).describe("One short sentence: why these lines belong here."),
});

export const recordRoutesParams = z.object({
  routes: z
    .array(
      z.object({
        cardId: cardIdSchema,
        destinations: z.array(routeDestinationParams).max(LIMITS.destinations),
        tagMatches: z
          .array(z.object({ tag: aliasSchema, slug: slugSchema }))
          .max(LIMITS.tags)
          .default([])
          .describe("Unknown @tags of this card that clearly mean an existing doc. Shown as suggestions only."),
      }),
    )
    .min(1)
    .max(LIMITS.unitsPerJob),
});
export type RecordRoutesParams = z.output<typeof recordRoutesParams>;

export const recordDescriptionParams = z.object({
  description: z.string().trim().min(1).max(LIMITS.caption).describe("A concise, factual description of the image in 1-3 sentences."),
});
export type RecordDescriptionParams = z.output<typeof recordDescriptionParams>;

const jobMetadataSchema = z.object({ wikiJob: z.enum(["route", "describe"]) });
const spawnedThreadSchema = z.object({ id: z.string().min(1) });
const threadStateSchema = z.object({
  id: z.string(),
  status: z.string(),
  archivedAt: z.number().nullable().optional(),
  deletedAt: z.number().nullable().optional(),
  createdAt: z.number().optional(),
});
const projectListSchema = z.array(z.object({ id: z.string() }));

type ThreadState = z.infer<typeof threadStateSchema>;
type SpawnArgs = Parameters<WikiContext["bb"]["sdk"]["threads"]["spawn"]>[0];

interface RoutingRuntime {
  timers: Map<string, NodeJS.Timeout>;
  waiters: Map<string, Array<() => void>>;
  queued: Set<string>;
}

interface RouteJobPlan {
  id: string;
  index: number;
  total: number;
}

const runtimes = new WeakMap<object, RoutingRuntime>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeOf(ctx: WikiContext): RoutingRuntime {
  const existing = runtimes.get(ctx.store);
  if (existing !== undefined) return existing;
  const created: RoutingRuntime = { timers: new Map(), waiters: new Map(), queued: new Set() };
  runtimes.set(ctx.store, created);
  return created;
}

function clearTimer(ctx: WikiContext, jobId: string): void {
  const runtime = runtimeOf(ctx);
  const timer = runtime.timers.get(jobId);
  if (timer !== undefined) clearTimeout(timer);
  runtime.timers.delete(jobId);
}

function markSettled(ctx: WikiContext, jobId: string): void {
  clearTimer(ctx, jobId);
  const runtime = runtimeOf(ctx);
  const waiters = runtime.waiters.get(jobId) ?? [];
  runtime.waiters.delete(jobId);
  for (const resolve of waiters) resolve();
}

function waitForJob(ctx: WikiContext, jobId: string): Promise<void> {
  if (ctx.store.getJob(jobId)?.status !== "running") return Promise.resolve();
  const runtime = runtimeOf(ctx);
  return new Promise((resolve) => {
    runtime.waiters.set(jobId, [...(runtime.waiters.get(jobId) ?? []), resolve]);
  });
}

export function jobKindFromMetadata(metadata: unknown): JobKind | null {
  const parsed = jobMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.wikiJob : null;
}

async function personalProjectExists(ctx: WikiContext): Promise<boolean> {
  try {
    const projects = projectListSchema.parse(await ctx.bb.sdk.projects.list({ includePersonal: true }));
    return projects.some((project) => project.id === PERSONAL_PROJECT_ID);
  } catch (error) {
    ctx.log.warn(`Wiki could not list projects: ${errorMessage(error)}`);
    return false;
  }
}

type JobExecution = Pick<SpawnArgs, "providerId" | "model" | "permissionMode" | "executionInputSources">;

async function jobExecution(ctx: WikiContext): Promise<JobExecution> {
  const model = (await ctx.settings()).routingModel.trim();
  if (model === "") {
    return {
      providerId: ROUTING_PROVIDER_ID,
      permissionMode: JOB_PERMISSION_MODE,
      executionInputSources: { providerId: "explicit", permissionMode: "explicit" },
    };
  }
  return {
    providerId: ROUTING_PROVIDER_ID,
    model,
    permissionMode: JOB_PERMISSION_MODE,
    executionInputSources: { providerId: "explicit", model: "explicit", permissionMode: "explicit" },
  };
}

async function releaseThread(ctx: WikiContext, threadId: string): Promise<void> {
  try {
    await ctx.bb.sdk.threads.archive({ threadId });
  } catch (error) {
    ctx.log.debug(`Wiki could not archive job thread ${threadId}: ${errorMessage(error)}`);
  }
  try {
    await ctx.bb.sdk.threads.stop({ threadId });
  } catch (error) {
    ctx.log.debug(`Wiki could not stop job thread ${threadId}: ${errorMessage(error)}`);
  }
}

function settleRouteJob(ctx: WikiContext, job: Job, failed: boolean, error: string | null): void {
  const waiting = ctx.store.cardsForJob(job.id).filter((card) => card.status === "routing");
  for (const card of waiting) fallbackToRules(ctx, card, FALLBACK_REASON);
  ctx.store.finishJob(job.id, failed ? { status: "failed", error: error ?? "The routing thread failed." } : { status: "done" });
  if (waiting.length > 0) ctx.publishInbox();
}

function settleDescribeJob(ctx: WikiContext, job: Job, failed: boolean, error: string | null): void {
  const reason = failed ? (error ?? "The description thread failed.") : "Claude Code finished without describing the image.";
  ctx.store.finishJob(job.id, { status: "failed", error: reason });
}

function settleJob(ctx: WikiContext, job: Job, failed: boolean, error: string | null): void {
  runtimeOf(ctx).queued.delete(job.id);
  const current = ctx.store.getJob(job.id) ?? job;
  if (current.status === "running") {
    if (current.kind === "route") settleRouteJob(ctx, current, failed, error);
    else settleDescribeJob(ctx, current, failed, error);
  }
  markSettled(ctx, job.id);
}

async function onTimeout(ctx: WikiContext, jobId: string): Promise<void> {
  const job = ctx.store.getJob(jobId);
  if (job === null || job.status !== "running") return;
  settleJob(ctx, job, true, `Timed out after ${TIMEOUT_MINUTES} minutes.`);
  if (job.threadId !== null) await releaseThread(ctx, job.threadId);
}

function armTimeout(ctx: WikiContext, jobId: string, ms: number): void {
  clearTimer(ctx, jobId);
  const runtime = runtimeOf(ctx);
  const timer = setTimeout(() => {
    runtime.timers.delete(jobId);
    onTimeout(ctx, jobId).catch((error: unknown) => ctx.log.warn(`Wiki job ${jobId} timeout failed: ${errorMessage(error)}`));
  }, Math.max(0, ms));
  timer.unref();
  runtime.timers.set(jobId, timer);
}

const LINES_PER_JOB = 1_200;

function batchCards(cards: readonly Card[]): Card[][] {
  const batches: Card[][] = [];
  let current: Card[] = [];
  let lines = 0;
  for (const card of cards) {
    if (current.length > 0 && (current.length >= LIMITS.unitsPerJob || lines + card.lines.length > LINES_PER_JOB)) {
      batches.push(current);
      current = [];
      lines = 0;
    }
    current.push(card);
    lines += card.lines.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function catalogLine(doc: CatalogDoc): string {
  const headings = doc.headings.slice(0, CATALOG_HEADINGS).map((heading) => truncate(heading, CATALOG_HEADING_LENGTH));
  const parts = [
    `\`${doc.slug}\` — ${doc.title} (${doc.type})`,
    doc.aliases.length > 0 ? `aliases: ${doc.aliases.join(", ")}` : null,
    headings.length > 0 ? `headings: ${headings.join("; ")}` : null,
    doc.excerpt !== "" ? `excerpt: ${doc.excerpt}` : null,
  ];
  return `- ${parts.filter((part) => part !== null).join(" · ")}`;
}

function describeTag(ctx: WikiContext, tag: string): string {
  const slug = ctx.store.resolveTag(tag);
  return slug === null ? `@${tag} (not a Wiki doc)` : `@${tag} (doc \`${slug}\`)`;
}

function describeTarget(ctx: WikiContext, target: DocTarget): string {
  if (target.kind === "new") return `new doc “${target.title}”`;
  return `\`${target.slug}\` (${ctx.store.getDoc(target.slug)?.title ?? target.slug})`;
}

function provisionalLine(ctx: WikiContext, card: Card): string {
  const included = card.destinations.filter((destination) => destination.include);
  if (included.length === 0) return "Rule-based guess: none.";
  return `Rule-based guess: ${included.map((destination) => `${describeTarget(ctx, destination.target)} › ${destination.heading}`).join("; ")}.`;
}

function cardSection(ctx: WikiContext, card: Card): string {
  const source =
    card.source.kind === "agent"
      ? `Agent text from thread ${card.source.threadId}`
      : card.source.origin === "file"
        ? `File: ${card.source.notePath}${card.source.section === undefined ? "" : ` › ${card.source.section}`} (a reference note, not a daily note; the default heading is its section)`
        : `Note: ${formatNoteDateShort(card.source.noteDate)} (${card.source.notePath})`;
  const tags = card.tags.length === 0 ? "Tags: none" : `Tags: ${card.tags.map((tag) => describeTag(ctx, tag)).join(", ")}`;
  const lines = card.lines.map((line, index) => `${index} | ${line}`);
  return [`### ${card.id}`, source, tags, provisionalLine(ctx, card), "Lines:", ...lines].join("\n");
}

const ROUTING_RULES = [
  "Rules:",
  "1. Copy only. Never write, rewrite, summarize, merge or invent text. You choose a doc, a heading and line ranges; the server copies the user's own lines word for word.",
  `2. ${TOOL_LIMITS} Use only the Wiki tools you were given: ${SEARCH_TOOL}, ${GET_TOOL} and ${ROUTES_TOOL}.`,
  '3. Line ranges are 0-based and inclusive, using the line numbers shown for each card. Use "all" for the whole card. You may split one card across several destinations.',
  '4. Prefer existing docs and their existing headings. Use "Unsorted" when no heading fits.',
  "5. Placement: if a fact is true outside the project (how a system works, a reusable technique, a process), send it to a topic, process or service doc, not the project doc. Doc types: topic = general knowledge, the catch-all; project = a piece of work with a goal and an end; process = how to do something, step by step (deploying, testing, migrations); service = one specific running system or codebase (a microservice, a repo, an internal platform): how it works, its config, APIs, and quirks. The server adds the project's \"See [[…]]\" link line itself, so never also send the same lines to the project.",
  `6. Create a new doc ({ "newDoc": { "title", "type", "aliases" } }) only when nothing fits. Never create a near-duplicate of an existing doc; use ${SEARCH_TOOL} first when unsure.`,
  "7. Give one short reason (one sentence) per destination.",
  "8. If a card has an @tag that is not a Wiki doc but clearly means an existing doc (a typo or an abbreviation), add { \"tag\", \"slug\" } to that card's tagMatches. The user sees these as suggestions only.",
  "9. If a card does not belong in the Wiki at all, give it an empty destinations list; the user decides.",
  `10. Call ${ROUTES_TOOL} exactly once, with a route for every card below. If it reports problems, call it again with only the cards it lists. Then stop.`,
].join("\n");

export function routingPrompt(ctx: WikiContext, cards: readonly Card[]): string {
  const catalog = ctx.store.catalog(LIMITS.catalogDocs);
  const total = ctx.store.docCount();
  const catalogBody = catalog.length === 0 ? "The Wiki has no docs yet." : catalog.map(catalogLine).join("\n");
  return [
    "You are sorting the user's notes into their Wiki of topic, project, process and service docs. Each card below is copied word for word from a daily note item or from a section of one of the user's reference notes.",
    "Your only job is to choose where each card's lines go. You never write text.",
    "",
    ROUTING_RULES,
    "",
    "## Doc catalog",
    `Showing ${catalog.length} of ${total} docs, most recently updated first. Use ${SEARCH_TOOL} to find others and ${GET_TOOL} to read one.`,
    catalogBody,
    "",
    `## Cards (${cards.length})`,
    cards.map((card) => cardSection(ctx, card)).join("\n\n"),
    "",
    `Now call ${ROUTES_TOOL} once with routes for all ${cards.length} cards: ${cards.map((card) => card.id).join(", ")}.`,
  ].join("\n");
}

function routingTitle(date: string, plan: RouteJobPlan): string {
  return plan.total > 1 ? `Wiki routing ${date} (${plan.index} of ${plan.total})` : `Wiki routing ${date}`;
}

function settleUnstartedJob(ctx: WikiContext, jobId: string, error: string | null): void {
  const job = ctx.store.getJob(jobId);
  if (job !== null) settleJob(ctx, job, error !== null, error);
}

async function launchThread(ctx: WikiContext, jobId: string, args: () => Promise<SpawnArgs>): Promise<void> {
  const thread = spawnedThreadSchema.parse(await ctx.bb.sdk.threads.spawn(await args()));
  if (ctx.store.getJob(jobId)?.status !== "running") {
    await releaseThread(ctx, thread.id);
    return;
  }
  ctx.store.setJobThread(jobId, thread.id);
}

async function startJobThread(ctx: WikiContext, jobId: string, args: () => Promise<SpawnArgs>, startError: string): Promise<void> {
  armTimeout(ctx, jobId, ROUTING_TIMEOUT_MS);
  const launched = launchThread(ctx, jobId, args).catch((error: unknown) => {
    ctx.log.warn(`Wiki could not start a job thread: ${errorMessage(error)}`);
    settleUnstartedJob(ctx, jobId, `${startError}: ${errorMessage(error)}`);
  });
  await Promise.race([launched, waitForJob(ctx, jobId)]);
}

async function spawnRouteJob(ctx: WikiContext, plan: RouteJobPlan): Promise<void> {
  runtimeOf(ctx).queued.delete(plan.id);
  const cards = ctx.store.cardsForJob(plan.id).filter((card) => card.status === "routing");
  if (cards.length === 0) {
    settleUnstartedJob(ctx, plan.id, null);
    return;
  }
  const args = async (): Promise<SpawnArgs> => ({
    projectId: PERSONAL_PROJECT_ID,
    environment: { type: "host", workspace: { type: "personal" } },
    ...(await jobExecution(ctx)),
    visibility: "hidden",
    title: routingTitle(await todayIso(ctx), plan),
    prompt: routingPrompt(ctx, cards),
    pluginMetadata: { wikiJob: "route", jobId: plan.id },
  });
  await startJobThread(ctx, plan.id, args, "Could not start the routing thread");
}

async function runQueuedJobs(ctx: WikiContext, plans: readonly RouteJobPlan[]): Promise<void> {
  for (let index = 1; index < plans.length; index += 1) {
    const previous = plans[index - 1];
    const plan = plans[index];
    if (previous === undefined || plan === undefined) continue;
    await waitForJob(ctx, previous.id);
    await spawnRouteJob(ctx, plan);
  }
}

function fallBackAll(ctx: WikiContext, cards: readonly Card[]): void {
  for (const card of cards) fallbackToRules(ctx, card, FALLBACK_REASON);
  ctx.publishInbox();
}

export async function startRoutingJobs(ctx: WikiContext, cards: readonly Card[]): Promise<string[]> {
  const routing = cards.filter((card) => card.status === "routing");
  if (routing.length === 0) return [];
  if (!(await personalProjectExists(ctx))) {
    ctx.log.warn("Wiki routing needs the personal project; routing by links and tags only.");
    fallBackAll(ctx, routing);
    return [];
  }
  const batches = batchCards(routing);
  const runtime = runtimeOf(ctx);
  const plans = batches.map((batch, index): RouteJobPlan => {
    const job = ctx.store.createJob({ kind: "route", payload: { cardIds: batch.map((card) => card.id) } });
    for (const card of batch) ctx.store.setCardJob(card.id, job.id);
    runtime.queued.add(job.id);
    return { id: job.id, index: index + 1, total: batches.length };
  });
  const [first] = plans;
  if (first !== undefined) await spawnRouteJob(ctx, first);
  if (plans.length > 1) {
    runQueuedJobs(ctx, plans).catch((error: unknown) => ctx.log.warn(`Wiki routing queue failed: ${errorMessage(error)}`));
  }
  return plans.map((plan) => plan.id);
}

function routeTarget(target: RecordRoutesParams["routes"][number]["destinations"][number]["target"]): DocTarget {
  if ("slug" in target) return { kind: "existing", slug: target.slug };
  return { kind: "new", title: target.newDoc.title, type: target.newDoc.type, aliases: target.newDoc.aliases };
}

function cardRoutes(route: RecordRoutesParams["routes"][number]): CardRoutes {
  return {
    destinations: route.destinations.map((destination) => ({
      target: routeTarget(destination.target),
      heading: destination.heading,
      lineRanges: destination.lineRanges,
      reason: destination.reason,
    })),
    tagMatches: route.tagMatches,
  };
}

function requireJob(ctx: WikiContext, threadId: string, kind: JobKind, tool: string): Job {
  const job = ctx.store.jobForThread(threadId);
  const label = kind === "route" ? "a Wiki routing thread" : "a Wiki image description thread";
  if (job === null || job.kind !== kind) throw new Error(`${tool} only works in ${label}.`);
  if (job.status !== "running") throw new Error(`This Wiki job already finished (${job.status}); nothing was recorded.`);
  return job;
}

function routeSummary(applied: number, total: number, problems: readonly string[], waiting: readonly string[]): string {
  const lines = [`Recorded routes for ${applied} of ${total} card${total === 1 ? "" : "s"}.`];
  if (problems.length > 0) {
    lines.push(`Problems (fix these and call ${ROUTES_TOOL} again with only these cards):`, ...problems.map((problem) => `- ${problem}`));
  }
  lines.push(waiting.length === 0 ? "Every card in this job is routed. You are done." : `Still waiting for routes: ${waiting.join(", ")}.`);
  return lines.join("\n");
}

export async function recordRoutes(ctx: WikiContext, threadId: string, params: RecordRoutesParams): Promise<string> {
  const job = requireJob(ctx, threadId, "route", ROUTES_TOOL);
  const cards = new Map(ctx.store.cardsForJob(job.id).map((card) => [card.id, card]));
  const problems: string[] = [];
  const seen = new Set<string>();
  let applied = 0;
  for (const route of params.routes) {
    const card = cards.get(route.cardId);
    if (seen.has(route.cardId)) problems.push(`${route.cardId}: listed more than once; only the first route was used.`);
    else if (card === undefined) problems.push(`${route.cardId}: not one of the cards in this routing job.`);
    else if (card.status !== "routing") problems.push(`${route.cardId}: already recorded or reviewed; left as it is.`);
    else {
      try {
        applyRoutes(ctx, card, cardRoutes(route));
        applied += 1;
      } catch (error) {
        problems.push(`${route.cardId}: ${errorMessage(error)}`);
      }
    }
    seen.add(route.cardId);
  }
  const waiting = ctx.store.cardsForJob(job.id).filter((card) => card.status === "routing").map((card) => card.id);
  if (applied > 0) ctx.publishInbox();
  if (waiting.length === 0) {
    ctx.store.finishJob(job.id, { status: "done" });
    markSettled(ctx, job.id);
  }
  return routeSummary(applied, params.routes.length, problems, waiting);
}

const DESCRIBE_PROMPT = [
  "Look at the attached image and write a concise, factual description of it in 1-3 sentences, so the user can find it later by search.",
  "Say what kind of image it is (for example a screenshot, diagram, chart or photo), what it shows, and any important visible text or names. Do not guess beyond what is visible.",
  `Then call ${DESCRIPTION_TOOL} once with { "description": "…" } and stop.`,
  `${TOOL_LIMITS} Use only the Wiki tool you were given, ${DESCRIPTION_TOOL}. Do not add anything to the Wiki yourself; the user reviews the description before it is saved.`,
].join("\n");

async function assertImageFile(absImagePath: string): Promise<void> {
  if (!path.isAbsolute(absImagePath) || mediaKindOf(absImagePath) !== "image") {
    throw new Error("Describing needs an absolute path to a .png, .jpg, .jpeg, .gif or .webp image.");
  }
  const stats = await stat(absImagePath).catch(() => null);
  if (stats === null || !stats.isFile()) throw new Error(`There is no image file at ${absImagePath}.`);
}

export async function startDescribeJob(ctx: WikiContext, absImagePath: string): Promise<{ jobId: string }> {
  await assertImageFile(absImagePath);
  const job = ctx.store.createJob({ kind: "describe", payload: { path: absImagePath } });
  if (!(await personalProjectExists(ctx))) {
    ctx.store.finishJob(job.id, { status: "failed", error: "Claude Code needs the personal project to describe images." });
    return { jobId: job.id };
  }
  const args = async (): Promise<SpawnArgs> => ({
    projectId: PERSONAL_PROJECT_ID,
    environment: { type: "host", workspace: { type: "personal" } },
    ...(await jobExecution(ctx)),
    visibility: "hidden",
    title: `Wiki image description ${path.basename(absImagePath)}`,
    input: [
      { type: "text", text: DESCRIBE_PROMPT, mentions: [] },
      { type: "localImage", path: absImagePath },
    ],
    pluginMetadata: { wikiJob: "describe", jobId: job.id },
  });
  await startJobThread(ctx, job.id, args, "Could not start Claude Code");
  return { jobId: job.id };
}

export async function recordDescription(ctx: WikiContext, threadId: string, params: RecordDescriptionParams): Promise<string> {
  const job = requireJob(ctx, threadId, "describe", DESCRIPTION_TOOL);
  const description = truncate(params.description.trim(), LIMITS.caption);
  if (description === "") throw new Error("The description is empty.");
  ctx.store.finishJob(job.id, { status: "done", result: description });
  markSettled(ctx, job.id);
  return "Saved the description for the user to review. You are done.";
}

export async function handleThreadSettled(ctx: WikiContext, threadId: string, failed: boolean, error: string | null): Promise<void> {
  const job = ctx.store.jobForThread(threadId);
  if (job === null) return;
  settleJob(ctx, job, failed, error);
  await releaseThread(ctx, threadId);
}

async function threadState(ctx: WikiContext, threadId: string): Promise<ThreadState | null> {
  try {
    return threadStateSchema.parse(await ctx.bb.sdk.threads.get({ threadId }));
  } catch (error) {
    ctx.log.debug(`Wiki could not read job thread ${threadId}: ${errorMessage(error)}`);
    return null;
  }
}

function isSettled(thread: ThreadState): boolean {
  const gone = (thread.archivedAt ?? null) !== null || (thread.deletedAt ?? null) !== null;
  return gone || thread.status === "idle" || thread.status === "error";
}

function remainingMs(startedAt: number, now: number): number {
  return Math.max(0, ROUTING_TIMEOUT_MS - (now - startedAt));
}

async function recoverJob(ctx: WikiContext, job: Job): Promise<void> {
  const runtime = runtimeOf(ctx);
  if (runtime.queued.has(job.id) || runtime.timers.has(job.id)) return;
  if (job.threadId === null) {
    settleJob(ctx, job, true, "The Wiki restarted before this job's thread started.");
    return;
  }
  const thread = await threadState(ctx, job.threadId);
  if (thread !== null && isSettled(thread)) {
    const failed = thread.status === "error";
    await handleThreadSettled(ctx, job.threadId, failed, failed ? "The job's thread failed." : null);
    return;
  }
  const startedAt = thread?.createdAt ?? Date.parse(job.createdAt);
  armTimeout(ctx, job.id, remainingMs(Number.isFinite(startedAt) ? startedAt : 0, Date.now()));
}

export async function recoverJobs(ctx: WikiContext): Promise<void> {
  for (const job of ctx.store.runningJobs()) {
    try {
      await recoverJob(ctx, job);
    } catch (error) {
      ctx.log.warn(`Wiki could not recover job ${job.id}: ${errorMessage(error)}`);
    }
  }
}

function clearAllTimers(ctx: WikiContext): void {
  const runtime = runtimeOf(ctx);
  for (const timer of runtime.timers.values()) clearTimeout(timer);
  runtime.timers.clear();
}

async function settleFromEvent(ctx: WikiContext, threadId: string, failed: boolean, error: string | null): Promise<void> {
  try {
    await handleThreadSettled(ctx, threadId, failed, error);
  } catch (caught) {
    ctx.log.warn(`Wiki could not finish the job for thread ${threadId}: ${errorMessage(caught)}`);
  }
}

export function registerRouting(ctx: WikiContext): void {
  ctx.bb.events.on("thread.idle", ({ thread }) => settleFromEvent(ctx, thread.id, false, null));
  ctx.bb.events.on("thread.failed", ({ thread, error }) => settleFromEvent(ctx, thread.id, true, error));
  ctx.bb.onDispose(() => clearAllTimers(ctx));
  recoverJobs(ctx).catch((error: unknown) => ctx.log.warn(`Wiki job recovery failed: ${errorMessage(error)}`));
}
