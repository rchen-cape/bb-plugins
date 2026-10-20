import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fsErrorCode, isMissing } from "./errors.js";

export interface FileData {
  bytes: Buffer;
  sha256: string;
  mtimeMs: number;
  size: number;
}

const LINK_UNSUPPORTED: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stampOf(stats: Pick<Stats, "mtimeMs" | "size">): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
}

export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeSynced(target: string, data: Uint8Array, mode: number | null): Promise<void> {
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(data);
    if (mode !== null) await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type ReadyHook = (stats: Stats) => void;

async function withTemp<T>(target: string, data: Uint8Array, mode: number | null, onReady: ReadyHook | null, place: (temp: string) => Promise<T>): Promise<T> {
  const temp = tempPathFor(target);
  try {
    await writeSynced(temp, data, mode);
    onReady?.(await lstat(temp));
    return await place(temp);
  } finally {
    await rm(temp, { force: true });
  }
}

async function currentMode(target: string): Promise<number | null> {
  const stats = await lstatOrNull(target);
  return stats?.isFile() === true ? stats.mode & 0o7777 : null;
}

export async function writeFileAtomic(target: string, data: Uint8Array, onReady: ReadyHook | null = null): Promise<void> {
  await withTemp(target, data, await currentMode(target), onReady, (temp) => rename(temp, target));
}

async function linkExclusive(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to);
    return true;
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "EEXIST") return false;
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
  }
  if ((await lstatOrNull(to)) !== null) return false;
  await rename(from, to);
  return true;
}

export async function createFileExclusive(target: string, data: Uint8Array, onReady: ReadyHook | null = null): Promise<boolean> {
  return withTemp(target, data, null, onReady, (temp) => linkExclusive(temp, target));
}

export async function moveNoClobber(from: string, to: string): Promise<boolean> {
  if (!(await linkExclusive(from, to))) return false;
  await unlink(from).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  return true;
}

export async function readRegularFile(file: string): Promise<FileData | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error) || fsErrorCode(error) === "ELOOP") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const bytes = await handle.readFile();
    return { bytes, sha256: sha256Hex(bytes), mtimeMs: stats.mtimeMs, size: stats.size };
  } finally {
    await handle.close();
  }
}

const TEMP_FILE = /^\..+\.[0-9a-f]{12}\.tmp$/;

export async function sweepTempFiles(folder: string, olderThanMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names.filter((entry) => TEMP_FILE.test(entry))) {
    const file = path.join(folder, name);
    const stats = await lstatOrNull(file);
    if (stats === null || !stats.isFile() || now - stats.mtimeMs <= olderThanMs) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return removed;
}
