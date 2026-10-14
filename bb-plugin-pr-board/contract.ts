import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");
const prNumberSchema = z.number().int().positive();
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/, "expected a full commit sha");
const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "expected a repository-relative path");
const lineSchema = z.number().int().positive();
const pullRef = { repo: repoSchema, number: prNumberSchema };

export const sideSchema = z.enum(["additions", "deletions"]);
export type Side = z.infer<typeof sideSchema>;

export const columnSchema = z.enum(["draft", "open", "reviewing", "ready"]);
export type Column = z.infer<typeof columnSchema>;

const personSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable() });
export type Person = z.infer<typeof personSchema>;

export const reviewerStateSchema = z.enum(["approved", "changes-requested", "commented", "requested"]);
export type ReviewerState = z.infer<typeof reviewerStateSchema>;

export const checksSchema = z.enum(["success", "failure", "pending", "none"]);
export type Checks = z.infer<typeof checksSchema>;

const agentSchema = z.object({
  threadId: z.string().nullable(),
  running: z.boolean(),
  findings: z.number().int().nonnegative(),
});
export type AgentState = z.infer<typeof agentSchema>;

export const boardCardSchema = z.object({
  repo: repoSchema,
  number: prNumberSchema,
  title: z.string(),
  url: z.string(),
  column: columnSchema,
  author: personSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  checks: checksSchema,
  reviewers: z.array(personSchema.extend({ state: reviewerStateSchema })),
  humanComments: z.number().int().nonnegative(),
  unresolvedThreads: z.number().int().nonnegative(),
  unansweredComments: z.number().int().nonnegative(),
  isAuthor: z.boolean(),
  isMentioned: z.boolean(),
  isRequested: z.boolean(),
  isAwaitingReply: z.boolean(),
  agent: agentSchema,
});
export type BoardCard = z.infer<typeof boardCardSchema>;

const boardSchema = z.object({
  viewer: z.string(),
  repos: z.array(repoSchema),
  fetchedAt: z.string(),
  cards: z.array(boardCardSchema),
  errors: z.array(z.object({ search: z.string(), message: z.string() })),
});
export type Board = z.infer<typeof boardSchema>;

export const fileStatusSchema = z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
export type FileStatus = z.infer<typeof fileStatusSchema>;

export const pullFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: fileStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().nullable(),
  viewed: z.boolean(),
});
export type PullFile = z.infer<typeof pullFileSchema>;

const commentSchema = z.object({
  id: z.string(),
  databaseId: z.number().int(),
  author: personSchema,
  isBot: z.boolean(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type ReviewComment = z.infer<typeof commentSchema>;

const conversationCommentSchema = z.object({
  id: z.string(),
  kind: z.enum(["comment", "review"]),
  author: personSchema,
  isBot: z.boolean(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type ConversationComment = z.infer<typeof conversationCommentSchema>;

export const reviewThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: sideSchema,
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(commentSchema),
});
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

const pullDetailSchema = z.object({
  repo: repoSchema,
  number: prNumberSchema,
  nodeId: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  author: personSchema,
  headRefName: z.string(),
  baseRefName: z.string(),
  headSha: shaSchema,
  mergeBaseSha: shaSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  viewer: z.string(),
  files: z.array(pullFileSchema),
  threads: z.array(reviewThreadSchema),
  conversation: z.array(conversationCommentSchema),
});
export type PullDetail = z.infer<typeof pullDetailSchema>;

export const severitySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

const findingSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: sideSchema,
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  severity: severitySchema,
  title: z.string(),
  body: z.string(),
  headSha: z.string().nullable(),
  dismissed: z.boolean(),
});
export type Finding = z.infer<typeof findingSchema>;

const draftSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: sideSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
  body: z.string(),
});
export type Draft = z.infer<typeof draftSchema>;

export const suggestionEditSchema = z.object({
  path: z.string(),
  find: z.string(),
  replace: z.string(),
});
export type SuggestionEdit = z.infer<typeof suggestionEditSchema>;

export const replyStateSchema = z.enum(["open", "used", "dismissed"]);
export const changeStateSchema = z.enum(["open", "applied", "dismissed"]);

const suggestionSchema = z.object({
  id: z.string(),
  commentId: z.string(),
  summary: z.string(),
  reply: z.string().nullable(),
  replyState: replyStateSchema,
  edits: z.array(suggestionEditSchema),
  changeState: changeStateSchema,
});
export type Suggestion = z.infer<typeof suggestionSchema>;

const addressAgentSchema = z.object({
  threadId: z.string().nullable(),
  running: z.boolean(),
});

const reviewStateSchema = z.object({
  agent: agentSchema,
  findings: z.array(findingSchema),
  drafts: z.array(draftSchema),
  addressAgent: addressAgentSchema,
  suggestions: z.array(suggestionSchema),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

const definitionSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  preview: z.string(),
  external: z.boolean(),
});
export type Definition = z.infer<typeof definitionSchema>;

const definitionResultSchema = z.object({
  symbol: z.string(),
  source: z.enum(["gopls", "search"]),
  definitions: z.array(definitionSchema),
  message: z.string().nullable(),
});
export type DefinitionResult = z.infer<typeof definitionResultSchema>;

const fileContentSchema = z.object({
  content: z.string().nullable(),
  unavailable: z.enum(["missing", "binary", "too-large"]).nullable(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

const commentTargetSchema = {
  path: pathSchema,
  side: sideSchema,
  startLine: lineSchema,
  endLine: lineSchema,
};

const bodySchema = z.string().trim().min(1).max(65_000);

export const reviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

const empty = z.object({}).strict();

export const rpcContract = defineRpcContract({
  board: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: boardSchema,
  },
  pull: {
    input: z.object({ ...pullRef, refresh: z.boolean() }).strict(),
    output: pullDetailSchema,
  },
  fileAt: {
    input: z.object({ repo: repoSchema, sha: shaSchema, path: pathSchema }).strict(),
    output: fileContentSchema,
  },
  externalFile: {
    input: z.object({ path: z.string().startsWith("/") }).strict(),
    output: fileContentSchema,
  },
  reviewState: {
    input: z.object(pullRef).strict(),
    output: reviewStateSchema,
  },
  pullForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ repo: repoSchema, number: prNumberSchema }).nullable(),
  },
  openReview: {
    input: z.object(pullRef).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }),
  },
  runReview: {
    input: z.object(pullRef).strict(),
    output: z.object({ threadId: z.string(), delivery: z.enum(["sent", "queued"]) }),
  },
  definition: {
    input: z
      .object({
        ...pullRef,
        sha: shaSchema,
        path: pathSchema,
        line: lineSchema,
        character: z.number().int().nonnegative(),
        symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,199}$/, "expected an identifier"),
      })
      .strict(),
    output: definitionResultSchema,
  },
  saveDraft: {
    input: z.object({ ...pullRef, id: z.string().nullable(), ...commentTargetSchema, body: bodySchema }).strict(),
    output: draftSchema,
  },
  deleteDraft: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: empty,
  },
  submitReview: {
    input: z.object({ ...pullRef, headSha: shaSchema, event: reviewEventSchema, body: z.string().max(65_000) }).strict(),
    output: z.object({ url: z.string().nullable(), comments: z.number().int() }),
  },
  postComment: {
    input: z.object({ ...pullRef, headSha: shaSchema, ...commentTargetSchema, body: bodySchema }).strict(),
    output: empty,
  },
  reply: {
    input: z.object({ ...pullRef, commentId: z.number().int().positive(), body: bodySchema }).strict(),
    output: empty,
  },
  resolveThread: {
    input: z.object({ ...pullRef, threadId: z.string().min(1), resolved: z.boolean() }).strict(),
    output: empty,
  },
  setViewed: {
    input: z.object({ ...pullRef, pullNodeId: z.string().min(1), path: pathSchema, viewed: z.boolean() }).strict(),
    output: empty,
  },
  dismissFinding: {
    input: z.object({ id: z.string().min(1), dismissed: z.boolean() }).strict(),
    output: empty,
  },
  addressComments: {
    input: z.object(pullRef).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean(), delivery: z.enum(["sent", "queued"]) }),
  },
  suggestionFiles: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({
      files: z.array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string() })),
      error: z.string().nullable(),
    }),
  },
  applySuggestion: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: empty,
  },
  setSuggestionState: {
    input: z
      .discriminatedUnion("part", [
        z.object({ id: z.string().min(1), part: z.literal("reply"), state: replyStateSchema }).strict(),
        z.object({ id: z.string().min(1), part: z.literal("change"), state: z.enum(["open", "dismissed"]) }).strict(),
      ]),
    output: empty,
  },
  submitAddress: {
    input: z.object(pullRef).strict(),
    output: z.object({ threadId: z.string(), delivery: z.enum(["sent", "queued"]) }),
  },
  postConversationComment: {
    input: z.object({ ...pullRef, body: bodySchema }).strict(),
    output: empty,
  },
});
