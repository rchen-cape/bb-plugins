import type { DocSummary } from "../contract";
import { mediaKindOf } from "../lib/wiki";
import { normalizeTag } from "../lib/slug";
import { anchorForHeading } from "../lib/markdown-doc";
import { assetUrl } from "./hooks";

export interface LinkTarget {
  slug: string;
  title: string;
  headings: readonly string[];
}

export interface WikiLink {
  target: string;
  heading: string | null;
  label: string | null;
}

export interface WikiLinkContext {
  resolve: (target: string) => LinkTarget | null;
  docSlug: string;
  ownHeadings: () => readonly string[];
}

export interface WikiLinkView {
  label: string;
  href: string | null;
  missing: string | null;
}

export interface WikiEmbed {
  relPath: string;
  alt: string;
}

export interface MarkerPart {
  text: string;
  threadLink?: string;
}

export interface SourceMarkerLabel {
  parts: MarkerPart[];
  title: string | null;
}

export interface HtmlMedia {
  video: boolean;
  src: string;
  alt: string;
}

export interface TitleSpan {
  start: number;
  end: number;
}

const LINE_BREAK = /[\n\r\u2028\u2029]/;
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
const LOADABLE_URL = /^(?:https?:\/\/|\/(?!\/))/i;
const ATTRIBUTE = /([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi;
const MEDIA_LINE = /^[ \t]*<(video|img)\b([^>]*)>(?:[ \t]*<\/video>)?[ \t]*$/i;

export const WIKI_HREF_PREFIX = "#wiki/";
export const THREAD_HREF_PREFIX = "#wiki-thread/";

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

function isBlank(line: string): boolean {
  return line.trim() === "";
}

export function leadingTitleSpan(line: (index: number) => string | null, title: string): TitleSpan | null {
  let start = 0;
  for (let text = line(start); text !== null && isBlank(text); text = line(start)) start += 1;
  const first = line(start);
  const heading = first === null ? null : titleHeading(first);
  if (heading === null || titleKey(heading) !== titleKey(title)) return null;
  let end = start + 1;
  for (let text = line(end); text !== null && isBlank(text); text = line(end)) end += 1;
  return { start, end };
}

function encodeSlug(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

export function wikiHref(slug: string, anchor: string | null = null): string {
  return `${WIKI_HREF_PREFIX}${encodeSlug(slug)}${anchor === null || anchor === "" ? "" : `#${encodeURIComponent(anchor)}`}`;
}

export function threadHref(threadId: string): string {
  return `${THREAD_HREF_PREFIX}${encodeURIComponent(threadId)}`;
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

export function describeWikiLink(inner: string, context: WikiLinkContext): WikiLinkView {
  const link = parseWikiLink(inner);
  const fallback = link.heading === null ? link.target : link.target === "" ? link.heading : `${link.target} › ${link.heading}`;
  const label = link.label ?? fallback;
  const self = link.target === "";
  const resolved = self ? { slug: context.docSlug, title: "", headings: [] } : context.resolve(link.target);
  if (resolved === null) return { label, href: null, missing: `No Wiki doc named “${link.target}” yet` };
  const headings = self || resolved.slug === context.docSlug ? context.ownHeadings() : resolved.headings;
  const anchor = link.heading === null ? null : anchorForHeading(headings, link.heading);
  return { label, href: wikiHref(resolved.slug, anchor), missing: null };
}

export function embedAssetPath(target: string): string {
  return target.includes("/") ? target : `assets/${target}`;
}

export function describeWikiEmbed(inner: string, docSlug: string): WikiEmbed {
  const pipe = inner.indexOf("|");
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alt = pipe === -1 ? target : inner.slice(pipe + 1).trim();
  return { relPath: resolveAssetPath(embedAssetPath(target), docSlug), alt };
}

export function noteDateLabel(isoDate: string): string {
  const match = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? isoDate : `${match[2]}-${match[3]}-${match[1]}`;
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

function threadPart(attributes: Map<string, string>): MarkerPart {
  const thread = attributes.get("thread") ?? "";
  const title = (attributes.get("title") ?? "").replace(/\s+/g, " ").trim() || "a thread";
  const text = `“${title}”`;
  return thread === "" ? { text } : { text, threadLink: threadHref(thread) };
}

function markerParts(attributes: Map<string, string>): MarkerPart[] {
  if (attributes.has("notes")) {
    const date = attributes.get("date");
    const day = date === undefined || date === "" ? noteNameDate(attributes.get("notes") ?? "") : noteDateLabel(date);
    const file = attributes.get("notes") ?? "";
    return [{ text: day !== null ? `from ${day} notes` : file === "" ? "from daily notes" : `from ${file}` }];
  }
  if (attributes.has("agent")) return [{ text: "from an agent in " }, threadPart(attributes)];
  if (attributes.has("thread")) return [{ text: "from " }, threadPart(attributes)];
  if (attributes.has("upload")) return [{ text: `from ${attributes.get("upload") || "an upload"}` }];
  return [{ text: "added by hand" }];
}

export function sourceMarkerLabel(attributes: Map<string, string>): SourceMarkerLabel {
  const added = attributes.get("added");
  return { parts: markerParts(attributes), title: added === undefined || added === "" ? null : `Added ${added}` };
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

export function mediaUrl(pluginId: string, relPath: string): string {
  return assetUrl(pluginId, relPath).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function markdownImageUrl(pluginId: string, src: string, docSlug: string): string | null {
  const bare = src.replace(/^<|>$/g, "");
  if (ABSOLUTE_URL.test(bare)) return LOADABLE_URL.test(bare) ? bare : null;
  const relPath = resolveAssetPath(bare, docSlug);
  const kind = mediaKindOf(relPath);
  return kind === "image" || kind === "video" ? mediaUrl(pluginId, relPath) : null;
}

function attributeValue(attributes: string, name: string): string | null {
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1]?.toLowerCase() === name && match[2] !== undefined && match[2] !== "") return decodeEntities(match[2]);
  }
  return null;
}

export function htmlMediaLine(line: string): HtmlMedia | null {
  const match = MEDIA_LINE.exec(line);
  const tag = match?.[1];
  const attributes = match?.[2];
  if (tag === undefined || attributes === undefined) return null;
  const src = attributeValue(attributes, "src");
  if (src === null) return null;
  return { video: tag.toLowerCase() === "video", src, alt: attributeValue(attributes, "alt") ?? "" };
}

export function htmlMediaUrl(pluginId: string, src: string, docSlug: string): string | null {
  if (ABSOLUTE_URL.test(src)) return LOADABLE_URL.test(src) ? src : null;
  return mediaUrl(pluginId, resolveAssetPath(src, docSlug));
}
