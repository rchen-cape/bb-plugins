import type { DocSummary } from "../contract";
import { mediaKindOf } from "../lib/wiki";
import { normalizeTag, slugify } from "../lib/slug";
import { MARKER_LINE, UNSORTED_MARKER, anchorForHeading, headingAnchors, headingSlug } from "../lib/markdown-doc";
import { assetUrl } from "./hooks";

export interface LinkTarget {
  slug: string;
  title: string;
  headings: readonly string[];
}

export interface RenderOptions {
  pluginId: string;
  resolve: (target: string) => LinkTarget | null;
  docSlug?: string;
  title?: string;
}

interface RenderContext extends RenderOptions {
  ownHeadings: readonly string[];
}

export interface WikiLink {
  target: string;
  heading: string | null;
  label: string | null;
}

type Seek = (from: number) => number;

interface ImageScan {
  text: string;
  alt: Seek;
  space: Seek;
  angle: Seek;
  plain: Seek;
  quote: Seek;
}

interface ImageTail {
  end: number;
  target: string;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const WIKI_LINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const IMAGE_ALT_GAPS = /[^\]\n]+/g;
const SPACE_GAPS = /\s+/g;
const ANGLE_GAPS = /[^>\n]+/g;
const PATH_GAPS = /[^)\s]+/g;
const TITLE_GAPS = /[^"\n]+/g;
const MEDIA_TAG = /<(?:video|img|source)\b/gi;
const SRC_ATTR = /\bsrc=/gi;
const TAG_GAPS = /[^>]+/g;
const VALUE_GAPS = /[^"]+/g;
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
const ATTRIBUTE = /([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi;

export const WIKI_HREF_PREFIX = "#wiki/";
export const THREAD_HREF_PREFIX = "#wiki-thread/";

export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER.exec(content);
  return match === null ? content.replace(/^﻿/, "") : content.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function parseWikiLink(inner: string): WikiLink {
  const pipe = inner.indexOf("|");
  const reference = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  const hash = reference.indexOf("#");
  const target = (hash === -1 ? reference : reference.slice(0, hash)).trim();
  const heading = hash === -1 ? null : reference.slice(hash + 1).trim() || null;
  return { target, heading, label };
}

function titleKey(text: string): string {
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

function titleHeading(line: string): string | null {
  let at = 0;
  while (at < 3 && line.charAt(at) === " ") at += 1;
  if (line.charAt(at) !== "#" || !isInlineSpace(line.charAt(at + 1)) || LINE_BREAK.test(line)) return null;
  let start = at + 1;
  while (isInlineSpace(line.charAt(start))) start += 1;
  const end = trimInlineEnd(line, line.length, start);
  let hashes = end;
  while (hashes > start && line.charAt(hashes - 1) === "#") hashes -= 1;
  const cut = trimInlineEnd(line, hashes, start);
  return line.slice(start, hashes < end && cut < hashes ? cut : end);
}

function titleLineEnd(lines: readonly string[], title: string | undefined): { start: number; end: number } | null {
  if (title === undefined) return null;
  const start = lines.findIndex((line) => line.trim() !== "");
  const heading = start === -1 ? null : titleHeading(lines[start] ?? "");
  if (heading === null || titleKey(heading) !== titleKey(title)) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] ?? "").trim() === "") end += 1;
  return { start, end };
}

export function dropLeadingTitle(body: string, title: string | undefined): string {
  const lines = body.split(/\r?\n/);
  const span = titleLineEnd(lines, title);
  return span === null ? body : [...lines.slice(0, span.start), ...lines.slice(span.end)].join("\n");
}

function shownHeadings(content: string, title: string | undefined) {
  const headings = headingAnchors(content);
  return titleLineEnd(stripFrontmatter(content).split(/\r?\n/), title) === null ? headings : headings.slice(1);
}

export function renderedHeadingIndex(content: string, anchor: string, rendered: readonly string[], title?: string): number {
  const headings = shownHeadings(content, title);
  const index = headings.findIndex((heading) => heading.anchor === anchor);
  const wanted = headings[index];
  if (wanted === undefined) {
    const loose = slugify(anchor);
    return rendered.findIndex((text) => slugify(text) === loose);
  }
  if (rendered.length === headings.length) return index;
  const slug = headingSlug(wanted.text);
  const occurrence = headings.slice(0, index).filter((heading) => headingSlug(heading.text) === slug).length;
  const matches = rendered.flatMap((text, position) => (headingSlug(text) === slug ? [position] : []));
  return matches[occurrence] ?? -1;
}

function encodeSlug(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

export function wikiHref(slug: string, anchor: string | null = null): string {
  return `${WIKI_HREF_PREFIX}${encodeSlug(slug)}${anchor === null || anchor === "" ? "" : `#${encodeURIComponent(anchor)}`}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseWikiHref(href: string): { slug: string; anchor: string | null } | null {
  if (!href.startsWith(WIKI_HREF_PREFIX)) return null;
  const rest = href.slice(WIKI_HREF_PREFIX.length);
  const hash = rest.indexOf("#");
  const slug = safeDecode(hash === -1 ? rest : rest.slice(0, hash));
  if (slug === "") return null;
  const anchor = hash === -1 ? null : safeDecode(rest.slice(hash + 1)) || null;
  return { slug, anchor };
}

export function parseThreadHref(href: string): string | null {
  if (!href.startsWith(THREAD_HREF_PREFIX)) return null;
  const id = safeDecode(href.slice(THREAD_HREF_PREFIX.length));
  return id === "" ? null : id;
}

export function createResolver(docs: readonly DocSummary[]): (target: string) => LinkTarget | null {
  const bySlug = new Map<string, DocSummary>();
  const byTitle = new Map<string, DocSummary>();
  const byAlias = new Map<string, DocSummary>();
  const byTag = new Map<string, DocSummary>();
  const remember = (map: Map<string, DocSummary>, key: string, doc: DocSummary) => {
    if (key !== "" && !map.has(key)) map.set(key, doc);
  };
  for (const doc of docs) {
    remember(bySlug, doc.slug.toLowerCase(), doc);
    remember(byTitle, doc.title.trim().toLowerCase(), doc);
    for (const alias of doc.aliases) remember(byAlias, alias.trim().toLowerCase(), doc);
    remember(byTag, doc.tag.toLowerCase(), doc);
  }
  return (target) => {
    const key = target.trim().toLowerCase();
    if (key === "") return null;
    const tag = normalizeTag(target);
    const doc = bySlug.get(key) ?? byTitle.get(key) ?? byAlias.get(key) ?? byAlias.get(tag) ?? byTag.get(tag) ?? null;
    return doc === null ? null : { slug: doc.slug, title: doc.title, headings: doc.headings };
  };
}

export function noteDateLabel(isoDate: string): string {
  const match = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? isoDate : `${match[2]}-${match[3]}-${match[1]}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&" };

function decodeEntity(match: string, name: string): string {
  const named = NAMED_ENTITIES[name];
  if (named !== undefined) return named;
  const code = name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

function decodeEntities(text: string): string {
  return text.replace(/&(quot|lt|gt|amp|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, decodeEntity);
}

function escapeLabel(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

export function parseMarkerAttributes(body: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of body.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name !== undefined && !attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? ""));
  }
  return attributes;
}

function noteNameDate(notePath: string): string | null {
  const match = /(\d{1,2})-(\d{2})-(\d{2})\.md$/.exec(notePath);
  return match === null ? null : `${(match[1] ?? "").padStart(2, "0")}-${match[2]}-${match[3]}`;
}

function threadLink(attributes: Map<string, string>): string {
  const thread = attributes.get("thread") ?? "";
  const title = (attributes.get("title") ?? "").replace(/\s+/g, " ").trim() || "a thread";
  const label = `“${escapeHtml(title)}”`;
  return thread === "" ? label : `<a href="${THREAD_HREF_PREFIX}${encodeURIComponent(thread)}">${label}</a>`;
}

export function sourceMarkerHtml(attributes: Map<string, string>): string {
  let label: string;
  if (attributes.has("notes")) {
    const date = attributes.get("date");
    const day = date === undefined || date === "" ? noteNameDate(attributes.get("notes") ?? "") : noteDateLabel(date);
    const file = attributes.get("notes") ?? "";
    label = day !== null ? `from ${day} notes` : file === "" ? "from daily notes" : `from ${escapeHtml(file)}`;
  } else if (attributes.has("agent")) {
    label = `from an agent in ${threadLink(attributes)}`;
  } else if (attributes.has("thread")) {
    label = `from ${threadLink(attributes)}`;
  } else if (attributes.has("upload")) {
    label = `from ${escapeHtml(attributes.get("upload") || "an upload")}`;
  } else {
    label = "added by hand";
  }
  const added = attributes.get("added");
  const title = added === undefined || added === "" ? "" : ` title="Added ${escapeHtml(added)}"`;
  return `<sub${title}>${label}</sub>`;
}

function dirnameOf(slug: string | undefined): string {
  if (slug === undefined) return "";
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? "" : slug.slice(0, slash);
}

export function resolveAssetPath(path: string, docSlug?: string): string {
  const clean = path.replace(/^<|>$/g, "").split(/[?#]/)[0] ?? "";
  const decoded = safeDecode(clean);
  if (decoded.startsWith("assets/")) return decoded;
  const base = dirnameOf(docSlug);
  const parts = base === "" ? [] : base.split("/");
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function mediaUrl(options: RenderOptions, relPath: string): string {
  return assetUrl(options.pluginId, relPath).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function embedMarkup(options: RenderOptions, relPath: string, alt: string): string {
  const url = mediaUrl(options, relPath);
  const kind = mediaKindOf(relPath);
  if (kind === "video") return `<video controls src="${escapeHtml(url)}"></video>`;
  if (kind === "image") return `![${escapeLabel(alt)}](${url})`;
  return `[${escapeLabel(alt)}](${url})`;
}

function embedPath(target: string): string {
  return target.includes("/") ? target : `assets/${target}`;
}

function renderWikiLink(options: RenderContext, embed: boolean, inner: string): string {
  if (embed) {
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const alt = pipe === -1 ? target : inner.slice(pipe + 1).trim();
    return embedMarkup(options, resolveAssetPath(embedPath(target), options.docSlug), alt);
  }
  const link = parseWikiLink(inner);
  const fallback = link.heading === null ? link.target : link.target === "" ? link.heading : `${link.target} › ${link.heading}`;
  const label = link.label ?? fallback;
  const resolved =
    link.target === "" && options.docSlug !== undefined ? { slug: options.docSlug, title: "", headings: options.ownHeadings } : options.resolve(link.target);
  if (resolved === null) {
    return `<span title="${escapeHtml(`No Wiki doc named “${link.target}” yet`)}">${escapeHtml(label)}</span>`;
  }
  const headings = resolved.slug === options.docSlug ? options.ownHeadings : resolved.headings;
  const anchor = link.heading === null ? null : anchorForHeading(headings, link.heading);
  return `[${escapeLabel(label)}](${wikiHref(resolved.slug, anchor)})`;
}

function rewriteMarkdownImage(options: RenderOptions, match: string, alt: string, path: string): string {
  const bare = path.replace(/^<|>$/g, "");
  if (ABSOLUTE_URL.test(bare)) return match;
  return embedMarkup(options, resolveAssetPath(bare, options.docSlug), alt);
}

function rewriteHtmlSrc(options: RenderOptions, prefix: string, path: string): string {
  if (ABSOLUTE_URL.test(path)) return `${prefix}"${path}"`;
  return `${prefix}"${escapeHtml(mediaUrl(options, resolveAssetPath(decodeEntities(path), options.docSlug)))}"`;
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
    plain: seeker(text, PATH_GAPS),
    quote: seeker(text, TITLE_GAPS),
  };
}

function imageClose(scan: ImageScan, end: number): number {
  const gap = scan.space(end);
  if (gap > end && scan.text.charAt(gap) === '"') {
    const close = scan.quote(gap + 1);
    const after = scan.space(close + 1);
    if (scan.text.charAt(close) === '"' && scan.text.charAt(after) === ")") return after + 1;
  }
  return scan.text.charAt(gap) === ")" ? gap + 1 : -1;
}

function imageTail(scan: ImageScan, from: number): ImageTail | null {
  const start = scan.space(from);
  const angled = scan.text.charAt(start) === "<" ? scan.angle(start + 1) : -1;
  if (angled > start + 1 && scan.text.charAt(angled) === ">") {
    const end = imageClose(scan, angled + 1);
    if (end !== -1) return { end, target: scan.text.slice(start, angled + 1) };
  }
  const stop = scan.plain(start);
  const end = stop === start ? -1 : imageClose(scan, stop);
  return end === -1 ? null : { end, target: scan.text.slice(start, stop) };
}

function replaceMarkdownImages(text: string, replace: (match: string, alt: string, path: string) => string): string {
  let open = text.indexOf("![");
  if (open === -1) return text;
  const scan = imageScan(text);
  let output = "";
  let cursor = 0;
  while (open !== -1) {
    const close = scan.alt(open + 2);
    const found = text.startsWith("](", close) ? imageTail(scan, close + 2) : null;
    if (found === null) {
      open = text.indexOf("![", open + 1);
      continue;
    }
    output += `${text.slice(cursor, open)}${replace(text.slice(open, found.end), text.slice(open + 2, close), found.target)}`;
    cursor = found.end;
    open = text.indexOf("![", cursor);
  }
  return `${output}${text.slice(cursor)}`;
}

function replaceHtmlSrc(text: string, replace: (prefix: string, path: string) => string): string {
  const tags = new RegExp(MEDIA_TAG);
  let tag = tags.exec(text);
  if (tag === null) return text;
  const srcs = Array.from(text.matchAll(SRC_ATTR), (match) => match.index);
  const tagEnd = seeker(text, TAG_GAPS);
  const quote = seeker(text, VALUE_GAPS);
  const valueEnd = (src: number): number => {
    const close = quote(src + 5);
    return text.charAt(src + 4) === '"' && close > src + 5 && close < text.length ? close : -1;
  };
  let output = "";
  let cursor = 0;
  let next = 0;
  for (; tag !== null; tag = tags.exec(text)) {
    const from = tag.index + tag[0].length;
    while (next < srcs.length && ((srcs[next] ?? 0) < from || valueEnd(srcs[next] ?? 0) === -1)) next += 1;
    const src = srcs[next];
    if (src === undefined || src >= tagEnd(from)) continue;
    const close = valueEnd(src);
    output += `${text.slice(cursor, tag.index)}${replace(text.slice(tag.index, src + 4), text.slice(src + 5, close))}`;
    cursor = close + 1;
    tags.lastIndex = cursor;
  }
  return `${output}${text.slice(cursor)}`;
}

function renderInline(text: string, options: RenderContext): string {
  const linked = text.replace(WIKI_LINK, (_match, bang: string, inner: string) => renderWikiLink(options, bang === "!", inner));
  const imaged = replaceMarkdownImages(linked, (match, alt, path) => rewriteMarkdownImage(options, match, alt, path));
  return replaceHtmlSrc(imaged, (prefix, path) => rewriteHtmlSrc(options, prefix, path));
}

function closingTicks(line: string, from: number, length: number): number {
  const ticks = /`+/g;
  ticks.lastIndex = from;
  for (let match = ticks.exec(line); match !== null; match = ticks.exec(line)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

export function mapOutsideInlineCode(line: string, transform: (text: string) => string): string {
  const ticks = /`+/g;
  let output = "";
  let plainStart = 0;
  for (let match = ticks.exec(line); match !== null; match = ticks.exec(line)) {
    const length = match[0].length;
    const close = closingTicks(line, match.index + length, length);
    if (close === -1) continue;
    output += transform(line.slice(plainStart, match.index)) + line.slice(match.index, close + length);
    plainStart = close + length;
    ticks.lastIndex = plainStart;
  }
  return output + transform(line.slice(plainStart));
}

interface Fence {
  char: string;
  length: number;
}

function openFence(line: string): Fence | null {
  const match = FENCE.exec(line);
  const marker = match?.[1];
  if (match === null || marker === undefined) return null;
  const info = line.slice(match[0].length);
  if (LINE_BREAK.test(info) || (marker.startsWith("`") && info.includes("`"))) return null;
  return { char: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  const marker = match?.[1];
  return marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length;
}

export function renderDoc(content: string, options: RenderOptions): string {
  const context: RenderContext = { ...options, ownHeadings: headingAnchors(content).map((heading) => heading.text) };
  const lines = dropLeadingTitle(stripFrontmatter(content), options.title).split(/\r?\n/);
  const output: string[] = [];
  let fence: Fence | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== null) {
      output.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = openFence(line);
    if (fence !== null) {
      output.push(line);
      continue;
    }
    if (line.trim() === UNSORTED_MARKER) continue;
    const marker = MARKER_LINE.exec(line);
    if (marker !== null) {
      output.push(sourceMarkerHtml(parseMarkerAttributes(marker[1] ?? "")));
      if ((lines[index + 1] ?? "").trim() !== "") output.push("");
      continue;
    }
    output.push(mapOutsideInlineCode(line, (text) => renderInline(text, context)));
  }
  return output.join("\n");
}
