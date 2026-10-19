import { createHash } from "node:crypto";
import { normalizeTag, normalizeTags } from "./slug.js";

export const SKIP_TAG = "skip";

export interface NoteLink {
  target: string;
  heading: string | null;
}

export interface NoteUnit {
  index: number;
  lines: string[];
  text: string;
  blockTags: string[];
  inlineTags: string[];
  tags: string[];
  explicitLinks: NoteLink[];
  skip: boolean;
  images: string[];
  hash: string;
}

export interface ParseNoteOptions {
  knownTags: ReadonlySet<string>;
}

type LineKind = "blank" | "text" | "fence" | "code";

interface NoteLine {
  text: string;
  indent: number;
  kind: LineKind;
}

interface Fence {
  marker: string;
  size: number;
}

interface UnitDraft {
  lines: NoteLine[];
  tags: string[];
}

interface TickRun {
  start: number;
  size: number;
}

type Seek = (from: number) => number;

interface ImageScan {
  text: string;
  alt: Seek;
  space: Seek;
  angle: Seek;
  plain: Seek;
  titles: Array<{ open: string; close: string; seek: Seek }>;
}

interface ImageTail {
  end: number;
  target: string;
}

const DAILY_NOTE_NAME = /^(\d{1,2})-(\d{2})-(\d{2})\.md$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOTES_HEADING = /^(#{1,6})\s+NOTES/i;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const TAG_TOKEN = "@[A-Za-z0-9][A-Za-z0-9-]*";
const TAG_LINE = new RegExp(`^${TAG_TOKEN}(?:\\s+${TAG_TOKEN})*$`);
const INLINE_TAG = /(?<![A-Za-z0-9_@./\\-])@([A-Za-z0-9][A-Za-z0-9-]*)/g;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=\s|$)/;
const FENCE_OPEN = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const TICK_RUN = /`+/g;
const WIKI_LINK = /(?<!!)\[\[([^[\]\n]+)\]\]/g;
const IMAGE_ALT_GAPS = /[^\]\n]+/g;
const SPACE_GAPS = /\s+/g;
const ANGLE_GAPS = /[^>\n]+/g;
const PLAIN_GAPS = /[^\s()]+/g;
const IMAGE_TITLES = [
  { open: '"', close: '"', gaps: /[^"\n]+/g },
  { open: "'", close: "'", gaps: /[^'\n]+/g },
  { open: "(", close: ")", gaps: /[^)\n]+/g },
];
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NESTED_INDENT = 2;
const TAB_WIDTH = 4;
const DATE_LOCALE = "en-US-u-ca-gregory-nu-latn";
const DATE_PARTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export function parseDailyNoteName(fileName: string): string | null {
  const match = DAILY_NOTE_NAME.exec(basename(fileName));
  if (match === null) return null;
  const [, monthText = "", dayText = "", yearText = ""] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = 2000 + Number(yearText);
  return isRealDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

export function formatNoteDateShort(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) return isoDate;
  const [, year = "", month = "", day = ""] = match;
  return `${month}-${day}-${year.slice(-2)}`;
}

export function isSkippedNotesDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

export function isIngestibleNoteDate(noteDate: string, today: string): boolean {
  return noteDate < today;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(DATE_LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const zone = timeZone.trim();
  if (zone !== "" && isValidTimeZone(zone)) return new Intl.DateTimeFormat(DATE_LOCALE, { ...DATE_PARTS, timeZone: zone });
  return new Intl.DateTimeFormat(DATE_LOCALE, DATE_PARTS);
}

export function todayInZone(timeZone: string, now: Date): string {
  const parts = dateFormatter(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

function splitLines(content: string): string[] {
  return content.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += TAB_WIDTH - (width % TAB_WIDTH);
    else break;
  }
  return width;
}

function fenceOpening(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const run = match?.[1];
  if (match === null || run === undefined) return null;
  const info = line.slice(match[0].length);
  if (LINE_BREAK.test(info) || (run.startsWith("`") && info.includes("`"))) return null;
  return { marker: run.charAt(0), size: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = FENCE_CLOSE.exec(line)?.[1];
  return run !== undefined && run.charAt(0) === fence.marker && run.length >= fence.size;
}

function classifyLines(lines: readonly string[]): NoteLine[] {
  const classified: NoteLine[] = [];
  let fence: Fence | null = null;
  for (const raw of lines) {
    const text = raw.trimEnd();
    if (fence !== null) {
      if (closesFence(text, fence)) fence = null;
      classified.push({ text, indent: indentOf(text), kind: "code" });
    } else if (text === "") {
      classified.push({ text, indent: 0, kind: "blank" });
    } else {
      fence = fenceOpening(text);
      classified.push({ text, indent: indentOf(text), kind: fence === null ? "text" : "fence" });
    }
  }
  return classified;
}

function headingLevel(line: NoteLine): number | null {
  if (line.kind !== "text" || line.indent >= NESTED_INDENT) return null;
  const hashes = ATX_HEADING.exec(line.text)?.[1];
  return hashes === undefined ? null : hashes.length;
}

function notesHeadingLevel(line: NoteLine): number | null {
  if (line.kind !== "text") return null;
  const match = NOTES_HEADING.exec(line.text);
  const hashes = match?.[1];
  if (match === null || hashes === undefined) return null;
  const rest = line.text.slice(match[0].length).trim();
  return rest === "" || rest === ":" ? hashes.length : null;
}

export function extractNotesSection(content: string): string[] | null {
  const lines = splitLines(content);
  const classified = classifyLines(lines);
  const start = classified.findIndex((line) => notesHeadingLevel(line) !== null);
  const startLine = classified[start];
  if (startLine === undefined) return null;
  const level = notesHeadingLevel(startLine) ?? 1;
  const offset = classified.slice(start + 1).findIndex((line) => {
    const other = headingLevel(line);
    return other !== null && other <= level;
  });
  return lines.slice(start + 1, offset < 0 ? lines.length : start + 1 + offset);
}

export function isTagLine(line: string): string[] | null {
  const trimmed = line.trim();
  return TAG_LINE.test(trimmed) ? normalizeTags(trimmed.split(/\s+/)) : null;
}

function nextIndents(lines: readonly NoteLine[]): Array<number | null> {
  const indents: Array<number | null> = new Array<number | null>(lines.length).fill(null);
  let next: number | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    indents[index] = next;
    const line = lines[index];
    if (line !== undefined && line.kind !== "blank") next = line.indent;
  }
  return indents;
}

function splitBlocks(lines: readonly NoteLine[]): NoteLine[][] {
  const following = nextIndents(lines);
  const blocks: NoteLine[][] = [];
  let current: NoteLine[] = [];
  lines.forEach((line, index) => {
    const continues = (following[index] ?? 0) >= NESTED_INDENT;
    if (line.kind !== "blank" || (current.length > 0 && continues)) {
      current.push(line);
      return;
    }
    if (current.length > 0) blocks.push(current);
    current = [];
  });
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function tagsOfLine(line: NoteLine, current: UnitDraft | null): string[] | null {
  if (line.kind !== "text") return null;
  if (current !== null && line.indent >= NESTED_INDENT) return null;
  return isTagLine(line.text);
}

function startsUnit(line: NoteLine, current: UnitDraft | null): boolean {
  if (current === null) return true;
  if (line.kind !== "text" && line.kind !== "fence") return false;
  return line.indent < NESTED_INDENT && LIST_ITEM.test(line.text.trimStart());
}

function draftsOfBlock(block: readonly NoteLine[]): UnitDraft[] {
  const drafts: UnitDraft[] = [];
  let tags: string[] = [];
  let current: UnitDraft | null = null;
  for (const line of block) {
    const lineTags = tagsOfLine(line, current);
    if (lineTags !== null) {
      tags = current === null ? normalizeTags([...tags, ...lineTags]) : lineTags;
      current = null;
    } else if (line.kind === "blank") {
      current?.lines.push(line);
    } else if (startsUnit(line, current)) {
      current = { lines: [line], tags };
      drafts.push(current);
    } else {
      current?.lines.push(line);
    }
  }
  return drafts;
}

function hasContent(draft: UnitDraft): boolean {
  return draft.lines.some((line) => line.text.trim().replace(LIST_MARKER, "").trim() !== "");
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function tickRuns(text: string): TickRun[] {
  return Array.from(text.matchAll(TICK_RUN), (match) => ({ start: match.index, size: match[0].length }));
}

function longestFrom(runs: readonly TickRun[]): number[] {
  const longest = new Array<number>(runs.length + 1).fill(0);
  for (let index = runs.length - 1; index >= 0; index -= 1) longest[index] = Math.max(longest[index + 1] ?? 0, runs[index]?.size ?? 0);
  return longest;
}

function blankSegmentCode(text: string): string {
  const runs = tickRuns(text);
  const longest = longestFrom(runs);
  let output = "";
  let cursor = 0;
  let index = 0;
  let from = runs[0]?.start ?? 0;
  for (let run = runs[0]; run !== undefined; run = runs[index]) {
    const open = run.start + run.size - from;
    const size = Math.min(open, longest[index + 1] ?? 0);
    let end = open < 2 ? -1 : from + open - (open % 2);
    if (2 * size > open) {
      do index += 1;
      while ((runs[index]?.size ?? size) < size);
      end = (runs[index]?.start ?? 0) + size;
    }
    if (end !== -1) {
      output += `${text.slice(cursor, from)} `;
      cursor = end;
    }
    const current = runs[index];
    if (end !== -1 && current !== undefined && end < current.start + current.size) {
      from = end;
    } else {
      index += 1;
      from = runs[index]?.start ?? 0;
    }
  }
  return `${output}${text.slice(cursor)}`;
}

function blankInlineCode(text: string): string {
  return text.split("\n").map(blankSegmentCode).join("\n");
}

function proseOf(lines: readonly NoteLine[]): string {
  return lines
    .filter((line) => line.kind === "text")
    .map((line) => blankInlineCode(line.text))
    .join("\n");
}

function knownTagSet(knownTags: ReadonlySet<string>): Set<string> {
  return new Set([...normalizeTags(knownTags), SKIP_TAG]);
}

function inlineTagsOf(prose: string, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of prose.matchAll(INLINE_TAG)) {
    const tag = normalizeTag(match[1] ?? "");
    if (known.has(tag)) found.add(tag);
  }
  return [...found];
}

function parseWikiTarget(inner: string): NoteLink | null {
  const [reference = ""] = inner.split(/\\?\|/, 1);
  const hashAt = reference.indexOf("#");
  const target = (hashAt < 0 ? reference : reference.slice(0, hashAt)).trim();
  const heading = hashAt < 0 ? "" : reference.slice(hashAt + 1).trim();
  return target === "" ? null : { target, heading: heading === "" ? null : heading };
}

function linksOf(prose: string): NoteLink[] {
  const links = new Map<string, NoteLink>();
  for (const match of prose.matchAll(WIKI_LINK)) {
    const link = parseWikiTarget(match[1] ?? "");
    if (link === null) continue;
    const key = `${link.target.toLowerCase()}#${(link.heading ?? "").toLowerCase()}`;
    if (!links.has(key)) links.set(key, link);
  }
  return [...links.values()];
}

function unwrapAngle(path: string): string {
  return path.startsWith("<") && path.endsWith(">") ? path.slice(1, -1).trim() : path;
}

function stopTable(text: string, gaps: RegExp): Int32Array {
  const table = new Int32Array(text.length + 1);
  for (let index = 0; index <= text.length; index += 1) table[index] = index;
  for (const gap of text.matchAll(gaps)) table.fill(gap.index + gap[0].length, gap.index, gap.index + gap[0].length);
  return table;
}

function seeker(text: string, gaps: RegExp): Seek {
  let table: Int32Array | undefined;
  return (from) => {
    table ??= stopTable(text, gaps);
    return table[from] ?? text.length;
  };
}

function imageScan(text: string): ImageScan {
  return {
    text,
    alt: seeker(text, IMAGE_ALT_GAPS),
    space: seeker(text, SPACE_GAPS),
    angle: seeker(text, ANGLE_GAPS),
    plain: seeker(text, PLAIN_GAPS),
    titles: IMAGE_TITLES.map((title) => ({ open: title.open, close: title.close, seek: seeker(text, title.gaps) })),
  };
}

function imageClose(scan: ImageScan, end: number): number {
  const gap = scan.space(end);
  const title = gap > end ? scan.titles.find((entry) => entry.open === scan.text.charAt(gap)) : undefined;
  if (title !== undefined) {
    const close = title.seek(gap + 1);
    const after = scan.space(close + 1);
    if (scan.text.charAt(close) === title.close && scan.text.charAt(after) === ")") return after + 1;
  }
  return scan.text.charAt(gap) === ")" ? gap + 1 : -1;
}

function imagePathEnd(scan: ImageScan, from: number): number {
  let at = scan.plain(from);
  while (scan.text.charAt(at) === "(") {
    const close = scan.plain(at + 1);
    if (scan.text.charAt(close) !== ")") break;
    at = scan.plain(close + 1);
  }
  return at;
}

function imageTail(scan: ImageScan, from: number): ImageTail | null {
  const start = scan.space(from);
  const angled = scan.text.charAt(start) === "<" ? scan.angle(start + 1) : -1;
  if (angled > start + 1 && scan.text.charAt(angled) === ">") {
    const end = imageClose(scan, angled + 1);
    if (end !== -1) return { end, target: scan.text.slice(start, angled + 1) };
  }
  const stop = imagePathEnd(scan, start);
  const end = stop === start ? -1 : imageClose(scan, stop);
  return end === -1 ? null : { end, target: scan.text.slice(start, stop) };
}

function imageTargets(prose: string): string[] {
  const targets: string[] = [];
  let open = prose.indexOf("![");
  if (open === -1) return targets;
  const scan = imageScan(prose);
  let altEnd = -1;
  let found: ImageTail | null = null;
  while (open !== -1) {
    const close = scan.alt(open + 2);
    if (close !== altEnd) {
      altEnd = close;
      found = prose.startsWith("](", close) ? imageTail(scan, close + 2) : null;
    }
    if (found === null) {
      open = prose.indexOf("![", open + 1);
      continue;
    }
    targets.push(found.target);
    open = prose.indexOf("![", found.end);
  }
  return targets;
}

function imagesOf(prose: string): string[] {
  const images = new Set<string>();
  for (const target of imageTargets(prose)) {
    const path = unwrapAngle(target);
    if (path !== "" && !URL_SCHEME.test(path)) images.add(path);
  }
  return [...images];
}

export function normalizeWhitespace(text: string): string {
  const lines: string[] = [];
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (trimmed === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(trimmed);
  }
  return trimTrailingBlank(lines).join("\n");
}

export function hashUnitText(text: string): string {
  return createHash("sha256").update(normalizeWhitespace(text), "utf8").digest("hex");
}

function buildUnit(draft: UnitDraft, index: number, known: ReadonlySet<string>): NoteUnit {
  const lines = trimTrailingBlank(draft.lines.map((line) => line.text));
  const text = lines.join("\n");
  const prose = proseOf(draft.lines);
  const blockTags = [...draft.tags];
  const inlineTags = inlineTagsOf(prose, known);
  const tags = normalizeTags([...blockTags, ...inlineTags]);
  return {
    index,
    lines,
    text,
    blockTags,
    inlineTags,
    tags,
    explicitLinks: linksOf(prose),
    skip: tags.includes(SKIP_TAG),
    images: imagesOf(prose),
    hash: hashUnitText(text),
  };
}

export function parseSectionUnits(lines: readonly string[], options: ParseNoteOptions): NoteUnit[] {
  const known = knownTagSet(options.knownTags);
  return splitBlocks(classifyLines(lines))
    .flatMap((block) => draftsOfBlock(block))
    .filter(hasContent)
    .map((draft, index) => buildUnit(draft, index, known));
}

export function parseNoteUnits(content: string, options: ParseNoteOptions): NoteUnit[] {
  const section = extractNotesSection(content);
  return section === null ? [] : parseSectionUnits(section, options);
}
