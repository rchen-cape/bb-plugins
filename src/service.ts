import { createHash } from "node:crypto";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  additionalContextPrompt,
  assembleContext,
  markdownSummaryPrompt,
  summaryRequestPrompt,
  type ContextSource,
} from "./context.js";
import {
  countNodes,
  deleteEdge,
  deleteNode as deleteNodeRow,
  deleteProject as deleteProjectRow,
  findNodeByThread,
  findProjectByDirectory,
  getNode,
  getProject,
  insertEdge,
  insertNode,
  insertProject,
  setProjectBbProject as setProjectBbProjectRow,
  listEdges,
  listPendingSummaryNodeIds,
  listNodes,
  listProjects as listProjectRows,
  nextOrdinal,
  renameProject as renameProjectRow,
  replaceContextIncludes,
  touchProject,
  updateNode as updateNodeRow,
  type Db,
  type NodeRow,
  type ProjectRow,
  type UpdateNodeArgs,
} from "./data.js";
import {
  ancestorIdsOf,
  childIdsOf,
  currentInputDigest,
  dependencyProblem,
  layeredLayout,
  parentIdsOf,
  resolveNodeStates,
  type Graph,
  type GraphNode,
} from "./graph.js";
import {
  CONTEXT_MODES,
  HANDOFF_MODES,
  TREES_REALTIME_CHANNEL,
  type ContextMode,
  type Handoff,
  type NodeKind,
  type NodeState,
  type TreeGraph,
  type TreeNode,
  type TreeProject,
  type WorkspaceTarget,
} from "./model.js";
import {
  artifactFileName,
  artifactPath,
  isMarkdownStub,
  markdownStub,
  projectDirectory,
} from "./paths.js";

export class TreeError extends Error {}

const TURN_TIMEOUT_MS = 180_000;
const ACTIVATION_GRACE_MS = 8_000;
const TURN_POLL_INTERVAL_MS = 1_000;
const MAX_ARTIFACT_CHARS = 2_000_000;
const MAX_TITLE_LENGTH = 200;
const MAX_INSTRUCTION_LENGTH = 20_000;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_PROJECTS = 200;
const MAX_NODES_PER_PROJECT = 300;

const BUSY_THREAD_STATUSES = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

const threadSchema = z
  .object({ id: z.string().min(1), status: z.string().min(1) })
  .loose();

const hostListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      connected: z.boolean().optional(),
      isPrimary: z.boolean().optional(),
    })
    .loose(),
);

const branchOptionsSchema = z
  .object({
    branches: z.array(z.string()),
    remoteBranches: z.array(z.string()),
    defaultBranch: z.string().nullable(),
    defaultWorktreeBaseBranch: z.string().nullable(),
  })
  .loose();

const environmentRowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    projectId: z.string().min(1),
    isWorktree: z.boolean(),
    branchName: z.string().nullable(),
    path: z.string().nullable(),
    status: z.string(),
  })
  .loose();
const environmentListSchema = z.array(environmentRowSchema);

const projectListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      name: z.string(),
      sources: z
        .array(
          z
            .object({
              type: z.string(),
              path: z.string().optional(),
            })
            .loose(),
        )
        .optional(),
    })
    .loose(),
);

export type TreeServiceApi = Pick<BbPluginApi, "sdk" | "log" | "realtime">;

export interface TreeServiceDeps {
  bb: TreeServiceApi;
  db: Db;
  resolveRootDirectory: () => Promise<string>;
  revealDirectory: (path: string) => Promise<void>;
}

export interface CreateNodeArgs {
  projectId: string;
  title: string;
  kind: NodeKind;
  instruction?: string;
  contextMode?: ContextMode;
  handoff?: Handoff;
  customBrief?: string;
  workspace?: WorkspaceTarget;
  dependsOn?: readonly string[];
  position?: { x: number; y: number };
}

export interface UpdateNodeInput {
  nodeId: string;
  title?: string;
  instruction?: string;
  contextMode?: ContextMode;
  handoff?: Handoff;
  customBrief?: string;
  workspace?: WorkspaceTarget;
  contextIncludes?: readonly string[];
}

export interface ArtifactContent {
  content: string;
  sha256: string | null;
  problem: string | null;
}

export interface ContextPreview {
  prompt: string;
  sourceTitles: string[];
}

/*
 * What became of one immediate child when its parent handed the context
 * down. "on_start" is not a failure: an agent task with no thread yet
 * assembles its context when it starts, so it is already going to get this.
 */
export const HAND_DOWN_OUTCOMES = [
  "sent",
  "on_start",
  "note",
  "failed",
] as const;
export type HandDownOutcome = (typeof HAND_DOWN_OUTCOMES)[number];

export interface HandDownDelivery {
  nodeId: string;
  title: string;
  outcome: HandDownOutcome;
  problem: string | null;
}

export interface HandDownResult {
  deliveries: HandDownDelivery[];
}

export interface CompletionResult {
  node: TreeNode;
  summaryProblem: string | null;
}

export interface ReadyEntry {
  project: TreeProject;
  node: TreeNode;
}

interface LoadedProject {
  project: ProjectRow;
  rows: NodeRow[];
  graph: Graph;
  states: Map<string, NodeState>;
}

type NodePlacement = {
  projectId: string;
  environment:
    | { type: "project-default" }
    | { type: "reuse"; environmentId: string }
    | { type: "host"; workspace: { type: "personal" } };
};

const PERSONAL_WORKSPACE_ENVIRONMENT: NodePlacement["environment"] = {
  type: "host",
  workspace: { type: "personal" },
};

export interface TreeService {
  listProjects(): TreeProject[];
  getProject(projectId: string): TreeProject;
  createProject(args: {
    name: string;
    bbProjectId?: string | null;
  }): Promise<TreeProject>;
  listBaseBranches(args: {
    projectId: string;
  }): Promise<{ branches: string[]; defaultBranch: string | null }>;
  setBbProject(args: {
    projectId: string;
    bbProjectId: string;
  }): Promise<TreeProject>;
  openThread(args: {
    nodeId: string;
    baseBranch: string;
    prompt: string;
  }): Promise<TreeNode>;
  revealDirectory(args: { projectId: string }): Promise<string>;
  renameProject(args: { projectId: string; name: string }): TreeProject;
  deleteProject(args: { projectId: string }): void;
  getGraph(projectId: string): TreeGraph;
  getNode(nodeId: string): TreeNode;
  listReady(args: { projectId: string | null }): ReadyEntry[];
  createNode(args: CreateNodeArgs): Promise<TreeNode>;
  updateNode(args: UpdateNodeInput): TreeNode;
  deleteNode(args: { nodeId: string }): void;
  moveNode(args: { nodeId: string; x: number; y: number }): void;
  autoLayout(args: { projectId: string }): void;
  addDependency(args: { parentId: string; childId: string }): void;
  removeDependency(args: { parentId: string; childId: string }): void;
  readArtifact(args: { nodeId: string }): Promise<ArtifactContent>;
  writeArtifact(args: {
    nodeId: string;
    content: string;
    expectedSha256: string | null;
  }): Promise<{ sha256: string }>;
  previewContext(args: { nodeId: string }): Promise<ContextPreview>;
  startNode(args: { nodeId: string }): Promise<TreeNode>;
  resendContext(args: { nodeId: string }): Promise<TreeNode>;
  handDownContext(args: { nodeId: string }): Promise<HandDownResult>;
  completeNode(args: {
    nodeId: string;
    awaitSummary?: boolean;
  }): Promise<CompletionResult>;
  compactNode(args: { nodeId: string }): TreeNode;
  runPendingSummaries(): Promise<number>;
  setSummary(args: { nodeId: string; summary: string }): TreeNode;
  reopenNode(args: { nodeId: string; discardThread: boolean }): TreeNode;
  markWorking(args: { nodeId: string }): TreeNode;
  acknowledgeStale(args: { nodeId: string }): TreeNode;
  reconcileArtifacts(): Promise<number>;
  clearThread(threadId: string): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function digestContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function requireText(
  value: string,
  args: { field: string; maxLength: number },
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new TreeError(`${args.field} cannot be empty.`);
  if (trimmed.length > args.maxLength) {
    throw new TreeError(
      `${args.field} must be at most ${args.maxLength} characters.`,
    );
  }
  return trimmed;
}

function boundedText(
  value: string,
  args: { field: string; maxLength: number },
): string {
  if (value.length > args.maxLength) {
    throw new TreeError(
      `${args.field} must be at most ${args.maxLength} characters.`,
    );
  }
  return value;
}

export function createTreeService(deps: TreeServiceDeps): TreeService {
  const { bb, db } = deps;

  function toGraphNode(node: NodeRow): GraphNode {
    return {
      id: node.id,
      completion: node.completion,
      summary: node.summary,
      artifactDigest: node.artifactDigest,
      inputDigest: node.inputDigest,
      instruction: node.instruction,
      contextMode: node.contextMode,
      handoff: node.handoff,
      customBrief: node.customBrief,
      contextIncludes: node.contextIncludes,
    };
  }

  function graphOf(projectId: string): Graph {
    return {
      nodes: listNodes(db, projectId).map(toGraphNode),
      edges: listEdges(db, projectId),
    };
  }

  function loadProject(projectId: string): LoadedProject {
    const project = requireProject(projectId);
    const rows = listNodes(db, projectId);
    const graph: Graph = {
      nodes: rows.map(toGraphNode),
      edges: listEdges(db, projectId),
    };
    return { project, rows, graph, states: resolveNodeStates(graph) };
  }

  function toTreeNode(args: {
    project: ProjectRow;
    row: NodeRow;
    graph: Graph;
    states: Map<string, NodeState>;
  }): TreeNode {
    return {
      id: args.row.id,
      projectId: args.row.projectId,
      title: args.row.title,
      kind: args.row.kind,
      state: args.states.get(args.row.id) ?? "blocked",
      artifactFile: args.row.artifactFile,
      summaryStatus: args.row.summaryStatus,
      summaryProblem: args.row.summaryProblem,
      artifactPath: artifactPath({
        directory: args.project.directory,
        artifactFile: args.row.artifactFile,
      }),
      summary: args.row.summary,
      instruction: args.row.instruction,
      contextMode: args.row.contextMode,
      handoff: args.row.handoff,
      customBrief: args.row.customBrief,
      contextIncludes: args.row.contextIncludes,
      workspace: args.row.workspace,
      threadId: args.row.threadId,
      dependsOn: parentIdsOf(args.graph, args.row.id),
      x: args.row.x,
      y: args.row.y,
      createdAt: args.row.createdAt,
      updatedAt: args.row.updatedAt,
    };
  }

  function requireProject(projectId: string): ProjectRow {
    const project = getProject(db, projectId);
    if (project === null) {
      throw new TreeError(`Unknown tree project ${projectId}.`);
    }
    return project;
  }

  function requireNode(nodeId: string): NodeRow {
    const node = getNode(db, nodeId);
    if (node === null) throw new TreeError(`Unknown task ${nodeId}.`);
    return node;
  }

  function summaryOf(loaded: LoadedProject): TreeProject {
    let readyCount = 0;
    let staleCount = 0;
    for (const state of loaded.states.values()) {
      if (state === "ready") readyCount += 1;
      if (state === "stale") staleCount += 1;
    }
    return {
      id: loaded.project.id,
      name: loaded.project.name,
      directory: loaded.project.directory,
      bbProjectId: loaded.project.bbProjectId,
      nodeCount: loaded.states.size,
      readyCount,
      staleCount,
      createdAt: loaded.project.createdAt,
      updatedAt: loaded.project.updatedAt,
    };
  }

  function publish(projectId: string | null): void {
    bb.realtime.publish(TREES_REALTIME_CHANNEL, {
      kind: "graph-changed",
      projectId,
    });
  }

  function nodeView(nodeId: string): TreeNode {
    const row = requireNode(nodeId);
    const loaded = loadProject(row.projectId);
    return toTreeNode({
      project: loaded.project,
      row,
      graph: loaded.graph,
      states: loaded.states,
    });
  }

  async function resolvePersonalProjectId(): Promise<string> {
    const projects = projectListSchema.parse(
      await bb.sdk.projects.list({ includePersonal: true }),
    );
    if (!projects.some((project) => project.id === PERSONAL_PROJECT_ID)) {
      throw new TreeError(
        "bb has no personal project, so this task has nowhere to run. Point the task at a bb project instead.",
      );
    }
    return PERSONAL_PROJECT_ID;
  }

  async function openAgentThread(args: {
    node: NodeRow;
    baseBranch: string;
    prompt: string;
  }): Promise<void> {
    const project = requireProject(args.node.projectId);
    if (project.bbProjectId === null) {
      throw new TreeError(
        `${project.name} is not associated with a bb project, so its agent tasks have nowhere to check out.`,
      );
    }
    const instruction = requireText(args.prompt, {
      field: "A first message",
      maxLength: MAX_INSTRUCTION_LENGTH,
    });
    const now = Date.now();
    updateNodeRow(db, { nodeId: args.node.id, now, instruction });
    const preview = await buildContextPreview(requireNode(args.node.id));
    const thread = threadSchema.parse(
      await bb.sdk.threads.spawn({
        projectId: project.bbProjectId,
        environment: {
          type: "host",
          hostId: await primaryHostId(),
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "named", name: args.baseBranch },
          },
        },
        title: args.node.title,
        prompt: preview.prompt,
        pluginMetadata: {
          treeProjectId: args.node.projectId,
          treeNodeId: args.node.id,
        },
      }),
    );
    updateNodeRow(db, {
      nodeId: args.node.id,
      now: Date.now(),
      threadId: thread.id,
      completion: "working",
    });
  }

  async function primaryHostId(): Promise<string> {
    const hosts = hostListSchema.parse(await bb.sdk.hosts.list());
    const host =
      hosts.find((candidate) => candidate.isPrimary === true) ??
      hosts.find((candidate) => candidate.connected === true) ??
      hosts[0];
    if (host === undefined) {
      throw new TreeError("No machine is enrolled with bb.");
    }
    return host.id;
  }

  async function requireBbCheckout(bbProjectId: string): Promise<void> {
    const projects = projectListSchema.parse(await bb.sdk.projects.list());
    const owner = projects.find((project) => project.id === bbProjectId);
    if (owner === undefined) {
      throw new TreeError(`No bb project has the id ${bbProjectId}.`);
    }
    const source = (owner.sources ?? []).find(
      (candidate) =>
        candidate.type === "local_path" && typeof candidate.path === "string",
    );
    if (source?.path === undefined) {
      throw new TreeError(
        `${owner.name} has no local checkout, so its tasks have nowhere to make a worktree.`,
      );
    }
  }

  async function resolveProjectOwningPath(path: string): Promise<string> {
    const projects = projectListSchema.parse(await bb.sdk.projects.list());
    const owner = projects.find((project) =>
      (project.sources ?? []).some(
        (source) =>
          source.type === "local_path" &&
          typeof source.path === "string" &&
          (source.path === path || path.startsWith(`${source.path}/`)),
      ),
    );
    if (owner === undefined) {
      throw new TreeError(
        `No bb project has ${path} as a source, and bb only runs a thread in a directory a project owns. Add that directory as a bb project, then point this task at the project.`,
      );
    }
    return owner.id;
  }

  async function readHostFile(path: string): Promise<ArtifactContent> {
    try {
      const file = await bb.sdk.files.read({ path });
      if ("notModified" in file) {
        return {
          content: "",
          sha256: null,
          problem: `Could not read ${path}.`,
        };
      }
      if (file.contentEncoding !== "utf8") {
        return {
          content: "",
          sha256: null,
          problem: `${path} is not a UTF-8 text file.`,
        };
      }
      return { content: file.content, sha256: file.sha256, problem: null };
    } catch (error) {
      return { content: "", sha256: null, problem: errorText(error) };
    }
  }

  async function writeHostFile(args: {
    path: string;
    rootPath: string;
    content: string;
    expectedSha256?: string | null;
  }): Promise<string> {
    const result = await bb.sdk.files.write({
      path: args.path,
      rootPath: args.rootPath,
      content: args.content,
      createParents: true,
      ...(args.expectedSha256 === undefined
        ? {}
        : { expectedSha256: args.expectedSha256 }),
    });
    if (result.outcome === "conflict") {
      throw new TreeError(
        `${args.path} changed on disk since it was loaded. Reload the task and apply the change again.`,
      );
    }
    return result.sha256;
  }

  async function waitForTurnToSettle(threadId: string): Promise<void> {
    const startedAt = Date.now();
    let sawBusy = false;
    while (Date.now() - startedAt < TURN_TIMEOUT_MS) {
      const thread = threadSchema.parse(await bb.sdk.threads.get({ threadId }));
      if (BUSY_THREAD_STATUSES.has(thread.status)) {
        sawBusy = true;
      } else if (thread.status === "error") {
        throw new TreeError("The agent's turn failed before it finished.");
      } else if (
        thread.status === "idle" &&
        (sawBusy || Date.now() - startedAt > ACTIVATION_GRACE_MS)
      ) {
        return;
      }
      await sleep(TURN_POLL_INTERVAL_MS);
    }
    throw new TreeError("The agent did not finish within three minutes.");
  }

  async function threadOutput(threadId: string): Promise<string> {
    const { output } = await bb.sdk.threads.output({ threadId });
    return output ?? "";
  }

  function readArtifactContent(
    node: NodeRow,
    project: ProjectRow,
  ): Promise<ArtifactContent> {
    return readHostFile(
      artifactPath({
        directory: project.directory,
        artifactFile: node.artifactFile,
      }),
    );
  }

  async function summarizeWithWorker(args: {
    node: NodeRow;
    artifact: string;
  }): Promise<string> {
    const projectId = await resolvePersonalProjectId();
    const worker = threadSchema.parse(
      await bb.sdk.threads.spawn({
        projectId,
        environment: PERSONAL_WORKSPACE_ENVIRONMENT,
        prompt: markdownSummaryPrompt({
          title: args.node.title,
          artifact: args.artifact,
        }),
        title: `Compact ${args.node.title}`,
        visibility: "hidden",
      }),
    );
    try {
      await waitForTurnToSettle(worker.id);
      return await threadOutput(worker.id);
    } finally {
      try {
        await bb.sdk.threads.archive({ threadId: worker.id });
        await bb.sdk.threads.stop({ threadId: worker.id });
      } catch (error) {
        bb.log.warn(
          `Trees could not release its summarizer thread: ${errorText(error)}`,
        );
      }
    }
  }

  async function summarizeInThread(node: NodeRow): Promise<string> {
    if (node.threadId === null) {
      throw new TreeError("This task has no thread to summarize.");
    }
    await bb.sdk.threads.send({
      threadId: node.threadId,
      mode: "auto",
      input: [
        {
          type: "text",
          text: summaryRequestPrompt({ title: node.title }),
          mentions: [],
        },
      ],
    });
    await waitForTurnToSettle(node.threadId);
    return await threadOutput(node.threadId);
  }

  async function generateSummary(node: NodeRow): Promise<string> {
    const project = requireProject(node.projectId);
    if (node.kind === "agent") {
      return (await summarizeInThread(node)).trim();
    }
    const artifact = await readArtifactContent(node, project);
    if (artifact.problem !== null) {
      throw new TreeError(
        `Could not read ${node.artifactFile}: ${artifact.problem}`,
      );
    }
    if (isMarkdownStub(artifact.content)) {
      throw new TreeError(
        `${node.artifactFile} holds nothing but its heading, so there is nothing to compact.`,
      );
    }
    return (
      await summarizeWithWorker({ node, artifact: artifact.content })
    ).trim();
  }

  async function buildContextPreview(node: NodeRow): Promise<ContextPreview> {
    const project = requireProject(node.projectId);
    const graph = graphOf(node.projectId);
    const rows = new Map(
      listNodes(db, node.projectId).map((row) => [row.id, row]),
    );
    const ancestors = new Set(ancestorIdsOf(graph, node.id));
    const sourceIds =
      node.contextMode === "custom"
        ? node.contextIncludes.filter((sourceId) => ancestors.has(sourceId))
        : parentIdsOf(graph, node.id);
    const sources: ContextSource[] = [];
    for (const sourceId of sourceIds) {
      const source = rows.get(sourceId);
      if (source === undefined) continue;
      const sendsDocument =
        node.contextMode === "full_parents" || source.handoff === "full";
      const artifact = sendsDocument
        ? (await readArtifactContent(source, project)).content
        : "";
      sources.push({
        nodeId: source.id,
        title: source.title,
        artifactFile: source.artifactFile,
        summary: source.summary,
        artifact,
        handoff: source.handoff,
      });
    }
    return {
      prompt: assembleContext({
        nodeTitle: node.title,
        nodeKind: node.kind,
        artifactFile: node.artifactFile,
        mode: node.contextMode,
        customBrief: node.customBrief,
        instruction: node.instruction,
        sources,
      }),
      sourceTitles: sources.map((source) => source.title),
    };
  }

  function recordCompletion(args: {
    node: NodeRow;
    artifactDigest: string;
    summary: string;
    now: number;
  }): void {
    updateNodeRow(db, {
      nodeId: args.node.id,
      now: args.now,
      completion: "done",
      artifactDigest: args.artifactDigest,
      summary: args.summary,
    });
    updateNodeRow(db, {
      nodeId: args.node.id,
      now: args.now,
      inputDigest: currentInputDigest(
        graphOf(args.node.projectId),
        args.node.id,
      ),
    });
    touchProject(db, { projectId: args.node.projectId, now: args.now });
  }

  async function nodePlacement(node: NodeRow): Promise<NodePlacement> {
    if (node.workspace.kind === "project") {
      return {
        projectId: node.workspace.projectId,
        environment: { type: "project-default" },
      };
    }
    if (node.workspace.kind === "path") {
      return {
        projectId: await resolveProjectOwningPath(node.workspace.path),
        environment: { type: "project-default" },
      };
    }
    if (node.workspace.kind === "environment") {
      const environmentId = node.workspace.environmentId;
      const environment = environmentRowSchema.parse(
        await bb.sdk.environments.get({ environmentId }),
      );
      return {
        projectId: environment.projectId,
        environment: { type: "reuse", environmentId },
      };
    }
    return {
      projectId: await resolvePersonalProjectId(),
      environment: PERSONAL_WORKSPACE_ENVIRONMENT,
    };
  }

  function requireRunnable(node: NodeRow): void {
    if (node.kind !== "agent") {
      throw new TreeError("Only agent tasks run in a thread.");
    }
    const state = resolveNodeStates(graphOf(node.projectId)).get(node.id);
    if (state === "blocked") {
      throw new TreeError(
        "This task is still waiting on the tasks it depends on.",
      );
    }
  }

  const service: TreeService = {
    listProjects() {
      return listProjectRows(db).map((project) =>
        summaryOf(loadProject(project.id)),
      );
    },

    getProject(projectId) {
      return summaryOf(loadProject(projectId));
    },

    async listBaseBranches(args) {
      const project = requireProject(args.projectId);
      if (project.bbProjectId === null) {
        throw new TreeError(
          `${project.name} is not associated with a bb project, so it has no branches to start from.`,
        );
      }
      const result = branchOptionsSchema.parse(
        await bb.sdk.projects.branches({
          projectId: project.bbProjectId,
          hostId: await primaryHostId(),
        }),
      );
      const seen = new Set<string>();
      const branches: string[] = [];
      for (const branch of [...result.branches, ...result.remoteBranches]) {
        if (seen.has(branch)) continue;
        seen.add(branch);
        branches.push(branch);
      }
      return {
        branches,
        defaultBranch: result.defaultWorktreeBaseBranch ?? result.defaultBranch,
      };
    },

    async revealDirectory(args) {
      const project = requireProject(args.projectId);
      await deps.revealDirectory(project.directory);
      return project.directory;
    },

    async setBbProject(args) {
      const project = requireProject(args.projectId);
      await requireBbCheckout(args.bbProjectId);
      setProjectBbProjectRow(db, {
        projectId: project.id,
        bbProjectId: args.bbProjectId,
        now: Date.now(),
      });
      publish(project.id);
      return summaryOf(loadProject(project.id));
    },

    async openThread(args) {
      const node = requireNode(args.nodeId);
      if (node.kind !== "agent") {
        throw new TreeError("Only agent tasks run in a thread.");
      }
      if (node.threadId !== null) {
        throw new TreeError(
          "This task already has a thread. Detach it first to start over.",
        );
      }
      await openAgentThread({
        node,
        baseBranch: args.baseBranch,
        prompt: args.prompt,
      });
      publish(node.projectId);
      return nodeView(node.id);
    },

    async createProject(args) {
      const name = requireText(args.name, {
        field: "A project name",
        maxLength: MAX_TITLE_LENGTH,
      });
      if (listProjectRows(db).length >= MAX_PROJECTS) {
        throw new TreeError(
          `Trees holds at most ${MAX_PROJECTS} projects. Delete one before adding another.`,
        );
      }
      const bbProjectId = args.bbProjectId ?? null;
      if (bbProjectId !== null) await requireBbCheckout(bbProjectId);
      const rootDirectory = await deps.resolveRootDirectory();
      const directory = projectDirectory({ rootDirectory, name });
      if (findProjectByDirectory(db, directory) !== null) {
        throw new TreeError(
          `Another project already uses the folder ${directory}.`,
        );
      }
      await bb.sdk.files.mkdir({ path: directory, recursive: true });
      const now = Date.now();
      const project = insertProject(db, {
        name,
        directory,
        bbProjectId,
        now,
      });
      publish(project.id);
      return summaryOf(loadProject(project.id));
    },

    renameProject(args) {
      const project = requireProject(args.projectId);
      renameProjectRow(db, {
        projectId: project.id,
        name: requireText(args.name, {
          field: "A project name",
          maxLength: MAX_TITLE_LENGTH,
        }),
        now: Date.now(),
      });
      publish(project.id);
      return summaryOf(loadProject(project.id));
    },

    deleteProject(args) {
      deleteProjectRow(db, requireProject(args.projectId).id);
      publish(null);
    },

    getGraph(projectId) {
      const loaded = loadProject(projectId);
      return {
        project: summaryOf(loaded),
        nodes: loaded.rows.map((row) =>
          toTreeNode({
            project: loaded.project,
            row,
            graph: loaded.graph,
            states: loaded.states,
          }),
        ),
      };
    },

    getNode(nodeId) {
      return nodeView(nodeId);
    },

    listReady(args) {
      const entries: ReadyEntry[] = [];
      for (const row of listProjectRows(db)) {
        if (args.projectId !== null && row.id !== args.projectId) continue;
        const loaded = loadProject(row.id);
        const summary = summaryOf(loaded);
        for (const node of loaded.rows) {
          const state = loaded.states.get(node.id);
          if (state !== "ready" && state !== "stale") continue;
          entries.push({
            project: summary,
            node: toTreeNode({
              project: loaded.project,
              row: node,
              graph: loaded.graph,
              states: loaded.states,
            }),
          });
        }
      }
      return entries;
    },

    async createNode(args) {
      const project = requireProject(args.projectId);
      const title = requireText(args.title, {
        field: "A task title",
        maxLength: MAX_TITLE_LENGTH,
      });
      const graph = graphOf(project.id);
      if (graph.nodes.length >= MAX_NODES_PER_PROJECT) {
        throw new TreeError(
          `A tree holds at most ${MAX_NODES_PER_PROJECT} tasks.`,
        );
      }
      const dependsOn = [...new Set(args.dependsOn ?? [])];
      for (const parentId of dependsOn) {
        if (!graph.nodes.some((node) => node.id === parentId)) {
          throw new TreeError(`Unknown dependency ${parentId}.`);
        }
      }
      if (args.workspace !== undefined && args.kind !== "agent") {
        throw new TreeError(
          "Only agent tasks run in a workspace; a note has nowhere to run.",
        );
      }
      const now = Date.now();
      const ordinal = nextOrdinal(db, project.id);
      const nodeId = insertNode(db, {
        projectId: project.id,
        ordinal,
        title,
        kind: args.kind,
        artifactFile: artifactFileName({ ordinal, title }),
        instruction: boundedText(args.instruction ?? "", {
          field: "A task instruction",
          maxLength: MAX_INSTRUCTION_LENGTH,
        }),
        contextMode: args.contextMode ?? "auto_compact",
        handoff: args.handoff ?? "summary",
        customBrief: boundedText(args.customBrief ?? "", {
          field: "A context brief",
          maxLength: MAX_INSTRUCTION_LENGTH,
        }),
        workspace: args.workspace ?? { kind: "tree" },
        x: args.position?.x ?? 0,
        y: args.position?.y ?? 0,
        now,
      });
      for (const parentId of dependsOn) {
        insertEdge(db, { projectId: project.id, parentId, childId: nodeId });
      }
      if (args.position === undefined) {
        service.autoLayout({ projectId: project.id });
      }
      const created = requireNode(nodeId);
      if (created.kind === "markdown") {
        try {
          await writeHostFile({
            path: artifactPath({
              directory: project.directory,
              artifactFile: created.artifactFile,
            }),
            rootPath: project.directory,
            content: markdownStub(title),
            expectedSha256: null,
          });
        } catch (error) {
          bb.log.info(
            `Trees kept the file already at ${created.artifactFile}: ${errorText(error)}`,
          );
        }
      }
      touchProject(db, { projectId: project.id, now });
      publish(project.id);
      return nodeView(nodeId);
    },

    updateNode(args) {
      const node = requireNode(args.nodeId);
      const now = Date.now();
      const update: UpdateNodeArgs = { nodeId: node.id, now };
      if (args.title !== undefined) {
        update.title = requireText(args.title, {
          field: "A task title",
          maxLength: MAX_TITLE_LENGTH,
        });
      }
      if (args.instruction !== undefined) {
        update.instruction = boundedText(args.instruction, {
          field: "A task instruction",
          maxLength: MAX_INSTRUCTION_LENGTH,
        });
      }
      if (args.contextMode !== undefined) {
        if (!CONTEXT_MODES.includes(args.contextMode)) {
          throw new TreeError(`Unknown context mode ${args.contextMode}.`);
        }
        update.contextMode = args.contextMode;
      }
      if (args.handoff !== undefined) {
        if (!HANDOFF_MODES.includes(args.handoff)) {
          throw new TreeError(`Unknown handoff ${args.handoff}.`);
        }
        update.handoff = args.handoff;
      }
      if (args.customBrief !== undefined) {
        update.customBrief = boundedText(args.customBrief, {
          field: "A context brief",
          maxLength: MAX_INSTRUCTION_LENGTH,
        });
      }
      if (args.workspace !== undefined) {
        if (node.kind !== "agent") {
          throw new TreeError(
            "Only agent tasks run in a workspace; a note has nowhere to run.",
          );
        }
        update.workspace = args.workspace;
      }
      if (args.contextIncludes !== undefined) {
        const graph = graphOf(node.projectId);
        const known = new Set(graph.nodes.map((candidate) => candidate.id));
        const ancestors = new Set(ancestorIdsOf(graph, node.id));
        for (const includedNodeId of args.contextIncludes) {
          if (includedNodeId === node.id) {
            throw new TreeError("A task cannot include its own output.");
          }
          if (!known.has(includedNodeId)) {
            throw new TreeError(`Unknown context source ${includedNodeId}.`);
          }
          if (!ancestors.has(includedNodeId)) {
            throw new TreeError(
              `${requireNode(includedNodeId).title} is not upstream of this task, so its output cannot be a context source. Add a dependency first.`,
            );
          }
        }
        replaceContextIncludes(db, {
          nodeId: node.id,
          includedNodeIds: [...new Set(args.contextIncludes)],
        });
      }
      updateNodeRow(db, update);
      touchProject(db, { projectId: node.projectId, now });
      publish(node.projectId);
      return nodeView(node.id);
    },

    deleteNode(args) {
      const node = requireNode(args.nodeId);
      const graph = graphOf(node.projectId);
      const parents = parentIdsOf(graph, node.id);
      const children = graph.edges
        .filter((edge) => edge.parentId === node.id)
        .map((edge) => edge.childId);
      for (const childId of children) {
        for (const parentId of parents) {
          if (dependencyProblem(graph, parentId, childId) !== null) continue;
          insertEdge(db, { projectId: node.projectId, parentId, childId });
        }
      }
      deleteNodeRow(db, node.id);
      touchProject(db, { projectId: node.projectId, now: Date.now() });
      publish(node.projectId);
    },

    moveNode(args) {
      const node = requireNode(args.nodeId);
      updateNodeRow(db, {
        nodeId: node.id,
        now: Date.now(),
        position: { x: args.x, y: args.y },
      });
      publish(node.projectId);
    },

    autoLayout(args) {
      const project = requireProject(args.projectId);
      const now = Date.now();
      for (const [nodeId, position] of layeredLayout(graphOf(project.id))) {
        updateNodeRow(db, { nodeId, now, position });
      }
      publish(project.id);
    },

    addDependency(args) {
      const child = requireNode(args.childId);
      const parent = requireNode(args.parentId);
      if (parent.projectId !== child.projectId) {
        throw new TreeError(
          "Tasks in different trees cannot depend on each other.",
        );
      }
      const problem = dependencyProblem(
        graphOf(child.projectId),
        parent.id,
        child.id,
      );
      if (problem !== null) throw new TreeError(problem);
      insertEdge(db, {
        projectId: child.projectId,
        parentId: parent.id,
        childId: child.id,
      });
      touchProject(db, { projectId: child.projectId, now: Date.now() });
      publish(child.projectId);
    },

    removeDependency(args) {
      const child = requireNode(args.childId);
      deleteEdge(db, { parentId: args.parentId, childId: args.childId });
      touchProject(db, { projectId: child.projectId, now: Date.now() });
      publish(child.projectId);
    },

    async readArtifact(args) {
      const node = requireNode(args.nodeId);
      return await readArtifactContent(node, requireProject(node.projectId));
    },

    async writeArtifact(args) {
      const node = requireNode(args.nodeId);
      const project = requireProject(node.projectId);
      if (args.content.length > MAX_ARTIFACT_CHARS) {
        throw new TreeError(
          `A task file must be at most ${MAX_ARTIFACT_CHARS} characters.`,
        );
      }
      const sha256 = await writeHostFile({
        path: artifactPath({
          directory: project.directory,
          artifactFile: node.artifactFile,
        }),
        rootPath: project.directory,
        content: args.content,
        expectedSha256: args.expectedSha256,
      });
      if (node.completion === "done") {
        updateNodeRow(db, {
          nodeId: node.id,
          now: Date.now(),
          artifactDigest: sha256,
        });
      }
      publish(node.projectId);
      return { sha256 };
    },

    async previewContext(args) {
      return await buildContextPreview(requireNode(args.nodeId));
    },

    async startNode(args) {
      const node = requireNode(args.nodeId);
      requireRunnable(node);
      if (node.threadId !== null) {
        throw new TreeError(
          "This task already has a thread. Send it the current context, or reset the task to start over.",
        );
      }
      const preview = await buildContextPreview(node);
      const placement = await nodePlacement(node);
      const thread = threadSchema.parse(
        await bb.sdk.threads.spawn({
          projectId: placement.projectId,
          environment: placement.environment,
          prompt: preview.prompt,
          title: node.title,
          pluginMetadata: {
            treeProjectId: node.projectId,
            treeNodeId: node.id,
          },
        }),
      );
      const now = Date.now();
      updateNodeRow(db, {
        nodeId: node.id,
        now,
        threadId: thread.id,
        completion: "working",
      });
      touchProject(db, { projectId: node.projectId, now });
      publish(node.projectId);
      return nodeView(node.id);
    },

    async resendContext(args) {
      const node = requireNode(args.nodeId);
      requireRunnable(node);
      if (node.threadId === null) {
        throw new TreeError("This task has no thread yet. Start it first.");
      }
      const preview = await buildContextPreview(node);
      await bb.sdk.threads.send({
        threadId: node.threadId,
        mode: "auto",
        input: [{ type: "text", text: preview.prompt, mentions: [] }],
      });
      const now = Date.now();
      updateNodeRow(db, { nodeId: node.id, now, completion: "working" });
      touchProject(db, { projectId: node.projectId, now });
      publish(node.projectId);
      return nodeView(node.id);
    },

    /*
     * Pushes this task's output to the tasks that depend on it, rather than
     * waiting for each of them to pull it. One child failing does not stop
     * the others: every child reports what became of it.
     */
    async handDownContext(args) {
      const node = requireNode(args.nodeId);
      const graph = graphOf(node.projectId);
      const rows = new Map(
        listNodes(db, node.projectId).map((row) => [row.id, row]),
      );
      const deliveries: HandDownDelivery[] = [];
      for (const childId of childIdsOf(graph, node.id)) {
        const child = rows.get(childId);
        if (child === undefined) continue;
        if (child.kind !== "agent") {
          deliveries.push({
            nodeId: child.id,
            title: child.title,
            outcome: "note",
            problem: null,
          });
          continue;
        }
        if (child.threadId === null) {
          deliveries.push({
            nodeId: child.id,
            title: child.title,
            outcome: "on_start",
            problem: null,
          });
          continue;
        }
        try {
          const preview = await buildContextPreview(child);
          await bb.sdk.threads.send({
            threadId: child.threadId,
            mode: "auto",
            input: [
              {
                type: "text",
                text: additionalContextPrompt({ context: preview.prompt }),
                mentions: [],
              },
            ],
          });
          deliveries.push({
            nodeId: child.id,
            title: child.title,
            outcome: "sent",
            problem: null,
          });
        } catch (error) {
          deliveries.push({
            nodeId: child.id,
            title: child.title,
            outcome: "failed",
            problem: errorText(error),
          });
        }
      }
      if (deliveries.some((delivery) => delivery.outcome === "sent")) {
        touchProject(db, { projectId: node.projectId, now: Date.now() });
        publish(node.projectId);
      }
      return { deliveries };
    },

    async completeNode(args) {
      const node = requireNode(args.nodeId);
      const project = requireProject(node.projectId);
      const now = Date.now();
      let artifactDigest: string;
      if (node.kind === "agent") {
        if (node.threadId === null) {
          throw new TreeError("Start this task before saving its output.");
        }
        const thread = threadSchema.parse(
          await bb.sdk.threads.get({ threadId: node.threadId }),
        );
        if (BUSY_THREAD_STATUSES.has(thread.status)) {
          throw new TreeError(
            "The agent is still working. Wait for it to finish, then save.",
          );
        }
        const output = (await threadOutput(node.threadId)).trim();
        if (output.length === 0) {
          throw new TreeError(
            "The agent has not produced any output to save yet.",
          );
        }
        artifactDigest = await writeHostFile({
          path: artifactPath({
            directory: project.directory,
            artifactFile: node.artifactFile,
          }),
          rootPath: project.directory,
          content: `${output}\n`,
        });
      } else {
        const artifact = await readArtifactContent(node, project);
        if (artifact.problem !== null) {
          throw new TreeError(
            `Could not read ${node.artifactFile}: ${artifact.problem}`,
          );
        }
        if (isMarkdownStub(artifact.content)) {
          throw new TreeError(
            `Write something under the heading in ${node.artifactFile} before marking this task done.`,
          );
        }
        artifactDigest = artifact.sha256 ?? digestContent(artifact.content);
      }
      recordCompletion({
        node,
        artifactDigest,
        summary: node.summary,
        now,
      });
      /*
       * Only an auto-summarized task is compacted on completion. A task
       * handing over its whole document has no summary anyone reads, and one
       * handing over text the user wrote must not have that text replaced.
       * Both would cost a model call and a wait for nothing.
       */
      if (node.handoff !== "summary") {
        updateNodeRow(db, {
          nodeId: node.id,
          now,
          summaryStatus: "idle",
          summaryProblem: null,
        });
        publish(node.projectId);
        return { node: nodeView(node.id), summaryProblem: null };
      }
      updateNodeRow(db, {
        nodeId: node.id,
        now,
        summaryStatus: "pending",
        summaryProblem: null,
      });
      publish(node.projectId);
      if (args.awaitSummary !== true) {
        return { node: nodeView(node.id), summaryProblem: null };
      }
      await service.runPendingSummaries();
      const settled = nodeView(node.id);
      return { node: settled, summaryProblem: settled.summaryProblem };
    },

    compactNode(args) {
      const node = requireNode(args.nodeId);
      /*
       * Compacting is explicit, so it is allowed on a custom handoff: it
       * drafts the text the user then edits. On a full handoff there is
       * nothing to draft, because no task is shown the summary field.
       */
      if (node.handoff === "full") {
        throw new TreeError(
          `${node.title} hands its whole document downstream, so a summary of it would never be read. Change what it passes downstream first.`,
        );
      }
      updateNodeRow(db, {
        nodeId: node.id,
        now: Date.now(),
        summaryStatus: "pending",
        summaryProblem: null,
      });
      publish(node.projectId);
      return nodeView(node.id);
    },

    async runPendingSummaries() {
      const pending = listPendingSummaryNodeIds(db);
      for (const nodeId of pending) {
        const node = getNode(db, nodeId);
        if (node === null || node.summaryStatus !== "pending") continue;
        try {
          const summary = await generateSummary(node);
          if (summary.length === 0) {
            throw new TreeError("The summarizer returned nothing to store.");
          }
          updateNodeRow(db, {
            nodeId: node.id,
            now: Date.now(),
            summary: summary.slice(0, MAX_SUMMARY_LENGTH),
            summaryStatus: "idle",
            summaryProblem: null,
          });
          updateNodeRow(db, {
            nodeId: node.id,
            now: Date.now(),
            inputDigest: currentInputDigest(graphOf(node.projectId), node.id),
          });
        } catch (error) {
          const problem = errorText(error);
          bb.log.warn(`Trees could not compact ${node.title}: ${problem}`);
          updateNodeRow(db, {
            nodeId: node.id,
            now: Date.now(),
            summaryStatus: "failed",
            summaryProblem: problem,
          });
        }
        publish(node.projectId);
      }
      return pending.length;
    },

    setSummary(args) {
      const node = requireNode(args.nodeId);
      updateNodeRow(db, {
        nodeId: node.id,
        now: Date.now(),
        summary: boundedText(args.summary, {
          field: "A summary",
          maxLength: MAX_SUMMARY_LENGTH,
        }),
      });
      publish(node.projectId);
      return nodeView(node.id);
    },

    reopenNode(args) {
      const node = requireNode(args.nodeId);
      const now = Date.now();
      updateNodeRow(db, {
        nodeId: node.id,
        now,
        completion: "open",
        inputDigest: "",
        ...(args.discardThread ? { threadId: null } : {}),
      });
      touchProject(db, { projectId: node.projectId, now });
      publish(node.projectId);
      return nodeView(node.id);
    },

    markWorking(args) {
      const node = requireNode(args.nodeId);
      const state = resolveNodeStates(graphOf(node.projectId)).get(node.id);
      if (state === "blocked") {
        throw new TreeError(
          "This task is still waiting on the tasks it depends on.",
        );
      }
      const now = Date.now();
      updateNodeRow(db, {
        nodeId: node.id,
        now,
        completion: "working",
        inputDigest: "",
      });
      touchProject(db, { projectId: node.projectId, now });
      publish(node.projectId);
      return nodeView(node.id);
    },

    acknowledgeStale(args) {
      const node = requireNode(args.nodeId);
      if (node.completion !== "done") {
        throw new TreeError(
          "Only a completed task carries a stale warning to acknowledge.",
        );
      }
      const graph = graphOf(node.projectId);
      const states = resolveNodeStates(graph);
      const staleParent = parentIdsOf(graph, node.id).find(
        (parentId) => states.get(parentId) === "stale",
      );
      if (staleParent !== undefined) {
        throw new TreeError(
          `${requireNode(staleParent).title} is still stale. Resolve the upstream task first.`,
        );
      }
      updateNodeRow(db, {
        nodeId: node.id,
        now: Date.now(),
        inputDigest: currentInputDigest(graph, node.id),
      });
      publish(node.projectId);
      return nodeView(node.id);
    },

    async reconcileArtifacts() {
      if (countNodes(db) === 0) return 0;
      let changed = 0;
      for (const project of listProjectRows(db)) {
        let projectChanged = false;
        for (const node of listNodes(db, project.id)) {
          if (node.completion !== "done") continue;
          const artifact = await readArtifactContent(node, project);
          if (artifact.problem !== null) continue;
          const digest = artifact.sha256 ?? digestContent(artifact.content);
          if (digest === node.artifactDigest) continue;
          updateNodeRow(db, {
            nodeId: node.id,
            now: Date.now(),
            artifactDigest: digest,
          });
          projectChanged = true;
          changed += 1;
        }
        if (projectChanged) publish(project.id);
      }
      return changed;
    },

    clearThread(threadId) {
      const node = findNodeByThread(db, threadId);
      if (node === null) return;
      updateNodeRow(db, {
        nodeId: node.id,
        now: Date.now(),
        threadId: null,
        ...(node.completion === "working" ? { completion: "open" } : {}),
      });
      publish(node.projectId);
    },
  };

  return service;
}
