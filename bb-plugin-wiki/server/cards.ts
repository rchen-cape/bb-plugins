import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  destinationSchema,
  headingSchema,
  rememberAliasSchema,
  titleSchema,
  type Card,
  type CardPreview,
  type CardRule,
  type Destination,
  type DocTarget,
  type LineSelection,
  type RememberAlias,
  type TagSuggestion,
} from "../contract.js";
import { SKIP_TAG, formatNoteDateShort, type NoteLink, type NoteUnit } from "../lib/daily-notes.js";
import { matchTag, type FuzzyCandidate } from "../lib/fuzzy.js";
import {
  dedent,
  extractImageTargets,
  insertUnderHeading,
  newDocContent,
  rewriteImageTargets,
  type SourceMarker,
} from "../lib/markdown-doc.js";
import { normalizeTag, normalizeTags, slugify, titleFromTag } from "../lib/slug.js";
import {
  DEFAULT_DOC_TYPE,
  DEFAULT_HEADING,
  LIMITS,
  NEW_DOC_HEADING,
  RELATED_HEADING,
  mediaKindOf,
  truncate,
  type DocType,
} from "../lib/wiki.js";
import type { WikiContext } from "./context.js";
import type { CardPatch, NewCard } from "./store.js";
import { docRelPath } from "./vault.js";
import { appendToTarget, sourceBlock, todayIso, type AppendResult } from "./write.js";

export const FALLBACK_REASON = "Claude Code routing was unavailable; routed by tag only.";
export const AGENT_ROUTED_REASON = "Claude Code suggested where these lines belong.";
export const AGENT_UNROUTED_REASON = "Claude Code found no good place for this; choose one or skip it.";

export interface NotesCardItem {
  unit: NoteUnit;
  notePath: string;
  noteDate: string;
  origin?: "daily" | "file";
  section?: string;
  heading?: string;
}

function withSectionHeading(destinations: readonly DestinationDraft[], heading: string | undefined): DestinationDraft[] {
  if (heading === undefined) return [...destinations];
  const clean = clampHeading(heading);
  return destinations.map((destination) =>
    destination.role === "content" && (destination.heading === DEFAULT_HEADING || destination.heading === NEW_DOC_HEADING)
      ? { ...destination, heading: clean }
      : destination,
  );
}

function notesSource(item: NotesCardItem): Card["source"] {
  const base = { kind: "notes" as const, notePath: item.notePath, noteDate: item.noteDate, unitHash: item.unit.hash };
  if (item.origin !== "file") return base;
  return { ...base, origin: "file", ...(item.section === undefined || item.section === "" ? {} : { section: item.section }) };
}

export interface AgentCardInput {
  threadId: string;
  threadTitle: string | null;
  text: string;
  doc: string | null;
  heading: string | null;
  title: string | null;
}

export interface RouteDestination {
  target: DocTarget;
  heading: string;
  lineRanges: LineSelection;
  reason: string;
}

export interface TagMatch {
  tag: string;
  slug: string;
}

export interface CardRoutes {
  destinations: RouteDestination[];
  tagMatches: TagMatch[];
}

type DestinationDraft = Omit<Destination, "id">;

interface Routing {
  rule: CardRule;
  reason: string;
  destinations: DestinationDraft[];
  tagSuggestions: TagSuggestion[];
}

interface ContentWrite {
  destination: Destination;
  text: string;
}

interface CopiedImages {
  map: Map<string, string>;
  paths: string[];
}

interface NoteImages {
  found: Map<string, string>;
  missing: string[];
}

interface WrittenContent {
  slug: string | null;
  title: string;
}

interface WritePlan {
  card: Card;
  writes: ContentWrite[];
  links: Destination[];
  checked: Destination[];
}

interface AcceptProgress {
  touched: Set<string>;
  done: Map<string, string>;
  written: AppendResult[];
  cardChanged: boolean;
}

const COMMIT_TEXT_LIMIT = 60;
const AGENT_TITLE_LIMIT = 60;
const DESTINATION_ID = /^dst_(\d+)$/;
const SOURCE_MARKER = /<!--[\s​-‍⁠﻿]*wiki:source\b/iu;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampTitle(text: string): string {
  return truncate(collapse(text), LIMITS.title) || "Untitled";
}

function clampHeading(text: string): string {
  return truncate(collapse(text), LIMITS.heading) || DEFAULT_HEADING;
}

function clampReason(text: string): string {
  return truncate(collapse(text), LIMITS.reason);
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

function tagList(tags: readonly string[]): string {
  return listText(tags.map((tag) => `@${tag}`));
}

function newTarget(title: string, type: DocType): DocTarget {
  return { kind: "new", title: clampTitle(title), type, aliases: [] };
}

function existingTarget(slug: string): DocTarget {
  return { kind: "existing", slug };
}

function targetKey(target: DocTarget): string {
  return target.kind === "existing" ? `doc:${target.slug}` : `new:${target.title.toLowerCase()}`;
}

function targetsDoc(destination: Destination, slug: string): boolean {
  return destination.target.kind === "existing" && destination.target.slug === slug;
}

function uniqueByTarget<T extends { target: DocTarget }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = targetKey(item.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nextDestinationNumber(existing: readonly Destination[]): number {
  const numbers = existing.map((destination) => Number(DESTINATION_ID.exec(destination.id)?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
}

function assignIds(drafts: readonly DestinationDraft[], existing: readonly Destination[] = []): Destination[] {
  const start = nextDestinationNumber(existing);
  return drafts.map((draft, index) => ({ id: `dst_${start + index}`, ...draft }));
}

function fuzzyCandidates(ctx: WikiContext): FuzzyCandidate[] {
  return ctx.store.listDocs(null).map((doc) => ({ slug: doc.slug, title: doc.title, tag: doc.tag, aliases: doc.aliases }));
}

function cardTags(unit: NoteUnit): string[] {
  return unit.tags.filter((tag) => tag !== SKIP_TAG);
}

function linkDestination(ctx: WikiContext, link: NoteLink): DestinationDraft {
  const resolved = ctx.store.resolveLink(link.target);
  const target = resolved === null ? newTarget(link.target, "topic") : existingTarget(resolved.slug);
  return {
    include: true,
    target,
    heading: clampHeading(link.heading ?? DEFAULT_HEADING),
    lineRanges: "all",
    role: "content",
    reason: clampReason(
      resolved === null ? `The note links to [[${link.target}]], which is not a Wiki doc yet.` : `The note links to [[${link.target}]].`,
    ),
  };
}

function tagDestination(slug: string, tag: string): DestinationDraft {
  return {
    include: true,
    target: existingTarget(slug),
    heading: DEFAULT_HEADING,
    lineRanges: "all",
    role: "content",
    reason: clampReason(`Tagged @${tag}.`),
  };
}

function unknownTagDestination(tag: string): DestinationDraft {
  return {
    include: false,
    target: newTarget(titleFromTag(tag), "project"),
    heading: NEW_DOC_HEADING,
    lineRanges: "all",
    role: "content",
    reason: clampReason(`@${tag} isn't a Wiki doc yet; turn this on to start one.`),
  };
}

function suggestionsFor(tags: readonly string[], candidates: readonly FuzzyCandidate[]): TagSuggestion[] {
  return tags.flatMap((tag) => matchTag(tag, candidates, LIMITS.tagSuggestions).map((match) => ({ tag, ...match })));
}

function splitTags(ctx: WikiContext, tags: readonly string[]): { known: Array<{ tag: string; slug: string }>; unknown: string[] } {
  const known: Array<{ tag: string; slug: string }> = [];
  const unknown: string[] = [];
  for (const tag of tags) {
    const slug = ctx.store.resolveTag(tag);
    if (slug === null) unknown.push(tag);
    else known.push({ tag, slug });
  }
  return { known, unknown };
}

function unknownTagsReason(unknown: readonly string[]): string {
  return unknown.length === 1 ? `${tagList(unknown)} isn't a Wiki doc yet.` : `${tagList(unknown)} aren't Wiki docs yet.`;
}

function ruleFor(unit: NoteUnit, known: readonly unknown[]): CardRule {
  if (unit.explicitLinks.length > 0) return "explicit-link";
  return known.length > 0 ? "tag" : "none";
}

function routingReason(rule: CardRule, unit: NoteUnit, known: ReadonlyArray<{ tag: string }>, unknown: readonly string[]): string {
  if (rule === "explicit-link") return `The note links to ${listText(unit.explicitLinks.map((link) => `[[${link.target}]]`))}.`;
  if (rule === "tag") return `Tagged ${tagList(known.map((entry) => entry.tag))}.`;
  if (unknown.length > 0) return unknownTagsReason(unknown);
  return "No [[link]] or known @tag; choose where this belongs.";
}

function contentTags(ctx: WikiContext, known: ReadonlyArray<{ tag: string; slug: string }>): Array<{ tag: string; slug: string }> {
  const elsewhere = known.filter((entry) => ctx.store.getDoc(entry.slug)?.type !== "project");
  return elsewhere.length > 0 ? elsewhere : [...known];
}

function provisionalRouting(ctx: WikiContext, unit: NoteUnit, candidates: readonly FuzzyCandidate[]): Routing {
  const { known, unknown } = splitTags(ctx, cardTags(unit));
  const rule = ruleFor(unit, known);
  const primary =
    rule === "explicit-link"
      ? unit.explicitLinks.map((link) => linkDestination(ctx, link))
      : contentTags(ctx, known).map((entry) => tagDestination(entry.slug, entry.tag));
  const destinations = uniqueByTarget([...primary, ...unknown.map(unknownTagDestination)]).slice(0, LIMITS.destinations);
  return {
    rule,
    reason: clampReason(routingReason(rule, unit, known, unknown)),
    destinations,
    tagSuggestions: suggestionsFor(unknown, candidates),
  };
}

function projectLinks(ctx: WikiContext, tags: readonly string[]): Array<{ tag: string; slug: string; title: string }> {
  const seen = new Set<string>();
  return tags.flatMap((tag) => {
    const slug = ctx.store.resolveTag(tag);
    const doc = slug === null ? null : ctx.store.getDoc(slug);
    if (doc === null || doc.type !== "project" || seen.has(doc.slug)) return [];
    seen.add(doc.slug);
    return [{ tag, slug: doc.slug, title: doc.title }];
  });
}

function projectLinkDraft(project: { tag: string; title: string; slug: string }): DestinationDraft {
  return {
    include: true,
    target: existingTarget(project.slug),
    heading: RELATED_HEADING,
    lineRanges: "all",
    role: "link",
    reason: clampReason(`@${project.tag} is the project “${project.title}”; it gets a link line instead of a copy.`),
  };
}

export function withProjectLinks(ctx: WikiContext, tags: readonly string[], destinations: readonly Destination[]): Destination[] {
  const content = destinations.filter((destination) => destination.role === "content" && destination.include);
  if (content.length === 0) return [...destinations];
  let result = [...destinations];
  for (const project of projectLinks(ctx, tags)) {
    if (content.some((destination) => targetsDoc(destination, project.slug))) continue;
    if (result.some((destination) => destination.role === "link" && targetsDoc(destination, project.slug))) continue;
    if (result.length >= LIMITS.destinations) break;
    result = [...result, ...assignIds([projectLinkDraft(project)], result)];
  }
  return result;
}

function notesCardInput(ctx: WikiContext, item: NotesCardItem, candidates: readonly FuzzyCandidate[], useAgent: boolean): NewCard {
  const { unit } = item;
  const routing = provisionalRouting(ctx, unit, candidates);
  const tags = cardTags(unit);
  const routed = useAgent && routing.rule !== "explicit-link";
  const destinations = assignIds(routing.rule === "explicit-link" ? routing.destinations : withSectionHeading(routing.destinations, item.heading));
  return {
    status: routed ? "routing" : "pending",
    source: notesSource(item),
    text: unit.text,
    lines: unit.lines,
    tags,
    rule: routing.rule,
    reason: routing.reason,
    destinations: routed ? destinations : withProjectLinks(ctx, tags, destinations),
    tagSuggestions: routing.tagSuggestions,
    rememberAliases: [],
  };
}

export async function createNotesCards(
  ctx: WikiContext,
  items: ReadonlyArray<NotesCardItem>,
  options: { useAgent: boolean },
): Promise<Card[]> {
  const candidates = fuzzyCandidates(ctx);
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const item of items) {
    const hash = item.unit.hash;
    if (seen.has(hash) || ctx.store.getUnit(hash) !== null) continue;
    seen.add(hash);
    const card = ctx.store.createCard(notesCardInput(ctx, item, candidates, options.useAgent));
    ctx.store.upsertUnit({ hash, notePath: item.notePath, noteDate: item.noteDate, status: "pending", cardId: card.id });
    cards.push(card);
  }
  if (cards.length > 0) ctx.publishInbox();
  return cards;
}

function titleFromText(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
  const plain = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+|>\s*)*/, "");
  return truncate(collapse(plain), AGENT_TITLE_LIMIT) || "Untitled";
}

function agentThreadLabel(input: AgentCardInput): string {
  const title = blankToNull(input.threadTitle);
  return title === null ? `thread ${input.threadId}` : `“${collapse(title)}”`;
}

function agentDestination(ctx: WikiContext, input: AgentCardInput): { rule: CardRule; destination: DestinationDraft } {
  const doc = blankToNull(input.doc);
  const heading = blankToNull(input.heading);
  const title = blankToNull(input.title);
  const resolved = doc === null ? null : ctx.store.resolveLink(doc);
  if (resolved !== null) {
    const docTitle = ctx.store.getDoc(resolved.slug)?.title ?? resolved.slug;
    return {
      rule: "explicit-link",
      destination: {
        include: true,
        target: existingTarget(resolved.slug),
        heading: clampHeading(heading ?? resolved.heading ?? DEFAULT_HEADING),
        lineRanges: "all",
        role: "content",
        reason: clampReason(`The agent asked to add this to “${docTitle}”.`),
      },
    };
  }
  const reason = title !== null ? `The agent suggested a new doc “${collapse(title)}”.` : "The agent named no existing doc; pick one or turn this on.";
  return {
    rule: "none",
    destination: {
      include: title !== null,
      target: newTarget(title ?? doc ?? titleFromText(input.text), DEFAULT_DOC_TYPE),
      heading: clampHeading(heading ?? NEW_DOC_HEADING),
      lineRanges: "all",
      role: "content",
      reason: clampReason(reason),
    },
  };
}

function agentText(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  if (text.trim() === "") throw new Error("Give the text to add to the Wiki.");
  if (SOURCE_MARKER.test(text)) {
    throw new Error("The text has a Wiki source marker line (<!-- wiki:source … -->); remove it, because the Wiki records where text came from itself.");
  }
  return text;
}

export async function createAgentCard(ctx: WikiContext, input: AgentCardInput): Promise<Card> {
  const text = agentText(input.text);
  const { rule, destination } = agentDestination(ctx, { ...input, text });
  const card = ctx.store.createCard({
    status: "pending",
    source: { kind: "agent", threadId: input.threadId, threadTitle: blankToNull(input.threadTitle) },
    text,
    lines: text.split("\n"),
    tags: [],
    rule,
    reason: clampReason(`Written by an agent in ${agentThreadLabel(input)}; review before adding.`),
    destinations: assignIds([destination]),
    tagSuggestions: [],
    rememberAliases: [],
  });
  ctx.publishInbox();
  return card;
}

function requireCard(ctx: WikiContext, id: string): Card {
  const card = ctx.store.getCard(id);
  if (card === null) throw new Error(`No Wiki inbox card ${id}.`);
  return card;
}

function assertOpen(card: Card): void {
  if (card.status === "accepted" || card.status === "skipped") {
    throw new Error(`Card ${card.id} was already ${card.status}.`);
  }
}

function saveCard(ctx: WikiContext, id: string, patch: CardPatch): Card {
  const card = ctx.store.updateCard(id, patch);
  if (card === null) throw new Error(`No Wiki inbox card ${id}.`);
  return card;
}

function lineCountText(count: number): string {
  return count === 1 ? "1 line (0)" : `${count} lines (0-${count - 1})`;
}

export function assertLineSelection(selection: LineSelection, count: number, label: string): void {
  if (selection === "all") return;
  if (selection.length === 0) throw new Error(`${label}: choose at least one line range, or "all".`);
  for (const range of selection) {
    if (range.end < range.start) throw new Error(`${label}: line range ${range.start}-${range.end} ends before it starts.`);
    if (range.end >= count) {
      throw new Error(`${label}: lines ${range.start}-${range.end} are outside this card's ${lineCountText(count)}.`);
    }
  }
}

function assertDocExists(ctx: WikiContext, slug: string, label: string): void {
  if (ctx.store.getDoc(slug) === null) throw new Error(`${label}: there is no Wiki doc with slug "${slug}".`);
}

function settledTarget(ctx: WikiContext, target: DocTarget): DocTarget {
  if (target.kind === "existing" || /[#|]/.test(target.title)) return target;
  const resolved = ctx.store.resolveLink(target.title);
  return resolved === null ? target : existingTarget(resolved.slug);
}

function settled(ctx: WikiContext, destination: Destination): Destination {
  const target = settledTarget(ctx, destination.target);
  return target === destination.target ? destination : { ...destination, target };
}

function checkedAliases(ctx: WikiContext, aliases: readonly string[], label: string): string[] {
  const tags = normalizeTags(aliases);
  for (const tag of tags) {
    const owner = ctx.store.resolveTag(tag);
    if (owner === null) continue;
    const title = ctx.store.getDoc(owner)?.title ?? owner;
    throw new Error(`${label}: @${tag} already names “${title}”; send the lines to that doc, or leave the alias out.`);
  }
  return tags;
}

function routeTarget(ctx: WikiContext, target: DocTarget, label: string): DocTarget {
  if (target.kind === "existing") {
    assertDocExists(ctx, target.slug, label);
    return target;
  }
  const title = titleSchema.safeParse(target.title);
  if (!title.success) throw new Error(`${label}: a new doc needs a title of 1-${LIMITS.title} characters.`);
  const resolved = settledTarget(ctx, { ...target, title: title.data });
  if (resolved.kind === "existing") return resolved;
  return { ...resolved, aliases: checkedAliases(ctx, target.aliases, label) };
}

function routeHeading(heading: string, label: string): string {
  const parsed = headingSchema.safeParse(heading);
  if (!parsed.success) throw new Error(`${label}: the heading must be 1-${LIMITS.heading} characters.`);
  return parsed.data;
}

function routeDraft(ctx: WikiContext, card: Card, route: RouteDestination, index: number): DestinationDraft {
  const label = `Destination ${index + 1}`;
  assertLineSelection(route.lineRanges, card.lines.length, label);
  return {
    include: true,
    target: routeTarget(ctx, route.target, label),
    heading: routeHeading(route.heading, label),
    lineRanges: route.lineRanges,
    role: "content",
    reason: clampReason(route.reason),
  };
}

function compareSuggestions(a: TagSuggestion, b: TagSuggestion): number {
  if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
  return b.score - a.score;
}

function agentSuggestions(ctx: WikiContext, card: Card, matches: readonly TagMatch[]): TagSuggestion[] {
  const fresh = matches.map((match) => {
    const tag = normalizeTag(match.tag);
    if (!card.tags.includes(tag)) {
      const known = card.tags.length === 0 ? "it has none" : `it has ${tagList(card.tags)}`;
      throw new Error(`Tag match @${tag || match.tag}: that is not one of this card's tags (${known}).`);
    }
    const doc = ctx.store.getDoc(match.slug);
    if (doc === null) throw new Error(`Tag match @${tag}: there is no Wiki doc with slug "${match.slug}".`);
    return { tag, slug: doc.slug, title: doc.title, score: 1 };
  });
  const kept = card.tagSuggestions.filter((entry) => !fresh.some((match) => match.tag === entry.tag && match.slug === entry.slug));
  return [...kept, ...fresh].sort(compareSuggestions);
}

export function applyRoutes(ctx: WikiContext, card: Card, routes: CardRoutes): Card {
  assertOpen(card);
  if (routes.destinations.length > LIMITS.destinations) {
    throw new Error(`Give at most ${LIMITS.destinations} destinations per card.`);
  }
  const drafts = routes.destinations.map((route, index) => routeDraft(ctx, card, route, index));
  const tagSuggestions = agentSuggestions(ctx, card, routes.tagMatches);
  return saveCard(ctx, card.id, {
    status: "pending",
    rule: "agent",
    reason: drafts.length === 0 ? AGENT_UNROUTED_REASON : AGENT_ROUTED_REASON,
    destinations: withProjectLinks(ctx, card.tags, assignIds(drafts)),
    tagSuggestions,
  });
}

export function fallbackToRules(ctx: WikiContext, card: Card, reason: string): Card {
  const current = ctx.store.getCard(card.id) ?? card;
  if (current.status !== "routing") return current;
  return saveCard(ctx, current.id, {
    status: "pending",
    reason: clampReason(reason),
    destinations: withProjectLinks(ctx, current.tags, current.destinations),
  });
}

function assertUniqueIds(destinations: readonly Destination[]): void {
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (seen.has(destination.id)) throw new Error(`Destination id "${destination.id}" is used twice.`);
    seen.add(destination.id);
  }
}

function checkDestination(ctx: WikiContext, card: Card, destination: Destination): void {
  const label = `Destination ${destination.id}`;
  const { target } = destination;
  if (target.kind === "existing") assertDocExists(ctx, target.slug, label);
  else checkedAliases(ctx, target.aliases, label);
  assertLineSelection(destination.lineRanges, card.lines.length, label);
}

function checkRememberAliases(ctx: WikiContext, aliases: readonly RememberAlias[]): RememberAlias[] {
  const chosen = new Map<string, string>();
  for (const entry of aliases) {
    const tag = normalizeTag(entry.tag);
    if (tag === "") throw new Error(`Remembered alias "${entry.tag}" has no letters or digits.`);
    assertDocExists(ctx, entry.slug, `Remembered alias @${tag}`);
    const owner = ctx.store.resolveTag(tag);
    if (owner !== null && owner !== entry.slug) {
      const title = ctx.store.getDoc(owner)?.title ?? owner;
      throw new Error(`@${tag} already belongs to “${title}”.`);
    }
    const previous = chosen.get(tag);
    if (previous !== undefined && previous !== entry.slug) throw new Error(`@${tag} is remembered for two different docs.`);
    chosen.set(tag, entry.slug);
  }
  return [...chosen].map(([tag, slug]) => ({ tag, slug }));
}

export function updateCardDestinations(
  ctx: WikiContext,
  id: string,
  destinations: Destination[],
  rememberAliases: RememberAlias[],
): Card {
  const card = requireCard(ctx, id);
  assertOpen(card);
  if (destinations.length > LIMITS.destinations) throw new Error(`A card can have at most ${LIMITS.destinations} destinations.`);
  const parsed = keepWritten(card, destinations.map((destination) => destinationSchema.parse(destination)));
  assertUniqueIds(parsed);
  for (const destination of parsed) checkDestination(ctx, card, destination);
  const remembered = checkRememberAliases(ctx, rememberAliases.map((entry) => rememberAliasSchema.parse(entry)));
  return saveCard(ctx, id, { status: "pending", destinations: parsed, rememberAliases: remembered });
}

function unwritten({ id, include, target, heading, lineRanges, role, reason }: Destination): Destination {
  return { id, include, target, heading, lineRanges, role, reason };
}

function keepWritten(card: Card, destinations: readonly Destination[]): Destination[] {
  const written = new Map(card.destinations.filter((destination) => destination.written === true).map((destination) => [destination.id, destination]));
  for (const id of written.keys()) {
    if (!destinations.some((destination) => destination.id === id)) {
      throw new Error(`Destination ${id} was already added to the Wiki, so it stays on the card.`);
    }
  }
  return destinations.map((destination) => {
    const stored = written.get(destination.id);
    if (stored === undefined) return unwritten(destination);
    if (destination.include) throw new Error(`Destination ${destination.id} was already added to the Wiki, so it can't be turned on again.`);
    return stored;
  });
}

function selectedLines(card: Card, selection: LineSelection): string[] {
  if (selection === "all") return card.lines;
  const indexes = new Set<number>();
  for (const range of selection) {
    for (let line = range.start; line <= range.end; line += 1) indexes.add(line);
  }
  return [...indexes].sort((a, b) => a - b).flatMap((line) => card.lines[line] ?? []);
}

function contentText(card: Card, destination: Destination): string {
  const text = dedent(selectedLines(card, destination.lineRanges)).join("\n");
  if (text.trim() === "") throw new Error(`Destination ${destination.id} selects only blank lines.`);
  return text;
}

function includedDestinations(card: Card): { content: Destination[]; links: Destination[] } {
  const included = card.destinations.filter((destination) => destination.include && destination.written !== true);
  return {
    content: included.filter((destination) => destination.role === "content"),
    links: included.filter((destination) => destination.role === "link"),
  };
}

function writtenContent(ctx: WikiContext, card: Card): WrittenContent[] {
  return card.destinations.flatMap((destination) => {
    if (destination.written !== true || destination.role !== "content" || destination.target.kind !== "existing") return [];
    const { slug } = destination.target;
    return [{ slug, title: ctx.store.getDoc(slug)?.title ?? slug }];
  });
}

function hasContent(ctx: WikiContext, card: Card, content: readonly Destination[]): boolean {
  return content.length > 0 || writtenContent(ctx, card).length > 0;
}

function writableDestinations(ctx: WikiContext, card: Card): { content: Destination[]; links: Destination[] } {
  const included = includedDestinations(card);
  if (!hasContent(ctx, card, included.content)) throw new Error("Turn on at least one destination with content before adding this card.");
  return included;
}

function checkWritable(ctx: WikiContext, card: Card, destinations: readonly Destination[]): void {
  for (const destination of destinations) checkDestination(ctx, card, destination);
  for (const entry of card.rememberAliases) assertDocExists(ctx, entry.slug, `Remembered alias @${entry.tag}`);
}

function markerFor(card: Card, added: string): SourceMarker {
  if (card.source.kind === "notes") {
    const noteDate = card.source.origin === "file" ? "" : card.source.noteDate;
    return { kind: "notes", notePath: card.source.notePath, noteDate, added };
  }
  return { kind: "agent", threadId: card.source.threadId, title: card.source.threadTitle, added };
}

function linkDate(card: Card, added: string): string {
  return formatNoteDateShort(card.source.kind === "notes" && card.source.origin !== "file" ? card.source.noteDate : added);
}

function linkBlock(titles: readonly string[], date: string): string | null {
  const unique = [...new Set(titles)];
  if (unique.length === 0) return null;
  return unique.map((title) => `- See [[${title}]] (from ${date})`).join("\n");
}

function contentTitles(written: readonly WrittenContent[], link: Destination): string[] {
  return written.filter((entry) => entry.slug === null || !targetsDoc(link, entry.slug)).map((entry) => entry.title);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realOrNull(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}

function imageBases(notesRoot: string, notePath: string): string[] {
  const root = path.resolve(notesRoot);
  const bases: string[] = [];
  for (let dir = path.dirname(path.resolve(root, notePath)); dir !== root && isInside(root, dir); dir = path.dirname(dir)) bases.push(dir);
  return [...bases, root];
}

function imageCandidates(notesRoot: string, notePath: string, target: string): string[] {
  if (path.isAbsolute(target)) return [target];
  return [...new Set(imageBases(notesRoot, notePath).map((base) => path.resolve(base, target)))];
}

async function findNoteImage(realNotesRoot: string, notesRoot: string, notePath: string, target: string): Promise<string | null> {
  if (mediaKindOf(target) !== "image") return null;
  for (const candidate of imageCandidates(notesRoot, notePath, target)) {
    const real = await realOrNull(candidate);
    if (real === null || !isInside(realNotesRoot, real)) continue;
    const stats = await stat(real).catch(() => null);
    if (stats?.isFile() === true) return real;
  }
  return null;
}

async function resolveNoteImages(ctx: WikiContext, card: Card, texts: readonly string[]): Promise<NoteImages> {
  const images: NoteImages = { found: new Map(), missing: [] };
  if (card.source.kind !== "notes") return images;
  const targets = [...new Set(texts.flatMap((text) => extractImageTargets(text)))].filter((target) => mediaKindOf(target) === "image");
  if (targets.length === 0) return images;
  const notesRoot = await ctx.notesRoot();
  const realNotesRoot = await realOrNull(notesRoot);
  for (const target of targets) {
    const source = realNotesRoot === null ? null : await findNoteImage(realNotesRoot, notesRoot, card.source.notePath, target);
    if (source === null) images.missing.push(target);
    else images.found.set(target, source);
  }
  return images;
}

async function copyNoteImages(ctx: WikiContext, card: Card, texts: readonly string[]): Promise<CopiedImages> {
  const copied: CopiedImages = { map: new Map(), paths: [] };
  const { found } = await resolveNoteImages(ctx, card, texts);
  for (const [target, source] of found) {
    const { relPath } = await ctx.vault.copyAsset(source);
    copied.map.set(target, relPath);
    copied.paths.push(relPath);
  }
  return copied;
}

function withImages(text: string, images: CopiedImages): string {
  if (images.map.size === 0) return text;
  return rewriteImageTargets(text, (target) => images.map.get(target) ?? null);
}

function commitMessage(card: Card, titles: readonly string[], complete: boolean): string {
  const unique = [...new Set(titles)];
  const destinations = unique.length === 0 ? "" : ` → ${unique.join(", ")}`;
  return `Wiki: ${truncate(collapse(card.text), COMMIT_TEXT_LIMIT)}${destinations}${complete ? "" : " (incomplete)"}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function planWrite(ctx: WikiContext, card: Card): WritePlan {
  const { content, links } = writableDestinations(ctx, card);
  const checked = [...content, ...links].map((destination) => settled(ctx, destination));
  checkWritable(ctx, card, checked);
  return { card, writes: content.map((destination) => ({ destination, text: contentText(card, destination) })), links, checked };
}

function planSlugs(plan: WritePlan): string[] {
  const targets = plan.checked.flatMap((destination) => (destination.target.kind === "existing" ? [destination.target.slug] : []));
  return [...new Set([...plan.card.rememberAliases.map((entry) => entry.slug), ...targets])];
}

async function assertReadable(ctx: WikiContext, plan: WritePlan): Promise<void> {
  for (const slug of planSlugs(plan)) {
    const doc = await ctx.vault.readDoc(slug);
    if (doc === null) throw new Error(`The Wiki doc "${slug}" is gone from the Wiki folder; choose another doc.`);
    if (sha256Hex(doc.content) !== doc.sha256) {
      throw new Error(`The Wiki doc "${slug}" is not valid UTF-8, so nothing was added; fix the file or choose another doc.`);
    }
  }
}

function claimCard(ctx: WikiContext, card: Card, progress: AcceptProgress): Card {
  if (card.status !== "routing") return card;
  progress.cardChanged = true;
  return saveCard(ctx, card.id, { status: "pending" });
}

function landed(destination: Destination, slug: string | undefined): Destination {
  return slug === undefined || targetsDoc(destination, slug) ? destination : { ...destination, target: existingTarget(slug) };
}

function acceptedDestinations(card: Card, done: ReadonlyMap<string, string>): Destination[] {
  return card.destinations.map((destination) => {
    const slug = done.get(destination.id);
    return slug === undefined ? destination : { ...landed(destination, slug), written: true };
  });
}

function alreadyAdded(destination: Destination, slug: string): Destination {
  return { ...landed(destination, slug), include: false, written: true, reason: clampReason(`Already added. ${destination.reason}`) };
}

function recordWritten(ctx: WikiContext, card: Card, destinationId: string, slug: string, progress: AcceptProgress): void {
  const current = requireCard(ctx, card.id);
  const destinations = current.destinations.map((destination) => (destination.id === destinationId ? alreadyAdded(destination, slug) : destination));
  saveCard(ctx, card.id, { destinations });
  progress.cardChanged = true;
}

async function appendDestination(
  ctx: WikiContext,
  card: Card,
  destination: Destination,
  block: string,
  progress: AcceptProgress,
): Promise<AppendResult> {
  const target = settledTarget(ctx, destination.target);
  const result = await appendToTarget(ctx, { target, heading: destination.heading, block });
  progress.done.set(destination.id, result.slug);
  progress.touched.add(docRelPath(result.slug));
  recordWritten(ctx, card, destination.id, result.slug, progress);
  return result;
}

async function writePlan(ctx: WikiContext, plan: WritePlan, progress: AcceptProgress): Promise<void> {
  const { card } = plan;
  for (const entry of card.rememberAliases) {
    await ctx.vault.addAlias(entry.slug, entry.tag);
    progress.touched.add(docRelPath(entry.slug));
  }
  const added = await todayIso(ctx);
  const marker = markerFor(card, added);
  const earlier = writtenContent(ctx, card);
  const images = await copyNoteImages(ctx, card, plan.writes.map((write) => write.text));
  for (const relPath of images.paths) progress.touched.add(relPath);
  for (const write of plan.writes) {
    const block = sourceBlock(marker, withImages(write.text, images));
    progress.written.push(await appendDestination(ctx, card, write.destination, block, progress));
  }
  for (const link of plan.links) {
    const text = linkBlock(contentTitles([...earlier, ...progress.written], settled(ctx, link)), linkDate(card, added));
    if (text !== null) await appendDestination(ctx, card, link, sourceBlock(marker, text), progress);
  }
}

async function commitProgress(ctx: WikiContext, card: Card, progress: AcceptProgress, complete: boolean): Promise<void> {
  if (progress.touched.size === 0) return;
  const titles = progress.written.map((result) => result.title);
  await ctx.vault.commit(commitMessage(card, titles, complete), [...progress.touched]);
}

async function writeCard(ctx: WikiContext, plan: WritePlan, progress: AcceptProgress): Promise<void> {
  try {
    await assertReadable(ctx, plan);
    await writePlan(ctx, plan, progress);
  } catch (error) {
    await commitProgress(ctx, plan.card, progress, false);
    throw error;
  }
}

function publishProgress(ctx: WikiContext, progress: AcceptProgress): void {
  if (progress.touched.size > 0) ctx.publishChanged();
  if (progress.touched.size > 0 || progress.cardChanged) ctx.publishInbox();
}

export async function acceptCard(ctx: WikiContext, id: string): Promise<Card> {
  const progress: AcceptProgress = { touched: new Set(), done: new Map(), written: [], cardChanged: false };
  try {
    return await ctx.vault.runExclusive(async () => {
      const found = requireCard(ctx, id);
      assertOpen(found);
      const plan = planWrite(ctx, found);
      const card = claimCard(ctx, found, progress);
      await writeCard(ctx, { ...plan, card }, progress);
      const updated = saveCard(ctx, id, { status: "accepted", destinations: acceptedDestinations(card, progress.done) });
      progress.cardChanged = true;
      if (card.source.kind === "notes") ctx.store.setUnitStatus(card.source.unitHash, "accepted");
      await commitProgress(ctx, card, progress, true);
      return updated;
    });
  } finally {
    publishProgress(ctx, progress);
  }
}

export async function skipCard(ctx: WikiContext, id: string): Promise<Card> {
  const result = await ctx.vault.runExclusive(async () => {
    const card = requireCard(ctx, id);
    if (card.status === "skipped") return { card, changed: false };
    assertOpen(card);
    const updated = saveCard(ctx, id, { status: "skipped" });
    if (card.source.kind === "notes") ctx.store.setUnitStatus(card.source.unitHash, "skipped");
    return { card: updated, changed: true };
  });
  if (result.changed) ctx.publishInbox();
  return result.card;
}

export async function restoreCard(ctx: WikiContext, id: string): Promise<Card> {
  const result = await ctx.vault.runExclusive(async () => {
    const card = requireCard(ctx, id);
    if (card.status === "pending" || card.status === "routing") return { card, changed: false };
    if (card.status !== "skipped") throw new Error(`${id} was already accepted, so it can't be restored.`);
    const updated = saveCard(ctx, id, { status: "pending" });
    if (card.source.kind === "notes") ctx.store.setUnitStatus(card.source.unitHash, "pending");
    return { card: updated, changed: true };
  });
  if (result.changed) ctx.publishInbox();
  return result.card;
}

interface PreviewState {
  path: string;
  content: string;
}

function previewTitle(ctx: WikiContext, target: DocTarget): string {
  return target.kind === "existing" ? (ctx.store.getDoc(target.slug)?.title ?? target.slug) : target.title;
}

async function previewStart(ctx: WikiContext, destination: Destination): Promise<PreviewState> {
  const { target } = destination;
  if (target.kind === "new") return { path: docRelPath(slugify(target.title)), content: "" };
  const doc = await ctx.vault.readDoc(target.slug);
  if (doc === null) throw new Error(`Destination ${destination.id}: there is no Wiki doc with slug "${target.slug}".`);
  return { path: docRelPath(target.slug), content: doc.content };
}

function appliedContent(destination: Destination, before: string, block: string): string {
  const { target } = destination;
  const base = target.kind === "new" && before === "" ? newDocContent(target) : before;
  return insertUnderHeading(base, destination.heading, block);
}

export async function previewCard(ctx: WikiContext, id: string): Promise<CardPreview[]> {
  const card = requireCard(ctx, id);
  const included = includedDestinations(card);
  if (!hasContent(ctx, card, included.content)) return [];
  const content = included.content.map((destination) => settled(ctx, destination));
  const links = included.links.map((destination) => settled(ctx, destination));
  checkWritable(ctx, card, [...content, ...links]);
  const marker = markerFor(card, await todayIso(ctx));
  const states = new Map<string, PreviewState>();
  const previews = new Map<string, CardPreview>();
  const preview = async (destination: Destination, text: string) => {
    const key = targetKey(destination.target);
    const state = states.get(key) ?? (await previewStart(ctx, destination));
    const after = appliedContent(destination, state.content, sourceBlock(marker, text));
    previews.set(destination.id, {
      destinationId: destination.id,
      slug: destination.target.kind === "existing" ? destination.target.slug : null,
      title: previewTitle(ctx, destination.target),
      patch: createTwoFilesPatch(state.path, state.path, state.content, after),
    });
    states.set(key, { path: state.path, content: after });
  };
  for (const destination of content) await preview(destination, contentText(card, destination));
  const written = [
    ...writtenContent(ctx, card),
    ...content.map((destination) => ({
      slug: destination.target.kind === "existing" ? destination.target.slug : null,
      title: previewTitle(ctx, destination.target),
    })),
  ];
  for (const link of links) {
    const text = linkBlock(contentTitles(written, link), linkDate(card, marker.added));
    if (text !== null) await preview(link, text);
  }
  return card.destinations.flatMap((destination) => previews.get(destination.id) ?? []);
}

export async function missingCardImages(ctx: WikiContext, id: string): Promise<string[]> {
  const card = requireCard(ctx, id);
  const texts = includedDestinations(card).content.flatMap((destination) => {
    const text = dedent(selectedLines(card, destination.lineRanges)).join("\n");
    return text.trim() === "" ? [] : [text];
  });
  return (await resolveNoteImages(ctx, card, texts)).missing;
}
