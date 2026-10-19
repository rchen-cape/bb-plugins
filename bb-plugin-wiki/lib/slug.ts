import { LIMITS } from "./wiki.js";

const MAX_SLUG_LENGTH = 80;
const FALLBACK_SLUG = "untitled";

function kebab(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clip(slug: string): string {
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
}

export function slugify(text: string): string {
  return clip(kebab(text)) || FALLBACK_SLUG;
}

export function normalizeTag(raw: string): string {
  return clip(kebab(raw.trim().replace(/^@+/, "")));
}

export function normalizeTags(raw: Iterable<string>): string[] {
  const tags = new Set<string>();
  for (const value of raw) {
    const tag = normalizeTag(value);
    if (tag !== "") tags.add(tag);
  }
  return [...tags];
}

export function wordsFromName(name: string): string {
  const words = name.replace(/[-_\s]+/g, " ").trim();
  return words === "" ? "Untitled" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function titleFromTag(tag: string): string {
  return wordsFromName(normalizeTag(tag));
}

export function basenameOfSlug(slug: string): string {
  return slug.slice(slug.lastIndexOf("/") + 1);
}

export function tagForSlug(slug: string): string {
  return slugify(basenameOfSlug(slug));
}

export function uniqueSlug(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}

export function isSafeSlug(slug: string): boolean {
  if (slug === "" || slug.length > LIMITS.slug || /[\\\0]/.test(slug)) return false;
  return slug.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}
