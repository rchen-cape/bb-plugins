import { PluginCliError } from "@get-bb/plugin-sdk";
import type { SketchDetail } from "../contract.js";
import { matchSketch } from "./cli-match.js";
import { guarded, SKETCH_HINT, STATUS_HINT } from "./cli-output.js";
import type { SketchContext } from "./context.js";
import { notFound } from "./errors.js";

const LISTED_MATCHES = 5;

export const sketchPositional = {
  name: "sketch",
  description: "Sketch name; case doesn't matter and a unique prefix works",
  required: true,
  variadic: true,
} as const;

function quotedList(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_MATCHES).map((name) => `“${name}”`);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export async function resolveSketchId(ctx: SketchContext, ref: string): Promise<string> {
  const ids = await guarded(STATUS_HINT, () => ctx.store.ids());
  const match = matchSketch(ids, ref);
  if (match.kind === "one") return match.item;
  if (match.kind === "many") {
    throw new PluginCliError(`“${ref.trim()}” matches ${match.items.length} sketches: ${quotedList(match.items)}.`, {
      code: "ambiguous",
      hint: "Type more of the name, or the whole name in quotes.",
    });
  }
  throw new PluginCliError(`No sketch matches “${ref.trim()}”.`, { code: "not_found", hint: SKETCH_HINT });
}

export async function requireSketch(ctx: SketchContext, id: string): Promise<SketchDetail> {
  return guarded(SKETCH_HINT, async () => {
    const sketch = await ctx.store.get(id);
    if (sketch === null) throw notFound(id);
    return sketch;
  });
}

export function noImage(id: string): PluginCliError {
  return new PluginCliError(`Open “${id}” in bb once so Sketch can draw its image.`, {
    code: "no_image",
    hint: "Open the Sketch page in bb and pick the sketch, then run this again.",
  });
}
