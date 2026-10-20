import { z } from "zod";
import { parseElements, type LinearElement, type ShapeElement, type SketchElement } from "./scene-elements.js";
import { FILE_SOURCE, LIMITS } from "./sketch.js";

export {
  FILL_STYLES,
  LINEAR_TYPES,
  newSeed,
  parseElement,
  parseElements,
  SHAPE_TYPES,
  STROKE_STYLES,
  TEXT_ALIGNS,
  VERTICAL_ALIGNS,
} from "./scene-elements.js";
export type {
  Binding,
  BoundElement,
  ElementType,
  FillStyle,
  FreedrawElement,
  LinearElement,
  LinearType,
  ParsedElements,
  Roundness,
  ShapeElement,
  ShapeType,
  SketchElement,
  StrokeStyle,
  StyledElement,
  TextAlign,
  TextElement,
  UnsupportedElement,
  VerticalAlign,
} from "./scene-elements.js";

export type SceneAppState = Record<string, unknown>;
export type Scene = {
  elements: readonly SketchElement[];
  appState: SceneAppState;
  files: Record<string, unknown>;
};

export class SceneFileError extends Error {
  override name = "SceneFileError";
}

const envelopeSchema = z.object({
  type: z.literal("excalidraw"),
  version: z.number().int().positive().catch(2),
  source: z.string().optional().catch(undefined),
  elements: z.array(z.unknown()).max(LIMITS.elements),
  appState: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
  files: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
});

const clipboardSchema = z.object({
  type: z.literal("excalidraw/clipboard"),
  elements: z.array(z.unknown()).max(LIMITS.elements),
  files: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
});

export function parseSceneFile(text: string): { scene: Scene; dropped: number; placeholders: number } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SceneFileError("This isn't valid JSON.");
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) throw new SceneFileError("This is not an Excalidraw file.");
  const { elements, dropped, placeholders } = parseElements(envelope.data.elements);
  return {
    scene: { elements, appState: envelope.data.appState ?? {}, files: envelope.data.files ?? {} },
    dropped,
    placeholders,
  };
}

export function parseClipboard(text: string): SketchElement[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const clipboard = clipboardSchema.safeParse(json);
  if (clipboard.success) return parseElements(clipboard.data.elements).elements;
  const envelope = envelopeSchema.safeParse(json);
  if (envelope.success) return parseElements(envelope.data.elements).elements;
  return null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPoints(points: readonly (readonly [number, number])[]): [number, number][] {
  return points.map(([x, y]) => [round(x), round(y)]);
}

export function elementToJson(element: SketchElement): Record<string, unknown> {
  if (element.type === "unsupported") {
    const { raw, originalType, type: _type, ...placement } = element;
    return {
      ...raw,
      ...placement,
      type: originalType,
      x: round(placement.x),
      y: round(placement.y),
      width: round(placement.width),
      height: round(placement.height),
    };
  }
  const json: Record<string, unknown> = {
    ...element,
    x: round(element.x),
    y: round(element.y),
    width: round(element.width),
    height: round(element.height),
  };
  if (element.customData === undefined) delete json.customData;
  if (element.type === "arrow" || element.type === "line" || element.type === "freedraw") {
    const points = roundPoints(element.points);
    json.points = points;
    json.lastCommittedPoint = element.type === "freedraw" ? (points[points.length - 1] ?? null) : null;
  }
  if ((element.type === "arrow" || element.type === "line") && element.elbowed === undefined) delete json.elbowed;
  return json;
}

export function serializeElements(elements: readonly SketchElement[]): Record<string, unknown>[] {
  return elements.map(elementToJson);
}

export function serializeScene(scene: Scene): string {
  return `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: FILE_SOURCE,
      elements: serializeElements(scene.elements),
      appState: scene.appState,
      files: scene.files,
    },
    null,
    2,
  )}\n`;
}

export function serializeClipboard(elements: readonly SketchElement[]): string {
  return JSON.stringify({ type: "excalidraw/clipboard", elements: serializeElements(elements), files: {} });
}

export function emptyScene(): Scene {
  return { elements: [], appState: { viewBackgroundColor: "#ffffff", gridSize: 20, gridModeEnabled: false }, files: {} };
}

export function gridEnabled(appState: SceneAppState): boolean {
  return appState.gridModeEnabled === true;
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newElementId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

export function newVersionNonce(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

export function isLinear(element: SketchElement): element is LinearElement {
  return element.type === "arrow" || element.type === "line";
}

export function isShape(element: SketchElement): element is ShapeElement {
  return element.type === "rectangle" || element.type === "diamond" || element.type === "ellipse";
}
