import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { uploadIdSchema, type MediaSource, type MessageMediaItem, type UploadInfo } from "../contract.js";
import { LIMITS, MEDIA_EXTENSIONS, mediaKindOf, type MediaKind } from "../lib/wiki.js";
import type { WikiContext } from "./context.js";

export const UPLOADS_DIR = "uploads";
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60_000;
export const MESSAGE_MEDIA_LIMIT = LIMITS.media;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 12;
const UPLOAD_ENTRY = /^upl_[a-z0-9]{12}(?:\.[a-z0-9]{1,10})?$/;
const SIDECAR_EXTENSION = ".json";
const TEXT_BYTES = LIMITS.text * 4;
const MESSAGE_CANDIDATES = 100;
const EXTENSIONS = MEDIA_EXTENSIONS.map((extension) => extension.slice(1)).join("|");
const PATH_STOP = "\\s\"'`<>()[\\]{}|*?\\/";
const QUOTES = "\"'`";
const BARE_MEDIA_PATH = new RegExp(
  `(?<![\\w/.~-])(\\/(?:[^${PATH_STOP}]+\\/)*[^${PATH_STOP}]+\\.(?:${EXTENSIONS}))(?!\\.?[\\w-])`,
  "gi",
);
const QUOTED_MEDIA_PATH = new RegExp(`([${QUOTES}])(\\/[^${QUOTES}\\n]*?\\.(?:${EXTENSIONS}))\\1`, "gi");

export type MediaErrorCode = "invalid-name" | "unsupported" | "too-large" | "missing" | "invalid-path";

export class MediaError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

export interface UploadOptions {
  limitBytes?: number;
}

export interface SavedUpload {
  uploadId: string;
  name: string;
  sizeBytes: number;
}

export interface ResolvedMedia {
  path: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
}

export type EmbedKind = "image" | "video";

type MediaContext = Pick<WikiContext, "dataDir">;

interface StoredUpload {
  uploadId: string;
  file: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
}

interface PathCandidate {
  path: string;
  name: string | null;
}

const sidecarSchema = z.object({
  name: z.string().min(1),
  file: z.string().regex(UPLOAD_ENTRY),
  createdAt: z.string(),
});

const attachmentsSchema = z.object({
  localImagePaths: z.array(z.string()).catch([]),
  localFilePaths: z.array(z.string()).catch([]),
  localFileDetails: z.array(z.object({ path: z.string(), name: z.string() })).catch([]),
});

const messageResponseSchema = z.object({
  message: z.object({ text: z.string().catch(""), attachments: attachmentsSchema.nullable().catch(null) }),
});

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unit] ?? "bytes"}`;
}

function tooLarge(name: string, limit: number): MediaError {
  return new MediaError("too-large", `${name} is larger than the ${formatBytes(limit)} upload limit.`);
}

function unsupported(name: string): MediaError {
  return new MediaError("unsupported", `${name} is not a supported file type. Use ${MEDIA_EXTENSIONS.join(" ")}.`);
}

function extensionOf(name: string): string {
  return /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0].toLowerCase() ?? "";
}

export function cleanUploadName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(-LIMITS.title);
}

export function uploadsDir(ctx: MediaContext): string {
  return path.join(ctx.dataDir(), UPLOADS_DIR);
}

function sidecarPath(folder: string, uploadId: string): string {
  return path.join(folder, `${uploadId}${SIDECAR_EXTENSION}`);
}

function newUploadId(): string {
  const chars = [...randomBytes(ID_LENGTH)].map((byte) => ID_ALPHABET.charAt(byte % ID_ALPHABET.length));
  return `upl_${chars.join("")}`;
}

async function writeChunk(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset);
    offset += bytesWritten;
  }
}

async function pumpBody(
  handle: Awaited<ReturnType<typeof open>>,
  body: ReadableStream<Uint8Array>,
  limit: number,
  name: string,
): Promise<number> {
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return size;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(name, limit);
      }
      await writeChunk(handle, value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeBody(file: string, body: ReadableStream<Uint8Array> | null, limit: number, name: string): Promise<number> {
  const handle = await open(file, "wx");
  try {
    return body === null ? 0 : await pumpBody(handle, body, limit, name);
  } finally {
    await handle.close();
  }
}

async function removeUpload(folder: string, uploadId: string, file: string): Promise<void> {
  await rm(path.join(folder, file), { force: true });
  await rm(sidecarPath(folder, uploadId), { force: true });
}

export async function saveUpload(
  ctx: MediaContext,
  rawName: string,
  body: ReadableStream<Uint8Array> | null,
  contentLength: number | null,
  options: UploadOptions = {},
): Promise<SavedUpload> {
  const limit = options.limitBytes ?? LIMITS.uploadBytes;
  const name = cleanUploadName(rawName);
  if (name === "") throw new MediaError("invalid-name", "The upload needs a file name, like ?name=screenshot.png.");
  if (mediaKindOf(name) === null) throw unsupported(name);
  if (contentLength !== null && contentLength > limit) throw tooLarge(name, limit);
  const folder = uploadsDir(ctx);
  await mkdir(folder, { recursive: true });
  const uploadId = newUploadId();
  const file = `${uploadId}${extensionOf(name)}`;
  try {
    const sizeBytes = await writeBody(path.join(folder, file), body, limit, name);
    const sidecar = { name, file, createdAt: new Date().toISOString() };
    await writeFile(sidecarPath(folder, uploadId), JSON.stringify(sidecar), { flag: "wx" });
    return { uploadId, name, sizeBytes };
  } catch (error) {
    await removeUpload(folder, uploadId, file);
    throw error;
  }
}

async function readSidecar(folder: string, uploadId: string): Promise<z.infer<typeof sidecarSchema> | null> {
  try {
    const parsed = sidecarSchema.safeParse(JSON.parse(await readFile(sidecarPath(folder, uploadId), "utf8")));
    return parsed.success && parsed.data.file.startsWith(uploadId) ? parsed.data : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function findUpload(ctx: MediaContext, uploadId: string): Promise<StoredUpload | null> {
  if (!uploadIdSchema.safeParse(uploadId).success) return null;
  const folder = uploadsDir(ctx);
  const sidecar = await readSidecar(folder, uploadId);
  const kind = sidecar === null ? null : mediaKindOf(sidecar.name);
  if (sidecar === null || kind === null) return null;
  const file = path.join(folder, sidecar.file);
  const stats = await lstat(file).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stats === null || !stats.isFile()) return null;
  return { uploadId, file, name: sidecar.name, kind, sizeBytes: stats.size };
}

async function requireUpload(ctx: MediaContext, uploadId: string): Promise<StoredUpload> {
  const upload = await findUpload(ctx, uploadId);
  if (upload === null) throw new MediaError("missing", `Upload ${uploadId} is gone. Uploads are kept for 24 hours; upload the file again.`);
  return upload;
}

export async function uploadPath(ctx: MediaContext, uploadId: string): Promise<string | null> {
  return (await findUpload(ctx, uploadId))?.file ?? null;
}

export function isTextKind(kind: MediaKind): boolean {
  return kind === "markdown" || kind === "text";
}

export async function readMediaText(file: string, name: string, sizeBytes: number): Promise<string> {
  const limit = `${LIMITS.text.toLocaleString("en-US")} characters`;
  if (sizeBytes > TEXT_BYTES) throw new MediaError("too-large", `${name} is too long to add as text (over ${limit}).`);
  const text = (await readFile(file, "utf8")).replace(/^﻿/, "");
  if (text.length > LIMITS.text) throw new MediaError("too-large", `${name} is too long to add as text (over ${limit}).`);
  return text;
}

export async function importUpload(ctx: MediaContext, uploadId: string): Promise<UploadInfo> {
  const upload = await requireUpload(ctx, uploadId);
  const text = isTextKind(upload.kind) ? await readMediaText(upload.file, upload.name, upload.sizeBytes) : null;
  return { uploadId, name: upload.name, kind: upload.kind, sizeBytes: upload.sizeBytes, text };
}

async function removeIfOld(folder: string, name: string, cutoff: number): Promise<boolean> {
  const target = path.join(folder, name);
  const stats = await lstat(target).catch(() => null);
  if (stats === null || stats.mtimeMs > cutoff) return false;
  await rm(target, { force: true, recursive: stats.isDirectory() });
  return true;
}

export async function cleanupUploads(ctx: MediaContext, olderThanMs: number = UPLOAD_MAX_AGE_MS, now: number = Date.now()): Promise<number> {
  const folder = uploadsDir(ctx);
  const names = await readdir(folder).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  let removed = 0;
  for (const name of names) {
    if (!UPLOAD_ENTRY.test(name)) continue;
    if ((await removeIfOld(folder, name, now - olderThanMs)) && !name.endsWith(SIDECAR_EXTENSION)) removed += 1;
  }
  return removed;
}

export function extractMediaPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(QUOTED_MEDIA_PATH)) if (match[2] !== undefined) found.add(match[2]);
  for (const match of text.matchAll(BARE_MEDIA_PATH)) if (match[1] !== undefined) found.add(match[1]);
  return [...found];
}

function messageCandidates(text: string, attachments: z.infer<typeof attachmentsSchema> | null): PathCandidate[] {
  return [
    ...(attachments?.localImagePaths ?? []).map((file) => ({ path: file, name: null })),
    ...(attachments?.localFileDetails ?? []).map((detail) => ({ path: detail.path, name: detail.name })),
    ...(attachments?.localFilePaths ?? []).map((file) => ({ path: file, name: null })),
    ...extractMediaPaths(text).map((file) => ({ path: file, name: null })),
  ];
}

function isUsablePath(file: string): boolean {
  return file !== "" && !file.includes("\0") && path.isAbsolute(file);
}

async function existingMedia(candidate: PathCandidate): Promise<MessageMediaItem | null> {
  if (!isUsablePath(candidate.path)) return null;
  const name = cleanUploadName(candidate.name ?? "") || path.basename(candidate.path);
  const kind = mediaKindOf(candidate.path) ?? mediaKindOf(name);
  if (kind === null) return null;
  const stats = await stat(candidate.path).catch(() => null);
  if (stats === null || !stats.isFile()) return null;
  return { path: path.normalize(candidate.path), name, kind, sizeBytes: stats.size };
}

function uniqueCandidates(candidates: readonly PathCandidate[]): PathCandidate[] {
  const seen = new Map<string, PathCandidate>();
  for (const candidate of candidates) {
    const key = path.normalize(candidate.path);
    const previous = seen.get(key);
    if (previous === undefined || (previous.name === null && candidate.name !== null)) seen.set(key, candidate);
  }
  return [...seen.values()].slice(0, MESSAGE_CANDIDATES);
}

export async function messageMedia(ctx: Pick<WikiContext, "bb">, threadId: string, messageSeq: number): Promise<MessageMediaItem[]> {
  const response = messageResponseSchema.safeParse(await ctx.bb.sdk.threads.message({ threadId, seq: messageSeq }));
  if (!response.success) throw new Error(`Could not read message ${messageSeq} in thread ${threadId}.`);
  const { text, attachments } = response.data.message;
  const items: MessageMediaItem[] = [];
  const seen = new Set<string>();
  for (const candidate of uniqueCandidates(messageCandidates(text, attachments))) {
    const item = await existingMedia(candidate);
    if (item === null || seen.has(item.path)) continue;
    seen.add(item.path);
    items.push(item);
    if (items.length >= MESSAGE_MEDIA_LIMIT) break;
  }
  return items;
}

async function resolvePath(file: string): Promise<ResolvedMedia> {
  if (!isUsablePath(file)) throw new MediaError("invalid-path", `Media paths must be absolute, got ${JSON.stringify(file)}.`);
  const name = path.basename(file);
  const kind = mediaKindOf(file);
  if (kind === null) throw unsupported(name);
  const stats = await stat(file).catch((error: unknown) => {
    if (isMissing(error)) throw new MediaError("missing", `${file} does not exist.`);
    throw error;
  });
  if (!stats.isFile()) throw new MediaError("invalid-path", `${file} is not a file.`);
  return { path: file, name, kind, sizeBytes: stats.size };
}

export async function resolveMediaSource(ctx: MediaContext, from: MediaSource): Promise<ResolvedMedia> {
  if (from.kind === "path") return resolvePath(from.path);
  const upload = await requireUpload(ctx, from.uploadId);
  return { path: upload.file, name: upload.name, kind: upload.kind, sizeBytes: upload.sizeBytes };
}

function altText(caption: string): string {
  return caption.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (char) => `\\${char}`);
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkTarget(relPath: string): string {
  return /[\s<>()]/.test(relPath) ? `<${relPath}>` : relPath;
}

export function embedFor(relPath: string, kind: EmbedKind, caption: string): string {
  const text = caption.trim();
  if (kind === "image") return `![${altText(text)}](${linkTarget(relPath)})`;
  const video = `<video controls src="${attribute(relPath)}"></video>`;
  return text === "" ? video : `${video}\n\n${text}`;
}
