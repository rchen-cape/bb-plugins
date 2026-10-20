import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LIMITS } from "./lib/sketch.js";

export const sketchIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.title)
  .refine((id) => id === id.trim(), "a sketch name can't start or end with a space")
  .refine((id) => !id.startsWith("."), "a sketch name can't start with a dot")
  .refine((id) => !/[/\\:*?"<>|\u0000-\u001f\u007f]/.test(id), "a sketch name can't contain / \\ : * ? \" < > | or control characters");
export const titleSchema = z.string().trim().min(1).max(LIMITS.title);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a sha256 hex digest");
export const contentSchema = z.string().max(LIMITS.contentChars);
export const pngBase64Schema = z.string().min(1).max(LIMITS.pngBase64Chars).regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

export const sketchSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  elementCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});
export type SketchSummary = z.infer<typeof sketchSummarySchema>;

export const sketchDetailSchema = sketchSummarySchema.extend({
  sha256: z.string(),
  content: z.string(),
});
export type SketchDetail = z.infer<typeof sketchDetailSchema>;

export const saveResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), sha256: z.string(), updatedAt: z.string() }),
  z.object({ outcome: z.literal("conflict") }),
]);
export type SaveResult = z.infer<typeof saveResultSchema>;


export const wikiDocSchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  aliases: z.array(z.string()),
  tag: z.string(),
  headings: z.array(z.string()),
});
export type WikiDoc = z.infer<typeof wikiDocSchema>;

export const wikiSuggestionSchema = z.object({
  slug: z.string(),
  title: z.string(),
  heading: z.string().nullable(),
  reason: z.string(),
});
export type WikiSuggestion = z.infer<typeof wikiSuggestionSchema>;

export const wikiAvailabilitySchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), inbox: z.boolean() }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type WikiAvailability = z.infer<typeof wikiAvailabilitySchema>;

export const wikiDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox") }).strict(),
  z
    .object({
      kind: z.literal("doc"),
      slug: z.string().min(1).max(LIMITS.slug),
      heading: z.string().trim().min(1).max(LIMITS.heading),
    })
    .strict(),
]);
export type WikiDestination = z.infer<typeof wikiDestinationSchema>;

export const sendResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), cardId: z.string() }),
  z.object({ kind: z.literal("doc"), slug: z.string(), title: z.string() }),
]);
export type SendResult = z.infer<typeof sendResultSchema>;

export const statusSchema = z.object({
  directory: z.string(),
  sketchCount: z.number().int().nonnegative(),
  wiki: wikiAvailabilitySchema,
});
export type SketchStatus = z.infer<typeof statusSchema>;

const empty = z.object({}).strict();

export const rpcContract = defineRpcContract({
  status: { input: empty, output: statusSchema },
  list: { input: empty, output: z.array(sketchSummarySchema) },
  get: { input: z.object({ id: sketchIdSchema }).strict(), output: sketchDetailSchema.nullable() },
  create: {
    input: z.object({ title: titleSchema.nullable(), content: contentSchema.nullable() }).strict(),
    output: sketchDetailSchema,
  },
  save: {
    input: z.object({ id: sketchIdSchema, content: contentSchema, expectedSha256: sha256Schema.nullable() }).strict(),
    output: saveResultSchema,
  },
  rename: { input: z.object({ id: sketchIdSchema, title: titleSchema }).strict(), output: sketchSummarySchema },
  duplicate: { input: z.object({ id: sketchIdSchema }).strict(), output: sketchSummarySchema },
  delete: { input: z.object({ id: sketchIdSchema }).strict(), output: z.object({ id: z.string() }) },
  savePreview: {
    input: z.object({ id: sketchIdSchema, sha256: sha256Schema, png: pngBase64Schema }).strict(),
    output: z.object({ stored: z.boolean() }),
  },
  wikiDocs: {
    input: empty,
    output: z.object({ wiki: wikiAvailabilitySchema, docs: z.array(wikiDocSchema) }),
  },
  wikiSuggest: {
    input: z.object({ text: z.string().max(LIMITS.note), title: z.string().max(LIMITS.title).nullable() }).strict(),
    output: z.object({ suggestions: z.array(wikiSuggestionSchema) }),
  },
  sendToWiki: {
    input: z
      .object({
        name: titleSchema,
        png: pngBase64Schema,
        caption: z.string().max(LIMITS.caption),
        note: z.string().max(LIMITS.note),
        destination: wikiDestinationSchema,
      })
      .strict(),
    output: sendResultSchema,
  },
});

export type SketchRpcContract = typeof rpcContract;
