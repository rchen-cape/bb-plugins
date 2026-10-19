import type { DocSummary, Suggestion } from "../contract.js";
import { bestTitleMatches } from "../lib/fuzzy.js";
import { extractWikiLinks, parseDoc, splitSections, stripSourceMarkers } from "../lib/markdown-doc.js";
import { normalizeTag } from "../lib/slug.js";
import { LIMITS, truncate } from "../lib/wiki.js";
import type { WikiContext } from "./context.js";
import type { SimilarSection, Store } from "./store.js";

const SIMILAR_SECTIONS = 24;
const SECTION_SHARE = 0.8;
const MAX_PHRASE_WORDS = 3;
const MIN_WORD = 4;
const PHRASE_STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "just", "like", "may", "me", "more", "my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "up", "us", "was", "we",
  "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

interface SectionCandidate {
  section: SimilarSection;
  score: number;
}

function wordsOf(text: string): string[] {
  return stripSourceMarkers(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function ngrams(words: readonly string[], size: number): string[] {
  const grams: string[] = [];
  for (let index = 0; index + size <= words.length; index += 1) grams.push(words.slice(index, index + size).join(" "));
  return grams;
}

function isDistinctive(gram: string): boolean {
  const words = gram.split(" ");
  const edges = [words[0] ?? "", words.at(-1) ?? ""];
  if (edges.some((word) => PHRASE_STOPWORDS.has(word))) return false;
  return words.some((word) => word.length >= MIN_WORD && !PHRASE_STOPWORDS.has(word) && !/^\p{N}+$/u.test(word));
}

export function sharedPhrase(text: string, body: string): string | null {
  const from = wordsOf(text);
  const inBody = wordsOf(body);
  for (let size = MAX_PHRASE_WORDS; size >= 1; size -= 1) {
    const grams = new Set(ngrams(inBody, size));
    const hits = ngrams(from, size).filter((gram) => grams.has(gram) && isDistinctive(gram));
    const best = hits.sort((a, b) => b.length - a.length)[0];
    if (best !== undefined) return best;
  }
  return null;
}

function offer(found: Map<string, Suggestion>, next: Suggestion): void {
  const previous = found.get(next.slug);
  if (previous === undefined) {
    found.set(next.slug, next);
    return;
  }
  const winner = next.score > previous.score ? next : previous;
  found.set(next.slug, { ...winner, heading: winner.heading ?? (winner === next ? previous.heading : next.heading) });
}

function suggestion(doc: DocSummary, heading: string | null, score: number, reason: string): Suggestion {
  return { slug: doc.slug, title: doc.title, type: doc.type, heading, score, reason };
}

function linkSuggestions(store: Store, text: string): Suggestion[] {
  return extractWikiLinks(text).flatMap((link) => {
    if (link.embed) return [];
    const resolved = store.resolveLink(link.heading === null ? link.target : `${link.target}#${link.heading}`);
    const doc = resolved === null ? null : store.getDoc(resolved.slug);
    return doc === null || resolved === null ? [] : [suggestion(doc, resolved.heading, 1, `Links to [[${link.target}]]`)];
  });
}

function tagSuggestions(store: Store, text: string): Suggestion[] {
  const tags = new Set([...stripSourceMarkers(text).matchAll(/(?:^|\s)@([A-Za-z0-9][A-Za-z0-9-]*)/g)].map((match) => normalizeTag(match[1] ?? "")));
  return [...tags].flatMap((tag) => {
    const slug = tag === "" ? null : store.resolveTag(tag);
    const doc = slug === null ? null : store.getDoc(slug);
    return doc === null ? [] : [suggestion(doc, null, 0.95, `Tagged @${tag}`)];
  });
}

function docHitReason(matched: "title" | "tag" | "alias", exact: boolean, title: string): string {
  if (matched === "title") return exact ? `Same title as “${title}”` : `Title matches “${title}”`;
  return matched === "tag" ? `Tag matches “${title}”` : `An alias matches “${title}”`;
}

function titleSuggestions(store: Store, title: string | null): Suggestion[] {
  const query = title?.trim() ?? "";
  if (query === "") return [];
  const key = query.replace(/\s+/g, " ").toLowerCase();
  const hits = store.search({ query, type: null, limit: LIMITS.docHits }).docs.map((hit) => {
    const exact = hit.title.toLowerCase() === key;
    return suggestion(hit, null, exact ? 1 : 0.85, docHitReason(hit.matched, exact, hit.title));
  });
  const docs = store.listDocs(null);
  const fuzzy = bestTitleMatches(query, docs).flatMap((match) => {
    const doc = docs.find((entry) => entry.slug === match.slug);
    return doc === undefined ? [] : [suggestion(doc, null, match.score * 0.9, `Title is close to “${doc.title}”`)];
  });
  return [...hits, ...fuzzy];
}

function sectionCandidates(store: Store, text: string, title: string | null): SectionCandidate[] {
  const sections = store.similarSections(`${title ?? ""}\n${text}`, SIMILAR_SECTIONS);
  const top = Math.max(...sections.map((section) => section.score), 0);
  if (top <= 0) return [];
  const best = new Map<string, SectionCandidate>();
  for (const section of sections) {
    if (!best.has(section.slug)) best.set(section.slug, { section, score: (section.score / top) * SECTION_SHARE });
  }
  return [...best.values()].slice(0, LIMITS.suggestions);
}

async function sectionBody(ctx: WikiContext, slug: string, heading: string): Promise<string | null> {
  const file = await ctx.vault.readDoc(slug);
  if (file === null) return null;
  const sections = splitSections(parseDoc(file.content, slug).body);
  return sections.find((section) => section.heading === heading)?.body ?? null;
}

async function sectionSuggestion(ctx: WikiContext, text: string, candidate: SectionCandidate): Promise<Suggestion | null> {
  const { section, score } = candidate;
  const doc = ctx.store.getDoc(section.slug);
  if (doc === null) return null;
  const where = section.heading === "" ? doc.title : section.heading;
  const body = await sectionBody(ctx, section.slug, section.heading);
  const phrase = body === null ? null : sharedPhrase(text, `${section.heading}\n${body}`);
  const reason = phrase === null ? `Similar wording in ${where}` : `Mentions “${phrase}” in ${where}`;
  return suggestion(doc, section.heading === "" ? null : section.heading, score, reason);
}

export async function suggestDocs(ctx: WikiContext, text: string, title: string | null): Promise<Suggestion[]> {
  const found = new Map<string, Suggestion>();
  const source = `${title ?? ""}\n${text}`;
  for (const entry of [...linkSuggestions(ctx.store, source), ...tagSuggestions(ctx.store, source), ...titleSuggestions(ctx.store, title)]) {
    offer(found, entry);
  }
  for (const candidate of sectionCandidates(ctx.store, text, title)) {
    const entry = await sectionSuggestion(ctx, source, candidate);
    if (entry !== null) offer(found, entry);
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, LIMITS.suggestions)
    .map((entry) => ({ ...entry, reason: truncate(entry.reason, LIMITS.reason) }));
}

