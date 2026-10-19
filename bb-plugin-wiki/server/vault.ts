import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream, watch as watchNative, type Dirent, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  addAlias as addAliasToContent,
  extractWikiLinks,
  insertUnderHeading,
  listHeadings,
  newDocContent,
  moveUnsortedBelowRule,
  renameDocContent,
  parseDoc,
  splitSections,
  type DocSection,
  type NewDocInput,
} from "../lib/markdown-doc.js";
import { isSafeSlug, slugify, tagForSlug, uniqueSlug } from "../lib/slug.js";
import { ASSETS_DIR, LIMITS, TAGS_FILE, mediaKindOf } from "../lib/wiki.js";
import type { IndexedDoc, IndexedFileStamp, IndexedLink } from "./index-types.js";
import type { Store, TagEntry } from "./store.js";

export type VaultLog = Pick<BbPluginApi["log"], "debug" | "info" | "warn">;

export interface DocFile {
  slug: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface DocContent {
  content: string;
  sha256: string;
  path: string;
}

export type WriteResult = { outcome: "written"; sha256: string } | { outcome: "conflict" };

export interface FirstBlock {
  heading: string;
  block: string;
}

export interface WatchHandle {
  close(): void;
}

export type WatchFactory = (
  root: string,
  onEvent: (filename: string | null) => void,
  onError: (error: unknown) => void,
) => WatchHandle;

export interface VaultDeps {
  getRoot: () => Promise<string>;
  store: Store;
  gitEnabled: () => Promise<boolean>;
  log: VaultLog;
  watchFactory?: WatchFactory;
  pollMs?: number;
  debounceMs?: number;
  gitBinaries?: readonly string[];
}

export type VaultErrorCode =
  | "invalid-root"
  | "invalid-slug"
  | "invalid-path"
  | "invalid-encoding"
  | "outside-root"
  | "missing"
  | "conflict";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

interface LoadedDoc extends DocContent {
  mtimeMs: number;
  size: number;
}

interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

type GitRun = (args: readonly string[]) => Promise<GitOutput>;

type IndexOutcome = "indexed" | "removed" | "absent";

export const DOC_EXTENSION = ".md";
export const GIT_BINARIES: readonly string[] = ["git", "/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
const NODE_MODULES = "node_modules";
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["user.name", "Wiki"],
  ["user.email", "wiki@localhost"],
];
const GIT_ENV_DROP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];
const DEBOUNCE_MS = 300;
const POLL_MS = 30_000;
const WRITE_ATTEMPTS = 3;
const ASSET_ATTEMPTS = 100;
const ASSET_HASH_CHARS = 8;
const ASSET_EXTENSION = /\.([A-Za-z0-9]{1,10})$/;
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);
const TAGS_VERSION = 1;

interface Lease {
  root: string;
  open: boolean;
  tail: Promise<void>;
}

const held = new AsyncLocalStorage<Lease>();
const tails = new Map<string, Promise<void>>();

export function resolveRoot(raw: string, home: string = homedir()): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
  if (expanded === "" || expanded.includes("\0") || !path.isAbsolute(expanded)) {
    throw new VaultError("invalid-root", `Expected an absolute folder path or one starting with "~/", got ${JSON.stringify(raw)}`);
  }
  const normalized = path.normalize(expanded);
  return normalized.length > 1 && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

export function resolveWikiRoot(raw: string, home: string = homedir()): string {
  const root = resolveRoot(raw, home);
  if (isInside(root, resolveRoot(home, home))) {
    throw new VaultError("invalid-root", `The Wiki folder ${root} holds your home folder; pick a folder inside it, like ~/Wiki`);
  }
  return root;
}

function passes(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

export function isFolderSetting(raw: string): boolean {
  return passes(() => resolveRoot(raw, "/"));
}

export function isWikiFolderSetting(raw: string, home: string = homedir()): boolean {
  return passes(() => resolveWikiRoot(raw, home));
}

export function docRelPath(slug: string): string {
  return `${slug}${DOC_EXTENSION}`;
}

export function tagsFilePath(root: string): string {
  return path.join(root, ...TAGS_FILE.split("/"));
}

function isNamed(segment: string | undefined, name: string): boolean {
  return segment?.toLowerCase() === name;
}

function isHidden(segment: string): boolean {
  return segment.startsWith(".");
}

function docSegments(slug: string): string[] | null {
  if (!isSafeSlug(slug)) return null;
  const segments = slug.split("/");
  const folders = segments.slice(0, -1);
  if (isNamed(folders[0], ASSETS_DIR) || folders.some((folder) => isNamed(folder, NODE_MODULES))) return null;
  return segments;
}

export function isDocSlug(slug: string): boolean {
  return docSegments(slug) !== null;
}

function requireDocSegments(slug: string): string[] {
  const segments = docSegments(slug);
  if (segments === null) throw new VaultError("invalid-slug", `Not a valid Wiki doc slug: ${JSON.stringify(slug)}`);
  return segments;
}

function docFilePath(root: string, segments: readonly string[]): string {
  return `${path.join(root, ...segments)}${DOC_EXTENSION}`;
}

function skipsFolder(segments: readonly string[]): boolean {
  const name = segments.at(-1) ?? "";
  return isHidden(name) || isNamed(name, NODE_MODULES) || (segments.length === 1 && isNamed(name, ASSETS_DIR));
}

export function isDocEvent(filename: string | null): boolean {
  if (filename === null) return true;
  const segments = filename.split(/[\\/]+/).filter((segment) => segment !== "");
  if (segments.length === 0) return true;
  if (segments.some(isHidden)) return false;
  return !isNamed(segments[0], ASSETS_DIR) && !segments.some((segment) => isNamed(segment, NODE_MODULES));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function realOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isMissing(error) || errorCode(error) === "ELOOP") return null;
    throw error;
  }
}

async function entryExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: unknown) => !isMissing(error),
  );
}

async function nearestReal(target: string): Promise<string | null> {
  let current = target;
  for (;;) {
    const real = await realOrNull(current);
    if (real !== null) return real;
    if (await entryExists(current)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function liesInside(realRoot: string, target: string): Promise<boolean> {
  const real = await nearestReal(target);
  return real !== null && isInside(realRoot, real);
}

async function assertInside(realRoot: string, target: string): Promise<void> {
  if (!(await liesInside(realRoot, target))) {
    throw new VaultError("outside-root", `Refusing to touch ${target}: it resolves outside the Wiki folder`);
  }
}

async function prepareFolder(realRoot: string, folder: string): Promise<void> {
  await assertInside(realRoot, folder);
  await mkdir(folder, { recursive: true });
  await assertInside(realRoot, folder);
}

async function openRoot(root: string): Promise<string> {
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || code === "ENOTDIR") throw new VaultError("invalid-root", `The Wiki folder ${root} is not a folder`);
    throw error;
  }
  const real = await realpath(root);
  if (!(await stat(real)).isDirectory()) throw new VaultError("invalid-root", `The Wiki folder ${root} is not a folder`);
  return real;
}

function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
}

async function writeSynced(target: string, data: Uint8Array, mode: number | null = null): Promise<void> {
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(data);
    if (mode !== null) await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withTemp<T>(target: string, data: Uint8Array, place: (temp: string) => Promise<T>, mode: number | null = null): Promise<T> {
  const temp = tempPathFor(target);
  try {
    await writeSynced(temp, data, mode);
    return await place(temp);
  } finally {
    await rm(temp, { force: true });
  }
}

async function currentMode(target: string): Promise<number | null> {
  const stats = await lstatOrNull(target);
  return stats?.isFile() === true ? stats.mode & 0o7777 : null;
}

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await withTemp(target, toBytes(data), (temp) => rename(temp, target), await currentMode(target));
}

async function linkExclusive(temp: string, target: string): Promise<boolean> {
  try {
    await link(temp, target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
  }
  if ((await lstatOrNull(target)) !== null) return false;
  await rename(temp, target);
  return true;
}

async function createFileExclusive(target: string, data: Uint8Array): Promise<boolean> {
  return withTemp(target, data, (temp) => linkExclusive(temp, target));
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

async function openNoFollow(file: string) {
  try {
    return await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error) || errorCode(error) === "ELOOP") return null;
    throw error;
  }
}

async function readDocFile(realRoot: string, file: string): Promise<LoadedDoc | null> {
  if (!(await liesInside(realRoot, path.dirname(file)))) return null;
  const handle = await openNoFollow(file);
  if (handle === null) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const bytes = await handle.readFile();
    return { content: bytes.toString("utf8"), sha256: sha256Hex(bytes), path: file, mtimeMs: stats.mtimeMs, size: stats.size };
  } finally {
    await handle.close();
  }
}

async function readEntries(folder: string, top: boolean): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (!top && (isMissing(error) || errorCode(error) === "EACCES" || errorCode(error) === "EPERM")) return [];
    throw error;
  }
}

async function docFileFor(root: string, segments: readonly string[]): Promise<DocFile | null> {
  const slug = segments.join("/").slice(0, -DOC_EXTENSION.length);
  if (!isDocSlug(slug)) return null;
  const file = path.join(root, ...segments);
  const stats = await lstatOrNull(file);
  if (stats === null || !stats.isFile()) return null;
  return { slug, path: file, mtimeMs: stats.mtimeMs, size: stats.size };
}

async function walkDocs(root: string, segments: readonly string[], found: DocFile[]): Promise<void> {
  for (const entry of await readEntries(path.join(root, ...segments), segments.length === 0)) {
    const next = [...segments, entry.name];
    if (entry.isDirectory()) {
      if (!skipsFolder(next)) await walkDocs(root, next, found);
    } else if (entry.isFile() && entry.name.endsWith(DOC_EXTENSION)) {
      const file = await docFileFor(root, next);
      if (file !== null) found.push(file);
    }
  }
}

async function listDocsAt(root: string): Promise<DocFile[]> {
  const found: DocFile[] = [];
  await walkDocs(root, [], found);
  return found.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function linkKey(link: IndexedLink): string {
  return `${link.targetText}\u0000${link.heading}`;
}

function sectionLinks(section: DocSection): IndexedLink[] {
  return extractWikiLinks(`${section.heading}\n${section.body}`).flatMap((link) => {
    if (link.embed && mediaKindOf(link.target) !== null) return [];
    const targetText = link.heading === null ? link.target : `${link.target}#${link.heading}`;
    return [{ targetText, heading: section.heading }];
  });
}

function docLinks(sections: readonly DocSection[]): IndexedLink[] {
  const links = new Map<string, IndexedLink>();
  for (const link of sections.flatMap(sectionLinks)) links.set(linkKey(link), link);
  return [...links.values()];
}

export function buildIndexedDoc(file: DocFile, content: string, sha256: string): IndexedDoc {
  const parsed = parseDoc(content, file.slug);
  const sections = splitSections(parsed.body);
  return {
    slug: file.slug,
    title: parsed.title,
    type: parsed.type,
    aliases: parsed.aliases,
    tag: tagForSlug(file.slug),
    path: file.path,
    mtimeMs: file.mtimeMs,
    size: file.size,
    sha256,
    headings: listHeadings(content),
    sections,
    links: docLinks(sections),
  };
}

export function tagsJson(entries: readonly TagEntry[]): string {
  const docs = [...entries]
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .map((entry) => ({ tag: entry.tag, title: entry.title, type: entry.type, aliases: [...entry.aliases] }));
  return `${JSON.stringify({ version: TAGS_VERSION, docs }, null, 2)}\n`;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assetNameParts(name: string): { stem: string; ext: string } {
  const file = path.basename(name);
  const match = ASSET_EXTENSION.exec(file);
  const ext = match?.[1] === undefined ? "" : `.${match[1].toLowerCase()}`;
  return { stem: match === null ? file : file.slice(0, -match[0].length), ext };
}

function assetFileName(absPath: string, preferredName: string | undefined): (attempt: number, digest: string) => string {
  const preferred = assetNameParts(preferredName ?? absPath);
  const ext = preferred.ext === "" ? assetNameParts(absPath).ext : preferred.ext;
  const base = slugify(preferred.stem);
  return (attempt, digest) => {
    const stem = `${base}-${digest.slice(0, ASSET_HASH_CHARS)}`;
    return `${attempt === 1 ? stem : `${stem}-${attempt}`}${ext}`;
  };
}

async function streamCopy(from: string, to: string): Promise<string> {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(from), tap, createWriteStream(to, { flags: "wx", flush: true }));
  return hash.digest("hex");
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function sameContent(target: string, existing: Stats, size: number, digest: string): Promise<boolean> {
  return existing.isFile() && existing.size === size && (await fileDigest(target)) === digest;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of GIT_ENV_DROP) delete env[key];
  return env;
}

function execGit(binary: string, args: readonly string[]): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(error);
      },
    );
  });
}

async function findGit(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await execGit(candidate, ["--version"])).code === 0) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function gitDetail(output: GitOutput): string {
  const text = `${output.stderr}\n${output.stdout}`.replace(/\s+/g, " ").trim();
  return text === "" ? `exit code ${output.code}` : text.slice(0, 500);
}

function relativeSpec(roots: readonly string[], entry: string): string | null {
  if (entry === "" || entry.includes("\0")) return null;
  for (const root of roots) {
    const absolute = path.isAbsolute(entry) ? entry : path.join(root, entry);
    if (!isInside(root, absolute)) continue;
    const relative = path.relative(root, absolute);
    return relative === "" ? "." : relative.split(path.sep).join("/");
  }
  return null;
}

async function removedSpecs(run: GitRun, root: string, realRoot: string, removed: readonly string[]): Promise<string[] | null> {
  const specs = [...new Set(removed.flatMap((entry) => relativeSpec([root, realRoot], entry) ?? []))].filter((spec) => spec !== ".");
  if (specs.length === 0) return [];
  const unstaged = await run(["rm", "--cached", "-q", "--ignore-unmatch", "--", ...specs]);
  if (unstaged.code !== 0) return null;
  const staged = await run(["diff", "--cached", "--name-only", "--", ...specs]);
  if (staged.code !== 0) return null;
  const listed = new Set(staged.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  return specs.filter((spec) => listed.has(spec));
}

async function pathspecs(root: string, realRoot: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return ["."];
  const specs = new Set<string>();
  for (const entry of paths) {
    const spec = relativeSpec([root, realRoot], entry);
    if (spec !== null && (await lstatOrNull(path.join(root, spec))) !== null) specs.add(spec);
  }
  return [...specs];
}

async function identityFlags(run: GitRun): Promise<string[]> {
  const flags: string[] = [];
  for (const [key, fallback] of GIT_IDENTITY) {
    const configured = await run(["config", "--get", key]);
    if (configured.code !== 0 || configured.stdout.trim() === "") flags.push("-c", `${key}=${fallback}`);
  }
  return flags;
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

const nativeWatch: WatchFactory = (root, onEvent, onError) => {
  const watcher = watchNative(root, { recursive: true }, (_event, filename) => onEvent(filename));
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = settled(result);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

function openLease(): Lease | null {
  const lease = held.getStore();
  return lease?.open === true ? lease : null;
}

async function drain(lease: Lease): Promise<void> {
  let tail: Promise<void> | null = null;
  while (tail !== lease.tail) {
    tail = lease.tail;
    await tail;
  }
}

async function runLeased<T>(root: string, fn: (root: string) => Promise<T>): Promise<T> {
  const lease: Lease = { root, open: true, tail: Promise.resolve() };
  try {
    return await held.run(lease, () => fn(root));
  } finally {
    await drain(lease);
    lease.open = false;
  }
}

function runNested<T>(lease: Lease, fn: (root: string) => Promise<T>): Promise<T> {
  const result = lease.tail.then(() => runLeased(lease.root, fn));
  lease.tail = settled(result);
  return result;
}

function createSyncRunner(run: () => Promise<void>, debounceMs: number) {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function loop(): Promise<void> {
    do {
      again = false;
      await run();
    } while (again);
  }

  function request(): void {
    if (running !== null) {
      again = true;
      return;
    }
    running = loop().finally(() => {
      running = null;
    });
  }

  return {
    request,
    schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        request();
      }, debounceMs);
    },
    async stop(): Promise<void> {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

function conflicts(current: LoadedDoc | null, expected: string | null | undefined): boolean {
  if (expected === null) return current !== null;
  return expected !== undefined && current?.sha256 !== expected;
}

function hasHiddenSegment(relative: string): boolean {
  return relative.split(path.sep).some(isHidden);
}

function needsIndex(file: DocFile, stamp: IndexedFileStamp | undefined, storedPath: () => string | null): boolean {
  return stamp === undefined || stamp.mtimeMs !== file.mtimeMs || stamp.size !== file.size || storedPath() !== file.path;
}

export function createVault(deps: VaultDeps) {
  const { store, log } = deps;
  const watchFactory = deps.watchFactory ?? nativeWatch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  let gitBinary: Promise<string | null> | null = null;

  async function root(): Promise<string> {
    return openLease()?.root ?? resolveWikiRoot(await deps.getRoot());
  }

  let gate: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const lease = openLease();
    if (lease !== null) return runNested(lease, fn);
    const result = gate.then(async () => {
      const key = await root();
      return enqueue(key, () => runLeased(key, fn));
    });
    gate = settled(result);
    return result;
  }

  async function writeTagsAt(rootPath: string, realRoot: string): Promise<boolean> {
    const file = tagsFilePath(rootPath);
    await prepareFolder(realRoot, path.dirname(file));
    const next = Buffer.from(tagsJson(store.allTags()), "utf8");
    const current = await readOrNull(file);
    if (current !== null && current.equals(next)) return false;
    await writeFileAtomic(file, next);
    return true;
  }

  async function refreshTags(rootPath: string, realRoot: string): Promise<void> {
    try {
      await writeTagsAt(rootPath, realRoot);
    } catch (error) {
      log.warn(`Wiki could not update ${tagsFilePath(rootPath)}: ${errorMessage(error)}`);
    }
  }

  async function indexLoaded(file: DocFile, realRoot: string): Promise<IndexOutcome> {
    const loaded = await readDocFile(realRoot, file.path);
    if (loaded === null) return store.removeDoc(file.slug) ? "removed" : "absent";
    const stamped = { slug: file.slug, path: file.path, mtimeMs: loaded.mtimeMs, size: loaded.size };
    store.upsertDoc(buildIndexedDoc(stamped, loaded.content, loaded.sha256));
    return "indexed";
  }

  async function indexSlug(rootPath: string, realRoot: string, segments: readonly string[]): Promise<boolean> {
    const file = { slug: segments.join("/"), path: docFilePath(rootPath, segments), mtimeMs: 0, size: 0 };
    const outcome = await indexLoaded(file, realRoot);
    await refreshTags(rootPath, realRoot);
    return outcome === "indexed";
  }

  async function indexAfterWrite(rootPath: string, realRoot: string, segments: readonly string[]): Promise<void> {
    try {
      await indexSlug(rootPath, realRoot, segments);
    } catch (error) {
      log.warn(`Wiki saved ${docFilePath(rootPath, segments)} but could not index it: ${errorMessage(error)}`);
    }
  }

  async function placeDoc(realRoot: string, file: string, bytes: Uint8Array, current: LoadedDoc | null, expected: string | null | undefined): Promise<boolean> {
    if (conflicts(current, expected)) return false;
    if (current?.sha256 === sha256Hex(bytes)) return true;
    await prepareFolder(realRoot, path.dirname(file));
    if (expected === null) return createFileExclusive(file, bytes);
    await writeFileAtomic(file, bytes);
    return true;
  }

  async function writeAt(rootPath: string, segments: readonly string[], content: string, expected: string | null | undefined): Promise<WriteResult> {
    const realRoot = await openRoot(rootPath);
    const file = docFilePath(rootPath, segments);
    const bytes = toBytes(content);
    if (!(await placeDoc(realRoot, file, bytes, await readDocFile(realRoot, file), expected))) return { outcome: "conflict" };
    await indexAfterWrite(rootPath, realRoot, segments);
    return { outcome: "written", sha256: sha256Hex(bytes) };
  }

  async function updateDoc(slug: string, edit: (content: string) => string): Promise<{ sha256: string }> {
    const segments = requireDocSegments(slug);
    return runExclusive(async (rootPath) => {
      const realRoot = await openRoot(rootPath);
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const current = await readDocFile(realRoot, docFilePath(rootPath, segments));
        if (current === null) throw new VaultError("missing", `The Wiki doc ${JSON.stringify(slug)} does not exist`);
        if (sha256Hex(toBytes(current.content)) !== current.sha256) {
          throw new VaultError("invalid-encoding", `The Wiki doc ${JSON.stringify(slug)} is not valid UTF-8, so it is left as is`);
        }
        const next = edit(current.content);
        if (next === current.content) {
          if (store.getDoc(slug)?.sha256 !== current.sha256) await indexAfterWrite(rootPath, realRoot, segments);
          return { sha256: current.sha256 };
        }
        const result = await writeAt(rootPath, segments, next, current.sha256);
        if (result.outcome === "written") return { sha256: result.sha256 };
      }
      throw new VaultError("conflict", `The Wiki doc ${JSON.stringify(slug)} kept changing while it was being updated`);
    });
  }

  async function takenSlugs(rootPath: string): Promise<(slug: string) => boolean> {
    const names = new Set((await readdir(rootPath)).map((name) => name.toLowerCase()));
    return (slug) => names.has(docRelPath(slug).toLowerCase()) || store.getDoc(slug) !== null;
  }

  async function placeAsset(folder: string, temp: string, name: (attempt: number, digest: string) => string, digest: string): Promise<string> {
    const size = (await stat(temp)).size;
    for (let attempt = 1; attempt <= ASSET_ATTEMPTS; attempt += 1) {
      const fileName = name(attempt, digest);
      const target = path.join(folder, fileName);
      const existing = await lstatOrNull(target);
      if (existing === null ? await linkExclusive(temp, target) : await sameContent(target, existing, size, digest)) return fileName;
    }
    throw new VaultError("conflict", `Could not find a free asset name for ${name(1, digest)}`);
  }

  async function gitFor(): Promise<string | null> {
    gitBinary ??= findGit(deps.gitBinaries ?? GIT_BINARIES).then((binary) => {
      if (binary === null) log.warn("Wiki git history is on, but no git binary was found; changes are not committed.");
      return binary;
    });
    return gitBinary;
  }

  async function commitAt(rootPath: string, message: string, paths: readonly string[], removed: readonly string[] = []): Promise<void> {
    const binary = await gitFor();
    if (binary === null) return;
    const realRoot = await openRoot(rootPath);
    const run: GitRun = (args) => execGit(binary, ["-C", rootPath, "--literal-pathspecs", ...args]);
    const fail = (step: string, output: GitOutput) => log.warn(`Wiki git ${step} failed in ${rootPath}: ${gitDetail(output)}`);
    if ((await lstatOrNull(path.join(rootPath, ".git"))) === null) {
      const init = await run(["init", "-q"]);
      if (init.code !== 0) return fail("init", init);
    }
    const remaining = paths.filter((entry) => !removed.includes(entry));
    const kept = remaining.length === 0 && removed.length > 0 ? [] : await pathspecs(rootPath, realRoot, remaining);
    const gone = await removedSpecs(run, rootPath, realRoot, removed);
    if (gone === null) return;
    const specs = [...new Set([...kept, ...gone])];
    if (specs.length === 0) return;
    if (kept.length > 0) {
      const added = await run(["add", "-A", "--", ...kept]);
      if (added.code !== 0) return fail("add", added);
    }
    const staged = await run(["diff", "--cached", "--quiet", "--", ...specs]);
    if (staged.code === 0) return;
    if (staged.code !== 1) return fail("diff", staged);
    const flags = await identityFlags(run);
    const committed = await run([...flags, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message, "--", ...specs]);
    if (committed.code !== 0) fail("commit", committed);
  }

  async function syncAll(): Promise<{ changed: number }> {
    return runExclusive(async (rootPath) => {
      const realRoot = await openRoot(rootPath);
      const files = await listDocsAt(rootPath);
      const stamps = new Map(store.stamps().map((stamp) => [stamp.slug, stamp]));
      let changed = 0;
      for (const file of files) {
        if (!needsIndex(file, stamps.get(file.slug), () => store.getDoc(file.slug)?.path ?? null)) continue;
        try {
          if ((await indexLoaded(file, realRoot)) !== "absent") changed += 1;
        } catch (error) {
          log.warn(`Wiki could not index ${file.path}: ${errorMessage(error)}`);
        }
      }
      const present = new Set(files.map((file) => file.slug));
      for (const slug of stamps.keys()) {
        if (!present.has(slug) && store.removeDoc(slug)) changed += 1;
      }
      await refreshTags(rootPath, realRoot);
      return { changed };
    });
  }

  async function watchRoot(): Promise<string> {
    const rootPath = await root();
    await openRoot(rootPath);
    return rootPath;
  }

  async function watch(signal: AbortSignal, onChanged: () => void): Promise<void> {
    const watched: { current: { root: string; handle: WatchHandle | null } | null } = { current: null };
    let lastProblem = "";
    const warnOnce = (problem: string) => {
      if (problem !== lastProblem) log.warn(problem);
      lastProblem = problem;
    };
    const runner = createSyncRunner(async () => {
      if (signal.aborted) return;
      try {
        const { changed } = await syncAll();
        if (changed > 0 && !signal.aborted) onChanged();
      } catch (error) {
        warnOnce(`Wiki sync failed: ${errorMessage(error)}`);
      }
    }, debounceMs);

    const close = () => {
      watched.current?.handle?.close();
      if (watched.current !== null) watched.current.handle = null;
    };

    const watchProblem = (rootPath: string, error: unknown) =>
      `Cannot watch ${rootPath}; checking for changes every ${Math.round(pollMs / 1000)} s: ${errorMessage(error)}`;

    const start = (rootPath: string): WatchHandle | null => {
      let handle: WatchHandle | null = null;
      const early: unknown[] = [];
      const onError = (error: unknown) => {
        if (handle === null) {
          early.push(error);
          return;
        }
        if (watched.current?.handle !== handle) return;
        close();
        warnOnce(watchProblem(rootPath, error));
        runner.request();
      };
      try {
        handle = watchFactory(rootPath, (filename) => {
          if (isDocEvent(filename)) runner.schedule();
        }, onError);
      } catch (error) {
        warnOnce(watchProblem(rootPath, error));
        return null;
      }
      if (early.length === 0) return handle;
      handle.close();
      warnOnce(watchProblem(rootPath, early[0]));
      return null;
    };

    try {
      while (!signal.aborted) {
        let rootPath: string | null = null;
        try {
          rootPath = await watchRoot();
        } catch (error) {
          warnOnce(`Wiki folder unavailable: ${errorMessage(error)}`);
        }
        if (rootPath === null) {
          close();
          watched.current = null;
        } else if (watched.current === null || watched.current.root !== rootPath || watched.current.handle === null) {
          if (watched.current?.root !== rootPath) close();
          watched.current = { root: rootPath, handle: start(rootPath) };
          runner.request();
        }
        await waitForDelay(pollMs, signal);
      }
    } finally {
      close();
      await runner.stop();
    }
  }

  return {
    root,
    runExclusive,

    async ensureRoot(): Promise<string> {
      const rootPath = await root();
      await openRoot(rootPath);
      return rootPath;
    },

    async listDocFiles(): Promise<DocFile[]> {
      const rootPath = await root();
      await openRoot(rootPath);
      return listDocsAt(rootPath);
    },

    async readDoc(slug: string): Promise<DocContent | null> {
      const segments = docSegments(slug);
      if (segments === null) return null;
      const rootPath = await root();
      const loaded = await readDocFile(await openRoot(rootPath), docFilePath(rootPath, segments));
      return loaded === null ? null : { content: loaded.content, sha256: loaded.sha256, path: loaded.path };
    },

    async writeDoc(slug: string, content: string, expectedSha256?: string | null): Promise<WriteResult> {
      const segments = requireDocSegments(slug);
      return runExclusive((rootPath) => writeAt(rootPath, segments, content, expectedSha256));
    },

    async createDoc(input: NewDocInput, firstBlock?: FirstBlock): Promise<{ slug: string; sha256: string }> {
      const template = newDocContent(input);
      const content = firstBlock === undefined ? template : insertUnderHeading(template, firstBlock.heading, firstBlock.block);
      return runExclusive(async (rootPath) => {
        await openRoot(rootPath);
        for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
          const slug = uniqueSlug(slugify(input.title), await takenSlugs(rootPath));
          const result = await writeAt(rootPath, requireDocSegments(slug), content, null);
          if (result.outcome === "written") return { slug, sha256: result.sha256 };
        }
        throw new VaultError("conflict", `Could not create a doc for ${JSON.stringify(input.title)}`);
      });
    },

    async deleteDoc(slug: string): Promise<{ path: string }> {
      const segments = requireDocSegments(slug);
      return runExclusive(async (rootPath) => {
        const realRoot = await openRoot(rootPath);
        const file = docFilePath(rootPath, segments);
        if ((await readDocFile(realRoot, file)) === null) throw new VaultError("missing", `The Wiki doc ${JSON.stringify(slug)} does not exist`);
        await rm(file);
        store.removeDoc(slug);
        await refreshTags(rootPath, realRoot);
        return { path: docRelPath(slug) };
      });
    },

    async renameDoc(slug: string, title: string): Promise<{ slug: string; paths: string[] }> {
      const segments = requireDocSegments(slug);
      return runExclusive(async (rootPath) => {
        const realRoot = await openRoot(rootPath);
        const file = docFilePath(rootPath, segments);
        const current = await readDocFile(realRoot, file);
        if (current === null) throw new VaultError("missing", `The Wiki doc ${JSON.stringify(slug)} does not exist`);
        if (sha256Hex(toBytes(current.content)) !== current.sha256) {
          throw new VaultError("invalid-encoding", `The Wiki doc ${JSON.stringify(slug)} is not valid UTF-8, so it is left as is`);
        }
        const parsed = parseDoc(current.content, slug);
        const keepAliases = [tagForSlug(slug), slugify(parsed.title)];
        const content = renameDocContent(current.content, { oldTitle: parsed.title, title, keepAliases });
        const folder = segments.slice(0, -1);
        const base = [...folder, slugify(title)].join("/");
        const taken = await takenSlugs(rootPath);
        const next = base.toLowerCase() === slug.toLowerCase() ? slug : uniqueSlug(base, taken);
        if (next === slug) {
          const result = await writeAt(rootPath, segments, content, current.sha256);
          if (result.outcome === "conflict") throw new VaultError("conflict", `The Wiki doc ${JSON.stringify(slug)} changed while it was being renamed`);
          return { slug, paths: [docRelPath(slug)] };
        }
        const created = await writeAt(rootPath, requireDocSegments(next), content, null);
        if (created.outcome === "conflict") throw new VaultError("conflict", `A Wiki doc named ${JSON.stringify(next)} already exists`);
        await rm(file);
        store.removeDoc(slug);
        await refreshTags(rootPath, realRoot);
        return { slug: next, paths: [docRelPath(slug), docRelPath(next)] };
      });
    },

    appendBlock(slug: string, heading: string, block: string): Promise<{ sha256: string }> {
      return updateDoc(slug, (content) => insertUnderHeading(content, heading, block));
    },

    moveUnsorted(slug: string): Promise<{ sha256: string }> {
      return updateDoc(slug, moveUnsortedBelowRule);
    },

    addAlias(slug: string, alias: string): Promise<{ sha256: string }> {
      return updateDoc(slug, (content) => addAliasToContent(content, alias));
    },

    async copyAsset(absPath: string, preferredName?: string): Promise<{ relPath: string }> {
      if (!path.isAbsolute(absPath) || absPath.includes("\0")) {
        throw new VaultError("invalid-path", `Asset source must be an absolute path, got ${JSON.stringify(absPath)}`);
      }
      const source = await stat(absPath).catch((error: unknown) => {
        if (isMissing(error)) throw new VaultError("missing", `Asset source ${absPath} does not exist`);
        throw error;
      });
      if (!source.isFile()) throw new VaultError("invalid-path", `Asset source ${absPath} is not a file`);
      const name = assetFileName(absPath, preferredName);
      return runExclusive(async (rootPath) => {
        const realRoot = await openRoot(rootPath);
        const folder = path.join(rootPath, ASSETS_DIR);
        await prepareFolder(realRoot, folder);
        const temp = tempPathFor(path.join(folder, "asset"));
        try {
          const digest = await streamCopy(absPath, temp);
          return { relPath: `${ASSETS_DIR}/${await placeAsset(folder, temp, name, digest)}` };
        } finally {
          await rm(temp, { force: true });
        }
      });
    },

    async resolveInsideRoot(relPath: string): Promise<string | null> {
      const segments = safeSegments(relPath);
      if (segments === null) return null;
      const realRoot = await realOrNull(await root());
      if (realRoot === null) return null;
      const resolved = await realOrNull(path.join(realRoot, ...segments));
      if (resolved === null || !isInside(realRoot, resolved) || hasHiddenSegment(path.relative(realRoot, resolved))) return null;
      return (await lstatOrNull(resolved))?.isFile() === true ? resolved : null;
    },

    async commit(message: string, paths: readonly string[] = [], removed: readonly string[] = []): Promise<void> {
      try {
        if (!(await deps.gitEnabled())) return;
        await runExclusive((rootPath) => commitAt(rootPath, message, paths, removed));
      } catch (error) {
        log.warn(`Wiki git commit failed: ${errorMessage(error)}`);
      }
    },

    async indexDoc(slug: string): Promise<boolean> {
      const segments = docSegments(slug);
      if (segments === null) return false;
      return runExclusive(async (rootPath) => indexSlug(rootPath, await openRoot(rootPath), segments));
    },

    syncAll,

    async writeTagsJson(): Promise<boolean> {
      return runExclusive(async (rootPath) => writeTagsAt(rootPath, await openRoot(rootPath)));
    },

    watch,
  };
}

export function safeSegments(relPath: string): string[] | null {
  if (relPath === "" || relPath.length > LIMITS.path || relPath.includes("\0") || relPath.includes("\\")) return null;
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
  const normalized = path.posix.normalize(relPath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment.startsWith("."))) return null;
  return segments;
}

export type Vault = ReturnType<typeof createVault>;
