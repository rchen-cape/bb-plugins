import { cliCommand, PluginCliError, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { parseSceneFile } from "../lib/scene.js";
import { EXPORT_BACKGROUND, EXPORT_PADDING } from "../lib/sketch.js";
import { sceneToSvg } from "../lib/svg-export.js";
import { writeCliFile } from "./cli-files.js";
import { guarded, jsonOption, output, printText, shellArg, SKETCH_HINT } from "./cli-output.js";
import { noImage, requireSketch, resolveSketchId, sketchPositional } from "./cli-resolve.js";
import type { SketchContext } from "./context.js";
import { pngSize } from "./previews.js";

export const EXPORT_FORMATS = ["excalidraw", "svg", "png"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = { excalidraw: ".excalidraw JSON", svg: "SVG", png: "PNG" };

interface Artifact {
  bytes: Buffer;
  width: number | null;
  height: number | null;
}

export function formatFor(format: ExportFormat | undefined, out: string | undefined): ExportFormat {
  if (format !== undefined) return format;
  const extension = /\.([a-z]+)$/i.exec(out?.trim() ?? "")?.[1]?.toLowerCase();
  return extension === "png" || extension === "svg" ? extension : "excalidraw";
}

export function svgFor(content: string): { svg: string; width: number; height: number } {
  const { elements } = parseSceneFile(content).scene;
  return sceneToSvg(elements, { padding: EXPORT_PADDING, background: EXPORT_BACKGROUND, embedFont: true });
}

async function textArtifact(ctx: SketchContext, id: string, format: "excalidraw" | "svg"): Promise<Artifact> {
  const sketch = await requireSketch(ctx, id);
  if (format === "excalidraw") return { bytes: Buffer.from(sketch.content, "utf8"), width: null, height: null };
  const svg = await guarded(SKETCH_HINT, async () => svgFor(sketch.content));
  return { bytes: Buffer.from(svg.svg, "utf8"), width: svg.width, height: svg.height };
}

async function pngArtifact(ctx: SketchContext, id: string): Promise<Artifact> {
  const { png } = await guarded(SKETCH_HINT, () => ctx.store.freshPreview(id));
  if (png === null) throw noImage(id);
  const size = pngSize(png);
  return { bytes: png, width: size?.width ?? null, height: size?.height ?? null };
}

function needsOut(id: string): PluginCliError {
  return new PluginCliError("PNG export needs --out <path>, because a PNG can't be printed.", {
    code: "missing_required",
    hint: `Add --out with a file path, like --out ${shellArg(`~/Desktop/${id}.png`)}.`,
  });
}

async function runExport(
  ctx: SketchContext,
  cli: PluginCliContext,
  options: { json: boolean; format?: ExportFormat | undefined; out?: string | undefined },
  ref: string,
): Promise<PluginCliResult> {
  const id = await resolveSketchId(ctx, ref);
  const format = formatFor(options.format, options.out);
  if (format === "png" && options.out === undefined) throw needsOut(id);
  const artifact = format === "png" ? await pngArtifact(ctx, id) : await textArtifact(ctx, id, format);
  const size = { width: artifact.width, height: artifact.height };
  if (options.out === undefined) {
    const text = artifact.bytes.toString("utf8");
    return options.json ? output(true, { id, format, ...size, content: text }, []) : printText(text);
  }
  const out = options.out;
  const written = await guarded(SKETCH_HINT, () => writeCliFile(ctx.bb, cli, out, artifact.bytes, `${id}.${format}`));
  const value = { id, format, path: written.path, sizeBytes: artifact.bytes.length, ...size };
  return output(options.json, value, [`Wrote “${id}” as ${FORMAT_LABELS[format]} to ${written.display}.`]);
}

export function exportCommands(ctx: SketchContext) {
  return {
    export: cliCommand({
      summary: "Export a sketch as .excalidraw JSON, SVG, or PNG",
      description:
        "excalidraw and svg print to stdout unless --out is given. png needs --out and uses the image Sketch drew the last time the sketch was open in bb.",
      positionals: [sketchPositional],
      options: {
        ...jsonOption,
        format: { type: "enum", values: EXPORT_FORMATS, description: "excalidraw, svg, or png (default: from the --out extension, else excalidraw)" },
        out: { type: "string", placeholder: "path", description: "File to write: absolute, ~/, or relative to the current folder; a folder gets <name>.<format>" },
      },
      run: ({ positionals, options }, cli) => runExport(ctx, cli, options, positionals.sketch.join(" ")),
    }),
  };
}
