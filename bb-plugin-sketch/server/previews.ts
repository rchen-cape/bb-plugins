import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SketchError } from "./errors.js";

export const PREVIEW_MIGRATIONS: readonly string[] = [
  "CREATE TABLE previews (sketch_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
];

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface Preview {
  sha256: string;
  png: Buffer;
  updatedAt: string;
}

const rowSchema = z.object({ sha256: z.string(), png: z.instanceof(Uint8Array), updated_at: z.string() });
const idRowsSchema = z.array(z.object({ sketch_id: z.string() }));

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function decodePng(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (!isPng(bytes)) throw new SketchError("not-png", "That image isn't a PNG.");
  return bytes;
}

export function createPreviewStore(storage: BbPluginApi["storage"]) {
  storage.migrate(storage.database(), [...PREVIEW_MIGRATIONS]);
  const db = () => storage.database();

  return {
    get(id: string): Preview | null {
      const row = db().prepare("SELECT sha256, png, updated_at FROM previews WHERE sketch_id = ?").get(id);
      if (row === undefined) return null;
      const parsed = rowSchema.parse(row);
      return { sha256: parsed.sha256, png: Buffer.from(parsed.png), updatedAt: parsed.updated_at };
    },

    put(id: string, sha256: string, png: Uint8Array): void {
      db()
        .prepare(
          "INSERT INTO previews (sketch_id, sha256, png, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(sketch_id) DO UPDATE SET sha256 = excluded.sha256, png = excluded.png, updated_at = excluded.updated_at",
        )
        .run(id, sha256, png, new Date().toISOString());
    },

    rename(from: string, to: string): void {
      const handle = db();
      handle.transaction(() => {
        handle.prepare("DELETE FROM previews WHERE sketch_id = ?").run(to);
        handle.prepare("UPDATE previews SET sketch_id = ? WHERE sketch_id = ?").run(to, from);
      })();
    },

    copy(from: string, to: string): void {
      db()
        .prepare("INSERT OR REPLACE INTO previews (sketch_id, sha256, png, updated_at) SELECT ?, sha256, png, updated_at FROM previews WHERE sketch_id = ?")
        .run(to, from);
    },

    remove(id: string): void {
      db().prepare("DELETE FROM previews WHERE sketch_id = ?").run(id);
    },

    retain(ids: Iterable<string>): number {
      const keep = new Set(ids);
      const handle = db();
      const stale = idRowsSchema
        .parse(handle.prepare("SELECT sketch_id FROM previews").all())
        .map((row) => row.sketch_id)
        .filter((id) => !keep.has(id));
      const remove = handle.prepare("DELETE FROM previews WHERE sketch_id = ?");
      handle.transaction(() => {
        for (const id of stale) remove.run(id);
      })();
      return stale.length;
    },
  };
}

export type PreviewStore = ReturnType<typeof createPreviewStore>;
