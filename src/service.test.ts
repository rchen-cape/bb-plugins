import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import treesPlugin from "../server";
import type { TreeGraph, TreeNode, TreeProject } from "./model";

const ROOT = "/tmp/bb-trees-test";
const NODE_OUTPUT = "The finished API design deliverable.";
const SUMMARY_TEXT = "Compacted summary for downstream tasks.";

interface FakeThread {
  id: string;
  output: string;
  busyReads: number;
}

interface SpawnRecord {
  id: string;
  projectId: string;
  prompt: string;
  input: PromptPart[];
  title: string;
  visibility: string | undefined;
  environment: unknown;
}

interface PromptPart {
  type: string;
  text?: string;
  path?: string;
}

interface FakeEnvironment {
  id: string;
  name: string | null;
  projectId: string;
  isWorktree: boolean;
  branchName: string | null;
  path: string | null;
  status: string;
}

interface Fakes {
  files: Map<string, string>;
  uploads: { projectId: string; filename: string; bytes: number }[];
  directories: Set<string>;
  environments: Map<string, FakeEnvironment>;
  spawns: SpawnRecord[];
  sent: { threadId: string; text: string; input: PromptPart[] }[];
  archived: string[];
  stopped: string[];
  summaryFailure: string | null;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeFakes(): Fakes {
  return {
    files: new Map(),
    uploads: [],
    directories: new Set(),
    environments: new Map(
      (
        [
          {
            id: "env_shared",
            name: null,
            projectId: "proj_api",
            isWorktree: true,
            branchName: "feature/push",
            path: "/Users/me/Development/api-push",
            status: "ready",
          },
          {
            id: "env_other",
            name: null,
            projectId: "proj_api",
            isWorktree: true,
            branchName: "feature/tests",
            path: "/Users/me/Development/api-tests",
            status: "ready",
          },
        ] satisfies FakeEnvironment[]
      ).map((environment) => [environment.id, environment]),
    ),
    spawns: [],
    sent: [],
    archived: [],
    stopped: [],
    summaryFailure: null,
  };
}

function buildSdk(fakes: Fakes) {
  const threads = new Map<string, FakeThread>();
  let counter = 0;
  return {
    hosts: {
      list: async () => [{ id: "host_1", connected: true, name: "primary" }],
    },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) => {
        const environment = fakes.environments.get(environmentId);
        if (environment === undefined) {
          throw new Error(`no environment ${environmentId}`);
        }
        return environment;
      },
      list: async () => [...fakes.environments.values()],
    },
    projects: {
      attachments: {
        // Typed as the SDK's own union, which is wider than Trees ever sends.
        upload: async (args: {
          projectId: string;
          clientFile: unknown;
          filename?: string;
          mimeType?: string;
        }) => {
          const bytes =
            args.clientFile instanceof Uint8Array
              ? args.clientFile.byteLength
              : 0;
          const filename = args.filename ?? "attachment";
          fakes.uploads.push({ projectId: args.projectId, filename, bytes });
          return {
            type: "localImage" as const,
            path: `attachments/${args.projectId}/${filename}`,
            name: filename,
            mimeType: args.mimeType,
            sizeBytes: bytes,
          };
        },
      },
      branches: async () => ({
        branches: ["main", "feature/push"],
        remoteBranches: ["origin/main"],
        defaultBranch: "main",
        defaultWorktreeBaseBranch: "main",
        checkout: { kind: "branch", branchName: "main", headSha: null },
        isWorktree: false,
        defaultBranchRelation: null,
        hasUncommittedChanges: false,
        operation: null,
        originDefaultBranch: "origin/main",
        branchesTruncated: false,
        remoteBranchesTruncated: false,
        selectedBranch: null,
      }),
      list: async () => [
        { id: "proj_personal", name: "Personal", sources: [] },
        {
          id: "proj_api",
          name: "API",
          sources: [
            {
              type: "local_path",
              hostId: "host_1",
              path: "/Users/me/Development/api",
            },
          ],
        },
      ],
    },
    files: {
      createPreview: async ({ rootPath }: { rootPath: string }) => ({
        baseUrl: `http://127.0.0.1:1/preview/${encodeURIComponent(rootPath)}`,
        expiresAtMs: 2_000,
      }),
      mkdir: async ({ path }: { path: string }) => {
        fakes.directories.add(path);
        return { created: true };
      },
      read: async ({ path }: { path: string }) => {
        const content = fakes.files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return {
          path,
          content,
          contentEncoding: "utf8" as const,
          sizeBytes: content.length,
          sha256: digest(content),
        };
      },
      write: async ({
        path,
        content,
        expectedSha256,
      }: {
        path: string;
        content: string;
        expectedSha256?: string | null;
      }) => {
        const existing = fakes.files.get(path);
        if (expectedSha256 !== undefined) {
          const current = existing === undefined ? null : digest(existing);
          if (current !== expectedSha256) {
            return {
              outcome: "conflict" as const,
              currentSha256: current,
            };
          }
        }
        fakes.files.set(path, content);
        return {
          outcome: "written" as const,
          sha256: digest(content),
          sizeBytes: content.length,
        };
      },
    },
    threads: {
      spawn: async (args: {
        projectId: string;
        prompt?: string;
        input?: PromptPart[];
        title?: string;
        visibility?: string;
        environment: unknown;
      }) => {
        counter += 1;
        const id = `th_${counter}`;
        const hidden = args.visibility === "hidden";
        threads.set(id, {
          id,
          output: hidden ? SUMMARY_TEXT : NODE_OUTPUT,
          busyReads: hidden ? 1 : 0,
        });
        const parts = args.input ?? [];
        fakes.spawns.push({
          id,
          projectId: args.projectId,
          // The SDK takes either; a caller passing parts still has a prompt.
          prompt:
            args.prompt ??
            parts
              .filter((part) => part.type === "text")
              .map((part) => String(part.text ?? ""))
              .join("\n"),
          input: parts,
          title: args.title ?? "",
          visibility: args.visibility,
          environment: args.environment,
        });
        return { id, status: "idle" };
      },
      get: async ({ threadId }: { threadId: string }) => {
        const thread = threads.get(threadId);
        if (thread === undefined) throw new Error(`unknown thread ${threadId}`);
        if (thread.busyReads > 0) {
          thread.busyReads -= 1;
          return { id: threadId, status: "active", environmentId: "env_1" };
        }
        return { id: threadId, status: "idle", environmentId: "env_1" };
      },
      send: async ({
        threadId,
        input,
      }: {
        threadId: string;
        input: PromptPart[];
      }) => {
        const thread = threads.get(threadId);
        if (thread === undefined) throw new Error(`unknown thread ${threadId}`);
        fakes.sent.push({
          threadId,
          text: String(input[0]?.text ?? ""),
          input,
        });
        if (fakes.summaryFailure !== null) {
          throw new Error(fakes.summaryFailure);
        }
        thread.busyReads = 1;
        thread.output = SUMMARY_TEXT;
        return { ok: true, delivery: "sent" };
      },
      output: async ({ threadId }: { threadId: string }) => ({
        output: threads.get(threadId)?.output ?? null,
      }),
      archive: async ({ threadId }: { threadId: string }) => {
        fakes.archived.push(threadId);
        return { archived: [threadId] };
      },
      stop: async ({ threadId }: { threadId: string }) => {
        fakes.stopped.push(threadId);
        return { ok: true };
      },
    },
  };
}

async function loadPlugin(
  fakes: Fakes,
): Promise<{ host: FakePluginHost; call: CallRpc }> {
  const host = createFakePluginHost({
    pluginId: "trees",
    settings: { rootDirectory: ROOT },
    sdk: buildSdk(fakes),
  });
  await treesPlugin(host.bb);
  const call: CallRpc = (method, input) =>
    host.harness.behavior.callRpc(method, input) as Promise<never>;
  return { host, call };
}

type CallRpc = (method: string, input?: unknown) => Promise<never>;

async function createProject(
  call: CallRpc,
  name: string,
): Promise<TreeProject> {
  const result = (await call("projects_create", { name })) as unknown as {
    project: TreeProject;
  };
  return result.project;
}

async function createNode(
  call: CallRpc,
  input: Record<string, unknown>,
): Promise<TreeNode> {
  const result = (await call("node_create", input)) as unknown as {
    node: TreeNode;
  };
  return result.node;
}

async function graphOf(call: CallRpc, projectId: string): Promise<TreeGraph> {
  return (await call("graph_get", { projectId })) as unknown as TreeGraph;
}

function stateOf(graph: TreeGraph, nodeId: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`missing node ${nodeId}`);
  return node.state;
}

describe("trees service", () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = makeFakes();
  });

  it("registers the panel data plane, the CLI, and a reconcile service", async () => {
    const { host } = await loadPlugin(fakes);
    expect(host.harness.registrations.cli?.name).toBe("tree");
    expect(
      host.harness.registrations.services.map((service) => service.name),
    ).toContain("trees-reconcile");
  });

  it("creates a project folder under the configured root", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Build Auth Feature");
    expect(project.directory).toBe(`${ROOT}/build_auth_feature`);
    expect(fakes.directories.has(project.directory)).toBe(true);
  });

  it("refuses a second project that would share one folder", async () => {
    const { call } = await loadPlugin(fakes);
    await createProject(call, "Build auth");
    await expect(createProject(call, "build   auth")).rejects.toThrow(
      /already uses the folder/u,
    );
  });

  it("writes a Markdown stub for a note and names it by position", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const node = await createNode(call, {
      projectId: project.id,
      title: "Write auth requirements",
      kind: "markdown",
    });
    expect(node.artifactFile).toBe("01_write_auth_requirements.md");
    expect(fakes.files.get(node.artifactPath)).toBe(
      "# Write auth requirements\n\n",
    );
  });

  it("keeps a child blocked until every parent completes, then passes the summary down", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const research = await createNode(call, {
      projectId: project.id,
      title: "User research",
      kind: "markdown",
    });
    const spec = await createNode(call, {
      projectId: project.id,
      title: "Spec doc",
      kind: "markdown",
    });
    const code = await createNode(call, {
      projectId: project.id,
      title: "Write code",
      kind: "agent",
      instruction: "Implement it.",
      dependsOn: [research.id, spec.id],
    });

    expect(stateOf(await graphOf(call, project.id), code.id)).toBe("blocked");

    fakes.files.set(research.artifactPath, "Users need OAuth2.");
    await call("node_complete", { nodeId: research.id, awaitSummary: true });
    expect(stateOf(await graphOf(call, project.id), code.id)).toBe("blocked");

    fakes.files.set(spec.artifactPath, "Endpoints live under /v2.");
    await call("node_complete", { nodeId: spec.id, awaitSummary: true });
    expect(stateOf(await graphOf(call, project.id), code.id)).toBe("ready");

    const preview = (await call("context_preview", {
      nodeId: code.id,
    })) as unknown as { prompt: string };
    expect(preview.prompt).toContain(
      "### Context from User research (summary)",
    );
    expect(preview.prompt).toContain("### Context from Spec doc (summary)");
    expect(preview.prompt).toContain(SUMMARY_TEXT);
    expect(preview.prompt).not.toContain("Users need OAuth2.");
  });

  it("compacts a note through a hidden worker it then releases", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "User research",
      kind: "markdown",
    });
    fakes.files.set(note.artifactPath, "Users need OAuth2.");
    const result = (await call("node_complete", {
      awaitSummary: true,
      nodeId: note.id,
    })) as unknown as { node: TreeNode; summaryProblem: string | null };

    expect(result.summaryProblem).toBeNull();
    expect(result.node.summary).toBe(SUMMARY_TEXT);
    const worker = fakes.spawns.at(-1);
    expect(worker?.visibility).toBe("hidden");
    expect(worker?.environment).toEqual({
      type: "host",
      workspace: { type: "personal" },
    });
    expect(worker?.prompt).toContain("Users need OAuth2.");
    expect(fakes.archived).toContain(worker?.id);
    expect(fakes.stopped).toContain(worker?.id);
  });

  it("refuses to complete a note that still holds only its heading stub", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "User research",
      kind: "markdown",
    });
    await expect(call("node_complete", { nodeId: note.id })).rejects.toThrow(
      /before marking this task done/u,
    );

    fakes.files.delete(note.artifactPath);
    await expect(call("node_complete", { nodeId: note.id })).rejects.toThrow(
      /Could not read/u,
    );
  });

  it("refuses a dependency that would close a loop", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const first = await createNode(call, {
      projectId: project.id,
      title: "First",
      kind: "markdown",
    });
    const second = await createNode(call, {
      projectId: project.id,
      title: "Second",
      kind: "markdown",
      dependsOn: [first.id],
    });
    await expect(
      call("dependency_add", { parentId: second.id, childId: first.id }),
    ).rejects.toThrow(/create a loop/u);
  });

  it("reattaches a deleted task's children to its parents", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const first = await createNode(call, {
      projectId: project.id,
      title: "First",
      kind: "markdown",
    });
    const middle = await createNode(call, {
      projectId: project.id,
      title: "Middle",
      kind: "markdown",
      dependsOn: [first.id],
    });
    const last = await createNode(call, {
      projectId: project.id,
      title: "Last",
      kind: "markdown",
      dependsOn: [middle.id],
    });

    await call("node_delete", { nodeId: middle.id });
    const graph = await graphOf(call, project.id);
    const remaining = graph.nodes.find((node) => node.id === last.id);
    expect(remaining?.dependsOn).toEqual([first.id]);
    expect(graph.nodes).toHaveLength(2);
  });

  it("leaves no dependency rows behind when a task is deleted", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Parent",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Child",
      kind: "agent",
      instruction: "Go.",
      contextMode: "custom",
      dependsOn: [parent.id],
    });
    await call("node_update", {
      nodeId: child.id,
      contextIncludes: [parent.id],
    });

    await call("node_delete", { nodeId: parent.id });
    const graph = await graphOf(call, project.id);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.dependsOn).toEqual([]);
    expect(graph.nodes[0]?.contextIncludes).toEqual([]);
  });

  it("empties a project so its folder can be reused", async () => {
    const { call } = await loadPlugin(fakes);
    const first = await createProject(call, "Auth");
    await createNode(call, {
      projectId: first.id,
      title: "A task",
      kind: "markdown",
    });
    await call("projects_delete", { projectId: first.id });

    const second = await createProject(call, "Auth");
    expect(second.directory).toBe(first.directory);
    expect((await graphOf(call, second.id)).nodes).toEqual([]);
  });

  it("refuses a context source that is not upstream of the task", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const unrelated = await createNode(call, {
      projectId: project.id,
      title: "Unrelated",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Child",
      kind: "agent",
      instruction: "Go.",
      contextMode: "custom",
    });
    await expect(
      call("node_update", {
        nodeId: child.id,
        contextIncludes: [unrelated.id],
      }),
    ).rejects.toThrow(/not upstream/u);
  });

  it("drops a context source that stopped being upstream", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Parent",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Child",
      kind: "agent",
      instruction: "Go.",
      contextMode: "custom",
      dependsOn: [parent.id],
    });
    await call("node_update", {
      nodeId: child.id,
      contextIncludes: [parent.id],
    });
    await call("node_summary_set", {
      nodeId: parent.id,
      summary: "Parent summary.",
    });
    await call("dependency_remove", {
      parentId: parent.id,
      childId: child.id,
    });

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string; sourceTitles: string[] };
    expect(preview.sourceTitles).toEqual([]);
    expect(preview.prompt).not.toContain("Parent summary.");
  });

  it("starts an agent task in a scratch workspace and saves its final message", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Generate API design specs",
      kind: "agent",
      instruction: "Generate the OpenAPI schema.",
    });

    const started = (await call("node_start", {
      nodeId: task.id,
    })) as unknown as { node: TreeNode };
    expect(started.node.state).toBe("in_progress");
    const spawn = fakes.spawns.at(-1);
    expect(spawn?.projectId).toBe("proj_personal");
    expect(spawn?.environment).toEqual({
      type: "host",
      workspace: { type: "personal" },
    });
    expect(spawn?.prompt).toContain("Generate the OpenAPI schema.");
    expect(spawn?.prompt).toContain("01_generate_api_design_specs.md");

    const completion = (await call("node_complete", {
      awaitSummary: true,
      nodeId: task.id,
    })) as unknown as { node: TreeNode; summaryProblem: string | null };
    expect(fakes.files.get(task.artifactPath)).toBe(`${NODE_OUTPUT}\n`);
    expect(completion.node.summary).toBe(SUMMARY_TEXT);
    expect(completion.node.state).toBe("completed");
    expect(fakes.sent.at(-1)?.text).toContain("summary spec");
  });

  it("runs an agent task through a bb project's own environment when pointed at one", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "project", projectId: "proj_api" },
    });
    await call("node_start", { nodeId: task.id });
    const spawn = fakes.spawns.at(-1);
    expect(spawn?.projectId).toBe("proj_api");
    expect(spawn?.environment).toEqual({ type: "project-default" });
  });

  /*
   * A tree belongs to no project: its files live in the Trees folder, and
   * which repository gets changed is each agent task's own business.
   */
  it("keeps a tree's files in the Trees folder and names no project", async () => {
    const { call } = await loadPlugin(fakes);
    const created = (await call("projects_create", {
      name: "Auth",
    })) as unknown as { project: TreeProject };

    expect(created.project.directory).toBe(`${ROOT}/auth`);
    expect(created.project).not.toHaveProperty("bbProjectId");
    expect(fakes.directories.has(`${ROOT}/auth`)).toBe(true);
    expect(
      [...fakes.directories].some((path) =>
        path.startsWith("/Users/me/Development/api"),
      ),
    ).toBe(false);
  });

  it("creates an agent task without a thread until it is started", async () => {
    const { call } = await loadPlugin(fakes);
    const created = (await call("projects_create", {
      name: "Auth",
    })) as unknown as { project: TreeProject };
    const task = await createNode(call, {
      projectId: created.project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write the middleware.",
    });

    expect(task.threadId).toBeNull();
    expect(task.state).toBe("ready");
    expect(fakes.spawns).toHaveLength(0);
  });

  it("opens a thread in the task's own project, off the branch it names", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      workspace: { kind: "project", projectId: "proj_api" },
    });
    expect(task.threadId).toBeNull();

    const opened = (await call("node_open_thread", {
      nodeId: task.id,
      baseBranch: "main",
      prompt: "Start with the router.",
    })) as unknown as { node: TreeNode };

    expect(opened.node.threadId).not.toBeNull();
    // The branch it opened on is remembered, not just used and forgotten.
    expect(opened.node.baseBranch).toBe("main");
    const spawn = fakes.spawns.at(-1);
    expect(spawn?.projectId).toBe("proj_api");
    expect(spawn?.prompt).toContain("Start with the router.");
    expect(spawn?.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "main" },
      },
    });
  });

  /*
   * One tree, two tasks, two repositories: the whole point of taking the
   * project off the tree and putting it on the task.
   */
  it("runs two tasks in one tree against different projects and branches", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const api = await createNode(call, {
      projectId: project.id,
      title: "Add the endpoint",
      kind: "agent",
      instruction: "Add it.",
      workspace: { kind: "project", projectId: "proj_api" },
      baseBranch: "feature/push",
    });
    const personal = await createNode(call, {
      projectId: project.id,
      title: "Note it in the changelog",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "project", projectId: "proj_personal" },
      baseBranch: "main",
    });

    await call("node_start", { nodeId: api.id });
    const first = fakes.spawns.at(-1);
    await call("node_start", { nodeId: personal.id });
    const second = fakes.spawns.at(-1);

    expect(first?.projectId).toBe("proj_api");
    expect(first?.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "feature/push" },
      },
    });
    expect(second?.projectId).toBe("proj_personal");
    expect(second?.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "main" },
      },
    });
  });

  it("offers the branches of the project a task names", async () => {
    const { call } = await loadPlugin(fakes);
    const options = (await call("base_branches", {
      bbProjectId: "proj_api",
    })) as unknown as { branches: string[]; defaultBranch: string | null };

    expect(options.branches).toEqual(["main", "feature/push", "origin/main"]);
    expect(options.defaultBranch).toBe("main");
  });

  it("names an unknown project rather than listing nothing", async () => {
    const { call } = await loadPlugin(fakes);
    await expect(
      call("base_branches", { bbProjectId: "proj_missing" }),
    ).rejects.toThrow(/No bb project has the id proj_missing/u);
  });

  it("refuses a branch for a task with no project to branch from", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Go.",
    });

    await expect(
      call("node_update", { nodeId: task.id, baseBranch: "main" }),
    ).rejects.toThrow(/Choose the project this task works in/u);
  });

  it("marks a task done before its summary is generated", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Requirements",
      kind: "markdown",
    });
    fakes.files.set(note.artifactPath, "# Requirements\n\nReal content.\n");

    const completion = (await call("node_complete", {
      nodeId: note.id,
    })) as unknown as { node: TreeNode };

    // Done immediately, with nothing spawned yet to summarize it.
    expect(completion.node.state).toBe("completed");
    expect(completion.node.summaryStatus).toBe("pending");
    expect(completion.node.summary).toBe("");
    expect(fakes.spawns).toHaveLength(0);

    await call("node_compact", { nodeId: note.id });
    const drained = (await call("graph_get", {
      projectId: project.id,
    })) as unknown as TreeGraph;
    expect(
      drained.nodes.find((candidate) => candidate.id === note.id)
        ?.summaryStatus,
    ).toBe("pending");
  });

  it("records a failed summary without un-completing the task", async () => {
    const { call, host } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Requirements",
      kind: "markdown",
    });
    fakes.files.set(note.artifactPath, "# Requirements\n\nReal content.\n");
    host.harness.sdk.stub("threads.spawn", async () => {
      throw new Error("provider unavailable");
    });

    const completion = (await call("node_complete", {
      nodeId: note.id,
      awaitSummary: true,
    })) as unknown as { node: TreeNode; summaryProblem: string | null };

    expect(completion.node.state).toBe("completed");
    expect(completion.node.summaryStatus).toBe("failed");
    expect(completion.summaryProblem).toContain("provider unavailable");
  });

  it("refuses to reveal a folder for a tree that does not exist", async () => {
    const { call } = await loadPlugin(fakes);

    await expect(
      call("project_reveal", { projectId: "trp_missing" }),
    ).rejects.toThrow(/trp_missing/u);
  });

  it("does not age a task when the canvas is rearranged", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Requirements",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Design",
      kind: "markdown",
      dependsOn: [parent.id],
    });
    const before = await graphOf(call, project.id);
    const agedAt = new Map(
      before.nodes.map((node) => [node.id, node.updatedAt]),
    );

    await call("node_move", { nodeId: child.id, x: 999, y: 999 });
    const dragged = await graphOf(call, project.id);
    const draggedChild = dragged.nodes.find((node) => node.id === child.id);
    expect(draggedChild?.x).toBe(999);
    expect(draggedChild?.updatedAt).toBe(agedAt.get(child.id));

    await call("layout_apply", { projectId: project.id });
    const tidied = await graphOf(call, project.id);
    const tidiedChild = tidied.nodes.find((node) => node.id === child.id);
    expect(tidiedChild?.x).not.toBe(999);
    for (const node of tidied.nodes) {
      expect(node.updatedAt).toBe(agedAt.get(node.id));
    }
  });

  it("still ages a task when the task itself changes", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Requirements",
      kind: "markdown",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await call("node_update", { nodeId: task.id, title: "Requirements v2" });

    const after = await graphOf(call, project.id);
    const updated = after.nodes.find((node) => node.id === task.id);
    expect(updated?.title).toBe("Requirements v2");
    expect(updated?.updatedAt).toBeGreaterThan(task.updatedAt);
  });

  it("shares one workspace between the tasks pointed at it", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const first = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "environment", environmentId: "env_shared" },
    });
    const second = await createNode(call, {
      projectId: project.id,
      title: "Add tests",
      kind: "agent",
      instruction: "Test it.",
      workspace: { kind: "environment", environmentId: "env_shared" },
    });

    await call("node_start", { nodeId: first.id });
    const firstSpawn = fakes.spawns.at(-1);
    await call("node_start", { nodeId: second.id });
    const secondSpawn = fakes.spawns.at(-1);

    expect(firstSpawn?.projectId).toBe("proj_api");
    expect(firstSpawn?.environment).toEqual({
      type: "reuse",
      environmentId: "env_shared",
    });
    expect(secondSpawn?.environment).toEqual(firstSpawn?.environment);
  });

  it("gives each task its own workspace when they name different ones", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const first = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "environment", environmentId: "env_shared" },
    });
    const second = await createNode(call, {
      projectId: project.id,
      title: "Add tests",
      kind: "agent",
      instruction: "Test it.",
      workspace: { kind: "environment", environmentId: "env_other" },
    });

    await call("node_start", { nodeId: first.id });
    const firstSpawn = fakes.spawns.at(-1);
    await call("node_start", { nodeId: second.id });
    const secondSpawn = fakes.spawns.at(-1);

    expect(firstSpawn?.environment).not.toEqual(secondSpawn?.environment);
    expect(secondSpawn?.environment).toEqual({
      type: "reuse",
      environmentId: "env_other",
    });
  });

  it("runs a named directory through the bb project that owns it", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "path", path: "/Users/me/Development/api/src" },
    });
    await call("node_start", { nodeId: task.id });
    const spawn = fakes.spawns.at(-1);
    expect(spawn?.projectId).toBe("proj_api");
    expect(spawn?.environment).toEqual({ type: "project-default" });
  });

  it("explains how to fix a directory no bb project owns", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Implement middleware",
      kind: "agent",
      instruction: "Write it.",
      workspace: { kind: "path", path: "/Users/me/elsewhere" },
    });
    await expect(call("node_start", { nodeId: task.id })).rejects.toThrow(
      /Add that directory as a bb project/u,
    );
  });

  it("refuses a workspace on a note, which has nowhere to run", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    await expect(
      createNode(call, {
        projectId: project.id,
        title: "A note",
        kind: "markdown",
        workspace: { kind: "path", path: "/tmp/x" },
      }),
    ).rejects.toThrow(/nowhere to run/u);
  });

  it("completes even when compaction fails, and reports the problem", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Generate specs",
      kind: "agent",
      instruction: "Go.",
    });
    await call("node_start", { nodeId: task.id });
    fakes.summaryFailure = "provider is out of quota";

    const completion = (await call("node_complete", {
      awaitSummary: true,
      nodeId: task.id,
    })) as unknown as { node: TreeNode; summaryProblem: string | null };
    expect(completion.node.state).toBe("completed");
    expect(completion.node.summary).toBe("");
    expect(completion.summaryProblem).toContain("out of quota");
    expect(fakes.files.get(task.artifactPath)).toBe(`${NODE_OUTPUT}\n`);
  });

  /*
   * A note whose exact wording matters can hand over its document instead of a
   * summary, without every task downstream having to ask for full output.
   */
  it("hands a note's whole document down when the note says so", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      dependsOn: [note.id],
    });
    expect(child.contextMode).toBe("auto_compact");

    fakes.files.set(note.artifactPath, "Exact wording that must survive.");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string };
    expect(preview.prompt).toContain("Exact wording that must survive.");
    expect(preview.prompt).toContain("full output");
  });

  /*
   * The whole point of choosing to send the document is that the summary is
   * not wanted. Compacting anyway costs a model call and a wait to produce
   * text no context path will ever show.
   */
  it("does not summarize a task that hands over its whole document", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    fakes.files.set(note.artifactPath, "Exact wording.");

    const before = fakes.spawns.length;
    const completion = (await call("node_complete", {
      nodeId: note.id,
      awaitSummary: true,
    })) as unknown as { node: TreeNode; summaryProblem: string | null };

    expect(completion.node.state).toBe("completed");
    expect(completion.node.summaryStatus).toBe("idle");
    expect(completion.node.summary).toBe("");
    expect(completion.summaryProblem).toBeNull();
    // No hidden worker was asked for a summary nobody reads.
    expect(fakes.spawns.length).toBe(before);
  });

  it("still summarizes a task that keeps to its summary", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
    });
    fakes.files.set(note.artifactPath, "Exact wording.");

    const before = fakes.spawns.length;
    await call("node_complete", { nodeId: note.id, awaitSummary: true });
    expect(fakes.spawns.length).toBeGreaterThan(before);
  });

  /*
   * Text the user wrote is the whole point of the custom handoff, so
   * completion must not replace it with a model's compaction.
   */
  it("sends the text the user wrote and leaves it alone on completion", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "custom",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      dependsOn: [note.id],
    });
    fakes.files.set(
      note.artifactPath,
      "Long document nobody downstream wants.",
    );
    await call("node_summary_set", {
      nodeId: note.id,
      summary: "Use bearer tokens. Reject cookies.",
    });

    const before = fakes.spawns.length;
    const completion = (await call("node_complete", {
      nodeId: note.id,
      awaitSummary: true,
    })) as unknown as { node: TreeNode };

    expect(completion.node.summary).toBe("Use bearer tokens. Reject cookies.");
    expect(completion.node.summaryStatus).toBe("idle");
    expect(fakes.spawns.length).toBe(before);

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string };
    expect(preview.prompt).toContain("Use bearer tokens. Reject cookies.");
    expect(preview.prompt).not.toContain("Long document nobody downstream");
  });

  /*
   * Compacting is an explicit request, so on a custom handoff it drafts the
   * text rather than being refused — what it must not do is happen by itself.
   */
  it("drafts the text on request for a custom handoff", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "custom",
    });
    fakes.files.set(note.artifactPath, "Exact wording.");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    await call("node_compact", { nodeId: note.id });
    const graph = await graphOf(call, project.id);
    expect(
      graph.nodes.find((candidate) => candidate.id === note.id)?.summaryStatus,
    ).toBe("pending");
  });

  /*
   * Handing down is a push from the parent, so it has to deal with children
   * in every shape at once: running, not started, and notes.
   */
  it("hands the context down to every kind of child", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "custom",
    });
    const running = await createNode(call, {
      projectId: project.id,
      title: "Implement it",
      kind: "agent",
      instruction: "Write it.",
      dependsOn: [parent.id],
    });
    const unstarted = await createNode(call, {
      projectId: project.id,
      title: "Test it",
      kind: "agent",
      instruction: "Test it.",
      dependsOn: [parent.id],
    });
    const noteChild = await createNode(call, {
      projectId: project.id,
      title: "Write the changelog",
      kind: "markdown",
      dependsOn: [parent.id],
    });
    const grandchild = await createNode(call, {
      projectId: project.id,
      title: "Ship it",
      kind: "agent",
      instruction: "Ship it.",
      dependsOn: [running.id],
    });

    fakes.files.set(parent.artifactPath, "The research.");
    await call("node_summary_set", {
      nodeId: parent.id,
      summary: "Use bearer tokens.",
    });
    await call("node_complete", { nodeId: parent.id, awaitSummary: true });
    await call("node_start", { nodeId: running.id });
    const sentBefore = fakes.sent.length;

    const { deliveries } = (await call("node_hand_down", {
      nodeId: parent.id,
    })) as unknown as {
      deliveries: { nodeId: string; outcome: string }[];
    };

    expect(
      deliveries.map((delivery) => [delivery.nodeId, delivery.outcome]),
    ).toEqual(
      expect.arrayContaining([
        [running.id, "sent"],
        [unstarted.id, "on_start"],
        [noteChild.id, "note"],
      ]),
    );
    // The grandchild is not immediate, so it is left alone.
    expect(
      deliveries.some((delivery) => delivery.nodeId === grandchild.id),
    ).toBe(false);
    expect(deliveries).toHaveLength(3);

    const messages = fakes.sent.slice(sentBefore);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("additional context");
    expect(messages[0]?.text).toContain("Use bearer tokens.");
  });

  it("reports the children it could not reach without giving up on the rest", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
    });
    const broken = await createNode(call, {
      projectId: project.id,
      title: "Implement it",
      kind: "agent",
      instruction: "Write it.",
      dependsOn: [parent.id],
    });
    const waiting = await createNode(call, {
      projectId: project.id,
      title: "Test it",
      kind: "agent",
      instruction: "Test it.",
      dependsOn: [parent.id],
    });
    fakes.files.set(parent.artifactPath, "The research.");
    await call("node_complete", { nodeId: parent.id, awaitSummary: true });
    await call("node_start", { nodeId: broken.id });
    fakes.summaryFailure = "the thread is gone";

    const { deliveries } = (await call("node_hand_down", {
      nodeId: parent.id,
    })) as unknown as {
      deliveries: { nodeId: string; outcome: string; problem: string | null }[];
    };

    const failure = deliveries.find(
      (delivery) => delivery.nodeId === broken.id,
    );
    expect(failure?.outcome).toBe("failed");
    expect(failure?.problem).toContain("the thread is gone");
    expect(
      deliveries.find((delivery) => delivery.nodeId === waiting.id)?.outcome,
    ).toBe("on_start");
  });

  /*
   * A note's images are the reason a whole-document handoff exists for some
   * work: a spec with a screenshot in it is not the same document without it.
   */
  it("stores an image beside the note and references it from the document", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
    });

    const attached = (await call("image_attach", {
      nodeId: note.id,
      fileName: "Login screen.png",
      contentBase64: Buffer.from("fake png bytes").toString("base64"),
    })) as unknown as { markdown: string; assetFile: string; url: string };

    expect(attached.assetFile).toMatch(/^[0-9a-f]{16}\.png$/u);
    expect(attached.markdown).toBe(
      `![Login screen.png](assets/${attached.assetFile})`,
    );
    const stored = `${ROOT}/auth/assets/${attached.assetFile}`;
    expect(fakes.files.get(stored)).toBe(
      Buffer.from("fake png bytes").toString("base64"),
    );
    expect(attached.url).toContain(attached.assetFile);
  });

  it("refuses what it cannot store or show", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
    });
    const task = await createNode(call, {
      projectId: project.id,
      title: "Specs",
      kind: "agent",
      instruction: "Go.",
    });
    const png = Buffer.from("bytes").toString("base64");

    await expect(
      call("image_attach", {
        nodeId: note.id,
        fileName: "diagram.svg",
        contentBase64: png,
      }),
    ).rejects.toThrow(/not an image Trees can store/u);
    await expect(
      call("image_attach", {
        nodeId: note.id,
        fileName: "huge.png",
        contentBase64: "A".repeat(15 * 1_048_576),
      }),
    ).rejects.toThrow(/limited to 10MB/u);
    await expect(
      call("image_attach", {
        nodeId: task.id,
        fileName: "shot.png",
        contentBase64: png,
      }),
    ).rejects.toThrow(/Only a note carries images/u);
  });

  it("sends a note's images down with the document that refers to them", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      instruction: "Build what the note shows.",
      dependsOn: [note.id],
    });
    fakes.files.set(
      note.artifactPath,
      "# Research\n\nThe flow:\n\n![the login screen](assets/abc123.png)\n",
    );
    fakes.files.set(`${ROOT}/auth/assets/abc123.png`, "png bytes");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string; imagePaths: string[] };
    expect(preview.imagePaths).toEqual([`${ROOT}/auth/assets/abc123.png`]);
    // Marked in place rather than left as a reference nothing can resolve.
    expect(preview.prompt).toContain("_[Image 1: the login screen]_");
    expect(preview.prompt).not.toContain("assets/abc123.png");

    await call("node_start", { nodeId: child.id });
    /*
     * Uploaded as an attachment of the thread's project: a path into the
     * Trees folder is handed to the agent's runtime to read, which it may
     * not be able to do, and then the picture never arrives.
     */
    expect(fakes.uploads).toEqual([
      { projectId: "proj_personal", filename: "abc123.png", bytes: 9 },
    ]);
    const spawn = fakes.spawns.at(-1);
    expect(spawn?.input).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "localImage", path: "attachments/proj_personal/abc123.png" },
    ]);
  });

  /*
   * The same has to hold for the push: a child already working is the case
   * where a parent's screenshots matter most, because it read the document
   * before they were there.
   */
  it("attaches the images to the context it pushes to a running child", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      instruction: "Build what the note shows.",
      dependsOn: [note.id],
    });
    fakes.files.set(
      note.artifactPath,
      "# Research\n\n![the login screen](assets/abc123.png)\n",
    );
    fakes.files.set(`${ROOT}/auth/assets/abc123.png`, "png bytes");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });
    await call("node_start", { nodeId: child.id });
    fakes.uploads.length = 0;
    const sentBefore = fakes.sent.length;

    const { deliveries } = (await call("node_hand_down", {
      nodeId: note.id,
    })) as unknown as { deliveries: { outcome: string }[] };

    expect(deliveries.map((delivery) => delivery.outcome)).toEqual(["sent"]);
    expect(fakes.uploads).toHaveLength(1);
    const message = fakes.sent.slice(sentBefore).at(-1);
    expect(message?.input).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "localImage", path: "attachments/proj_personal/abc123.png" },
    ]);
    expect(message?.text).toContain("_[Image 1: the login screen]_");
  });

  it("leaves the images behind when only the summary goes down", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      instruction: "Build it.",
      dependsOn: [note.id],
    });
    fakes.files.set(
      note.artifactPath,
      "# Research\n\n![the login screen](assets/abc123.png)\n",
    );
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { imagePaths: string[] };
    expect(preview.imagePaths).toEqual([]);
  });

  it("refuses to compact a task whose summary would go unread", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    fakes.files.set(note.artifactPath, "Exact wording.");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    await expect(call("node_compact", { nodeId: note.id })).rejects.toThrow(
      /hands its whole document downstream/u,
    );
  });

  it("goes back to the summary when the note is switched back", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      handoff: "full",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "agent",
      dependsOn: [note.id],
    });
    fakes.files.set(note.artifactPath, "Exact wording that must survive.");
    await call("node_complete", { nodeId: note.id, awaitSummary: true });

    await call("node_update", { nodeId: note.id, handoff: "summary" });
    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string };
    expect(preview.prompt).not.toContain("Exact wording that must survive.");
    expect(preview.prompt).toContain("(summary)");
  });

  it("stales a completed child when a parent's file changes outside bb", async () => {
    const { host, call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const parent = await createNode(call, {
      projectId: project.id,
      title: "Research",
      kind: "markdown",
      contextMode: "full_parents",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Spec",
      kind: "markdown",
      contextMode: "full_parents",
      dependsOn: [parent.id],
    });
    fakes.files.set(parent.artifactPath, "First findings.");
    await call("node_complete", { nodeId: parent.id, awaitSummary: true });
    fakes.files.set(child.artifactPath, "First spec.");
    await call("node_complete", { nodeId: child.id, awaitSummary: true });
    expect(stateOf(await graphOf(call, project.id), child.id)).toBe(
      "completed",
    );

    fakes.files.set(parent.artifactPath, "Revised findings.");
    const service = host.harness.behavior.runService("trees-reconcile");
    service.controller.abort();
    await service.done;

    expect(stateOf(await graphOf(call, project.id), child.id)).toBe("stale");
  });

  it("warns down the whole chain, and clears it from the top down", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const root = await createNode(call, {
      projectId: project.id,
      title: "Root",
      kind: "markdown",
    });
    const middle = await createNode(call, {
      projectId: project.id,
      title: "Middle",
      kind: "markdown",
      dependsOn: [root.id],
    });
    const leaf = await createNode(call, {
      projectId: project.id,
      title: "Leaf",
      kind: "markdown",
      dependsOn: [middle.id],
    });
    fakes.files.set(root.artifactPath, "a");
    await call("node_complete", { nodeId: root.id, awaitSummary: true });
    fakes.files.set(middle.artifactPath, "b");
    await call("node_complete", { nodeId: middle.id });
    fakes.files.set(leaf.artifactPath, "c");
    await call("node_complete", { nodeId: leaf.id });

    await call("node_summary_set", { nodeId: root.id, summary: "rewritten" });
    let graph = await graphOf(call, project.id);
    expect(stateOf(graph, middle.id)).toBe("stale");
    expect(stateOf(graph, leaf.id)).toBe("stale");

    await expect(call("node_acknowledge", { nodeId: leaf.id })).rejects.toThrow(
      /still stale/u,
    );

    await call("node_acknowledge", { nodeId: middle.id });
    graph = await graphOf(call, project.id);
    expect(stateOf(graph, middle.id)).toBe("completed");
    expect(stateOf(graph, leaf.id)).toBe("completed");
  });

  it("keeps a grandchild stale when the middle task is redone instead", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const root = await createNode(call, {
      projectId: project.id,
      title: "Root",
      kind: "markdown",
    });
    const middle = await createNode(call, {
      projectId: project.id,
      title: "Middle",
      kind: "markdown",
      dependsOn: [root.id],
    });
    const leaf = await createNode(call, {
      projectId: project.id,
      title: "Leaf",
      kind: "markdown",
      dependsOn: [middle.id],
    });
    fakes.files.set(root.artifactPath, "a");
    await call("node_complete", { nodeId: root.id, awaitSummary: true });
    fakes.files.set(middle.artifactPath, "b");
    await call("node_complete", { nodeId: middle.id });
    fakes.files.set(leaf.artifactPath, "c");
    await call("node_complete", { nodeId: leaf.id });

    await call("node_summary_set", { nodeId: root.id, summary: "rewritten" });
    await call("node_summary_set", {
      nodeId: middle.id,
      summary: "middle redone",
    });
    await call("node_acknowledge", { nodeId: middle.id });

    const graph = await graphOf(call, project.id);
    expect(stateOf(graph, middle.id)).toBe("completed");
    expect(stateOf(graph, leaf.id)).toBe("stale");
  });

  it("reopening a completed task lets it run again without losing the thread", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Specs",
      kind: "agent",
      instruction: "Go.",
    });
    await call("node_start", { nodeId: task.id });
    await call("node_complete", { nodeId: task.id });

    const reopened = (await call("node_reopen", {
      nodeId: task.id,
      discardThread: false,
    })) as unknown as { node: TreeNode };
    expect(reopened.node.state).toBe("ready");
    expect(reopened.node.threadId).not.toBeNull();

    const detached = (await call("node_reopen", {
      nodeId: task.id,
      discardThread: true,
    })) as unknown as { node: TreeNode };
    expect(detached.node.threadId).toBeNull();
  });

  it("only sends the selected upstream summaries in custom mode", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const wanted = await createNode(call, {
      projectId: project.id,
      title: "Wanted",
      kind: "markdown",
    });
    const unwanted = await createNode(call, {
      projectId: project.id,
      title: "Unwanted",
      kind: "markdown",
    });
    const child = await createNode(call, {
      projectId: project.id,
      title: "Child",
      kind: "agent",
      instruction: "Go.",
      contextMode: "custom",
      customBrief: "Only the auth providers matter.",
      dependsOn: [wanted.id, unwanted.id],
    });
    await call("node_summary_set", {
      nodeId: wanted.id,
      summary: "Wanted summary.",
    });
    await call("node_summary_set", {
      nodeId: unwanted.id,
      summary: "Unwanted summary.",
    });
    await call("node_update", {
      nodeId: child.id,
      contextIncludes: [wanted.id],
    });

    const preview = (await call("context_preview", {
      nodeId: child.id,
    })) as unknown as { prompt: string; sourceTitles: string[] };
    expect(preview.sourceTitles).toEqual(["Wanted"]);
    expect(preview.prompt).toContain("Only the auth providers matter.");
    expect(preview.prompt).toContain("Wanted summary.");
    expect(preview.prompt).not.toContain("Unwanted summary.");
  });

  it("reports a conflict instead of clobbering a file edited underneath it", async () => {
    const { call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const note = await createNode(call, {
      projectId: project.id,
      title: "Notes",
      kind: "markdown",
    });
    const loaded = (await call("artifact_read", {
      nodeId: note.id,
    })) as unknown as { sha256: string | null };
    fakes.files.set(note.artifactPath, "Someone else wrote this.");

    await expect(
      call("artifact_write", {
        nodeId: note.id,
        content: "My version.",
        expectedSha256: loaded.sha256,
      }),
    ).rejects.toThrow(/changed on disk/u);
    expect(fakes.files.get(note.artifactPath)).toBe("Someone else wrote this.");
  });

  it("detaches a task from a thread bb deleted", async () => {
    const { host, call } = await loadPlugin(fakes);
    const project = await createProject(call, "Auth");
    const task = await createNode(call, {
      projectId: project.id,
      title: "Specs",
      kind: "agent",
      instruction: "Go.",
    });
    const started = (await call("node_start", {
      nodeId: task.id,
    })) as unknown as { node: TreeNode };
    const threadId = started.node.threadId;
    expect(threadId).not.toBeNull();

    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { id: threadId ?? "" } as never,
    } as never);

    const graph = await graphOf(call, project.id);
    const refreshed = graph.nodes.find((node) => node.id === task.id);
    expect(refreshed?.threadId).toBeNull();
    expect(refreshed?.state).toBe("ready");
  });
});
