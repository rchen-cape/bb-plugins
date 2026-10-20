import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { titleSchema, type SketchStatus, type SketchSummary, type WikiAvailability } from "../contract.js";
import { parseSceneFile } from "../lib/scene.js";
import { DEFAULT_SKETCH_TITLE } from "../lib/sketch.js";
import { exportCommands } from "./cli-export.js";
import { readCliFile } from "./cli-files.js";
import { guarded, jsonOption, output, parseOrThrow, plural, printText, shellArg, STATUS_HINT, summaryOnly } from "./cli-output.js";
import { requireSketch, resolveSketchId, sketchPositional } from "./cli-resolve.js";
import { sendCommands } from "./cli-send.js";
import type { SketchContext } from "./context.js";
import { displayFolder } from "./folder.js";
import { statusOf } from "./status.js";

export const CLI_NAME = "sketch";

const TITLE_HINT = "Titles are 1 to 120 characters.";
const SETTINGS_HINT = "Check the Sketch settings with `bb plugin config sketch`.";

export function listLines(sketches: readonly SketchSummary[]): string[] {
  if (sketches.length === 0) return ["No sketches yet. Create one with `bb sketch new`."];
  return sketches.map((sketch) => [sketch.title, plural(sketch.elementCount, "element"), sketch.updatedAt].join("\t"));
}

export function wikiLine(wiki: WikiAvailability): string {
  if (!wiki.available) return `Wiki: ${wiki.reason}`;
  return wiki.inbox ? "Wiki: ready for images" : "Wiki: ready (doc only — update the Wiki plugin for inbox cards)";
}

export function statusLines(status: SketchStatus): string[] {
  return [`Sketch folder: ${status.directory}`, `Sketches: ${status.sketchCount}`, wikiLine(status.wiki)];
}

export function unreadCounts(content: string): { skipped: number; placeholders: number } {
  const { dropped, placeholders } = parseSceneFile(content);
  return { skipped: dropped, placeholders };
}

export function unreadLines({ skipped, placeholders }: { skipped: number; placeholders: number }): string[] {
  const lines: string[] = [];
  if (skipped > 0) lines.push(`Skipped ${plural(skipped, "element")} Sketch can't read. Each element needs a unique id and numbers for x and y.`);
  if (placeholders > 0) lines.push(`Kept ${plural(placeholders, "element")} with fields Sketch can't read as ${placeholders === 1 ? "a placeholder" : "placeholders"}.`);
  return lines;
}

export function titleFromPath(file: string): string | null {
  const base = file.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/(\.excalidraw)?(\.json)?$/i, "").trim();
  return stem === "" ? null : stem;
}

function typedTitle(words: readonly string[]): string | null {
  const joined = words.join(" ").trim();
  return joined === "" ? null : parseOrThrow(titleSchema, joined, TITLE_HINT, "title");
}

async function folderLabel(ctx: SketchContext): Promise<string> {
  return displayFolder(await ctx.root());
}

function readCommands(ctx: SketchContext) {
  return {
    list: cliCommand({
      summary: "List sketches, newest first (name, element count, updated)",
      aliases: ["ls"],
      options: jsonOption,
      async run({ options }) {
        const sketches = await guarded(STATUS_HINT, () => ctx.store.list());
        return output(options.json, sketches, listLines(sketches), "Look in the Sketch folder instead; `bb sketch status` prints where it is.");
      },
    }),
    show: cliCommand({
      summary: "Print a sketch's .excalidraw JSON",
      aliases: ["cat", "get"],
      positionals: [sketchPositional],
      options: jsonOption,
      async run({ positionals, options }) {
        const sketch = await requireSketch(ctx, await resolveSketchId(ctx, positionals.sketch.join(" ")));
        const hint = `Run \`bb sketch export ${shellArg(sketch.id)} --out <path>\` to write it to a file.`;
        return options.json ? output(true, sketch, [], hint) : printText(sketch.content, hint);
      },
    }),
  };
}

function statusCommand(ctx: SketchContext) {
  return {
    status: cliCommand({
      summary: "Show the Sketch folder, its sketch count, and whether the Wiki can take images",
      options: jsonOption,
      async run({ options }) {
        const status = await guarded(SETTINGS_HINT, () => statusOf(ctx));
        return output(options.json, status, statusLines(status));
      },
    }),
  };
}

function writeCommands(ctx: SketchContext) {
  return {
    new: cliCommand({
      summary: "Create a sketch, empty or from .excalidraw JSON",
      aliases: ["create"],
      positionals: [
        {
          name: "title",
          description: `Title (default: the --file name, else ${DEFAULT_SKETCH_TITLE}); a taken title gets " 2", " 3", ...`,
          variadic: true,
        },
      ],
      options: {
        ...jsonOption,
        file: { type: "string", placeholder: "path", description: "Start from this .excalidraw file: absolute, ~/, or relative to the current folder" },
        content: { type: "string", stdin: true, placeholder: "json", description: "Start from this .excalidraw JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["file", "content"] }],
      async run({ positionals, options }, cli) {
        const source = options.file === undefined ? null : await guarded(STATUS_HINT, () => readCliFile(ctx.bb, cli, options.file ?? ""));
        const title = typedTitle(positionals.title) ?? (source === null ? null : titleFromPath(source.path));
        const created = await guarded(STATUS_HINT, () => ctx.store.create(title, source?.text ?? options.content ?? null));
        const line = `Created “${created.title}” (${plural(created.elementCount, "element")}) in ${await folderLabel(ctx)}.`;
        const unread = unreadCounts(created.content);
        return output(options.json, { ...summaryOnly(created), ...unread }, [line, ...unreadLines(unread)]);
      },
    }),
    rename: cliCommand({
      summary: "Rename a sketch",
      aliases: ["mv"],
      positionals: [
        { name: "sketch", description: "Sketch name; case doesn't matter and a unique prefix works", required: true },
        { name: "title", description: "New title", required: true, variadic: true },
      ],
      options: jsonOption,
      async run({ positionals, options }) {
        const id = await resolveSketchId(ctx, positionals.sketch);
        const title = parseOrThrow(titleSchema, positionals.title.join(" "), TITLE_HINT, "title");
        const renamed = await guarded(STATUS_HINT, () => ctx.store.rename(id, title));
        const line = renamed.id === id ? `“${id}” already has that name.` : `Renamed “${id}” to “${renamed.title}”.`;
        return output(options.json, renamed, [line]);
      },
    }),
    duplicate: cliCommand({
      summary: 'Copy a sketch to "<name> copy"',
      aliases: ["copy", "cp"],
      positionals: [sketchPositional],
      options: jsonOption,
      async run({ positionals, options }) {
        const id = await resolveSketchId(ctx, positionals.sketch.join(" "));
        const copy = await guarded(STATUS_HINT, () => ctx.store.duplicate(id));
        return output(options.json, copy, [`Copied “${id}” to “${copy.title}”.`]);
      },
    }),
    delete: cliCommand({
      summary: "Delete a sketch file and its image",
      aliases: ["rm", "remove"],
      positionals: [sketchPositional],
      options: jsonOption,
      async run({ positionals, options }) {
        const id = await resolveSketchId(ctx, positionals.sketch.join(" "));
        const deleted = await guarded(STATUS_HINT, () => ctx.store.remove(id));
        return output(options.json, deleted, [`Deleted “${deleted.id}”.`]);
      },
    }),
  };
}

export function registerCli(ctx: SketchContext): void {
  ctx.bb.cli.register(
    defineCli({
      name: CLI_NAME,
      summary: "List, create, and export sketches, and send them to the Wiki",
      commands: { ...readCommands(ctx), ...writeCommands(ctx), ...exportCommands(ctx), ...sendCommands(ctx), ...statusCommand(ctx) },
    }),
  );
}
