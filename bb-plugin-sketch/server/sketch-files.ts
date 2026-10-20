import path from "node:path";
import type { SketchDetail, SketchSummary } from "../contract.js";
import { parseSceneFile, SceneFileError } from "../lib/scene.js";
import { folderNames } from "./entries.js";
import { notFound, SketchError } from "./errors.js";
import { readRegularFile, type FileData } from "./files.js";
import { nameKey, sketchFileName } from "./names.js";

export function countElements(content: string): number {
  try {
    return parseSceneFile(content).scene.elements.length;
  } catch {
    return 0;
  }
}

export function validateContent(content: string): void {
  try {
    parseSceneFile(content);
  } catch (error) {
    if (error instanceof SceneFileError) throw new SketchError("invalid-content", error.message);
    throw error;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function summaryOf(id: string, stats: { mtimeMs: number; size: number }, elementCount: number): SketchSummary {
  return { id, title: id, updatedAt: iso(stats.mtimeMs), elementCount, sizeBytes: stats.size };
}

export function detailOf(id: string, data: FileData): SketchDetail {
  const content = data.bytes.toString("utf8");
  return { ...summaryOf(id, data, countElements(content)), sha256: data.sha256, content };
}

export function newestFirst(a: SketchSummary, b: SketchSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);
}

export function folderKey(root: string): string {
  return `${root}\0`;
}

export function idKey(root: string, id: string): string {
  return `${root}\0${nameKey(id)}`;
}

export async function inBatches<T, R>(items: readonly T[], size: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(map))));
  }
  return results;
}

export async function readExact(root: string, id: string, names?: readonly string[]): Promise<FileData | null> {
  const fileName = sketchFileName(id);
  if (!(names ?? (await folderNames(root))).includes(fileName)) return null;
  return readRegularFile(path.join(root, fileName));
}

export async function requireExact(root: string, id: string): Promise<FileData> {
  const data = await readExact(root, id);
  if (data === null) throw notFound(id);
  return data;
}
