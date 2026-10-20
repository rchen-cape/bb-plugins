import { rename as renamePath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { SaveResult, SketchDetail, SketchSummary } from "../contract.js";
import { emptyScene, serializeScene } from "../lib/scene.js";
import { DEFAULT_SKETCH_TITLE } from "../lib/sketch.js";
import type { EchoFilter } from "./echo.js";
import { clashingName, entryFor, folderNames, scanEntries, takenKeys, type SketchEntry } from "./entries.js";
import { isMissing, nameTaken, notFound, SketchError } from "./errors.js";
import { createFileExclusive, moveNoClobber, readRegularFile, sha256Hex, stampOf, writeFileAtomic, type ReadyHook } from "./files.js";
import { ensureFolder } from "./folder.js";
import { withLocks } from "./locks.js";
import { copyTitle, freeTitle, idOfFileName, nameKey, sanitizeTitle, sketchFileName } from "./names.js";
import type { PreviewStore } from "./previews.js";
import {
  countElements,
  detailOf,
  folderKey,
  idKey,
  inBatches,
  iso,
  newestFirst,
  readExact,
  requireExact,
  summaryOf,
  validateContent,
} from "./sketch-files.js";

export interface StoreDeps {
  root: () => Promise<string>;
  previews: PreviewStore;
  echo: EchoFilter;
  publish: (id: string | null, renamedTo?: string) => void;
}

export interface FreshPreview {
  sketch: SketchDetail;
  png: Buffer | null;
}

interface WriteOutcome {
  result: SaveResult;
  changed: boolean;
}

const NAME_ATTEMPTS = 5;
const READ_BATCH = 8;

export function createSketchStore(deps: StoreDeps) {
  const counts = new Map<string, { stamp: string; count: number }>();

  async function countOf(entry: SketchEntry): Promise<number> {
    const cached = counts.get(entry.file);
    if (cached !== undefined && cached.stamp === stampOf(entry)) return cached.count;
    const data = await readRegularFile(entry.file);
    if (data === null) return 0;
    const count = countElements(data.bytes.toString("utf8"));
    counts.set(entry.file, { stamp: stampOf(data), count });
    return count;
  }

  async function summaryAt(root: string, id: string): Promise<SketchSummary> {
    const entry = await entryFor(root, sketchFileName(id));
    if (entry === null) throw notFound(id);
    return summaryOf(id, entry, await countOf(entry));
  }

  function noting(id: string): ReadyHook {
    return (stats) => deps.echo.note(sketchFileName(id), stampOf(stats));
  }

  async function statOf(root: string, id: string): Promise<{ mtimeMs: number; size: number }> {
    return stat(path.join(root, sketchFileName(id)));
  }

  async function createUnique(root: string, bytes: Buffer, pick: (taken: ReadonlySet<string>) => string): Promise<string> {
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
      const id = pick(takenKeys(await folderNames(root)));
      if (await createFileExclusive(path.join(root, sketchFileName(id)), bytes, noting(id))) return id;
    }
    throw new Error("Couldn't find a free sketch name. Try again.");
  }

  async function list(): Promise<SketchSummary[]> {
    const entries = await scanEntries(await deps.root());
    const live = new Set(entries.map((entry) => entry.file));
    for (const file of counts.keys()) if (!live.has(file)) counts.delete(file);
    const summaries = await inBatches(entries, READ_BATCH, async (entry) => summaryOf(entry.id, entry, await countOf(entry)));
    return summaries.sort(newestFirst);
  }

  async function ids(): Promise<string[]> {
    return (await scanEntries(await deps.root())).map((entry) => entry.id);
  }

  async function get(id: string): Promise<SketchDetail | null> {
    const data = await readExact(await deps.root(), id);
    return data === null ? null : detailOf(id, data);
  }

  async function create(title: string | null, content: string | null): Promise<SketchDetail> {
    const text = content ?? serializeScene(emptyScene());
    validateContent(text);
    const root = await deps.root();
    const wanted = sanitizeTitle(title ?? DEFAULT_SKETCH_TITLE);
    const bytes = Buffer.from(text, "utf8");
    const detail = await withLocks([folderKey(root)], async () => {
      await ensureFolder(root);
      const id = await createUnique(root, bytes, (taken) => freeTitle(wanted, taken));
      const stats = await statOf(root, id);
      return detailOf(id, { bytes, sha256: sha256Hex(bytes), mtimeMs: stats.mtimeMs, size: stats.size });
    });
    deps.publish(detail.id);
    return detail;
  }

  async function writeContent(root: string, id: string, content: string, expectedSha256: string | null): Promise<WriteOutcome> {
    const names = await folderNames(root);
    const current = await readExact(root, id, names);
    if (expectedSha256 !== null && current?.sha256 !== expectedSha256) return { result: { outcome: "conflict" }, changed: false };
    const bytes = Buffer.from(content, "utf8");
    const sha256 = sha256Hex(bytes);
    if (current !== null && current.sha256 === sha256) {
      return { result: { outcome: "written", sha256, updatedAt: iso(current.mtimeMs) }, changed: false };
    }
    const clash = current === null ? clashingName(names, id, null) : null;
    if (clash !== null) throw new SketchError("name-taken", `Another sketch is already named “${idOfFileName(clash)}”.`);
    await ensureFolder(root);
    await writeFileAtomic(path.join(root, sketchFileName(id)), bytes, noting(id));
    const stats = await statOf(root, id);
    return { result: { outcome: "written", sha256, updatedAt: iso(stats.mtimeMs) }, changed: true };
  }

  async function save(id: string, content: string, expectedSha256: string | null): Promise<SaveResult> {
    validateContent(content);
    const root = await deps.root();
    const { result, changed } = await withLocks([idKey(root, id)], () => writeContent(root, id, content, expectedSha256));
    if (changed) deps.publish(id);
    return result;
  }

  async function moveFile(root: string, id: string, target: string): Promise<void> {
    const from = path.join(root, sketchFileName(id));
    const to = path.join(root, sketchFileName(target));
    noting(target)(await stat(from));
    deps.echo.note(sketchFileName(id), null);
    if (nameKey(id) === nameKey(target)) {
      await renamePath(from, to);
      return;
    }
    if (!(await moveNoClobber(from, to))) throw nameTaken(target);
  }

  async function rename(id: string, title: string): Promise<SketchSummary> {
    const root = await deps.root();
    const target = sanitizeTitle(title);
    return withLocks([folderKey(root), idKey(root, id), idKey(root, target)], async () => {
      const names = await folderNames(root);
      if (!names.includes(sketchFileName(id))) throw notFound(id);
      if (target === id) return summaryAt(root, id);
      const clash = clashingName(names, target, id);
      if (clash !== null) throw nameTaken(idOfFileName(clash));
      await moveFile(root, id, target);
      deps.previews.rename(id, target);
      deps.publish(id, target);
      return summaryAt(root, target);
    });
  }

  async function duplicate(id: string): Promise<SketchSummary> {
    const root = await deps.root();
    const summary = await withLocks([folderKey(root), idKey(root, id)], async () => {
      const source = await requireExact(root, id);
      const copy = await createUnique(root, source.bytes, (taken) => copyTitle(id, taken));
      deps.previews.copy(id, copy);
      return summaryOf(copy, await statOf(root, copy), countElements(source.bytes.toString("utf8")));
    });
    deps.publish(summary.id);
    return summary;
  }

  async function remove(id: string): Promise<{ id: string }> {
    const root = await deps.root();
    await withLocks([folderKey(root), idKey(root, id)], async () => {
      if (!(await folderNames(root)).includes(sketchFileName(id))) throw notFound(id);
      deps.echo.note(sketchFileName(id), null);
      await unlink(path.join(root, sketchFileName(id))).catch((error: unknown) => {
        if (isMissing(error)) throw notFound(id);
        throw error;
      });
      deps.previews.remove(id);
    });
    deps.publish(id);
    return { id };
  }

  async function savePreview(id: string, sha256: string, png: Buffer): Promise<{ stored: boolean }> {
    const root = await deps.root();
    return withLocks([idKey(root, id)], async () => {
      const current = await readExact(root, id);
      if (current === null || current.sha256 !== sha256) return { stored: false };
      deps.previews.put(id, sha256, png);
      return { stored: true };
    });
  }

  async function freshPreview(id: string): Promise<FreshPreview> {
    const data = await requireExact(await deps.root(), id);
    const preview = deps.previews.get(id);
    return { sketch: detailOf(id, data), png: preview !== null && preview.sha256 === data.sha256 ? preview.png : null };
  }

  return {
    root: deps.root,
    list,
    ids,
    count: async () => (await ids()).length,
    get,
    create,
    save,
    rename,
    duplicate,
    remove,
    savePreview,
    freshPreview,
  };
}

export type SketchStore = ReturnType<typeof createSketchStore>;
