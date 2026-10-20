import { z } from "zod";
import { errorMessage, SketchError } from "./errors.js";

export const WIKI_NOT_INSTALLED = "The Wiki plugin isn't installed.";
export const WIKI_TURNED_OFF = "The Wiki plugin is turned off.";
export const WIKI_NOT_RUNNING = "The Wiki plugin isn't running.";
export const WIKI_NO_INBOX = "This Wiki version can't take inbox cards yet. Update the Wiki plugin, or pick a doc.";
export const WIKI_NO_INBOX_THREAD = "This Wiki version can't take inbox cards yet, and from a thread --doc files an inbox card too. Update the Wiki plugin.";
export const WIKI_TIMEOUT = "The Wiki didn't answer in time. Try again.";
export const WIKI_SEND_TIMEOUT = "The Wiki didn't answer in time. It may still add the image, so check the Wiki before you send it again.";
export const WIKI_BAD_REPLY = "The Wiki sent a reply Sketch doesn't understand. Update the Wiki and Sketch plugins.";

const TIMEOUT_NAMES: ReadonlySet<string> = new Set(["TimeoutError", "AbortError", "BbRequestTimeoutError"]);
const SEND_METHODS: ReadonlySet<string> = new Set(["addToDoc", "addCard"]);
const GAVE_UP_STATUSES: ReadonlySet<number> = new Set([408, 504]);

const httpErrorSchema = z.object({
  name: z.literal("BbHttpError"),
  status: z.number(),
  code: z.string().nullable().catch(null),
  message: z.string(),
  body: z.unknown(),
});

const errorBodySchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional().catch(undefined), message: z.string().optional().catch(undefined) })]),
});

export interface HttpFailure {
  status: number;
  code: string | null;
  message: string;
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

function errorField(error: object, key: string): unknown {
  return Reflect.get(error, key);
}

export function httpFailure(error: unknown): HttpFailure | null {
  if (!(error instanceof Error)) return null;
  const parsed = httpErrorSchema.safeParse({
    name: error.name,
    status: errorField(error, "status"),
    code: errorField(error, "code"),
    message: error.message,
    body: errorField(error, "body"),
  });
  if (!parsed.success) return null;
  const body = errorBodySchema.safeParse(parsed.data.body);
  const detail = body.success ? body.data.error : null;
  const nested = typeof detail === "string" || detail === null ? { code: undefined, message: detail ?? undefined } : detail;
  return {
    status: parsed.data.status,
    code: parsed.data.code ?? nested.code ?? null,
    message: nested.message ?? parsed.data.message.replace(/^HTTP \d+:\s*/, ""),
  };
}

export function isUnknownMethod(error: unknown): boolean {
  return httpFailure(error)?.code === "unknown_method";
}

export function wikiAnswered(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  const http = httpFailure(error);
  return http !== null && !GAVE_UP_STATUSES.has(http.status);
}

function unknownMethodMessage(method: string, threaded: boolean): string {
  if (method !== "addCard") return `This Wiki version has no “${method}” call. Update the Wiki plugin.`;
  return threaded ? WIKI_NO_INBOX_THREAD : WIKI_NO_INBOX;
}

function timeoutMessage(method: string): string {
  return SEND_METHODS.has(method) ? WIKI_SEND_TIMEOUT : WIKI_TIMEOUT;
}

function httpMessage(failure: HttpFailure, method: string, threaded: boolean): string {
  if (failure.code === "unknown_method") return unknownMethodMessage(method, threaded);
  if (failure.status === 404) return WIKI_NOT_INSTALLED;
  if (failure.status === 503) return /status: disabled\b/.test(failure.message) ? WIKI_TURNED_OFF : WIKI_NOT_RUNNING;
  if (GAVE_UP_STATUSES.has(failure.status)) return timeoutMessage(method);
  return failure.message;
}

export function wikiFailure(error: unknown, method: string, threaded = false): SketchError {
  if (error instanceof SketchError) return error;
  const http = httpFailure(error);
  if (http !== null) return new SketchError("wiki", httpMessage(http, method, threaded));
  if (error instanceof z.ZodError) return new SketchError("wiki", WIKI_BAD_REPLY);
  const name = errorName(error);
  if (name !== null && TIMEOUT_NAMES.has(name)) return new SketchError("wiki", timeoutMessage(method));
  return new SketchError("wiki", errorMessage(error));
}
