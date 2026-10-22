import { Document, isMap, isNode, isScalar, isSeq, type Pair, parseDocument, type ToStringOptions } from "yaml";
import { z } from "zod";
import { normalizeTag, normalizeTags, slugify, wordsFromName } from "./slug.js";
import { DEFAULT_DOC_TYPE, DEFAULT_HEADING, type DocType, isDocType, mediaKindOf, truncate } from "./wiki.js";

export interface DocMeta {
  title: string | null;
  type: DocType | null;
  aliases: string[];
}

export interface ParsedDoc {
  frontmatter: string;
  meta: DocMeta;
  body: string;
  title: string;
  type: DocType;
  aliases: string[];
}

export interface DocSection {
  heading: string;
  headingPath: string;
  anchor: string;
  level: number;
  ord: number;
  body: string;
}

export interface WikiLink {
  raw: string;
  target: string;
  heading: string | null;
  label: string | null;
  embed: boolean;
  index: number;
}

export const sourceMarkerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notes"), notePath: z.string().min(1), noteDate: z.string(), added: z.string() }),
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1), title: z.string().nullable(), added: z.string() }),
  z.object({ kind: z.literal("agent"), threadId: z.string().min(1), title: z.string().nullable(), added: z.string() }),
  z.object({ kind: z.literal("upload"), name: z.string().min(1), added: z.string() }),
  z.object({ kind: z.literal("manual"), added: z.string() }),
]);
export type SourceMarker = z.infer<typeof sourceMarkerSchema>;

export interface SourceMarkerLine {
  line: number;
  source: SourceMarker;
}

export interface NewDocInput {
  title: string;
  type: DocType;
  aliases: string[];
}

interface Line {
  start: number;
  text: string;
}

interface Fence {
  char: string;
  size: number;
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

interface Outline {
  headings: Heading[];
  open: Fence | null;
}

interface Frontmatter {
  end: number;
  sourceStart: number;
  sourceEnd: number;
  source: string;
  data: Record<string, unknown>;
}

interface ImageRef {
  target: string;
  start: number;
  end: number;
  style: "markdown" | "angle" | "embed";
}

interface Span {
  start: number;
  end: number;
}

interface FenceMatch {
  marker: string;
  info: string;
}

const OPEN_FRONTMATTER = /^---[ \t]*$/;
const CLOSE_FRONTMATTER = /^(?:---|\.\.\.)[ \t]*$/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_OPEN_ITEM = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;
const ATX_OPEN = /^ {0,3}(#{1,6})[\t ]/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const LINE_BREAK_SPLIT = /([\n\r\u2028\u2029])/;
const WORD_CHAR = /^\w$/;
const BLANK = /^[ \t]*$/;
const MAX_YAML_ALIASES = 20;
const MARKER_TITLE_LIMIT = 60;
export const MARKER_LINE = /^[ \t]*<!--[ \t]*wiki:source\b([^\n]*?)-->[ \t]*$/;
const MARKER_ATTR = /([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi;
const MARKER_LINES = /^[ \t]*<!--[ \t]*wiki:source\b[^\n]*?-->[ \t]*(?:\r?\n|$)/gm;
const SNIPPET_HEAD = /^…([^\n<>]*?)-->[ \t]*(?:\r?\n)?/;
const CUT_IN_VALUE = /^[^"\n]*"(?:[ \t]+[a-z][a-z0-9:-]*(?:="[^"\n]*")?)*[ \t]*$/i;
const CUT_IN_NAME = /^[a-z0-9:-]*=?(?:"[^"\n]*")?(?:[ \t]+[a-z][a-z0-9:-]*(?:="[^"\n]*")?)*[ \t]*$/i;
const SNIPPET_TAIL = /[ \t\r\n]*<!--([^\n>]*)…$/;
const MARKER_KEYWORD = "wiki:source";
const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "\n": "&#10;",
  "\r": "&#13;",
  "\t": "&#9;",
};
const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', lt: "<", gt: ">" };
const WIKI_LINK = /(!?)\[\[([^[\]\n]+)\]\]/g;
const TICKS_OR_BREAK = /`+|[\n\r\u2028\u2029]/g;
const MARKDOWN_IMAGE =
  /!\[(?:[^[\]\\\n]|\\.|\[(?:[^[\]\\\n]|\\.)*\])*\]\([ \t]*(<[^<>\n]*>|[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/dg;
const EMBED_IMAGE = /!\[\[([^[\]\n|#]+)(?:[|#][^[\]\n]*)?\]\]/dg;
const NON_LOCAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const FLOW_OPTIONS: ToStringOptions = { lineWidth: 0, flowCollectionPadding: false };

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function scanLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const raw of text.split("\n")) {
    const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ start, text: lines.length === 0 ? stripBom(clean) : clean });
    start += raw.length + 1;
  }
  return lines;
}

function lineTexts(text: string): string[] {
  return scanLines(text).map((line) => line.text);
}

function eolOf(content: string): string {
  const newline = content.indexOf("\n");
  return newline > 0 && content[newline - 1] === "\r" ? "\r\n" : "\n";
}

function isLayoutSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isInlineSpace(char: string): boolean {
  return char === " " || char === "\t";
}

function skipInlineSpace(text: string, from: number): number {
  let index = from;
  while (isInlineSpace(text.charAt(index))) index += 1;
  return index;
}

function trimInlineSpaceEnd(text: string, from: number, floor: number): number {
  let end = from;
  while (end > floor && isInlineSpace(text.charAt(end - 1))) end -= 1;
  return end;
}

export function trimLineEnds(text: string): string {
  return text
    .split(LINE_BREAK_SPLIT)
    .map((part, index) => (index % 2 === 0 ? part.slice(0, trimInlineSpaceEnd(part, part.length, 0)) : part))
    .join("");
}

function trimTrailingBlankLines(text: string): string {
  let end = text.length;
  let cut = text.length;
  while (end > 0 && isLayoutSpace(text.charAt(end - 1))) {
    end -= 1;
    if (text.charAt(end) === "\n") cut = end;
  }
  if (end === 0) return "";
  return text.slice(0, text.charAt(cut - 1) === "\r" ? cut - 1 : cut);
}

function isBlank(line: string): boolean {
  return BLANK.test(line);
}

function trimBlankLines(lines: readonly string[]): string[] {
  const first = lines.findIndex((line) => !isBlank(line));
  if (first === -1) return [];
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last] ?? "")) last -= 1;
  return lines.slice(first, last + 1);
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fenceMatch(text: string, pattern: RegExp = FENCE_OPEN): FenceMatch | null {
  const match = pattern.exec(text);
  const marker = match?.[1];
  if (match === null || marker === undefined || LINE_BREAK.test(text)) return null;
  return { marker, info: text.slice(match[0].length) };
}

function fenceOpening(text: string): Fence | null {
  const match = fenceMatch(text, FENCE_OPEN_ITEM);
  if (match === null) return null;
  if (match.marker.startsWith("`") && match.info.includes("`")) return null;
  return { char: match.marker.charAt(0), size: match.marker.length };
}

function closesFence(fence: Fence, text: string): boolean {
  const match = fenceMatch(text);
  if (match === null) return false;
  return match.marker.charAt(0) === fence.char && match.marker.length >= fence.size && match.info.trim() === "";
}

function fenceCloser(fence: Fence): string {
  return fence.char.repeat(fence.size);
}

function scanCode(texts: readonly string[]): { inCode: boolean[]; open: Fence | null } {
  let open: Fence | null = null;
  const inCode: boolean[] = [];
  for (const text of texts) {
    if (open === null) {
      open = fenceOpening(text);
      inCode.push(open !== null);
    } else {
      inCode.push(true);
      if (closesFence(open, text)) open = null;
    }
  }
  return { inCode, open };
}

function atxLabel(text: string, from: number): string {
  const start = skipInlineSpace(text, from);
  const end = trimInlineSpaceEnd(text, text.length, start);
  let hashes = end;
  while (hashes > start && text.charAt(hashes - 1) === "#") hashes -= 1;
  const cut = trimInlineSpaceEnd(text, hashes, start);
  return text.slice(start, hashes < end && cut < hashes ? cut : end);
}

function headingOf(text: string, line: number): Heading | null {
  const match = ATX_OPEN.exec(text);
  const hashes = match?.[1];
  if (match === null || hashes === undefined || LINE_BREAK.test(text)) return null;
  const label = atxLabel(text, match[0].length).trim();
  return label === "" ? null : { line, level: hashes.length, text: label };
}

function outline(texts: readonly string[]): Outline {
  const { inCode, open } = scanCode(texts);
  const headings = texts.flatMap((text, line) => {
    const heading = inCode[line] === true ? null : headingOf(text, line);
    return heading === null ? [] : [heading];
  });
  return { headings, open };
}

function headingKey(text: string): string {
  return cleanLine(text).toLowerCase();
}

function parseYamlMapping(source: string): Record<string, unknown> | null {
  try {
    const document = parseDocument(source);
    if (document.errors.length > 0) return null;
    const value: unknown = document.toJS({ maxAliasCount: MAX_YAML_ALIASES });
    if (value === null || value === undefined) return {};
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readFrontmatter(content: string): Frontmatter | null {
  const lines = scanLines(content);
  const open = lines[0];
  const first = lines[1];
  if (open === undefined || first === undefined || !OPEN_FRONTMATTER.test(open.text)) return null;
  const closeIndex = lines.findIndex((line, index) => index > 0 && CLOSE_FRONTMATTER.test(line.text));
  const close = lines[closeIndex];
  if (closeIndex === -1 || close === undefined) return null;
  const source = content.slice(first.start, close.start);
  const data = parseYamlMapping(source);
  if (data === null) return null;
  const end = lines[closeIndex + 1]?.start ?? content.length;
  return { end, sourceStart: first.start, sourceEnd: close.start, source, data };
}

export function hasValidFrontmatter(content: string): boolean {
  return readFrontmatter(content) !== null;
}

function frontmatterEnd(content: string): number {
  return readFrontmatter(content)?.end ?? 0;
}

function metaTitle(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const title = cleanLine(value);
  return title === "" ? null : title;
}

function metaType(value: unknown): DocType | null {
  if (typeof value !== "string") return null;
  const type = value.trim().toLowerCase();
  return isDocType(type) ? type : null;
}

function aliasItems(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [value];
  return items.flatMap((item) => {
    const text = typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
    return text === "" ? [] : [text];
  });
}

function docMeta(data: Record<string, unknown>): DocMeta {
  return {
    title: metaTitle(data.title),
    type: metaType(data.type),
    aliases: normalizeTags(aliasItems(data.aliases)),
  };
}

function firstH1(body: string): string | null {
  return outline(lineTexts(body)).headings.find((heading) => heading.level === 1)?.text ?? null;
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

export function parseDoc(content: string, fallbackName: string): ParsedDoc {
  const block = readFrontmatter(content);
  const frontmatter = block === null ? "" : content.slice(0, block.end);
  const body = content.slice(frontmatter.length);
  const meta = docMeta(block?.data ?? {});
  return {
    frontmatter,
    meta,
    body,
    title: meta.title ?? firstH1(body) ?? wordsFromName(baseName(fallbackName)),
    type: meta.type ?? DEFAULT_DOC_TYPE,
    aliases: meta.aliases,
  };
}

function unwrapMarkdownLinks(text: string): string {
  let result = "";
  let cursor = 0;
  let open = text.indexOf("[");
  while (open !== -1) {
    const close = text.indexOf("]", open + 1);
    if (close === -1) break;
    if (text.charAt(close + 1) !== "(") {
      open = text.indexOf("[", close + 1);
      continue;
    }
    const end = text.indexOf(")", close + 2);
    if (end === -1) break;
    const start = open > cursor && text.charAt(open - 1) === "!" ? open - 1 : open;
    result += `${text.slice(cursor, start)}${text.slice(open + 1, close)}`;
    cursor = end + 1;
    open = text.indexOf("[", cursor);
  }
  return `${result}${text.slice(cursor)}`;
}

function githubSlug(heading: string): string {
  const unwrapped = heading
    .toLowerCase()
    .replace(/\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/g, (_match, target: string, label: string | undefined) => label ?? target);
  return unwrapMarkdownLinks(unwrapped)
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

function anchorSlugger(): (heading: string) => string {
  const seen = new Map<string, number>();
  return (heading) => {
    const base = githubSlug(heading);
    let anchor = base;
    while (seen.has(anchor)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      anchor = `${base}-${count}`;
    }
    seen.set(anchor, 0);
    return anchor;
  };
}

export interface HeadingAnchor {
  text: string;
  level: number;
  anchor: string;
}

type AnchoredHeading = Heading & { anchor: string };

function withAnchors(headings: readonly Heading[]): AnchoredHeading[] {
  const anchor = anchorSlugger();
  return headings.map((heading) => ({ ...heading, anchor: anchor(heading.text) }));
}

export function headingSlug(text: string): string {
  return githubSlug(text.trim());
}

export function headingAnchors(content: string): HeadingAnchor[] {
  const { headings } = outline(lineTexts(content.slice(frontmatterEnd(content))));
  return withAnchors(headings).map(({ text, level, anchor }) => ({ text, level, anchor }));
}

export interface HeadingLine extends HeadingAnchor {
  line: number;
}

export function headingLines(content: string): HeadingLine[] {
  const start = frontmatterEnd(content);
  const offset = start === 0 ? 0 : lineTexts(content.slice(0, start)).length - 1;
  const { headings } = outline(lineTexts(content.slice(start)));
  return withAnchors(headings).map(({ text, level, anchor, line }) => ({ text, level, anchor, line: line + offset }));
}

export function headingLineForAnchor(content: string, anchor: string): number | null {
  const headings = headingLines(content);
  const exact = headings.find((heading) => heading.anchor === anchor);
  if (exact !== undefined) return exact.line;
  const loose = slugify(anchor);
  return headings.find((heading) => slugify(heading.text) === loose)?.line ?? null;
}

export function anchorForHeading(headings: readonly string[], heading: string): string {
  const key = headingKey(heading);
  const anchor = anchorSlugger();
  for (const text of headings) {
    const candidate = anchor(text);
    if (headingKey(text) === key) return candidate;
  }
  return headingSlug(heading);
}

function sectionBody(texts: readonly string[], from: number, to: number): string {
  return trimBlankLines(texts.slice(from, to)).join("\n");
}

function unsortedLines(texts: readonly string[]): { rule: number; marker: number } | null {
  const { inCode } = scanCode(texts);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    if (inCode[index] === true || (texts[index] ?? "").trim() !== UNSORTED_MARKER) continue;
    let above = index - 1;
    while (above >= 0 && (texts[above] ?? "").trim() === "") above -= 1;
    return { rule: above >= 0 && inCode[above] !== true && (texts[above] ?? "").trim() === "---" ? above : index, marker: index };
  }
  return null;
}

export function splitSections(body: string): DocSection[] {
  const all = lineTexts(body);
  const divider = unsortedLines(all);
  const texts = divider === null ? all : all.slice(0, divider.rule);
  const sections = splitOrganized(texts);
  if (divider === null) return sections;
  const unsorted = sectionBody(all, divider.marker + 1, all.length);
  if (unsorted === "") return sections;
  const anchor = anchorForHeading(sections.map((section) => section.heading).filter((heading) => heading !== ""), DEFAULT_HEADING);
  return [...sections, { heading: DEFAULT_HEADING, headingPath: DEFAULT_HEADING, anchor, level: 1, ord: sections.length, body: unsorted }];
}

function splitOrganized(texts: readonly string[]): DocSection[] {
  const headings = withAnchors(outline(texts).headings);
  const sections: DocSection[] = [];
  const preamble = sectionBody(texts, 0, headings[0]?.line ?? texts.length);
  if (preamble !== "") sections.push({ heading: "", headingPath: "", anchor: "", level: 0, ord: 0, body: preamble });
  const trail: Heading[] = [];
  headings.forEach((heading, index) => {
    while ((trail.at(-1)?.level ?? 0) >= heading.level) trail.pop();
    trail.push(heading);
    sections.push({
      heading: heading.text,
      headingPath: trail.map((entry) => entry.text).join(" > "),
      anchor: heading.anchor,
      level: heading.level,
      ord: sections.length,
      body: sectionBody(texts, heading.line + 1, headings[index + 1]?.line ?? texts.length),
    });
  });
  return sections;
}

export function listHeadings(content: string): string[] {
  const seen = new Set<string>();
  return outline(lineTexts(content.slice(frontmatterEnd(content)))).headings.flatMap((heading) => {
    const key = headingKey(heading.text);
    if (seen.has(key)) return [];
    seen.add(key);
    return [heading.text];
  });
}

function blockLines(block: string): string[] {
  const lines = trimBlankLines(block.split(/\r?\n/));
  const { open } = scanCode(lines);
  return open === null ? lines : [...lines, fenceCloser(open)];
}

function closedTail(text: string, open: Fence | null, eol: string): string {
  const trimmed = trimTrailingBlankLines(text);
  return open === null || trimmed === "" ? trimmed : `${trimmed}${eol}${fenceCloser(open)}`;
}

function leadAfterFrontmatter(frontmatter: string, eol: string): string {
  if (frontmatter === "") return "";
  return frontmatter.endsWith("\n") ? eol : `${eol}${eol}`;
}

function appendSection(body: string, open: Fence | null, heading: string, text: string, lead: string, eol: string): string {
  const section = `## ${heading}${eol}${eol}${text}${eol}`;
  const base = closedTail(body, open, eol);
  return base === "" ? `${lead}${section}` : `${base}${eol}${eol}${section}`;
}

export const UNSORTED_MARKER = "<!-- wiki:unsorted -->";

function isUnsortedHeading(heading: string): boolean {
  return headingKey(heading) === headingKey(DEFAULT_HEADING);
}

function findUnsortedDivider(body: string): number | null {
  const lines = scanLines(body);
  const { inCode } = scanCode(lines.map((line) => line.text));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || inCode[index] === true || line.text.trim() !== UNSORTED_MARKER) continue;
    let above = index - 1;
    while (above >= 0 && (lines[above]?.text.trim() ?? "") === "") above -= 1;
    const rule = lines[above];
    return rule !== undefined && inCode[above] !== true && rule.text.trim() === "---" ? rule.start : line.start;
  }
  return null;
}

function unsortedRule(eol: string): string {
  return `---${eol}${eol}${UNSORTED_MARKER}`;
}

function appendUnsorted(body: string, text: string, lead: string, eol: string): string {
  const { open } = outline(lineTexts(body));
  const base = closedTail(body, open, eol);
  if (findUnsortedDivider(body) !== null) return `${base}${eol}${eol}${text}${eol}`;
  const rule = `${unsortedRule(eol)}${eol}${eol}${text}${eol}`;
  return base === "" ? `${lead}${rule}` : `${base}${eol}${eol}${rule}`;
}

function insertIntoBody(body: string, heading: string, text: string, lead: string, eol: string): string {
  if (isUnsortedHeading(heading)) return appendUnsorted(body, text, lead, eol);
  const divider = findUnsortedDivider(body);
  if (divider === null) return insertOrganized(body, heading, text, lead, eol);
  const organized = insertOrganized(body.slice(0, divider), heading, text, lead, eol);
  return `${trimTrailingBlankLines(organized)}${eol}${eol}${body.slice(divider)}`;
}

export function moveUnsortedBelowRule(content: string): string {
  const eol = eolOf(content);
  const head = frontmatterEnd(content);
  const frontmatter = content.slice(0, head);
  const body = content.slice(head);
  const divider = findUnsortedDivider(body);
  const organized = divider === null ? body : body.slice(0, divider);
  const lines = scanLines(organized);
  const { headings } = outline(lines.map((line) => line.text));
  const targets = headings.filter((heading) => isUnsortedHeading(heading.text));
  if (targets.length === 0) return content;
  const removed = new Set<number>();
  const moved: string[] = [];
  for (const target of targets) {
    if (removed.has(target.line)) continue;
    const next = headings.find((entry) => entry.line > target.line && entry.level <= target.level);
    const end = next?.line ?? lines.length;
    const texts = lines.slice(target.line + 1, end).map((line) => line.text);
    while (texts.length > 0 && (texts[0] ?? "").trim() === "") texts.shift();
    while (texts.length > 0 && (texts.at(-1) ?? "").trim() === "") texts.pop();
    if (texts.length > 0) moved.push(texts.join(eol));
    for (let index = target.line; index < end; index += 1) removed.add(index);
  }
  const bom = head === 0 && content.startsWith("﻿") ? "﻿" : "";
  const kept = trimTrailingBlankLines(lines.filter((_, index) => !removed.has(index)).map((line) => line.text).join(eol));
  const tail = divider === null ? unsortedRule(eol) : trimTrailingBlankLines(body.slice(divider));
  const parts = [kept, tail, ...moved].filter((part) => part !== "");
  return `${frontmatter}${bom}${parts.join(`${eol}${eol}`)}${eol}`;
}

function insertOrganized(body: string, heading: string, text: string, lead: string, eol: string): string {
  const lines = scanLines(body);
  const { headings, open } = outline(lines.map((line) => line.text));
  const key = headingKey(headingOf(`## ${heading}`, 0)?.text ?? heading);
  const target = headings.find((entry) => headingKey(entry.text) === key);
  if (target === undefined) return appendSection(body, open, heading, text, lead, eol);
  const next = headings.find((entry) => entry.line > target.line && entry.level <= target.level);
  const at = next === undefined ? undefined : lines[next.line]?.start;
  if (at === undefined) return `${closedTail(body, open, eol)}${eol}${eol}${text}${eol}`;
  return `${trimTrailingBlankLines(body.slice(0, at))}${eol}${eol}${text}${eol}${eol}${body.slice(at)}`;
}

export function insertUnderHeading(content: string, heading: string, block: string): string {
  const eol = eolOf(content);
  const lines = blockLines(block);
  if (lines.length === 0) return content;
  const head = frontmatterEnd(content);
  const frontmatter = content.slice(0, head);
  const label = cleanLine(heading) || DEFAULT_HEADING;
  return `${frontmatter}${insertIntoBody(content.slice(head), label, lines.join(eol), leadAfterFrontmatter(frontmatter, eol), eol)}`;
}

function flowList(items: readonly string[]): string {
  return new Document([...items], { flow: true }).toString(FLOW_OPTIONS).trimEnd();
}

function aliasesPair(document: Document.Parsed): Pair<unknown, unknown> | null | undefined {
  const contents = document.contents;
  if (contents === null) return null;
  if (!isMap(contents) || contents.flow === true) return undefined;
  return contents.items.find((pair) => isScalar(pair.key) && pair.key.value === "aliases") ?? null;
}

function appendAliasLine(source: string, line: string, eol: string): string {
  if (source === "") return `${line}${eol}`;
  return source.endsWith("\n") ? `${source}${line}${eol}` : `${source}${eol}${line}${eol}`;
}

function replaceAliasPair(source: string, pair: Pair<unknown, unknown>, line: string): string | null {
  const keyStart = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  const valueEnd = isNode(pair.value) ? pair.value.range?.[1] : undefined;
  if (keyStart === undefined || valueEnd === undefined || valueEnd < keyStart) return null;
  const value = source.slice(keyStart, valueEnd);
  const trailing = value.slice(value.trimEnd().length);
  return `${source.slice(0, keyStart)}${line}${trailing}${source.slice(valueEnd)}`;
}

function spliceAliases(source: string, items: readonly string[], eol: string): string | null {
  const pair = aliasesPair(parseDocument(source));
  if (pair === undefined) return null;
  const line = `aliases: ${flowList(items)}`;
  return pair === null ? appendAliasLine(source, line, eol) : replaceAliasPair(source, pair, line);
}

function withoutAliases(data: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(Object.entries(data).filter(([key]) => key !== "aliases"));
  } catch {
    return null;
  }
}

function keepsOtherKeys(before: Record<string, unknown>, source: string, items: readonly string[]): boolean {
  const after = parseYamlMapping(source);
  const others = withoutAliases(before);
  if (after === null || others === null) return false;
  const expected = normalizeTags(items);
  const actual = normalizeTags(aliasItems(after.aliases));
  return others === withoutAliases(after) && JSON.stringify(actual) === JSON.stringify(expected);
}

function stringifyAliases(source: string, items: readonly string[], tag: string, eol: string): string {
  const document = parseDocument(source);
  const current = document.get("aliases", true);
  if (isSeq(current)) current.add(document.createNode(tag));
  else document.set("aliases", document.createNode([...items, tag], { flow: true }));
  return document.toString(FLOW_OPTIONS).replace(/\r?\n/g, eol);
}

function rewriteAliases(block: Frontmatter, items: readonly string[], tag: string, eol: string): string {
  const next = [...items, tag];
  const spliced = spliceAliases(block.source, next, eol);
  if (spliced !== null && keepsOtherKeys(block.data, spliced, next)) return spliced;
  return stringifyAliases(block.source, items, tag, eol);
}

function prependFrontmatter(content: string, alias: string): string {
  const eol = eolOf(content);
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const rest = content.slice(bom.length);
  const gap = rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n") ? "" : eol;
  return `${bom}---${eol}aliases: ${flowList([alias])}${eol}---${eol}${gap}${rest}`;
}

export function addAlias(content: string, alias: string): string {
  const tag = normalizeTag(alias);
  if (tag === "") return content;
  const block = readFrontmatter(content);
  if (block === null) return prependFrontmatter(content, tag);
  const existing = aliasItems(block.data.aliases);
  if (normalizeTags(existing).includes(tag)) return content;
  const source = rewriteAliases(block, existing, tag, eolOf(content));
  return `${content.slice(0, block.sourceStart)}${source}${content.slice(block.sourceEnd)}`;
}

function withTitle(content: string, title: string): string {
  const block = readFrontmatter(content);
  const eol = eolOf(content);
  if (block === null) {
    const bom = content.startsWith("﻿") ? "﻿" : "";
    const rest = content.slice(bom.length);
    const gap = rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n") ? "" : eol;
    const meta = new Document({ title }).toString(FLOW_OPTIONS).replace(/\r?\n/g, eol);
    return `${bom}---${eol}${meta}---${eol}${gap}${rest}`;
  }
  const document = parseDocument(block.source);
  document.set("title", title);
  const source = document.toString(FLOW_OPTIONS).replace(/\r?\n/g, eol);
  return `${content.slice(0, block.sourceStart)}${source}${content.slice(block.sourceEnd)}`;
}

function withRenamedH1(content: string, oldTitle: string, title: string): string {
  const start = frontmatterEnd(content);
  const body = content.slice(start);
  const lines = scanLines(body);
  const heading = outline(lines.map((line) => line.text)).headings.find((entry) => entry.level === 1);
  if (heading === undefined || headingKey(heading.text) !== headingKey(oldTitle)) return content;
  const line = lines[heading.line];
  if (line === undefined) return content;
  const end = line.start + line.text.length;
  return `${content.slice(0, start)}${body.slice(0, line.start)}# ${title}${body.slice(end)}`;
}

export function renameDocContent(content: string, input: { oldTitle: string; title: string; keepAliases: readonly string[] }): string {
  const title = cleanLine(input.title) || "Untitled";
  const renamed = withRenamedH1(withTitle(content, title), input.oldTitle, title);
  return input.keepAliases.reduce((next, alias) => addAlias(next, alias), renamed);
}

export function newDocContent(input: NewDocInput): string {
  const title = cleanLine(input.title) || "Untitled";
  const meta = new Document({ title, type: input.type, aliases: normalizeTags(input.aliases) });
  const aliases = meta.get("aliases", true);
  if (isSeq(aliases)) aliases.flow = true;
  return `---\n${meta.toString(FLOW_OPTIONS)}---\n\n# ${title}\n`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&"<>\n\r\t]/g, (char) => ATTR_ESCAPES[char] ?? char);
}

function decodeEntity(match: string, name: string): string {
  const named = NAMED_ENTITIES[name];
  if (named !== undefined) return named;
  const code = Number.parseInt(name.slice(1), 10);
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

function decodeAttr(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|#\d{1,7});/g, decodeEntity);
}

function attr(name: string, value: string): string {
  return `${name}="${escapeAttr(value)}"`;
}

function titleAttr(title: string | null): string[] {
  return title === null ? [] : [attr("title", title)];
}

function markerAttrs(source: SourceMarker): string[] {
  switch (source.kind) {
    case "notes":
      return [attr("notes", source.notePath), attr("date", source.noteDate)];
    case "thread":
      return [attr("thread", source.threadId), ...titleAttr(source.title)];
    case "agent":
      return ["agent", attr("thread", source.threadId), ...titleAttr(source.title)];
    case "upload":
      return [attr("upload", source.name)];
    case "manual":
      return ["manual"];
  }
}

export function formatSourceMarker(source: SourceMarker): string {
  return `<!-- ${MARKER_KEYWORD} ${[...markerAttrs(source), attr("added", source.added)].join(" ")} -->`;
}

function markerAttributes(inner: string): Map<string, string | null> {
  const attrs = new Map<string, string | null>();
  for (const match of inner.matchAll(MARKER_ATTR)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && !attrs.has(name)) attrs.set(name, match[2] === undefined ? null : decodeAttr(match[2]));
  }
  return attrs;
}

function markerCandidate(attrs: Map<string, string | null>): unknown {
  const text = (name: string) => attrs.get(name) ?? undefined;
  const added = text("added") ?? "";
  const title = text("title") || null;
  if (attrs.has("notes")) return { kind: "notes", notePath: text("notes"), noteDate: text("date") ?? "", added };
  if (attrs.has("agent")) return { kind: "agent", threadId: text("thread"), title, added };
  if (attrs.has("thread")) return { kind: "thread", threadId: text("thread"), title, added };
  if (attrs.has("upload")) return { kind: "upload", name: text("upload"), added };
  if (attrs.has("manual")) return { kind: "manual", added };
  return null;
}

function markerAt(text: string): SourceMarker | null {
  const inner = MARKER_LINE.exec(text)?.[1];
  if (inner === undefined) return null;
  const parsed = sourceMarkerSchema.safeParse(markerCandidate(markerAttributes(inner)));
  return parsed.success ? parsed.data : null;
}

function bodyStartLine(lines: readonly Line[], head: number): number {
  if (head === 0) return 0;
  const index = lines.findIndex((line) => line.start >= head);
  return index === -1 ? lines.length : index;
}

export function parseSourceMarkers(content: string): SourceMarkerLine[] {
  const lines = scanLines(content);
  const from = bodyStartLine(lines, frontmatterEnd(content));
  const { inCode } = scanCode(lines.slice(from).map((line) => line.text));
  return lines.flatMap((line, index) => {
    const source = index < from || inCode[index - from] === true ? null : markerAt(line.text);
    return source === null ? [] : [{ line: index, source }];
  });
}

function isMarkerPrefix(rest: string): boolean {
  const head = rest.trimStart();
  return MARKER_KEYWORD.startsWith(head) || head.startsWith(MARKER_KEYWORD);
}

function isMarkerSuffix(rest: string): boolean {
  return rest.trimEnd().endsWith('"') && (CUT_IN_VALUE.test(rest) || CUT_IN_NAME.test(rest));
}

function markerKeywordEnd(line: string, open: number): number {
  const at = skipInlineSpace(line, open + 4);
  const end = at + MARKER_KEYWORD.length;
  return line.startsWith(MARKER_KEYWORD, at) && !WORD_CHAR.test(line.charAt(end)) ? end : -1;
}

function stripInlineMarkers(line: string): string {
  let result = "";
  let cursor = 0;
  let open = line.indexOf("<!--");
  while (open !== -1) {
    const keyword = markerKeywordEnd(line, open);
    if (keyword === -1) {
      open = line.indexOf("<!--", open + 1);
      continue;
    }
    const close = line.indexOf("-->", keyword);
    if (close === -1) break;
    result += line.slice(cursor, open);
    cursor = close + 3;
    open = line.indexOf("<!--", cursor);
  }
  return `${result}${line.slice(cursor)}`;
}

export function stripSourceMarkers(text: string): string {
  return text
    .replace(MARKER_LINES, "")
    .split("\n")
    .map(stripInlineMarkers)
    .join("\n")
    .replace(SNIPPET_HEAD, (match, rest: string) => (isMarkerSuffix(rest) ? "…" : match))
    .replace(SNIPPET_TAIL, (match, rest: string) => (isMarkerPrefix(rest) ? "…" : match));
}

function noteLabel(notePath: string, noteDate: string): string {
  const date = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(noteDate);
  if (date !== null) return `${date[2]}-${date[3]}-${date[1]}`;
  return baseName(notePath) || "daily";
}

function quotedTitle(title: string): string {
  return `“${truncate(cleanLine(title), MARKER_TITLE_LIMIT)}”`;
}

export function describeSourceMarker(source: SourceMarker): string {
  switch (source.kind) {
    case "notes":
      if (source.noteDate === "" && !/\d{1,2}-\d{2}-\d{2}\.md$/.test(source.notePath)) return `from ${source.notePath}`;
      return `from ${noteLabel(source.notePath, source.noteDate)} notes`;
    case "thread":
      return source.title ? `from thread ${quotedTitle(source.title)}` : "from a thread";
    case "agent":
      return source.title ? `from agent in ${quotedTitle(source.title)}` : "from an agent";
    case "upload":
      return `uploaded ${source.name}`;
    case "manual":
      return "added manually";
  }
}

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function blankSpans(text: string, spans: readonly Span[]): string {
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += `${text.slice(cursor, span.start)}${blank(text.slice(span.start, span.end))}`;
    cursor = span.end;
  }
  return `${result}${text.slice(cursor)}`;
}

function pairRuns(runs: readonly Span[], spans: Span[]): void {
  const latest = new Map<number, number>();
  const partners = runs.map(() => -1);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run === undefined) continue;
    partners[index] = latest.get(run.end - run.start) ?? -1;
    latest.set(run.end - run.start, index);
  }
  for (let index = 0; index < runs.length; index += 1) {
    const partner = partners[index] ?? -1;
    const open = runs[index];
    const close = runs[partner];
    if (open === undefined || close === undefined) continue;
    spans.push({ start: open.start, end: close.end });
    index = partner;
  }
}

function inlineCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  let runs: Span[] = [];
  for (const match of text.matchAll(TICKS_OR_BREAK)) {
    if (match[0].startsWith("`")) {
      runs.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    pairRuns(runs, spans);
    runs = [];
  }
  pairRuns(runs, spans);
  return spans;
}

function commentSpans(text: string): Span[] {
  const spans: Span[] = [];
  let open = text.indexOf("<!--");
  while (open !== -1) {
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    spans.push({ start: open, end: close + 3 });
    open = text.indexOf("<!--", close + 3);
  }
  return spans;
}

function maskCode(text: string): string {
  const { inCode } = scanCode(lineTexts(text));
  const fenced = text
    .split("\n")
    .map((line, index) => (inCode[index] === true ? blank(line) : line))
    .join("\n");
  const inline = blankSpans(fenced, inlineCodeSpans(fenced));
  return blankSpans(inline, commentSpans(inline));
}

function wikiLinkFrom(raw: string, index: number): WikiLink | null {
  const embed = raw.startsWith("!");
  const inner = raw.slice(embed ? 3 : 2, -2);
  const pipe = inner.indexOf("|");
  const path = (pipe === -1 ? inner : inner.slice(0, pipe)).replace(/\\$/, "");
  const label = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  const hash = path.indexOf("#");
  const target = (hash === -1 ? path : path.slice(0, hash)).trim();
  const heading = hash === -1 ? null : path.slice(hash + 1).trim() || null;
  return target === "" ? null : { raw, target, heading, label, embed, index };
}

export function extractWikiLinks(text: string): WikiLink[] {
  return [...maskCode(text).matchAll(WIKI_LINK)].flatMap((match) => {
    const link = wikiLinkFrom(text.slice(match.index, match.index + match[0].length), match.index);
    return link === null ? [] : [link];
  });
}

function decodeTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function isLocalTarget(target: string): boolean {
  return target !== "" && !NON_LOCAL_TARGET.test(target);
}

function isEmbeddedMedia(target: string): boolean {
  const kind = mediaKindOf(target);
  return kind === "image" || kind === "video";
}

function markdownImageRef(match: RegExpExecArray): ImageRef | null {
  const span = match.indices?.[1];
  const raw = match[1];
  if (span === undefined || raw === undefined) return null;
  const angle = raw.startsWith("<");
  const target = decodeTarget(angle ? raw.slice(1, -1).trim() : raw);
  if (!isLocalTarget(target)) return null;
  return { target, start: span[0], end: span[1], style: angle ? "angle" : "markdown" };
}

function embedImageRef(match: RegExpExecArray): ImageRef | null {
  const span = match.indices?.[1];
  const raw = match[1];
  if (span === undefined || raw === undefined) return null;
  const target = raw.trim();
  if (!isLocalTarget(target) || !isEmbeddedMedia(target)) return null;
  const start = span[0] + raw.length - raw.trimStart().length;
  return { target, start, end: start + target.length, style: "embed" };
}

function imageRefs(text: string): ImageRef[] {
  const masked = maskCode(text);
  const refs = [
    ...[...masked.matchAll(MARKDOWN_IMAGE)].map(markdownImageRef),
    ...[...masked.matchAll(EMBED_IMAGE)].map(embedImageRef),
  ];
  return refs.flatMap((ref) => (ref === null ? [] : [ref])).sort((left, right) => left.start - right.start);
}

function formatTarget(ref: ImageRef, target: string): string {
  if (ref.style === "embed") return target;
  return ref.style === "angle" || /[\s<>()]/.test(target) ? `<${target}>` : target;
}

export function extractImageTargets(text: string): string[] {
  return [...new Set(imageRefs(text).map((ref) => ref.target))];
}

export function rewriteImageTargets(text: string, map: (target: string) => string | null): string {
  let result = "";
  let cursor = 0;
  for (const ref of imageRefs(text)) {
    if (ref.start < cursor) continue;
    const next = map(ref.target);
    if (next === null || next === ref.target) continue;
    result += `${text.slice(cursor, ref.start)}${formatTarget(ref, next)}`;
    cursor = ref.end;
  }
  return `${result}${text.slice(cursor)}`;
}

function sharedPrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

export function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => !isBlank(line)).map((line) => /^[ \t]*/.exec(line)?.[0] ?? "");
  const first = indents[0];
  if (first === undefined) return lines.map(() => "");
  const prefix = indents.reduce(sharedPrefix, first);
  return lines.map((line) => (isBlank(line) ? "" : line.slice(prefix.length)));
}
