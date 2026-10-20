import { readdir } from "node:fs/promises";
import path from "node:path";
import { fsErrorCode, SketchError } from "./errors.js";
import { lstatOrNull } from "./files.js";
import { displayFolder } from "./folder.js";
import { nameKey, sketchFileName, sketchIdOf, takenKey } from "./names.js";

export interface SketchEntry {
  id: string;
  fileName: string;
  file: string;
  mtimeMs: number;
  size: number;
}

export async function folderNames(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT") return [];
    if (code === "ENOTDIR") throw new SketchError("invalid-folder", `The Sketch folder ${displayFolder(root)} isn't a folder.`);
    throw error;
  }
}

export function takenKeys(names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const key = takenKey(name);
    if (key !== null) keys.add(key);
  }
  return keys;
}

export function clashingName(names: readonly string[], id: string, except: string | null): string | null {
  const key = nameKey(sketchFileName(id));
  const exempt = except === null ? null : sketchFileName(except);
  return names.find((name) => name !== exempt && nameKey(name) === key) ?? null;
}

export async function entryFor(root: string, fileName: string): Promise<SketchEntry | null> {
  const id = sketchIdOf(fileName);
  if (id === null) return null;
  const file = path.join(root, fileName);
  const stats = await lstatOrNull(file);
  if (stats === null || !stats.isFile()) return null;
  return { id, fileName, file, mtimeMs: stats.mtimeMs, size: stats.size };
}

export async function scanEntries(root: string): Promise<SketchEntry[]> {
  const entries: SketchEntry[] = [];
  for (const fileName of await folderNames(root)) {
    const entry = await entryFor(root, fileName);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
