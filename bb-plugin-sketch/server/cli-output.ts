import { PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SketchDetail, SketchSummary } from "../contract.js";
import { errorMessage, issueText, SketchError, type SketchErrorCode } from "./errors.js";

export const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

export const SKETCH_HINT = "Run `bb sketch list` to see sketch names.";
export const STATUS_HINT = "Run `bb sketch status` to check the Sketch folder.";
export const WIKI_HINT = "Run `bb sketch status` to check the Wiki.";
export const OUT_HINT = "Pass --out <path> to write it to a file instead.";
export const CONTENT_HINT = 'Sketch reads Excalidraw JSON like {"type":"excalidraw","elements":[]}.';

const CODES: Readonly<Record<SketchErrorCode, string>> = {
  "invalid-folder": "invalid_folder",
  "invalid-content": "invalid_content",
  "not-found": "not_found",
  "name-taken": "name_taken",
  "not-png": "invalid_value",
  wiki: "wiki_failed",
};

const HINTS: Partial<Readonly<Record<SketchErrorCode, string>>> = {
  "invalid-folder": "Check the sketchDirectory setting with `bb plugin config sketch`.",
  "invalid-content": CONTENT_HINT,
  "not-found": SKETCH_HINT,
  "name-taken": "Pick another name. Run `bb sketch list` to see the names in use.",
  wiki: WIKI_HINT,
};

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fitting(stdout: string, hint: string): string {
  const bytes = Buffer.byteLength(stdout, "utf8");
  if (bytes <= PLUGIN_CLI_OUTPUT_MAX_BYTES) return stdout;
  throw new PluginCliError(`The output is ${megabytes(bytes)}, more than the ${megabytes(PLUGIN_CLI_OUTPUT_MAX_BYTES)} a bb command can print.`, {
    code: "output_too_large",
    hint,
  });
}

export function output(asJson: boolean, value: unknown, lines: readonly string[], hint: string = OUT_HINT): PluginCliResult {
  const stdout = asJson ? `${JSON.stringify(value)}\n` : lines.map((line) => `${line}\n`).join("");
  return { exitCode: 0, stdout: fitting(stdout, hint) };
}

export function printText(text: string, hint: string = OUT_HINT): PluginCliResult {
  return { exitCode: 0, stdout: fitting(text.endsWith("\n") ? text : `${text}\n`, hint) };
}

export function failure(error: unknown, hint: string): PluginCliError {
  if (error instanceof PluginCliError) return error;
  if (error instanceof SketchError) return new PluginCliError(error.message, { code: CODES[error.code], hint: HINTS[error.code] ?? hint });
  if (error instanceof z.ZodError) return new PluginCliError(issueText(error), { code: "invalid_value", hint });
  return new PluginCliError(errorMessage(error), { code: "command_failed", hint });
}

export async function guarded<T>(hint: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw failure(error, hint);
  }
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, hint: string, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new PluginCliError(`${issue?.path.join(".") || label}: ${issue?.message ?? "invalid"}`, { code: "invalid_value", hint });
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function cliThreadId(cli: PluginCliContext): string | null {
  return typeof cli.threadId === "string" && cli.threadId !== "" ? cli.threadId : null;
}

export function shellArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function summaryOnly(detail: SketchDetail): SketchSummary {
  return { id: detail.id, title: detail.title, updatedAt: detail.updatedAt, elementCount: detail.elementCount, sizeBytes: detail.sizeBytes };
}
