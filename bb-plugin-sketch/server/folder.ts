import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorMessage, fsErrorCode, SketchError } from "./errors.js";

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

export const FOLDER_HINT = 'Use an absolute folder path or one starting with "~/" that is not your home folder or above it, like ~/Sketches';

export function resolveRoot(raw: string, home: string = homedir()): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
  if (expanded === "" || expanded.includes("\0") || !path.isAbsolute(expanded)) {
    throw new SketchError("invalid-folder", `Use an absolute folder path or one starting with "~/", not ${JSON.stringify(raw)}.`);
  }
  const normalized = path.normalize(expanded);
  return normalized.length > 1 && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

export function isInside(
  parent: string,
  child: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_PLATFORMS.has(process.platform),
): boolean {
  const [left, right] = caseInsensitive ? [parent.toLowerCase(), child.toLowerCase()] : [parent, child];
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function displayFolder(root: string, home: string = homedir()): string {
  if (root === home) return "~";
  return root.startsWith(`${home}${path.sep}`) ? `~${root.slice(home.length)}` : root;
}

export function resolveSketchRoot(raw: string, home: string = homedir()): string {
  const root = resolveRoot(raw, home);
  if (isInside(root, resolveRoot(home, home))) {
    throw new SketchError("invalid-folder", `The Sketch folder can't be ${displayFolder(root, home)}, because it holds your home folder. Pick a folder inside it, like ~/Sketches.`);
  }
  return root;
}

export function isSketchFolderSetting(raw: string, home: string = homedir()): boolean {
  try {
    resolveSketchRoot(raw, home);
    return true;
  } catch {
    return false;
  }
}

function notAFolder(root: string): SketchError {
  return new SketchError("invalid-folder", `The Sketch folder ${displayFolder(root)} isn't a folder.`);
}

export async function ensureFolder(root: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "EEXIST" || code === "ENOTDIR") throw notAFolder(root);
    throw new SketchError("invalid-folder", `Couldn't create the Sketch folder ${displayFolder(root)}: ${errorMessage(error)}`);
  }
  if (!(await stat(root)).isDirectory()) throw notAFolder(root);
}
