import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./errors.js";
import { clip } from "./names.js";

export const OUTBOX_DIR = "outbox";
export const OUTBOX_STALE_MS = 60 * 60 * 1000;

const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;
const PNG_EXTENSION = /\.png$/i;
const FILE_STEM_LIMIT = 100;
const FALLBACK_STEM = "sketch";

export function pngStem(name: string): string {
  return name.trim().replace(PNG_EXTENSION, "").trim();
}

export function pngName(name: string): string {
  const stem = pngStem(name);
  return `${stem === "" ? FALLBACK_STEM : stem}.png`;
}

export function pngFileName(name: string): string {
  const stem = clip(pngStem(name).replace(UNSAFE, "-").replace(/\s+/g, " ").replace(/^[.\s]+/, ""), FILE_STEM_LIMIT).trim();
  return `${stem === "" ? FALLBACK_STEM : stem}.png`;
}

export function outboxRoot(dataDir: string): string {
  return path.join(dataDir, OUTBOX_DIR);
}

export interface OutboxOptions {
  settled: (error: unknown) => boolean;
}

async function writeOutboxFile(folder: string, name: string, png: Uint8Array): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, pngFileName(name));
  await writeFile(file, png, { flag: "wx" });
  return file;
}

export async function withOutboxFile<T>(
  dataDir: string,
  name: string,
  png: Uint8Array,
  use: (file: string) => Promise<T>,
  options: OutboxOptions,
): Promise<T> {
  const folder = path.join(outboxRoot(dataDir), randomBytes(8).toString("hex"));
  let keep = false;
  try {
    const file = await writeOutboxFile(folder, name, png);
    try {
      return await use(file);
    } catch (error) {
      keep = !options.settled(error);
      throw error;
    }
  } finally {
    if (!keep) await rm(folder, { recursive: true, force: true });
  }
}

async function isStale(folder: string, now: number): Promise<boolean> {
  try {
    return now - (await stat(folder)).mtimeMs > OUTBOX_STALE_MS;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function sweepOutbox(dataDir: string, now: number = Date.now()): Promise<number> {
  const root = outboxRoot(dataDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const folder = path.join(root, name);
    if (!(await isStale(folder, now))) continue;
    await rm(folder, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
