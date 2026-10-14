import { z } from "zod";

export const TREES_REALTIME_CHANNEL = "trees";

export const NODE_KINDS = ["markdown", "agent"] as const;
export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const NODE_STATES = [
  "blocked",
  "ready",
  "in_progress",
  "completed",
  "stale",
] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

export const SUMMARY_STATUSES = ["idle", "pending", "failed"] as const;
export const summaryStatusSchema = z.enum(SUMMARY_STATUSES);
export type SummaryStatus = z.infer<typeof summaryStatusSchema>;

export const COMPLETIONS = ["open", "working", "done"] as const;
export const completionSchema = z.enum(COMPLETIONS);
export type Completion = z.infer<typeof completionSchema>;

/*
 * Which upstream tasks a task hears from, and nothing about how much each one
 * says: that is the producer's handoff below, so what a parent shows as the
 * context it sends down is exactly what its children receive.
 */
export const CONTEXT_MODES = ["all_parents", "custom"] as const;
export const contextModeSchema = z.enum(CONTEXT_MODES);
export type ContextMode = z.infer<typeof contextModeSchema>;

/*
 * What a finished task hands to every task that depends on it. This is the
 * only thing that decides how much of the task travels downstream — a
 * consumer chooses which upstream tasks it hears from, never how much each
 * one says.
 *
 * "summary" and "custom" both send the summary field; they differ in who
 * writes it. Completion asks a model under "summary" and leaves the field
 * alone under "custom", so hand-written text is never overwritten.
 */
export const HANDOFF_MODES = ["summary", "custom", "full"] as const;
export const handoffSchema = z.enum(HANDOFF_MODES);
export type Handoff = z.infer<typeof handoffSchema>;

export const workspaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tree") }).strict(),
  z
    .object({ kind: z.literal("project"), projectId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("path"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("environment"),
      environmentId: z.string().min(1),
    })
    .strict(),
]);
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;

export const treeProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    directory: z.string(),
    nodeCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type TreeProject = z.infer<typeof treeProjectSchema>;

export const treeNodeSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    kind: nodeKindSchema,
    state: nodeStateSchema,
    artifactFile: z.string(),
    artifactPath: z.string(),
    summary: z.string(),
    summaryStatus: summaryStatusSchema,
    summaryProblem: z.string().nullable(),
    instruction: z.string(),
    contextMode: contextModeSchema,
    handoff: handoffSchema,
    customBrief: z.string(),
    contextIncludes: z.array(z.string()),
    workspace: workspaceTargetSchema,
    baseBranch: z.string().nullable(),
    threadId: z.string().nullable(),
    dependsOn: z.array(z.string()),
    x: z.number(),
    y: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type TreeNode = z.infer<typeof treeNodeSchema>;

export const treeGraphSchema = z
  .object({
    project: treeProjectSchema,
    nodes: z.array(treeNodeSchema),
  })
  .strict();
export type TreeGraph = z.infer<typeof treeGraphSchema>;

export const CONTEXT_MODE_LABELS: Record<ContextMode, string> = {
  all_parents: "Every task it depends on",
  custom: "The upstream tasks I choose",
};

export const CONTEXT_MODE_HINTS: Record<ContextMode, string> = {
  all_parents:
    "Each parent sends what its own handoff says it sends: a summary, or its whole document.",
  custom:
    "The brief below plus the upstream tasks you tick, each sending what its own handoff says it sends.",
};

export const HANDOFF_LABELS: Record<Handoff, string> = {
  summary: "Auto-summarized",
  custom: "What I write",
  full: "Whole document",
};

export const HANDOFF_HINTS: Record<Handoff, string> = {
  summary:
    "Completing this task asks a model to compact its output to under 200 words. Downstream tasks receive that.",
  custom:
    "Downstream tasks receive exactly the text below. Completing this task leaves it alone.",
  full: "Downstream tasks receive the whole document, however little context they asked for. No summary is written.",
};

export const NODE_STATE_LABELS: Record<NodeState, string> = {
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  completed: "Completed",
  stale: "Stale",
};

export function isRunnableState(state: NodeState): boolean {
  return state === "ready" || state === "stale";
}

export function upstreamNodeIds(
  nodes: readonly Pick<TreeNode, "id" | "dependsOn">[],
  nodeId: string,
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const seen = new Set<string>();
  const pending = [...(byId.get(nodeId) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    pending.push(...(byId.get(current) ?? []));
  }
  return [...seen];
}
