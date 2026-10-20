import { z } from "zod";
import { DEFAULT_STYLE, LINE_HEIGHT } from "./sketch.js";

export const SHAPE_TYPES = ["rectangle", "diamond", "ellipse"] as const;
export const LINEAR_TYPES = ["arrow", "line"] as const;
export const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"] as const;
export const STROKE_STYLES = ["solid", "dashed", "dotted"] as const;
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export const VERTICAL_ALIGNS = ["top", "middle", "bottom"] as const;

export type ShapeType = (typeof SHAPE_TYPES)[number];
export type LinearType = (typeof LINEAR_TYPES)[number];
export type FillStyle = (typeof FILL_STYLES)[number];
export type StrokeStyle = (typeof STROKE_STYLES)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];

const colorSchema = z.string().trim().min(1).max(64);
const pointSchema = z.tuple([z.number(), z.number()]);

const boundElementSchema = z.object({ id: z.string().min(1), type: z.enum(["arrow", "text"]) });
export type BoundElement = z.infer<typeof boundElementSchema>;

const bindingSchema = z.object({
  elementId: z.string().min(1),
  focus: z.number().catch(0),
  gap: z.number().catch(4),
});
export type Binding = z.infer<typeof bindingSchema>;

const roundnessSchema = z.object({ type: z.number().int(), value: z.number().optional() });
export type Roundness = z.infer<typeof roundnessSchema>;

const placementFields = {
  id: z.string().min(1).max(200),
  x: z.number(),
  y: z.number(),
  width: z.number().catch(0),
  height: z.number().catch(0),
  angle: z.number().catch(0),
  version: z.number().int().nonnegative().catch(1),
  versionNonce: z.number().int().catch(0),
  isDeleted: z.boolean().catch(false),
  groupIds: z.array(z.string()).catch([]),
  frameId: z.string().nullable().catch(null),
  updated: z.number().catch(0),
  link: z.string().nullable().catch(null),
  locked: z.boolean().catch(false),
};

const styleFields = {
  strokeColor: colorSchema.catch(DEFAULT_STYLE.strokeColor),
  backgroundColor: colorSchema.catch(DEFAULT_STYLE.backgroundColor),
  fillStyle: z.enum(FILL_STYLES).catch(DEFAULT_STYLE.fillStyle),
  strokeWidth: z.number().positive().max(100).catch(DEFAULT_STYLE.strokeWidth),
  strokeStyle: z.enum(STROKE_STYLES).catch(DEFAULT_STYLE.strokeStyle),
  roughness: z.number().min(0).max(10).catch(DEFAULT_STYLE.roughness),
  opacity: z.number().min(0).max(100).catch(DEFAULT_STYLE.opacity),
  roundness: roundnessSchema.nullable().catch(null),
  seed: z.number().int().catch(() => newSeed()),
  boundElements: z.array(boundElementSchema).nullable().catch(null),
  customData: z.record(z.string(), z.unknown()).optional().catch(undefined),
};

const shapeSchema = z.object({ ...placementFields, ...styleFields, type: z.enum(SHAPE_TYPES) });

const arrowheadSchema = z.string().max(40).nullable();

const linearSchema = z.object({
  ...placementFields,
  ...styleFields,
  type: z.enum(LINEAR_TYPES),
  points: z.array(pointSchema).min(2),
  startBinding: bindingSchema.nullable().catch(null),
  endBinding: bindingSchema.nullable().catch(null),
  startArrowhead: arrowheadSchema.catch(null),
  endArrowhead: arrowheadSchema.catch(null),
  elbowed: z.boolean().optional().catch(undefined),
});

const arrowSchema = linearSchema.extend({
  endArrowhead: arrowheadSchema
    .optional()
    .catch(null)
    .transform((head) => (head === undefined ? DEFAULT_STYLE.endArrowhead : head)),
});

const freedrawSchema = z.object({
  ...placementFields,
  ...styleFields,
  type: z.literal("freedraw"),
  points: z.array(pointSchema).min(1),
  pressures: z.array(z.number()).catch([]),
  simulatePressure: z.boolean().catch(true),
});

const textSchema = z.object({
  ...placementFields,
  ...styleFields,
  type: z.literal("text"),
  text: z.string(),
  originalText: z.string().nullable().catch(null),
  fontSize: z.number().positive().max(1000).catch(DEFAULT_STYLE.fontSize),
  fontFamily: z.number().int().catch(DEFAULT_STYLE.fontFamily),
  textAlign: z.enum(TEXT_ALIGNS).catch(DEFAULT_STYLE.textAlign),
  verticalAlign: z.enum(VERTICAL_ALIGNS).catch("top"),
  containerId: z.string().nullable().catch(null),
  autoResize: z.boolean().catch(true),
  lineHeight: z.number().positive().max(10).catch(LINE_HEIGHT),
});

const unsupportedSchema = z.object({
  id: placementFields.id,
  type: z.string().min(1).max(80),
  x: placementFields.x,
  y: placementFields.y,
  width: placementFields.width,
  height: placementFields.height,
  angle: placementFields.angle,
  version: placementFields.version,
  versionNonce: placementFields.versionNonce,
  isDeleted: placementFields.isDeleted,
  groupIds: placementFields.groupIds,
});

export type ShapeElement = z.infer<typeof shapeSchema>;
export type LinearElement = z.infer<typeof linearSchema>;
export type FreedrawElement = z.infer<typeof freedrawSchema>;
export type TextElement = Omit<z.infer<typeof textSchema>, "originalText"> & { originalText: string };
export type UnsupportedElement = Omit<z.infer<typeof unsupportedSchema>, "type"> & {
  type: "unsupported";
  originalType: string;
  raw: Record<string, unknown>;
};
export type StyledElement = ShapeElement | LinearElement | FreedrawElement | TextElement;
export type SketchElement = StyledElement | UnsupportedElement;
export type ElementType = SketchElement["type"];

const STYLED_SCHEMAS: Record<string, z.ZodType<StyledElement | z.infer<typeof textSchema>>> = {
  rectangle: shapeSchema,
  diamond: shapeSchema,
  ellipse: shapeSchema,
  arrow: arrowSchema,
  line: linearSchema,
  freedraw: freedrawSchema,
  text: textSchema,
};

type ReadElement = { readonly element: SketchElement; readonly placeholder: boolean };

export type ParsedElements = { elements: SketchElement[]; dropped: number; placeholders: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedOf(raw: Record<string, unknown>): UnsupportedElement | null {
  const parsed = unsupportedSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, type: "unsupported", originalType: parsed.data.type, raw };
}

function asPlaceholder(raw: Record<string, unknown>, placeholder: boolean): ReadElement | null {
  const element = unsupportedOf(raw);
  return element === null ? null : { element, placeholder };
}

function readElement(raw: unknown): ReadElement | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const schema = STYLED_SCHEMAS[raw.type];
  if (schema === undefined) return asPlaceholder(raw, false);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return asPlaceholder(raw, true);
  const element = parsed.data;
  if (element.type === "text") return { element: { ...element, originalText: element.originalText ?? element.text }, placeholder: false };
  return { element, placeholder: false };
}

export function parseElement(raw: unknown): SketchElement | null {
  return readElement(raw)?.element ?? null;
}

export function parseElements(raws: readonly unknown[]): ParsedElements {
  const elements: SketchElement[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let placeholders = 0;
  for (const raw of raws) {
    const read = readElement(raw);
    if (read === null || seen.has(read.element.id)) {
      dropped += 1;
      continue;
    }
    if (read.element.isDeleted) continue;
    seen.add(read.element.id);
    elements.push(read.element);
    if (read.placeholder) placeholders += 1;
  }
  return { elements, dropped, placeholders };
}

export function newSeed(): number {
  return 1 + Math.floor(Math.random() * 2_147_483_646);
}
