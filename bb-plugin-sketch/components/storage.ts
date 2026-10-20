import { z } from "zod";
import { parseSketchStyle, type SketchStyle } from "../lib/elements.js";
import { clampZoom, type Viewport } from "../lib/viewport.js";

const STYLE_KEY = "sketch:style:v1";
const LAST_KEY = "sketch:last:v1";
const VIEW_PREFIX = "sketch:view:v1:";
const WIKI_KEY = "sketch:wiki:v1";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  const raw = storage()?.getItem(key) ?? null;
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    return;
  }
}

export function readStyle(): SketchStyle {
  return parseSketchStyle(readJson(STYLE_KEY));
}

export function writeStyle(style: SketchStyle): void {
  writeJson(STYLE_KEY, style);
}

const lastSchema = z.string().min(1).nullable().catch(null);

export function readLast(): string | null {
  return lastSchema.parse(readJson(LAST_KEY) ?? null);
}

export function writeLast(id: string | null): void {
  if (id === null) remove(LAST_KEY);
  else writeJson(LAST_KEY, id);
}

const finite = z.number().refine((value) => Number.isFinite(value));
const viewSchema = z
  .object({ scrollX: finite, scrollY: finite, zoom: finite })
  .transform((view): Viewport => ({ ...view, zoom: clampZoom(view.zoom) }))
  .nullable()
  .catch(null);

export function readView(id: string): Viewport | null {
  return viewSchema.parse(readJson(`${VIEW_PREFIX}${id}`) ?? null);
}

export function writeView(id: string, view: Viewport): void {
  writeJson(`${VIEW_PREFIX}${id}`, { scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom });
}

export function moveView(from: string, to: string): void {
  const view = readView(from);
  remove(`${VIEW_PREFIX}${from}`);
  if (view !== null) writeView(to, view);
}

export function removeView(id: string): void {
  remove(`${VIEW_PREFIX}${id}`);
}

export const wikiChoiceSchema = z.object({
  kind: z.enum(["inbox", "doc"]).catch("inbox"),
  slug: z.string().min(1).nullable().catch(null),
  heading: z.string().min(1).nullable().catch(null),
});
export type WikiChoice = z.infer<typeof wikiChoiceSchema>;

const DEFAULT_WIKI_CHOICE: WikiChoice = { kind: "inbox", slug: null, heading: null };

export function readWikiChoice(): WikiChoice {
  const parsed = wikiChoiceSchema.safeParse(readJson(WIKI_KEY) ?? {});
  return parsed.success ? parsed.data : DEFAULT_WIKI_CHOICE;
}

export function writeWikiChoice(choice: WikiChoice): void {
  writeJson(WIKI_KEY, choice);
}
