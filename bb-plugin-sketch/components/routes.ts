import { sketchIdSchema, type SketchSummary } from "../contract";

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function routeSketchId(subPath: string): string | null {
  const trimmed = subPath.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return null;
  const decoded = safeDecode(trimmed);
  if (decoded === null) return null;
  const parsed = sketchIdSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export function sketchSubPath(id: string): string {
  return id;
}

export function defaultSketch(sketches: readonly SketchSummary[], last: string | null): string | null {
  if (last !== null && sketches.some((sketch) => sketch.id === last)) return last;
  return sketches[0]?.id ?? null;
}

const UNSAFE_TITLE = /[/\\:*?"<>|\u0000-\u001f\u007f]+/g;

export function titleFromFileName(name: string, limit: number): string | null {
  const stem = name.replace(/\.excalidraw(\.json)?$/i, "").replace(/\.json$/i, "");
  const cleaned = [...stem.replace(UNSAFE_TITLE, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "")].slice(0, limit).join("").trim();
  return cleaned === "" ? null : cleaned;
}
