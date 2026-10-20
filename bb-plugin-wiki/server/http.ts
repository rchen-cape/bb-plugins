import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ASSETS_DIR, WIKI_META_DIR, contentTypeOf, mediaKindOf } from "../lib/wiki.js";
import type { WikiContext } from "./context.js";
import { MediaError, cardMediaFile, saveUpload, type MediaErrorCode } from "./media.js";
import { safeSegments } from "./vault.js";

export const ASSET_PATH = "/asset";
export const CARD_MEDIA_PATH = "/card-media";
export const UPLOAD_PATH = "/upload";

const CHUNK_BYTES = 1024 * 1024;
const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const MEDIA_ERROR_STATUS: Record<MediaErrorCode, number> = {
  "invalid-name": 400,
  unsupported: 415,
  "too-large": 413,
  missing: 404,
  "invalid-path": 400,
};

export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

export interface HttpOptions {
  uploadLimitBytes?: number;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

function rangeBounds(first: string, last: string, size: number): ByteRange {
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "partial", start, end };
}

export function parseRange(header: string | null | undefined, size: number): ByteRange {
  if (header === null || header === undefined) return { kind: "full" };
  const match = SINGLE_RANGE.exec(header.trim().toLowerCase());
  const first = match?.[1];
  const last = match?.[2];
  if (first === undefined || last === undefined || (first === "" && last === "")) return { kind: "full" };
  if (!Number.isSafeInteger(Number(first || "0")) || !Number.isSafeInteger(Number(last || "0"))) return { kind: "full" };
  return rangeBounds(first, last, size);
}

export function isServablePath(relPath: string): boolean {
  const segments = safeSegments(relPath);
  if (segments === null) return false;
  const name = segments.at(-1) ?? "";
  if (segments[0] === WIKI_META_DIR || name.toLowerCase().endsWith(".md")) return false;
  if (segments.length > 1 && segments[0] === ASSETS_DIR) return true;
  const kind = mediaKindOf(name);
  return kind === "image" || kind === "video";
}

function relativeInside(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function servableFile(ctx: WikiContext, relPath: string): Promise<{ file: string; size: number } | null> {
  if (!isServablePath(relPath)) return null;
  const file = await ctx.vault.resolveInsideRoot(relPath);
  if (file === null) return null;
  const realRoot = await realpath(await ctx.vault.root()).catch(() => null);
  const real = realRoot === null ? null : relativeInside(realRoot, file);
  if (real === null || !isServablePath(real)) return null;
  const stats = await stat(file).catch(() => null);
  return stats !== null && stats.isFile() ? { file, size: stats.size } : null;
}

export async function fileStream(file: string, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
  const handle = await open(file, "r");
  let position = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const readChunk = async (): Promise<Uint8Array | null> => {
    const remaining = end - position + 1;
    if (remaining <= 0) return null;
    const buffer = new Uint8Array(Math.min(CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    position += bytesRead;
    return bytesRead === 0 ? null : buffer.subarray(0, bytesRead);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await readChunk();
        if (chunk !== null) return controller.enqueue(chunk);
        await close();
        controller.close();
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel: close,
  });
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "_");
}

function extValue(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function assetHeaders(relPath: string, length: number): Record<string, string> {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return {
    "Content-Type": contentTypeOf(name) ?? FALLBACK_CONTENT_TYPE,
    "Content-Length": String(length),
    "Content-Disposition": `inline; filename="${asciiName(name)}"; filename*=UTF-8''${extValue(name)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "X-Content-Type-Options": "nosniff" } });
}

function unservable(ctx: WikiContext, relPath: string): (error: unknown) => null {
  return (error) => {
    ctx.log.debug(`Wiki could not serve ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  };
}

export async function serveAsset(ctx: WikiContext, relPath: string | undefined, rangeHeader: string | undefined): Promise<Response> {
  if (relPath === undefined || relPath === "") return jsonError(400, "Pass the asset as ?path=assets/<file>.");
  const found = await servableFile(ctx, relPath).catch(unservable(ctx, relPath));
  if (found === null) return jsonError(404, "Asset not found.");
  return fileResponse(found, relPath, rangeHeader);
}

export async function serveCardMedia(ctx: WikiContext, relPath: string | undefined, rangeHeader: string | undefined): Promise<Response> {
  if (relPath === undefined || relPath === "") return jsonError(400, "Pass the image as ?path=card-media/<card id>/<file>.");
  const found = await cardMediaFile(ctx, relPath).catch(unservable(ctx, relPath));
  if (found === null) return jsonError(404, "Image not found.");
  return fileResponse(found, relPath, rangeHeader);
}

async function fileResponse(found: { file: string; size: number }, relPath: string, rangeHeader: string | undefined): Promise<Response> {
  const range = parseRange(rangeHeader, found.size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${found.size}`, "Accept-Ranges": "bytes" } });
  }
  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : found.size - 1;
  const headers = assetHeaders(relPath, end - start + 1);
  if (range.kind === "partial") headers["Content-Range"] = `bytes ${start}-${end}/${found.size}`;
  const body = found.size === 0 ? null : await fileStream(found.file, start, end);
  return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
}

export function declaredLength(header: string | undefined): number | null {
  if (header === undefined || !/^\d+$/.test(header.trim())) return null;
  const value = Number(header.trim());
  return Number.isSafeInteger(value) ? value : null;
}

export async function receiveUpload(
  ctx: WikiContext,
  request: Request,
  name: string | undefined,
  options: HttpOptions,
): Promise<Response> {
  try {
    const length = declaredLength(request.headers.get("content-length") ?? undefined);
    const saved = await saveUpload(ctx, name ?? "", request.body, length, { limitBytes: options.uploadLimitBytes });
    return Response.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof MediaError) return jsonError(MEDIA_ERROR_STATUS[error.code], error.message);
    ctx.log.warn(`Wiki upload failed: ${error instanceof Error ? error.message : String(error)}`);
    return jsonError(500, "The upload could not be saved.");
  }
}

export function registerHttp(ctx: WikiContext, options: HttpOptions = {}): void {
  ctx.bb.http.route("GET", ASSET_PATH, (c) => serveAsset(ctx, c.req.query("path"), c.req.header("range")), { auth: "local" });
  ctx.bb.http.route("GET", CARD_MEDIA_PATH, (c) => serveCardMedia(ctx, c.req.query("path"), c.req.header("range")), { auth: "local" });
  ctx.bb.http.route(
    "POST",
    UPLOAD_PATH,
    (c) => receiveUpload(ctx, c.req.raw, c.req.query("name") ?? c.req.header("x-file-name"), options),
    { auth: "token" },
  );
}
