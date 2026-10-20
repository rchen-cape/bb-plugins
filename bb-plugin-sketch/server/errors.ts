import { z } from "zod";

export type SketchErrorCode =
  | "invalid-folder"
  | "invalid-content"
  | "not-found"
  | "name-taken"
  | "not-png"
  | "wiki";

export class SketchError extends Error {
  readonly code: SketchErrorCode;

  constructor(code: SketchErrorCode, message: string) {
    super(message);
    this.name = "SketchError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function isMissing(error: unknown): boolean {
  const code = fsErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

export function friendlyError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error(`Invalid Sketch data: ${issueText(error)}`);
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function friendly<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    try {
      const result: Awaited<R> = await fn(...args);
      return result;
    } catch (error) {
      throw friendlyError(error);
    }
  };
}

export function notFound(id: string): SketchError {
  return new SketchError("not-found", `No sketch is named “${id}”.`);
}

export function nameTaken(id: string): SketchError {
  return new SketchError("name-taken", `A sketch named “${id}” already exists.`);
}
