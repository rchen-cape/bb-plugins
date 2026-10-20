import { sketchIdSchema } from "../contract.js";
import { DEFAULT_SKETCH_TITLE, LIMITS, SKETCH_EXTENSION } from "../lib/sketch.js";

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const FORBIDDEN = /[/\\:*?"<>|]+/g;
const COPIED = /^(.*\S)\s+copy(?:\s+\d+)?$/i;

export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

function stripExtension(name: string): string {
  return name.toLowerCase().endsWith(SKETCH_EXTENSION) ? name.slice(0, -SKETCH_EXTENSION.length).trim() : name;
}

export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(CONTROL, " ").replace(FORBIDDEN, "-").replace(/\s+/g, " ").trim();
  const bare = stripExtension(cleaned).replace(/^\.+/, "").trim();
  const bounded = clip(bare, LIMITS.title).trim();
  return bounded === "" ? DEFAULT_SKETCH_TITLE : bounded;
}

export function sketchFileName(id: string): string {
  return `${id}${SKETCH_EXTENSION}`;
}

export function sketchIdOf(fileName: string): string | null {
  if (fileName.startsWith(".") || !fileName.endsWith(SKETCH_EXTENSION)) return null;
  const id = fileName.slice(0, -SKETCH_EXTENSION.length);
  return sketchIdSchema.safeParse(id).success ? id : null;
}

export function takenKey(fileName: string): string | null {
  const key = nameKey(fileName);
  return key.endsWith(SKETCH_EXTENSION) ? key.slice(0, -SKETCH_EXTENSION.length) : null;
}

export function withSuffix(base: string, suffix: string): string {
  return `${clip(base, LIMITS.title - suffix.length).trimEnd()}${suffix}`;
}

function firstFree(candidates: (n: number) => string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = candidates(n);
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

export function freeTitle(title: string, taken: ReadonlySet<string>): string {
  if (!taken.has(nameKey(title))) return title;
  return firstFree((n) => withSuffix(title, ` ${n + 1}`), taken);
}

export function copyTitle(title: string, taken: ReadonlySet<string>): string {
  const base = COPIED.exec(title)?.[1] ?? title;
  return firstFree((n) => withSuffix(base, n === 1 ? " copy" : ` copy ${n}`), taken);
}

export function idOfFileName(fileName: string): string {
  return fileName.slice(0, -SKETCH_EXTENSION.length);
}
