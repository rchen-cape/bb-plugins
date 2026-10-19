import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cardSchema,
  jobStateSchema,
  type Backlink,
  type Card,
  type DocHit,
  type DocSummary,
  type SearchResult,
  type SectionHit,
} from "../contract.js";
import { stripSourceMarkers, trimLineEnds } from "../lib/markdown-doc.js";
import { normalizeTag } from "../lib/slug.js";
import { DEFAULT_DOC_TYPE, LIMITS, MARK_END, MARK_START, isDocType, truncate, type DocType } from "../lib/wiki.js";
import type { IndexedDoc, IndexedFileStamp, IndexedSection } from "./index-types.js";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export type StoreLog = Pick<BbPluginApi["log"], "warn">;

const BM25_WEIGHTS = "10, 8, 4, 1";
const SNIPPET_TOKENS = 24;
const CLOSED_CARD_LIMIT = 200;
const SIMILAR_TERMS = 12;
const SIMILAR_CANDIDATES = 48;
const SIMILAR_MIN_LENGTH = 4;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;

const STOPWORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "because", "both", "could", "does", "doing", "done",
  "each", "even", "from", "have", "having", "here", "http", "https", "into", "just", "like", "made", "make", "many",
  "more", "most", "much", "must", "need", "only", "other", "over", "same", "should", "some", "such", "than", "that",
  "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "very", "want", "were",
  "what", "when", "where", "which", "while", "will", "with", "would", "your",
]);

const MIGRATIONS = [
  `CREATE TABLE docs (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    aliases TEXT NOT NULL,
    tag TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    headings TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX docs_updated ON docs (updated_at)`,
  `CREATE TABLE sections (
    seq INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    aliases TEXT NOT NULL,
    heading TEXT NOT NULL,
    heading_path TEXT NOT NULL,
    anchor TEXT NOT NULL,
    level INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE INDEX sections_slug ON sections (slug, ord)`,
  `CREATE VIRTUAL TABLE sections_fts USING fts5(
    title, aliases, heading, body,
    content='sections', content_rowid='seq', tokenize='porter unicode61 remove_diacritics 2'
  )`,
  `CREATE VIRTUAL TABLE sections_words USING fts5(
    title, aliases, heading, body,
    content='sections', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER sections_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_fts (rowid, title, aliases, heading, body) VALUES (new.seq, new.title, new.aliases, new.heading, new.body);
    INSERT INTO sections_words (rowid, title, aliases, heading, body) VALUES (new.seq, new.title, new.aliases, new.heading, new.body);
  END`,
  `CREATE TRIGGER sections_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_fts (sections_fts, rowid, title, aliases, heading, body) VALUES ('delete', old.seq, old.title, old.aliases, old.heading, old.body);
    INSERT INTO sections_words (sections_words, rowid, title, aliases, heading, body) VALUES ('delete', old.seq, old.title, old.aliases, old.heading, old.body);
  END`,
  `CREATE TRIGGER sections_au AFTER UPDATE OF title, aliases, heading, body ON sections BEGIN
    INSERT INTO sections_fts (sections_fts, rowid, title, aliases, heading, body) VALUES ('delete', old.seq, old.title, old.aliases, old.heading, old.body);
    INSERT INTO sections_words (sections_words, rowid, title, aliases, heading, body) VALUES ('delete', old.seq, old.title, old.aliases, old.heading, old.body);
    INSERT INTO sections_fts (rowid, title, aliases, heading, body) VALUES (new.seq, new.title, new.aliases, new.heading, new.body);
    INSERT INTO sections_words (rowid, title, aliases, heading, body) VALUES (new.seq, new.title, new.aliases, new.heading, new.body);
  END`,
  `CREATE TABLE links (
    from_slug TEXT NOT NULL,
    to_slug TEXT,
    target_text TEXT NOT NULL,
    heading TEXT NOT NULL
  )`,
  `CREATE INDEX links_from ON links (from_slug)`,
  `CREATE INDEX links_to ON links (to_slug)`,
  `CREATE INDEX links_target ON links (target_text)`,
  `CREATE TABLE cards (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    lines TEXT NOT NULL,
    tags TEXT NOT NULL,
    rule TEXT NOT NULL,
    reason TEXT NOT NULL,
    destinations TEXT NOT NULL,
    tag_suggestions TEXT NOT NULL,
    remember_aliases TEXT NOT NULL,
    job_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX cards_status ON cards (status, created_at)`,
  `CREATE INDEX cards_job ON cards (job_id)`,
  `CREATE TABLE units (
    hash TEXT PRIMARY KEY,
    note_path TEXT NOT NULL,
    note_date TEXT NOT NULL,
    status TEXT NOT NULL,
    card_id TEXT,
    seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE notes_seen (
    path TEXT PRIMARY KEY,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL
  )`,
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    thread_id TEXT,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX jobs_thread ON jobs (thread_id)`,
  `CREATE INDEX jobs_status ON jobs (status)`,
];

export type StoredDoc = DocSummary & { path: string; sha256: string };
export type CatalogDoc = DocSummary & { excerpt: string };
export interface ResolvedLink {
  slug: string;
  heading: string | null;
}
export interface TagEntry {
  tag: string;
  title: string;
  type: DocType;
  aliases: string[];
}
export interface SearchInput {
  query: string;
  type: DocType | null;
  limit: number;
}
export interface SimilarSection {
  slug: string;
  title: string;
  type: DocType;
  heading: string;
  score: number;
}

export type NewCard = Omit<Card, "id" | "createdAt" | "updatedAt">;
export type CardPatch = Partial<Pick<Card, "status" | "rule" | "reason" | "destinations" | "tagSuggestions" | "rememberAliases">>;
export type CardListStatus = "open" | "accepted" | "skipped";

const unitStatusSchema = z.enum(["pending", "accepted", "skipped"]);
const storedUnitStatusSchema = unitStatusSchema.catch("pending");
export type UnitStatus = z.infer<typeof unitStatusSchema>;
export interface Unit {
  hash: string;
  notePath: string;
  noteDate: string;
  status: UnitStatus;
  cardId: string | null;
  seenAt: string;
}
export type UnitInput = Omit<Unit, "seenAt">;
export interface NoteStamp {
  mtimeMs: number;
  size: number;
}

const jobKindSchema = z.enum(["route", "describe"]);
const jobStatusSchema = jobStateSchema.shape.status;
export type JobKind = z.infer<typeof jobKindSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export interface Job {
  id: string;
  kind: JobKind;
  threadId: string | null;
  status: JobStatus;
  payload: unknown;
  result: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface JobOutcome {
  status: Exclude<JobStatus, "running">;
  result?: string | null;
  error?: string | null;
}

interface DocRow {
  slug: string;
  title: string;
  type: string;
  aliases: string;
  tag: string;
  path: string;
  mtime_ms: number;
  size: number;
  sha256: string;
  headings: string;
  updated_at: number;
}

interface SectionRow {
  seq: number;
  slug: string;
  title: string;
  type: string;
  heading: string;
  heading_path: string;
  anchor: string;
}

interface CardRow {
  id: string;
  status: string;
  source: string;
  text: string;
  lines: string;
  tags: string;
  rule: string;
  reason: string;
  destinations: string;
  tag_suggestions: string;
  remember_aliases: string;
  created_at: number;
  updated_at: number;
}

interface UnitRow {
  hash: string;
  note_path: string;
  note_date: string;
  status: string;
  card_id: string | null;
  seen_at: number;
}

interface JobRow {
  id: string;
  kind: string;
  thread_id: string | null;
  status: string;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

interface Resolver {
  slug: Map<string, string>;
  title: Map<string, string>;
  alias: Map<string, string>;
  tag: Map<string, string>;
}

interface DocMatch {
  doc: DocSummary;
  rank: number;
  field: number;
  matched: DocHit["matched"];
}

const quietLog: StoreLog = { warn: () => undefined };
const HIGHLIGHT_CHARS = new RegExp(`[${MARK_START}${MARK_END}]`, "g");
const stringListSchema = z.array(z.string());

export function ftsQuery(input: string): string | null {
  const terms = [...input.matchAll(/"([^"]*)"|(\S+)/g)].flatMap((match) => {
    const quoted = match[1] !== undefined;
    const words = (match[1] ?? match[2] ?? "").match(/[\p{L}\p{N}]+/gu);
    if (words === null) return [];
    return [`"${words.join(" ")}"${quoted ? "" : "*"}`];
  });
  return terms.length === 0 ? null : terms.join(" ");
}

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseList(text: string): string[] {
  const parsed = stringListSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : [];
}

function searchableBody(body: string): string {
  return trimLineEnds(stripSourceMarkers(body).replace(HIGHLIGHT_CHARS, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanSnippet(snippet: string): string {
  return collapse(stripSourceMarkers(snippet));
}

function excerptOf(body: string): string {
  return truncate(collapse(stripSourceMarkers(body)), LIMITS.excerpt);
}

function randomId(prefix: string): string {
  const chars = [...randomBytes(ID_LENGTH)].map((byte) => ID_ALPHABET.charAt(byte % ID_ALPHABET.length));
  return `${prefix}${chars.join("")}`;
}

function freshId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = randomId(prefix);
    if (!taken(id)) return id;
  }
}

function docType(value: string): DocType {
  return isDocType(value) ? value : DEFAULT_DOC_TYPE;
}

function toSummary(row: DocRow): DocSummary {
  return {
    slug: row.slug,
    title: row.title,
    type: docType(row.type),
    aliases: parseList(row.aliases),
    tag: row.tag,
    updatedAt: iso(row.updated_at),
    headings: parseList(row.headings),
  };
}

function docParams(doc: IndexedDoc) {
  return {
    slug: doc.slug,
    title: doc.title,
    type: doc.type,
    aliases: JSON.stringify(doc.aliases),
    tag: doc.tag,
    path: doc.path,
    mtimeMs: doc.mtimeMs,
    size: doc.size,
    sha256: doc.sha256,
    headings: JSON.stringify(doc.headings),
    updatedAt: Math.round(doc.mtimeMs),
  };
}

function sectionParams(doc: IndexedDoc, section: IndexedSection) {
  return {
    slug: doc.slug,
    title: doc.title,
    aliases: doc.aliases.join(" "),
    heading: section.heading,
    headingPath: section.headingPath,
    anchor: section.anchor,
    level: section.level,
    ord: section.ord,
    body: searchableBody(section.body),
  };
}

function toSectionHit(row: SectionRow, snippet: string): SectionHit {
  return {
    slug: row.slug,
    title: row.title,
    type: docType(row.type),
    heading: row.heading,
    headingPath: row.heading_path,
    anchor: row.anchor,
    snippet,
  };
}

function titleKey(text: string): string {
  return collapse(text).toLowerCase();
}

function claim(map: Map<string, string>, key: string, slug: string): void {
  if (key !== "" && !map.has(key)) map.set(key, slug);
}

function buildResolver(docs: readonly DocSummary[]): Resolver {
  const resolver: Resolver = { slug: new Map(), title: new Map(), alias: new Map(), tag: new Map() };
  for (const doc of docs) {
    claim(resolver.slug, doc.slug.toLowerCase(), doc.slug);
    claim(resolver.title, titleKey(doc.title), doc.slug);
    for (const alias of doc.aliases) claim(resolver.alias, normalizeTag(alias), doc.slug);
    claim(resolver.tag, normalizeTag(doc.tag), doc.slug);
  }
  return resolver;
}

function resolveName(resolver: Resolver, name: string): string | null {
  const tag = normalizeTag(name);
  return (
    resolver.slug.get(name.toLowerCase()) ??
    resolver.title.get(titleKey(name)) ??
    resolver.alias.get(tag) ??
    resolver.tag.get(tag) ??
    null
  );
}

function splitLinkText(text: string): { name: string; heading: string | null } {
  const target = text.split("|")[0] ?? "";
  const hash = target.indexOf("#");
  const name = (hash === -1 ? target : target.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : target.slice(hash + 1).trim();
  return { name, heading: heading === "" ? null : heading };
}

function tagAliases(doc: DocSummary): string[] {
  const aliases = new Set(doc.aliases.map(normalizeTag));
  return [...aliases].filter((alias) => alias !== "" && alias !== doc.tag).sort(compareText);
}

function textRank(value: string, query: string): number | null {
  if (query === "" || value === "") return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return value.includes(query) ? 2 : null;
}

function bestRank(values: readonly string[], query: string): number | null {
  const ranks = values.flatMap((value) => {
    const rank = textRank(value, query);
    return rank === null ? [] : [rank];
  });
  return ranks.length === 0 ? null : Math.min(...ranks);
}

function matchDoc(doc: DocSummary, titleQuery: string, tagQuery: string): DocMatch | null {
  const fields: Array<[DocHit["matched"], number | null]> = [
    ["title", textRank(titleKey(doc.title), titleQuery)],
    ["tag", textRank(doc.tag, tagQuery)],
    ["alias", bestRank(doc.aliases.map(normalizeTag), tagQuery)],
  ];
  let best: DocMatch | null = null;
  for (const [field, [matched, rank]] of fields.entries()) {
    if (rank !== null && (best === null || rank < best.rank)) best = { doc, rank, field, matched };
  }
  return best;
}

function compareMatches(a: DocMatch, b: DocMatch): number {
  return (
    a.rank - b.rank ||
    a.field - b.field ||
    a.doc.title.localeCompare(b.doc.title, undefined, { sensitivity: "base" }) ||
    compareText(a.doc.slug, b.doc.slug)
  );
}

function matchDocs(docs: readonly DocSummary[], query: string, type: DocType | null, limit: number): DocHit[] {
  const titleQuery = titleKey(query);
  const tagQuery = normalizeTag(query);
  return docs
    .filter((doc) => type === null || doc.type === type)
    .flatMap((doc) => {
      const match = matchDoc(doc, titleQuery, tagQuery);
      return match === null ? [] : [match];
    })
    .sort(compareMatches)
    .slice(0, limit)
    .map(({ doc, matched }) => ({ ...doc, matched }));
}

function candidateTerms(text: string): string[] {
  const words = new Set(stripSourceMarkers(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return [...words]
    .filter((word) => word.length >= SIMILAR_MIN_LENGTH && !STOPWORDS.has(word) && !/^\p{N}+$/u.test(word))
    .sort((a, b) => b.length - a.length || compareText(a, b))
    .slice(0, SIMILAR_CANDIDATES);
}

function quoteTerm(term: string): string {
  return `"${term}"`;
}

const SECTION_COLUMNS = "s.seq, s.slug, d.title, d.type, s.heading, s.heading_path, s.anchor";
const MATCHED_SECTIONS = `matched AS (
  SELECT rowid AS seq, bm25(sections_fts, ${BM25_WEIGHTS}) AS weight FROM sections_fts WHERE sections_fts MATCH @match
  UNION ALL
  SELECT rowid AS seq, bm25(sections_words, ${BM25_WEIGHTS}) AS weight FROM sections_words WHERE sections_words MATCH @match
), best AS (SELECT seq, MIN(weight) AS weight FROM matched GROUP BY seq)`;

function snippetStatement(db: Db, table: "sections_fts" | "sections_words") {
  return db.prepare<{ match: string; seq: number }, { snippet: string | null }>(
    `SELECT snippet(${table}, 3, char(2), char(3), '…', ${SNIPPET_TOKENS}) AS snippet
     FROM ${table} WHERE ${table} MATCH @match AND rowid = @seq`,
  );
}

function prepareDocStatements(db: Db) {
  const docColumns = "slug, title, type, aliases, tag, path, mtime_ms, size, sha256, headings, updated_at";
  return {
    upsertDoc: db.prepare<ReturnType<typeof docParams>>(
      `INSERT INTO docs (${docColumns})
       VALUES (@slug, @title, @type, @aliases, @tag, @path, @mtimeMs, @size, @sha256, @headings, @updatedAt)
       ON CONFLICT (slug) DO UPDATE SET
         title = excluded.title, type = excluded.type, aliases = excluded.aliases, tag = excluded.tag,
         path = excluded.path, mtime_ms = excluded.mtime_ms, size = excluded.size, sha256 = excluded.sha256,
         headings = excluded.headings, updated_at = excluded.updated_at`,
    ),
    deleteDoc: db.prepare<[string]>("DELETE FROM docs WHERE slug = ?"),
    deleteSections: db.prepare<[string]>("DELETE FROM sections WHERE slug = ?"),
    insertSection: db.prepare<ReturnType<typeof sectionParams>>(
      `INSERT INTO sections (slug, title, aliases, heading, heading_path, anchor, level, ord, body)
       VALUES (@slug, @title, @aliases, @heading, @headingPath, @anchor, @level, @ord, @body)`,
    ),
    deleteLinks: db.prepare<[string]>("DELETE FROM links WHERE from_slug = ?"),
    insertLink: db.prepare<[string, string, string]>(
      "INSERT INTO links (from_slug, to_slug, target_text, heading) VALUES (?, NULL, ?, ?)",
    ),
    getDoc: db.prepare<[string], DocRow>(`SELECT ${docColumns} FROM docs WHERE slug = ?`),
    allDocs: db.prepare<[], DocRow>(`SELECT ${docColumns} FROM docs ORDER BY slug`),
    listDocs: db.prepare<{ type: string | null }, DocRow>(
      `SELECT ${docColumns} FROM docs WHERE (@type IS NULL OR type = @type) ORDER BY title COLLATE NOCASE, slug`,
    ),
    stamps: db.prepare<[], { slug: string; mtime_ms: number; size: number }>(
      "SELECT slug, mtime_ms, size FROM docs ORDER BY slug",
    ),
    countDocs: db.prepare<{ type: string | null }, { count: number }>(
      "SELECT COUNT(*) AS count FROM docs WHERE (@type IS NULL OR type = @type)",
    ),
    catalog: db.prepare<[number], DocRow & { excerpt: string | null }>(
      `SELECT d.*, (
         SELECT f.body FROM sections f WHERE f.slug = d.slug AND trim(f.body) <> '' ORDER BY f.ord, f.seq LIMIT 1
       ) AS excerpt
       FROM docs d ORDER BY d.updated_at DESC, d.slug LIMIT ?`,
    ),
    linkTargets: db.prepare<[], { target_text: string }>("SELECT DISTINCT target_text FROM links"),
    setLinkTarget: db.prepare<[string | null, string]>("UPDATE links SET to_slug = ? WHERE target_text = ?"),
    backlinks: db.prepare<[string, string], Backlink>(
      `SELECT DISTINCT l.from_slug AS slug, d.title AS title, l.heading AS heading
       FROM links l JOIN docs d ON d.slug = l.from_slug
       WHERE l.to_slug = ? AND l.from_slug <> ?
       ORDER BY title COLLATE NOCASE, slug, heading`,
    ),
    searchSections: db.prepare<{ match: string; type: string | null; limit: number }, SectionRow>(
      `WITH ${MATCHED_SECTIONS}
       SELECT ${SECTION_COLUMNS} FROM best
       JOIN sections s ON s.seq = best.seq JOIN docs d ON d.slug = s.slug
       WHERE (@type IS NULL OR d.type = @type)
       ORDER BY best.weight, d.updated_at DESC, s.seq LIMIT @limit`,
    ),
    countSections: db.prepare<{ match: string; type: string | null }, { count: number }>(
      `WITH matched AS (
         SELECT rowid AS seq FROM sections_fts WHERE sections_fts MATCH @match
         UNION SELECT rowid AS seq FROM sections_words WHERE sections_words MATCH @match
       )
       SELECT COUNT(*) AS count FROM matched
       JOIN sections s ON s.seq = matched.seq JOIN docs d ON d.slug = s.slug
       WHERE (@type IS NULL OR d.type = @type)`,
    ),
    stemmedSnippet: snippetStatement(db, "sections_fts"),
    wordSnippet: snippetStatement(db, "sections_words"),
    recentSections: db.prepare<{ type: string | null; limit: number }, SectionRow & { body: string }>(
      `SELECT COALESCE(s.seq, 0) AS seq, d.slug AS slug, d.title AS title, d.type AS type,
         COALESCE(s.heading, '') AS heading, COALESCE(s.heading_path, '') AS heading_path,
         COALESCE(s.anchor, '') AS anchor, COALESCE(s.body, '') AS body
       FROM docs d
       LEFT JOIN sections s ON s.seq = (
         SELECT f.seq FROM sections f WHERE f.slug = d.slug ORDER BY trim(f.body) = '', f.ord, f.seq LIMIT 1
       )
       WHERE (@type IS NULL OR d.type = @type)
       ORDER BY d.updated_at DESC, d.slug LIMIT @limit`,
    ),
    termCount: db.prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM sections_fts WHERE sections_fts MATCH ?",
    ),
    similar: db.prepare<[string, number], { slug: string; title: string; type: string; heading: string; weight: number }>(
      `SELECT s.slug, d.title, d.type, s.heading, bm25(sections_fts, ${BM25_WEIGHTS}) AS weight
       FROM sections_fts JOIN sections s ON s.seq = sections_fts.rowid JOIN docs d ON d.slug = s.slug
       WHERE sections_fts MATCH ? ORDER BY weight, s.seq LIMIT ?`,
    ),
  };
}

function createDocIndex(db: Db) {
  const statements = prepareDocStatements(db);
  let snapshot: { docs: DocSummary[]; resolver: Resolver } | null = null;
  let linksStale = true;

  function current() {
    if (snapshot === null) {
      const docs = statements.allDocs.all().map(toSummary);
      snapshot = { docs, resolver: buildResolver(docs) };
    }
    return snapshot;
  }

  function changed(): void {
    snapshot = null;
    linksStale = true;
  }

  const writeDoc = db.transaction((doc: IndexedDoc) => {
    statements.upsertDoc.run(docParams(doc));
    statements.deleteSections.run(doc.slug);
    for (const section of doc.sections) statements.insertSection.run(sectionParams(doc, section));
    statements.deleteLinks.run(doc.slug);
    for (const link of doc.links) {
      if (link.targetText.trim() !== "") statements.insertLink.run(doc.slug, link.targetText, link.heading);
    }
  });

  const dropDoc = db.transaction((slug: string): boolean => {
    statements.deleteSections.run(slug);
    statements.deleteLinks.run(slug);
    return statements.deleteDoc.run(slug).changes > 0;
  });

  function resolveLink(text: string): ResolvedLink | null {
    const { name, heading } = splitLinkText(text);
    if (name === "") return null;
    const slug = resolveName(current().resolver, name);
    return slug === null ? null : { slug, heading };
  }

  const relink = db.transaction(() => {
    for (const { target_text } of statements.linkTargets.all()) {
      statements.setLinkTarget.run(resolveLink(target_text)?.slug ?? null, target_text);
    }
  });

  function pickSnippet(match: string, seq: number): string {
    const stemmed = statements.stemmedSnippet.get({ match, seq })?.snippet ?? null;
    if (stemmed?.includes(MARK_START)) return stemmed;
    const words = statements.wordSnippet.get({ match, seq })?.snippet ?? null;
    if (words?.includes(MARK_START)) return words;
    return stemmed ?? words ?? "";
  }

  function searchSections(query: string, type: DocType | null, limit: number): Omit<SearchResult, "docs"> {
    const match = ftsQuery(query);
    if (match === null) return { sections: [], total: 0 };
    const rows = statements.searchSections.all({ match, type, limit });
    const total = statements.countSections.get({ match, type })?.count ?? 0;
    return { sections: rows.map((row) => toSectionHit(row, cleanSnippet(pickSnippet(match, row.seq)))), total };
  }

  function recent(type: DocType | null, limit: number): SearchResult {
    const rows = statements.recentSections.all({ type, limit });
    const total = statements.countDocs.get({ type })?.count ?? 0;
    return { docs: [], sections: rows.map((row) => toSectionHit(row, excerptOf(row.body))), total };
  }

  function distinctiveTerms(text: string): string[] {
    return candidateTerms(text)
      .map((term) => ({ term, count: statements.termCount.get(quoteTerm(term))?.count ?? 0 }))
      .filter(({ count }) => count > 0)
      .sort((a, b) => a.count - b.count || b.term.length - a.term.length || compareText(a.term, b.term))
      .slice(0, SIMILAR_TERMS)
      .map(({ term }) => term);
  }

  return {
    upsertDoc(doc: IndexedDoc): void {
      writeDoc(doc);
      changed();
    },
    removeDoc(slug: string): boolean {
      const removed = dropDoc(slug);
      changed();
      return removed;
    },
    stamps(): IndexedFileStamp[] {
      return statements.stamps.all().map((row) => ({ slug: row.slug, mtimeMs: row.mtime_ms, size: row.size }));
    },
    getDoc(slug: string): StoredDoc | null {
      const row = statements.getDoc.get(slug);
      return row === undefined ? null : { ...toSummary(row), path: row.path, sha256: row.sha256 };
    },
    listDocs(type: DocType | null): DocSummary[] {
      return statements.listDocs.all({ type }).map(toSummary);
    },
    docCount(): number {
      return statements.countDocs.get({ type: null })?.count ?? 0;
    },
    catalog(limit: number): CatalogDoc[] {
      return statements.catalog.all(limit).map((row) => ({ ...toSummary(row), excerpt: excerptOf(row.excerpt ?? "") }));
    },
    resolveLink,
    resolveTag(tag: string): string | null {
      const key = normalizeTag(tag);
      if (key === "") return null;
      const { resolver } = current();
      return resolver.tag.get(key) ?? resolver.alias.get(key) ?? null;
    },
    backlinks(slug: string): Backlink[] {
      if (linksStale) {
        relink();
        linksStale = false;
      }
      return statements.backlinks.all(slug, slug);
    },
    allTags(): TagEntry[] {
      const seen = new Set<string>();
      const entries: TagEntry[] = [];
      for (const doc of current().docs) {
        if (doc.tag === "" || seen.has(doc.tag)) continue;
        seen.add(doc.tag);
        entries.push({ tag: doc.tag, title: doc.title, type: doc.type, aliases: tagAliases(doc) });
      }
      return entries.sort((a, b) => compareText(a.tag, b.tag));
    },
    search(input: SearchInput): SearchResult {
      const query = input.query.trim();
      if (query === "") return recent(input.type, input.limit);
      const docs = matchDocs(current().docs, query, input.type, Math.min(LIMITS.docHits, input.limit));
      return { docs, ...searchSections(query, input.type, input.limit) };
    },
    similarSections(text: string, limit: number): SimilarSection[] {
      const terms = distinctiveTerms(text);
      if (terms.length === 0) return [];
      return statements.similar.all(terms.map(quoteTerm).join(" OR "), limit).map((row) => ({
        slug: row.slug,
        title: row.title,
        type: docType(row.type),
        heading: row.heading,
        score: -row.weight,
      }));
    },
  };
}

function parseCardRow(row: CardRow) {
  return cardSchema.safeParse({
    id: row.id,
    status: row.status,
    source: parseJson(row.source),
    text: row.text,
    lines: parseJson(row.lines),
    tags: parseJson(row.tags),
    rule: row.rule,
    reason: row.reason,
    destinations: parseJson(row.destinations),
    tagSuggestions: parseJson(row.tag_suggestions),
    rememberAliases: parseJson(row.remember_aliases),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function cardParams(card: Card) {
  return {
    id: card.id,
    status: card.status,
    source: JSON.stringify(card.source),
    text: card.text,
    lines: JSON.stringify(card.lines),
    tags: JSON.stringify(card.tags),
    rule: card.rule,
    reason: card.reason,
    destinations: JSON.stringify(card.destinations),
    tagSuggestions: JSON.stringify(card.tagSuggestions),
    rememberAliases: JSON.stringify(card.rememberAliases),
    createdAt: Date.parse(card.createdAt),
    updatedAt: Date.parse(card.updatedAt),
  };
}

function issueSummary(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "card"}: ${issue.message}`).join("; ");
}

function createInbox(db: Db, log: StoreLog) {
  const cardColumns =
    "id, status, source, text, lines, tags, rule, reason, destinations, tag_suggestions, remember_aliases, created_at, updated_at";
  const statements = {
    insert: db.prepare<ReturnType<typeof cardParams>>(
      `INSERT INTO cards (${cardColumns})
       VALUES (@id, @status, @source, @text, @lines, @tags, @rule, @reason, @destinations, @tagSuggestions, @rememberAliases, @createdAt, @updatedAt)`,
    ),
    update: db.prepare<ReturnType<typeof cardParams>>(
      `UPDATE cards SET status = @status, source = @source, text = @text, lines = @lines, tags = @tags, rule = @rule,
         reason = @reason, destinations = @destinations, tag_suggestions = @tagSuggestions,
         remember_aliases = @rememberAliases, created_at = @createdAt, updated_at = @updatedAt
       WHERE id = @id`,
    ),
    exists: db.prepare<[string], { id: string }>("SELECT id FROM cards WHERE id = ?"),
    get: db.prepare<[string], CardRow>(`SELECT ${cardColumns} FROM cards WHERE id = ?`),
    open: db.prepare<[], CardRow>(
      `SELECT ${cardColumns} FROM cards WHERE status IN ('routing', 'pending') ORDER BY created_at, seq`,
    ),
    closed: db.prepare<[string, number], CardRow>(
      `SELECT ${cardColumns} FROM cards WHERE status = ? ORDER BY updated_at DESC, seq DESC LIMIT ?`,
    ),
    openCount: db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM cards WHERE status IN ('routing', 'pending')",
    ),
    forJob: db.prepare<[string], CardRow>(`SELECT ${cardColumns} FROM cards WHERE job_id = ? ORDER BY seq`),
    setJob: db.prepare<[string | null, string]>("UPDATE cards SET job_id = ? WHERE id = ?"),
  };

  function readCard(row: CardRow | undefined): Card | null {
    if (row === undefined) return null;
    const parsed = parseCardRow(row);
    if (parsed.success) return parsed.data;
    log.warn(`Skipped unreadable Wiki inbox card ${row.id}: ${issueSummary(parsed.error)}`);
    return null;
  }

  function readCards(rows: readonly CardRow[]): Card[] {
    return rows.flatMap((row) => {
      const card = readCard(row);
      return card === null ? [] : [card];
    });
  }

  function getCard(id: string): Card | null {
    return readCard(statements.get.get(id));
  }

  return {
    createCard(input: NewCard): Card {
      const now = iso(Date.now());
      const id = freshId("card_", (candidate) => statements.exists.get(candidate) !== undefined);
      const card = cardSchema.parse({ ...input, id, createdAt: now, updatedAt: now });
      statements.insert.run(cardParams(card));
      return card;
    },
    getCard,
    listCards(status: CardListStatus): Card[] {
      return readCards(status === "open" ? statements.open.all() : statements.closed.all(status, CLOSED_CARD_LIMIT));
    },
    updateCard(id: string, patch: CardPatch): Card | null {
      const existing = getCard(id);
      if (existing === null) return null;
      const card = cardSchema.parse({
        ...existing,
        status: patch.status ?? existing.status,
        rule: patch.rule ?? existing.rule,
        reason: patch.reason ?? existing.reason,
        destinations: patch.destinations ?? existing.destinations,
        tagSuggestions: patch.tagSuggestions ?? existing.tagSuggestions,
        rememberAliases: patch.rememberAliases ?? existing.rememberAliases,
        updatedAt: iso(Date.now()),
      });
      statements.update.run(cardParams(card));
      return card;
    },
    openCount(): number {
      return statements.openCount.get()?.count ?? 0;
    },
    cardsForJob(jobId: string): Card[] {
      return readCards(statements.forJob.all(jobId));
    },
    setCardJob(cardId: string, jobId: string | null): boolean {
      return statements.setJob.run(jobId, cardId).changes > 0;
    },
  };
}

function toUnit(row: UnitRow): Unit {
  return {
    hash: row.hash,
    notePath: row.note_path,
    noteDate: row.note_date,
    status: storedUnitStatusSchema.parse(row.status),
    cardId: row.card_id,
    seenAt: iso(row.seen_at),
  };
}

function createLedger(db: Db) {
  const statements = {
    getUnit: db.prepare<[string], UnitRow>(
      "SELECT hash, note_path, note_date, status, card_id, seen_at FROM units WHERE hash = ?",
    ),
    upsertUnit: db.prepare<UnitInput & { seenAt: number }>(
      `INSERT INTO units (hash, note_path, note_date, status, card_id, seen_at)
       VALUES (@hash, @notePath, @noteDate, @status, @cardId, @seenAt)
       ON CONFLICT (hash) DO UPDATE SET
         note_path = excluded.note_path, note_date = excluded.note_date, status = excluded.status, card_id = excluded.card_id`,
    ),
    setUnitStatus: db.prepare<[string, string]>("UPDATE units SET status = ? WHERE hash = ?"),
    noteStamp: db.prepare<[string], { mtime_ms: number; size: number }>(
      "SELECT mtime_ms, size FROM notes_seen WHERE path = ?",
    ),
    setNoteStamp: db.prepare<[string, number, number]>(
      `INSERT INTO notes_seen (path, mtime_ms, size) VALUES (?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
    ),
  };

  return {
    getUnit(hash: string): Unit | null {
      const row = statements.getUnit.get(hash);
      return row === undefined ? null : toUnit(row);
    },
    upsertUnit(unit: UnitInput): void {
      statements.upsertUnit.run({
        hash: unit.hash,
        notePath: unit.notePath,
        noteDate: unit.noteDate,
        status: unit.status,
        cardId: unit.cardId,
        seenAt: Date.now(),
      });
    },
    setUnitStatus(hash: string, status: UnitStatus): boolean {
      return statements.setUnitStatus.run(status, hash).changes > 0;
    },
    noteStamp(path: string): NoteStamp | null {
      const row = statements.noteStamp.get(path);
      return row === undefined ? null : { mtimeMs: row.mtime_ms, size: row.size };
    },
    setNoteStamp(path: string, mtimeMs: number, size: number): void {
      statements.setNoteStamp.run(path, mtimeMs, size);
    },
  };
}

function parseJobRow(row: JobRow): Job | null {
  const kind = jobKindSchema.safeParse(row.kind);
  const status = jobStatusSchema.safeParse(row.status);
  if (!kind.success || !status.success) return null;
  return {
    id: row.id,
    kind: kind.data,
    threadId: row.thread_id,
    status: status.data,
    payload: parseJson(row.payload) ?? null,
    result: row.result,
    error: row.error,
    createdAt: iso(row.created_at),
    finishedAt: row.finished_at === null ? null : iso(row.finished_at),
  };
}

function createJobs(db: Db, log: StoreLog) {
  const jobColumns = "id, kind, thread_id, status, payload, result, error, created_at, finished_at";
  const statements = {
    insert: db.prepare<[string, string, string, number]>(
      "INSERT INTO jobs (id, kind, thread_id, status, payload, created_at) VALUES (?, ?, NULL, 'running', ?, ?)",
    ),
    get: db.prepare<[string], JobRow>(`SELECT ${jobColumns} FROM jobs WHERE id = ?`),
    forThread: db.prepare<[string], JobRow>(
      `SELECT ${jobColumns} FROM jobs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ),
    running: db.prepare<[], JobRow>(`SELECT ${jobColumns} FROM jobs WHERE status = 'running' ORDER BY created_at, rowid`),
    setThread: db.prepare<[string, string]>("UPDATE jobs SET thread_id = ? WHERE id = ?"),
    finish: db.prepare<{ id: string; status: string; result: string | null; error: string | null; finishedAt: number }>(
      `UPDATE jobs SET status = @status, result = @result, error = @error, finished_at = @finishedAt
       WHERE id = @id AND status = 'running'`,
    ),
  };

  function readJob(row: JobRow | undefined): Job | null {
    if (row === undefined) return null;
    const job = parseJobRow(row);
    if (job === null) log.warn(`Skipped unreadable Wiki job ${row.id}: kind=${row.kind} status=${row.status}`);
    return job;
  }

  function getJob(id: string): Job | null {
    return readJob(statements.get.get(id));
  }

  return {
    createJob(input: { kind: JobKind; payload: unknown }): Job {
      const id = freshId("job_", (candidate) => statements.get.get(candidate) !== undefined);
      const payload = JSON.stringify(input.payload) ?? "null";
      const createdAt = Date.now();
      statements.insert.run(id, input.kind, payload, createdAt);
      return {
        id,
        kind: input.kind,
        threadId: null,
        status: "running",
        payload: parseJson(payload) ?? null,
        result: null,
        error: null,
        createdAt: iso(createdAt),
        finishedAt: null,
      };
    },
    setJobThread(id: string, threadId: string): boolean {
      return statements.setThread.run(threadId, id).changes > 0;
    },
    getJob,
    jobForThread(threadId: string): Job | null {
      return readJob(statements.forThread.get(threadId));
    },
    finishJob(id: string, outcome: JobOutcome): boolean {
      const params = {
        id,
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        finishedAt: Date.now(),
      };
      return statements.finish.run(params).changes > 0;
    },
    runningJobs(): Job[] {
      return statements.running.all().flatMap((row) => {
        const job = readJob(row);
        return job === null ? [] : [job];
      });
    },
  };
}

export function createStore(storage: BbPluginApi["storage"], log: StoreLog = quietLog) {
  const db = storage.database();
  storage.migrate(db, MIGRATIONS);
  return { ...createDocIndex(db), ...createInbox(db, log), ...createLedger(db), ...createJobs(db, log) };
}

export type Store = ReturnType<typeof createStore>;
