import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isoDateSchema, type Card, type IngestResult } from "../contract.js";
import {
  extractNotesSection,
  hashUnitText,
  isIngestibleNoteDate,
  isSkippedNotesDirectory,
  parseDailyNoteName,
  parseNoteUnits,
  todayInZone,
  type NoteUnit,
} from "../lib/daily-notes.js";
import { chunkMarkdownFile, type FileChunk } from "../lib/file-chunks.js";
import { extractImageTargets, extractWikiLinks } from "../lib/markdown-doc.js";
import { normalizeTag, wordsFromName } from "../lib/slug.js";
import { LIMITS } from "../lib/wiki.js";
import { FALLBACK_REASON, createNotesCards, fallbackToRules, type NotesCardItem } from "./cards.js";
import type { WikiContext } from "./context.js";
import { startRoutingJobs } from "./routing.js";

export const FIRST_RUN_KEY = "firstRunAt";
export const FIRST_RUN_LOOKBACK_DAYS = 7;

export interface IngestOptions {
  since: string | null;
  useAgent: boolean | null;
}

export interface DailyNoteFile {
  path: string;
  relPath: string;
  date: string;
}

interface LoadedNote {
  content: string;
  mtimeMs: number;
  size: number;
}

interface Scan {
  items: NotesCardItem[];
  stamps: Array<{ path: string; mtimeMs: number; size: number }>;
  notesScanned: number;
  unitsFound: number;
}

const firstRunSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const locks = new WeakMap<object, Promise<unknown>>();

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

async function firstRunAt(ctx: WikiContext, now: Date): Promise<Date> {
  const stored = firstRunSchema.safeParse(await ctx.bb.storage.kv.get<unknown>(FIRST_RUN_KEY));
  if (stored.success) return new Date(stored.data);
  await ctx.bb.storage.kv.set(FIRST_RUN_KEY, now.toISOString());
  return now;
}

async function startDate(ctx: WikiContext, options: IngestOptions, timeZone: string, configured: string, now: Date): Promise<string> {
  const firstRun = await firstRunAt(ctx, now);
  if (options.since !== null) return options.since;
  if (configured !== "") return configured;
  return shiftIsoDate(todayInZone(timeZone, firstRun), -FIRST_RUN_LOOKBACK_DAYS);
}

async function readEntries(folder: string, top: boolean): Promise<Dirent[] | null> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (top && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return null;
  }
}

async function walkNotes(root: string, segments: readonly string[], found: DailyNoteFile[]): Promise<boolean> {
  const entries = await readEntries(path.join(root, ...segments), segments.length === 0);
  if (entries === null) return false;
  for (const entry of entries) {
    const next = [...segments, entry.name];
    if (entry.isDirectory()) {
      if (!isSkippedNotesDirectory(entry.name)) await walkNotes(root, next, found);
      continue;
    }
    const date = entry.isFile() ? parseDailyNoteName(entry.name) : null;
    if (date !== null) found.push({ path: path.join(root, ...next), relPath: next.join("/"), date });
  }
  return true;
}

export async function listDailyNotes(notesRoot: string): Promise<DailyNoteFile[] | null> {
  const found: DailyNoteFile[] = [];
  if (!(await walkNotes(notesRoot, [], found))) return null;
  return found.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.relPath < b.relPath ? -1 : 1));
}

function knownTags(ctx: WikiContext): Set<string> {
  return new Set(ctx.store.allTags().flatMap((entry) => [entry.tag, ...entry.aliases]));
}

async function loadNote(ctx: WikiContext, note: DailyNoteFile, force: boolean): Promise<LoadedNote | null> {
  const stats = await stat(note.path).catch(() => null);
  if (stats === null || !stats.isFile()) return null;
  if (stats.size > LIMITS.content) {
    ctx.log.warn(`Wiki skipped ${note.path}: it is larger than ${LIMITS.content} bytes.`);
    return null;
  }
  const seen = force ? null : ctx.store.noteStamp(note.path);
  if (seen !== null && seen.mtimeMs === stats.mtimeMs && seen.size === stats.size) return null;
  try {
    return { content: await readFile(note.path, "utf8"), mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    ctx.log.warn(`Wiki skipped ${note.path} for now: ${errorMessage(error)}`);
    return null;
  }
}

async function scanNotes(ctx: WikiContext, notes: readonly DailyNoteFile[], force: boolean): Promise<Scan> {
  const scan: Scan = { items: [], stamps: [], notesScanned: 0, unitsFound: 0 };
  const tags = knownTags(ctx);
  const hashes = new Set<string>();
  for (const note of notes) {
    const loaded = await loadNote(ctx, note, force);
    if (loaded === null) continue;
    scan.notesScanned += 1;
    scan.stamps.push({ path: note.path, mtimeMs: loaded.mtimeMs, size: loaded.size });
    if (extractNotesSection(loaded.content) === null) ctx.log.info(`Wiki found no NOTES section in ${note.relPath}.`);
    const units = parseNoteUnits(loaded.content, { knownTags: tags }).filter((unit) => !unit.skip);
    scan.unitsFound += units.length;
    for (const unit of units) {
      if (hashes.has(unit.hash) || ctx.store.getUnit(unit.hash) !== null) continue;
      hashes.add(unit.hash);
      scan.items.push({ unit, notePath: note.relPath, noteDate: note.date });
    }
  }
  return scan;
}

async function routeCards(ctx: WikiContext, cards: readonly Card[]): Promise<string[]> {
  const routing = cards.filter((card) => card.status === "routing");
  if (routing.length === 0) return [];
  try {
    return await startRoutingJobs(ctx, routing);
  } catch (error) {
    ctx.log.warn(`Wiki could not start Claude Code routing: ${errorMessage(error)}`);
    for (const card of routing) fallbackToRules(ctx, card, FALLBACK_REASON);
    ctx.publishInbox();
    return [];
  }
}

async function ingest(ctx: WikiContext, options: IngestOptions): Promise<IngestResult> {
  await ctx.wikiRoot();
  const settings = await ctx.settings();
  const now = new Date();
  const today = todayInZone(settings.timezone, now);
  const from = await startDate(ctx, options, settings.timezone, settings.ingestStartDate, now);
  const notesRoot = await ctx.notesRoot();
  const listed = await listDailyNotes(notesRoot);
  if (listed === null) {
    ctx.log.info(`Wiki ingest found no notes folder at ${notesRoot}.`);
    return { notesScanned: 0, unitsFound: 0, cardsCreated: 0, jobIds: [] };
  }
  const notes = listed.filter((note) => note.date >= from && isIngestibleNoteDate(note.date, today));
  const scan = await scanNotes(ctx, notes, options.since !== null);
  const useAgent = options.useAgent ?? settings.routingAgent;
  const cards = await createNotesCards(ctx, scan.items, { useAgent });
  for (const stamp of scan.stamps) ctx.store.setNoteStamp(stamp.path, stamp.mtimeMs, stamp.size);
  const jobIds = useAgent ? await routeCards(ctx, cards) : [];
  return { notesScanned: scan.notesScanned, unitsFound: scan.unitsFound, cardsCreated: cards.length, jobIds };
}

function withIngestLock<T>(ctx: WikiContext, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(ctx.store) ?? Promise.resolve();
  const run = previous.then(work, work);
  locks.set(
    ctx.store,
    run.catch(() => undefined),
  );
  return run;
}

export function runIngest(ctx: WikiContext, options: IngestOptions): Promise<IngestResult> {
  if (options.since !== null && !isoDateSchema.safeParse(options.since).success) {
    return Promise.reject(new Error(`Expected the since date as YYYY-MM-DD, got ${JSON.stringify(options.since)}.`));
  }
  return withIngestLock(ctx, () => ingest(ctx, options));
}

export interface ImportOptions {
  folders: readonly string[];
  useAgent: boolean | null;
}

export interface ReferenceFile {
  path: string;
  relPath: string;
  tag: string;
}

const REFERENCE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

function isSkippedImportDirectory(name: string): boolean {
  return isSkippedNotesDirectory(name) || name.endsWith("_files");
}

async function walkReference(notesRoot: string, base: readonly string[], segments: readonly string[], found: ReferenceFile[]): Promise<void> {
  const entries = await readEntries(path.join(notesRoot, ...base, ...segments), false);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = [...segments, entry.name];
    if (entry.isDirectory()) {
      if (!isSkippedImportDirectory(entry.name)) await walkReference(notesRoot, base, next, found);
      continue;
    }
    if (!entry.isFile() || !REFERENCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (parseDailyNoteName(entry.name) !== null) continue;
    const owner = next.length > 1 ? (next[0] ?? entry.name) : entry.name.replace(/\.[^.]+$/, "");
    found.push({ path: path.join(notesRoot, ...base, ...next), relPath: [...base, ...next].join("/"), tag: normalizeTag(owner) });
  }
}

export function importFolderSegments(folder: string): string[] {
  const segments = folder
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment.startsWith("."))) {
    throw new Error(`Import folders must be inside the notes folder, like "Projects" or "Tools"; got ${JSON.stringify(folder)}.`);
  }
  return segments;
}

export async function listReferenceFiles(notesRoot: string, folders: readonly string[]): Promise<ReferenceFile[]> {
  const found: ReferenceFile[] = [];
  for (const folder of folders) {
    const base = importFolderSegments(folder);
    const stats = await stat(path.join(notesRoot, ...base)).catch(() => null);
    if (stats === null || !stats.isDirectory()) throw new Error(`No folder "${base.join("/")}" in the notes folder ${notesRoot}.`);
    await walkReference(notesRoot, base, [], found);
  }
  const unique = new Map(found.map((file) => [file.relPath, file]));
  return [...unique.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}

function chunkUnit(chunk: FileChunk, index: number, tag: string): NoteUnit {
  const links = extractWikiLinks(chunk.text)
    .filter((link) => !link.embed)
    .map((link) => ({ target: link.target, heading: link.heading }));
  const tags = tag === "" ? [] : [tag];
  return {
    index,
    lines: chunk.lines,
    text: chunk.text,
    blockTags: tags,
    inlineTags: [],
    tags,
    explicitLinks: links,
    skip: /(^|\s)@skip\b/i.test(chunk.text),
    images: extractImageTargets(chunk.text),
    hash: hashUnitText(chunk.text),
  };
}

function fileTitle(relPath: string): string {
  return wordsFromName(path.basename(relPath).replace(/\.[^.]+$/, ""));
}

async function scanReference(ctx: WikiContext, files: readonly ReferenceFile[], timeZone: string): Promise<Scan> {
  const scan: Scan = { items: [], stamps: [], notesScanned: 0, unitsFound: 0 };
  const hashes = new Set<string>();
  for (const file of files) {
    const stats = await stat(file.path).catch(() => null);
    if (stats === null || stats.size > LIMITS.content) continue;
    let content: string;
    try {
      content = await readFile(file.path, "utf8");
    } catch (error) {
      ctx.log.warn(`Wiki skipped ${file.path} for now: ${errorMessage(error)}`);
      continue;
    }
    scan.notesScanned += 1;
    const modified = todayInZone(timeZone, stats.mtime);
    const chunks = chunkMarkdownFile(content);
    chunks.forEach((chunk, index) => {
      const unit = chunkUnit(chunk, index, file.tag);
      if (unit.skip) return;
      scan.unitsFound += 1;
      if (hashes.has(unit.hash) || ctx.store.getUnit(unit.hash) !== null) return;
      hashes.add(unit.hash);
      const heading = chunk.headingPath.at(-1) ?? fileTitle(file.relPath);
      const section = chunk.headingPath.join(" › ");
      scan.items.push({ unit, notePath: file.relPath, noteDate: modified, origin: "file", section, heading });
    });
  }
  return scan;
}

async function importFolders(ctx: WikiContext, options: ImportOptions): Promise<IngestResult> {
  await ctx.wikiRoot();
  const settings = await ctx.settings();
  const files = await listReferenceFiles(await ctx.notesRoot(), options.folders);
  const scan = await scanReference(ctx, files, settings.timezone);
  const useAgent = options.useAgent ?? settings.routingAgent;
  const cards = await createNotesCards(ctx, scan.items, { useAgent });
  const jobIds = useAgent ? await routeCards(ctx, cards) : [];
  return { notesScanned: scan.notesScanned, unitsFound: scan.unitsFound, cardsCreated: cards.length, jobIds };
}

export function runImport(ctx: WikiContext, options: ImportOptions): Promise<IngestResult> {
  return withIngestLock(ctx, () => importFolders(ctx, options));
}
