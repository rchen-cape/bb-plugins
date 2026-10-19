import { normalizeTag } from "./slug.js";
import { LIMITS } from "./wiki.js";

export interface FuzzyCandidate {
  slug: string;
  title: string;
  tag: string;
  aliases: readonly string[];
}

export interface FuzzyMatch {
  slug: string;
  title: string;
  score: number;
}

type MatchMode = "tag" | "title";

export const FUZZY_THRESHOLD = 0.45;

const EXACT_SCORE = 1;
const TITLE_KEY_SCORE = 0.95;
const ACRONYM_SCORE = 0.85;
const PARTIAL_ACRONYM_SCORE = 0.7;
const TOKEN_PREFIX_SCORE = 0.8;
const MIN_PREFIX = 2;
const MIN_SUBSTRING = 3;
const MIN_LOOSE_SUBSTRING = 4;
const MIN_EDIT = 3;
const FULL_EDIT_WEIGHT_LENGTH = 6;
const MIN_TOKEN_EDIT = 4;
const CHARS_PER_TYPO = 5;

function tokensOf(key: string): string[] {
  return key.split("-").filter((token) => token !== "");
}

function ordered(a: string, b: string): [string, string] {
  return a.length <= b.length ? [a, b] : [b, a];
}

function typoBudget(a: string, b: string): number {
  return Math.max(1, Math.floor(Math.max(a.length, b.length) / CHARS_PER_TYPO));
}

function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let beforePrevious = previous.slice();
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (beforePrevious[j - 2] ?? 0) + 1);
      }
      current.push(best);
    }
    if (Math.min(...current) > max) return null;
    beforePrevious = previous;
    previous = current;
  }
  const distance = previous[b.length] ?? 0;
  return distance > max ? null : distance;
}

function typoSimilarity(a: string, b: string): number {
  const distance = editDistanceWithin(a, b, typoBudget(a, b));
  return distance === null ? 0 : 1 - distance / Math.max(a.length, b.length, 1);
}

function prefixScore(query: string, key: string): number {
  const [short, long] = ordered(query, key);
  if (short.length < MIN_PREFIX || !long.startsWith(short)) return 0;
  return 0.6 + (0.35 * short.length) / long.length;
}

function substringScore(query: string, key: string): number {
  const [short, long] = ordered(query, key);
  if (short.length < MIN_SUBSTRING) return 0;
  const at = long.indexOf(short);
  if (at < 0) return 0;
  const ratio = short.length / long.length;
  if (at === 0 || long.charAt(at - 1) === "-") return 0.5 + 0.3 * ratio;
  return short.length >= MIN_LOOSE_SUBSTRING ? 0.35 + 0.3 * ratio : 0;
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const shortest = Math.min(a.length, b.length);
  if (shortest >= MIN_SUBSTRING && (a.startsWith(b) || b.startsWith(a))) return TOKEN_PREFIX_SCORE;
  return shortest < MIN_TOKEN_EDIT ? 0 : typoSimilarity(a, b);
}

function matchedTokens(query: readonly string[], key: readonly string[]): number {
  const unused = [...key];
  let total = 0;
  for (const token of query) {
    let best = 0;
    let bestAt = -1;
    unused.forEach((candidate, at) => {
      const similarity = tokenSimilarity(token, candidate);
      if (similarity > best) {
        best = similarity;
        bestAt = at;
      }
    });
    if (bestAt < 0) continue;
    total += best;
    unused.splice(bestAt, 1);
  }
  return total;
}

function tokenScore(query: string, key: string, mode: MatchMode): number {
  const queryTokens = tokensOf(query);
  const keyTokens = tokensOf(key);
  if (queryTokens.length + keyTokens.length < 3) return 0;
  const matched = matchedTokens(queryTokens, keyTokens);
  if (matched === 0) return 0;
  const dice = (2 * matched) / (queryTokens.length + keyTokens.length);
  const overlap = mode === "title" ? (dice + matched / queryTokens.length) / 2 : dice;
  return 0.3 + 0.6 * overlap;
}

function acronymOf(short: string, long: string): number {
  if (short.length < 2 || short.includes("-")) return 0;
  const tokens = tokensOf(long);
  if (tokens.length < 2) return 0;
  const initials = tokens.map((token) => token.charAt(0)).join("");
  if (initials === short) return ACRONYM_SCORE;
  return initials.includes(short) ? PARTIAL_ACRONYM_SCORE : 0;
}

function acronymScore(query: string, key: string): number {
  return Math.max(acronymOf(query, key), acronymOf(key, query));
}

function editScore(query: string, key: string): number {
  const [short, long] = ordered(query, key);
  if (short.length < MIN_EDIT) return 0;
  if (short.length / long.length < FUZZY_THRESHOLD) return 0;
  return typoSimilarity(query, key) * Math.min(1, short.length / FULL_EDIT_WEIGHT_LENGTH);
}

function fuzzyScore(query: string, key: string, mode: MatchMode): number {
  return Math.max(
    prefixScore(query, key),
    substringScore(query, key),
    tokenScore(query, key, mode),
    acronymScore(query, key),
    editScore(query, key),
  );
}

function pairScore(query: string, key: string, exact: number, mode: MatchMode): number {
  if (query === "" || key === "") return 0;
  return query === key ? exact : Math.min(fuzzyScore(query, key, mode), exact);
}

export function tagSimilarity(a: string, b: string): number {
  return roundScore(pairScore(normalizeTag(a), normalizeTag(b), EXACT_SCORE, "tag"));
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function exactKeys(candidate: FuzzyCandidate): string[] {
  return [candidate.tag, ...candidate.aliases].map(normalizeTag);
}

function tagModeScore(query: string, candidate: FuzzyCandidate): number {
  const keyed = exactKeys(candidate).map((key) => pairScore(query, key, EXACT_SCORE, "tag"));
  return Math.max(0, ...keyed, pairScore(query, normalizeTag(candidate.title), TITLE_KEY_SCORE, "tag"));
}

function titleModeScore(query: string, candidate: FuzzyCandidate): number {
  const keys = [normalizeTag(candidate.title), normalizeTag(candidate.slug), ...exactKeys(candidate)];
  return Math.max(0, ...keys.map((key) => pairScore(query, key, EXACT_SCORE, "title")));
}

function compareMatches(a: FuzzyMatch, b: FuzzyMatch): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
}

function rank(
  candidates: ReadonlyArray<FuzzyCandidate>,
  limit: number,
  scoreOf: (candidate: FuzzyCandidate) => number,
): FuzzyMatch[] {
  const count = Math.floor(limit);
  if (!(count > 0)) return [];
  const best = new Map<string, FuzzyMatch>();
  for (const candidate of candidates) {
    const score = roundScore(scoreOf(candidate));
    if (score < FUZZY_THRESHOLD) continue;
    const previous = best.get(candidate.slug);
    if (previous === undefined || score > previous.score) {
      best.set(candidate.slug, { slug: candidate.slug, title: candidate.title, score });
    }
  }
  return [...best.values()].sort(compareMatches).slice(0, count);
}

export function matchTag(
  tag: string,
  candidates: ReadonlyArray<FuzzyCandidate>,
  limit: number = LIMITS.tagSuggestions,
): FuzzyMatch[] {
  const query = normalizeTag(tag);
  if (query === "") return [];
  return rank(candidates, limit, (candidate) => tagModeScore(query, candidate));
}

export function bestTitleMatches(
  query: string,
  candidates: ReadonlyArray<FuzzyCandidate>,
  limit: number = LIMITS.suggestions,
): FuzzyMatch[] {
  const normalized = normalizeTag(query);
  if (normalized === "") return [];
  return rank(candidates, limit, (candidate) => titleModeScore(normalized, candidate));
}
