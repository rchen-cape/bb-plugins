import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  contextModeSchema,
  handoffSchema,
  nodeKindSchema,
  treeGraphSchema,
  treeNodeSchema,
  treeProjectSchema,
  workspaceTargetSchema,
} from "./model.js";
import { HAND_DOWN_OUTCOMES, type TreeService } from "./service.js";

const okSchema = z.object({ ok: z.literal(true) }).strict();
const positionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});
const nodeResultSchema = z.object({ node: treeNodeSchema }).strict();
const projectResultSchema = z.object({ project: treeProjectSchema }).strict();
const nodeTargetSchema = z.object({ nodeId: z.string().min(1) }).strict();
const dependencySchema = z
  .object({ parentId: z.string().min(1), childId: z.string().min(1) })
  .strict();

export const treesRpcContract = defineRpcContract({
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(treeProjectSchema) }).strict(),
  },
  projects_create: {
    input: z
      .object({
        name: z.string().min(1),
        bbProjectId: z.string().min(1).nullable().optional(),
      })
      .strict(),
    output: projectResultSchema,
  },
  project_reveal: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ directory: z.string() }).strict(),
  },
  projects_set_bb_project: {
    input: z
      .object({
        projectId: z.string().min(1),
        bbProjectId: z.string().min(1),
      })
      .strict(),
    output: projectResultSchema,
  },
  node_open_thread: {
    input: z
      .object({
        nodeId: z.string().min(1),
        baseBranch: z.string().min(1),
        prompt: z.string().min(1),
      })
      .strict(),
    output: nodeResultSchema,
  },
  base_branches: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z
      .object({
        branches: z.array(z.string()),
        defaultBranch: z.string().nullable(),
      })
      .strict(),
  },
  projects_rename: {
    input: z
      .object({ projectId: z.string().min(1), name: z.string().min(1) })
      .strict(),
    output: projectResultSchema,
  },
  projects_delete: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: okSchema,
  },
  graph_get: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: treeGraphSchema,
  },
  ready_list: {
    input: z.object({ projectId: z.string().min(1).nullable() }).strict(),
    output: z
      .object({
        entries: z.array(
          z
            .object({ project: treeProjectSchema, node: treeNodeSchema })
            .strict(),
        ),
      })
      .strict(),
  },
  node_create: {
    input: z
      .object({
        projectId: z.string().min(1),
        title: z.string().min(1),
        kind: nodeKindSchema,
        instruction: z.string().optional(),
        contextMode: contextModeSchema.optional(),
        handoff: handoffSchema.optional(),
        customBrief: z.string().optional(),
        workspace: workspaceTargetSchema.optional(),
        dependsOn: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    output: nodeResultSchema,
  },
  node_update: {
    input: z
      .object({
        nodeId: z.string().min(1),
        title: z.string().min(1).optional(),
        instruction: z.string().optional(),
        contextMode: contextModeSchema.optional(),
        handoff: handoffSchema.optional(),
        customBrief: z.string().optional(),
        workspace: workspaceTargetSchema.optional(),
        contextIncludes: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    output: nodeResultSchema,
  },
  node_delete: {
    input: nodeTargetSchema,
    output: okSchema,
  },
  node_move: {
    input: positionSchema.extend({ nodeId: z.string().min(1) }).strict(),
    output: okSchema,
  },
  layout_apply: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: okSchema,
  },
  dependency_add: {
    input: dependencySchema,
    output: okSchema,
  },
  dependency_remove: {
    input: dependencySchema,
    output: okSchema,
  },
  artifact_read: {
    input: nodeTargetSchema,
    output: z
      .object({
        content: z.string(),
        sha256: z.string().nullable(),
        problem: z.string().nullable(),
      })
      .strict(),
  },
  artifact_write: {
    input: z
      .object({
        nodeId: z.string().min(1),
        content: z.string(),
        expectedSha256: z.string().nullable(),
      })
      .strict(),
    output: z.object({ sha256: z.string() }).strict(),
  },
  context_preview: {
    input: nodeTargetSchema,
    output: z
      .object({ prompt: z.string(), sourceTitles: z.array(z.string()) })
      .strict(),
  },
  node_start: {
    input: nodeTargetSchema,
    output: nodeResultSchema,
  },
  node_resend: {
    input: nodeTargetSchema,
    output: nodeResultSchema,
  },
  node_hand_down: {
    input: nodeTargetSchema,
    output: z
      .object({
        deliveries: z.array(
          z
            .object({
              nodeId: z.string(),
              title: z.string(),
              outcome: z.enum(HAND_DOWN_OUTCOMES),
              problem: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  node_complete: {
    input: z
      .object({
        nodeId: z.string().min(1),
        awaitSummary: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        node: treeNodeSchema,
        summaryProblem: z.string().nullable(),
      })
      .strict(),
  },
  node_compact: {
    input: nodeTargetSchema,
    output: nodeResultSchema,
  },
  node_summary_set: {
    input: z
      .object({ nodeId: z.string().min(1), summary: z.string() })
      .strict(),
    output: nodeResultSchema,
  },
  node_reopen: {
    input: z
      .object({
        nodeId: z.string().min(1),
        discardThread: z.boolean(),
      })
      .strict(),
    output: nodeResultSchema,
  },
  node_mark_working: {
    input: nodeTargetSchema,
    output: nodeResultSchema,
  },
  node_acknowledge: {
    input: nodeTargetSchema,
    output: nodeResultSchema,
  },
  workspace_options: {
    input: z.null(),
    output: z
      .object({
        projects: z.array(
          z.object({ id: z.string(), name: z.string() }).strict(),
        ),
        environments: z.array(
          z
            .object({
              id: z.string(),
              projectId: z.string(),
              label: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
});

export function createRpcHandlers(args: {
  service: TreeService;
  listBbProjects: () => Promise<{ id: string; name: string }[]>;
  listSharedEnvironments: () => Promise<
    { id: string; projectId: string; label: string }[]
  >;
}): PluginRpcHandlers<typeof treesRpcContract> {
  const { service } = args;
  return {
    projects_list: () => ({ projects: service.listProjects() }),
    projects_create: async (input) => ({
      project: await service.createProject(input),
    }),
    base_branches: (input) => service.listBaseBranches(input),
    project_reveal: async (input) => ({
      directory: await service.revealDirectory(input),
    }),
    projects_set_bb_project: async (input) => ({
      project: await service.setBbProject(input),
    }),
    node_open_thread: async (input) => ({
      node: await service.openThread(input),
    }),
    projects_rename: (input) => ({ project: service.renameProject(input) }),
    projects_delete: (input) => {
      service.deleteProject(input);
      return { ok: true };
    },
    graph_get: (input) => service.getGraph(input.projectId),
    ready_list: (input) => ({ entries: service.listReady(input) }),
    node_create: async (input) => ({ node: await service.createNode(input) }),
    node_update: (input) => ({ node: service.updateNode(input) }),
    node_delete: (input) => {
      service.deleteNode(input);
      return { ok: true };
    },
    node_move: (input) => {
      service.moveNode(input);
      return { ok: true };
    },
    layout_apply: (input) => {
      service.autoLayout(input);
      return { ok: true };
    },
    dependency_add: (input) => {
      service.addDependency(input);
      return { ok: true };
    },
    dependency_remove: (input) => {
      service.removeDependency(input);
      return { ok: true };
    },
    artifact_read: (input) => service.readArtifact(input),
    artifact_write: (input) => service.writeArtifact(input),
    context_preview: (input) => service.previewContext(input),
    node_start: async (input) => ({ node: await service.startNode(input) }),
    node_resend: async (input) => ({
      node: await service.resendContext(input),
    }),
    node_hand_down: (input) => service.handDownContext(input),
    node_complete: (input) => service.completeNode(input),
    node_compact: (input) => ({ node: service.compactNode(input) }),
    node_summary_set: (input) => ({ node: service.setSummary(input) }),
    node_reopen: (input) => ({ node: service.reopenNode(input) }),
    node_mark_working: (input) => ({ node: service.markWorking(input) }),
    node_acknowledge: (input) => ({ node: service.acknowledgeStale(input) }),
    workspace_options: async () => ({
      projects: await args.listBbProjects(),
      environments: await args.listSharedEnvironments(),
    }),
  };
}
