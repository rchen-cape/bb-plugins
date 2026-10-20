import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DOC_TYPES, LIMITS, MEDIA_KINDS } from "./lib/wiki.js";

export const docTypeSchema = z.enum(DOC_TYPES);
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export const slugSchema = z.string().min(1).max(LIMITS.slug);
export const titleSchema = z.string().trim().min(1).max(LIMITS.title);
export const aliasSchema = z.string().trim().min(1).max(LIMITS.alias);
export const aliasesSchema = z.array(aliasSchema).max(LIMITS.aliases);
export const headingSchema = z.string().trim().min(1).max(LIMITS.heading);
export const cardIdSchema = z.string().regex(/^card_[a-z0-9]{8}$/, "expected a card id like card_1a2b3c4d");
export const jobIdSchema = z.string().regex(/^job_[a-z0-9]{8}$/, "expected a job id like job_1a2b3c4d");
export const uploadIdSchema = z.string().regex(/^upl_[a-z0-9]{12}$/, "expected an upload id like upl_1a2b3c4d5e6f");
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const docSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: docTypeSchema,
  aliases: z.array(z.string()),
  tag: z.string(),
  updatedAt: z.string(),
  headings: z.array(z.string()),
});
export type DocSummary = z.infer<typeof docSummarySchema>;

export const backlinkSchema = z.object({ slug: z.string(), title: z.string(), heading: z.string() });
export type Backlink = z.infer<typeof backlinkSchema>;

export const docDetailSchema = docSummarySchema.extend({
  content: z.string(),
  sha256: z.string(),
  backlinks: z.array(backlinkSchema),
});
export type DocDetail = z.infer<typeof docDetailSchema>;

export const docHitSchema = docSummarySchema.extend({ matched: z.enum(["title", "tag", "alias"]) });
export type DocHit = z.infer<typeof docHitSchema>;

export const sectionHitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: docTypeSchema,
  heading: z.string(),
  headingPath: z.string(),
  anchor: z.string(),
  snippet: z.string(),
});
export type SectionHit = z.infer<typeof sectionHitSchema>;

export const searchResultSchema = z.object({
  docs: z.array(docHitSchema),
  sections: z.array(sectionHitSchema),
  total: z.number().int().nonnegative(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const suggestionSchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: docTypeSchema,
  heading: z.string().nullable(),
  score: z.number(),
  reason: z.string(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

export const lineRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((range) => range.end >= range.start, "end must be at or after start");
export type LineRange = z.infer<typeof lineRangeSchema>;
export const lineSelectionSchema = z.union([z.literal("all"), z.array(lineRangeSchema).min(1).max(LIMITS.lines)]);
export type LineSelection = z.infer<typeof lineSelectionSchema>;

export const newDocTargetSchema = z.object({
  kind: z.literal("new"),
  title: titleSchema,
  type: docTypeSchema,
  aliases: aliasesSchema,
});
export const existingDocTargetSchema = z.object({ kind: z.literal("existing"), slug: slugSchema });
export const docTargetSchema = z.discriminatedUnion("kind", [existingDocTargetSchema, newDocTargetSchema]);
export type DocTarget = z.infer<typeof docTargetSchema>;

export const destinationSchema = z.object({
  id: z.string().min(1).max(40),
  include: z.boolean(),
  target: docTargetSchema,
  heading: headingSchema,
  lineRanges: lineSelectionSchema,
  role: z.enum(["content", "link"]),
  reason: z.string().max(LIMITS.reason),
  written: z.boolean().optional(),
});
export type Destination = z.infer<typeof destinationSchema>;

export const cardSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notes"),
    notePath: z.string(),
    noteDate: isoDateSchema,
    unitHash: z.string(),
    origin: z.enum(["daily", "file"]).optional(),
    section: z.string().max(LIMITS.heading * 4).optional(),
  }),
  z.object({ kind: z.literal("agent"), threadId: z.string(), threadTitle: z.string().nullable() }),
  z.object({
    kind: z.literal("upload"),
    name: z.string(),
    pluginId: z.string().nullable(),
    threadId: z.string().min(1).nullable().default(null),
  }),
]);
export type CardSource = z.infer<typeof cardSourceSchema>;

export const cardStatusSchema = z.enum(["routing", "pending", "accepted", "skipped"]);
export type CardStatus = z.infer<typeof cardStatusSchema>;
export const cardRuleSchema = z.enum(["explicit-link", "tag", "agent", "picked", "none"]);
export type CardRule = z.infer<typeof cardRuleSchema>;

export const tagSuggestionSchema = z.object({
  tag: z.string(),
  slug: z.string(),
  title: z.string(),
  score: z.number(),
});
export type TagSuggestion = z.infer<typeof tagSuggestionSchema>;

export const rememberAliasSchema = z.object({ tag: aliasSchema, slug: slugSchema });
export type RememberAlias = z.infer<typeof rememberAliasSchema>;

export const cardSchema = z.object({
  id: z.string(),
  status: cardStatusSchema,
  source: cardSourceSchema,
  text: z.string(),
  lines: z.array(z.string()),
  tags: z.array(z.string()),
  rule: cardRuleSchema,
  reason: z.string(),
  destinations: z.array(destinationSchema),
  tagSuggestions: z.array(tagSuggestionSchema),
  rememberAliases: z.array(rememberAliasSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Card = z.infer<typeof cardSchema>;

export const mediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), uploadId: uploadIdSchema }),
  z.object({ kind: z.literal("path"), path: z.string().min(1).max(LIMITS.path) }),
]);
export type MediaSource = z.infer<typeof mediaSourceSchema>;

export const mediaItemSchema = z.object({ from: mediaSourceSchema, caption: z.string().max(LIMITS.caption) });
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const addSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1), messageId: z.string().min(1).nullable() }),
  z.object({ kind: z.literal("upload"), name: z.string().min(1).max(LIMITS.title) }),
  z.object({ kind: z.literal("manual") }),
]);
export type AddSource = z.infer<typeof addSourceSchema>;

export const ingestResultSchema = z.object({
  notesScanned: z.number().int().nonnegative(),
  unitsFound: z.number().int().nonnegative(),
  cardsCreated: z.number().int().nonnegative(),
  jobIds: z.array(z.string()),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

export const statusSchema = z.object({
  wikiDirectory: z.string(),
  notesDirectory: z.string(),
  docCount: z.number().int().nonnegative(),
  inboxCount: z.number().int().nonnegative(),
  lastIngestDate: z.string().nullable(),
  routingAgent: z.boolean(),
  gitHistory: z.boolean(),
  tagsFile: z.string(),
});
export type WikiStatus = z.infer<typeof statusSchema>;

export const uploadInfoSchema = z.object({
  uploadId: z.string(),
  name: z.string(),
  kind: mediaKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().nullable(),
});
export type UploadInfo = z.infer<typeof uploadInfoSchema>;

export const messageMediaItemSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: mediaKindSchema,
  sizeBytes: z.number().int().nonnegative(),
});
export type MessageMediaItem = z.infer<typeof messageMediaItemSchema>;

export const jobStateSchema = z.object({
  status: z.enum(["running", "done", "failed"]),
  result: z.string().nullable(),
  error: z.string().nullable(),
});
export type JobState = z.infer<typeof jobStateSchema>;

export const cardPreviewSchema = z.object({
  destinationId: z.string(),
  slug: z.string().nullable(),
  title: z.string(),
  patch: z.string(),
});
export type CardPreview = z.infer<typeof cardPreviewSchema>;

const empty = z.object({}).strict();

export const rpcContract = defineRpcContract({
  status: { input: empty, output: statusSchema },
  docs: { input: z.object({ type: docTypeSchema.nullable() }).strict(), output: z.array(docSummarySchema) },
  doc: { input: z.object({ slug: slugSchema }).strict(), output: docDetailSchema.nullable() },
  saveDoc: {
    input: z.object({ slug: slugSchema, content: z.string().max(LIMITS.content), expectedSha256: z.string().nullable() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict") }),
    ]),
  },
  createDoc: {
    input: z
      .object({ title: titleSchema, type: docTypeSchema, aliases: aliasesSchema, body: z.string().max(LIMITS.text) })
      .strict(),
    output: docSummarySchema,
  },
  search: {
    input: z
      .object({
        query: z.string().max(LIMITS.query),
        type: docTypeSchema.nullable(),
        limit: z.number().int().min(1).max(LIMITS.results),
      })
      .strict(),
    output: searchResultSchema,
  },
  suggest: {
    input: z.object({ text: z.string().max(LIMITS.text), title: z.string().max(LIMITS.title).nullable() }).strict(),
    output: z.object({ suggestions: z.array(suggestionSchema) }),
  },
  addToDoc: {
    input: z
      .object({
        target: docTargetSchema,
        heading: headingSchema,
        text: z.string().max(LIMITS.text),
        media: z.array(mediaItemSchema).max(LIMITS.media),
        source: addSourceSchema,
      })
      .strict(),
    output: z.object({ slug: z.string(), title: z.string() }),
  },
  addCard: {
    input: z
      .object({
        name: titleSchema,
        text: z.string().max(LIMITS.text),
        media: z.array(mediaItemSchema).max(LIMITS.media),
        target: docTargetSchema.nullable(),
        heading: headingSchema.nullable(),
        threadId: z.string().min(1).nullable(),
      })
      .strict(),
    output: cardSchema,
  },
  inbox: {
    input: z.object({ status: z.enum(["open", "accepted", "skipped"]) }).strict(),
    output: z.array(cardSchema),
  },
  card: { input: z.object({ id: cardIdSchema }).strict(), output: cardSchema.nullable() },
  updateCard: {
    input: z
      .object({
        id: cardIdSchema,
        destinations: z.array(destinationSchema).max(LIMITS.destinations),
        rememberAliases: z.array(rememberAliasSchema).max(LIMITS.tags),
      })
      .strict(),
    output: cardSchema,
  },
  previewCard: {
    input: z.object({ id: cardIdSchema }).strict(),
    output: z.object({ previews: z.array(cardPreviewSchema), missingImages: z.array(z.string()) }),
  },
  acceptCard: { input: z.object({ id: cardIdSchema }).strict(), output: cardSchema },
  skipCard: { input: z.object({ id: cardIdSchema }).strict(), output: cardSchema },
  restoreCard: { input: z.object({ id: cardIdSchema }).strict(), output: cardSchema },
  ingestNow: {
    input: z.object({ since: isoDateSchema.nullable(), useAgent: z.boolean().nullable() }).strict(),
    output: ingestResultSchema,
  },
  importFolders: {
    input: z
      .object({ folders: z.array(z.string().min(1).max(LIMITS.path)).min(1).max(20), useAgent: z.boolean().nullable() })
      .strict(),
    output: ingestResultSchema,
  },
  importUpload: { input: z.object({ uploadId: uploadIdSchema }).strict(), output: uploadInfoSchema },
  messageMedia: {
    input: z.object({ threadId: z.string().min(1), messageSeq: z.number().int().nonnegative() }).strict(),
    output: z.object({ items: z.array(messageMediaItemSchema) }),
  },
  describeImage: { input: z.object({ from: mediaSourceSchema }).strict(), output: z.object({ jobId: z.string() }) },
  job: { input: z.object({ jobId: jobIdSchema }).strict(), output: jobStateSchema },
  addAlias: { input: z.object({ slug: slugSchema, alias: aliasSchema }).strict(), output: docSummarySchema },
  renameDoc: { input: z.object({ slug: slugSchema, title: titleSchema }).strict(), output: docSummarySchema },
  deleteDoc: {
    input: z.object({ slug: slugSchema }).strict(),
    output: z.object({ slug: z.string(), title: z.string() }),
  },
  reindex: { input: empty, output: z.object({ docCount: z.number().int().nonnegative() }) },
  tidyUnsorted: { input: empty, output: z.object({ changed: z.array(z.string()) }) },
});

export type WikiRpcContract = typeof rpcContract;
