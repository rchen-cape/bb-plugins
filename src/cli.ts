import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CONTEXT_MODES,
  HANDOFF_MODES,
  NODE_KINDS,
  NODE_STATE_LABELS,
  contextModeSchema,
  handoffSchema,
  nodeKindSchema,
  type Handoff,
  type TreeNode,
  type TreeProject,
  type WorkspaceTarget,
} from "./model.js";
import { referencedImages } from "./images.js";
import { assetPath } from "./paths.js";
import type {
  HandDownDelivery,
  HandDownOutcome,
  TreeService,
} from "./service.js";

export class CliUsageError extends Error {}

interface ParsedArgv {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

const threadSchema = z
  .object({ environmentId: z.string().min(1).nullable().optional() })
  .loose();
const environmentSchema = z.object({ hostId: z.string().min(1) }).loose();
const hostListSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().optional() }).loose(),
);

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      options.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(body);
      continue;
    }
    options.set(body, next);
    index += 1;
  }
  return { positionals, options, flags };
}

function requireOption(args: ParsedArgv, name: string): string {
  const value = args.options.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`--${name} is required.`);
  }
  return value;
}

function requirePositional(
  args: ParsedArgv,
  index: number,
  label: string,
): string {
  const value = args.positionals[index];
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`${label} is required.`);
  }
  return value;
}

function requireCoordinate(args: ParsedArgv, name: string): number {
  const raw = requireOption(args, name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new CliUsageError(`--${name} must be a whole number of pixels.`);
  }
  return value;
}

function optionalPosition(args: ParsedArgv): { x: number; y: number } | null {
  const hasX = args.options.get("x") !== undefined;
  const hasY = args.options.get("y") !== undefined;
  if (!hasX && !hasY) return null;
  if (!hasX || !hasY) {
    throw new CliUsageError("--x and --y go together.");
  }
  return {
    x: requireCoordinate(args, "x"),
    y: requireCoordinate(args, "y"),
  };
}

function parseHandoff(args: ParsedArgv): Handoff | undefined {
  const raw = args.options.get("handoff");
  if (raw === undefined) return undefined;
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(
      `--handoff must be one of ${HANDOFF_MODES.join(", ")}.`,
    );
  }
  return parsed.data;
}

const USAGE = [
  "bb tree ready [--project <project>]",
  "bb tree project list|create|show|rename|delete",
  "bb tree node list|show|create|update|move|delete [--handoff summary|custom|full]",
  "bb tree dep add|remove --parent <node> --child <node>",
  "bb tree context <node>",
  "bb tree artifact read|write <node>",
  "bb tree image add|list <node> [--file <path>]",
  "bb tree start|resend|handdown|complete|compact|reopen|working|ack <node>",
  "bb tree summary <node> --text <summary>",
  "bb tree layout <project>",
].join("\n");

export const TREE_CLI_COMMANDS = [
  {
    name: "ready",
    summary: "List every task whose dependencies are satisfied.",
    usage: "bb tree ready [--json]",
  },
  {
    name: "project",
    summary: "Manage tree projects and the folder each one writes to.",
    usage:
      "bb tree project list|create|show|rename|delete|attach|reveal " +
      "[<project>] " +
      "[--name <name>] [--bb-project <proj-id>] [--json]",
  },
  {
    name: "node",
    summary: "Create, inspect, and edit the tasks in a tree.",
    usage:
      "bb tree node list|show|create|update|move|delete [<node>] [--project <project>] [--title <title>] [--kind markdown|agent] [--instruction <text>] [--context-mode auto_compact|full_parents|custom] [--brief <text>] [--depends-on <node>] [--include <node>] [--workspace scratch|<bb project id>|<absolute path>] [--x <px> --y <px>] [--json]",
  },
  {
    name: "dep",
    summary: "Add or remove a dependency between two tasks in one tree.",
    usage: "bb tree dep add|remove --parent <node> --child <node> [--json]",
  },
  {
    name: "context",
    summary: "Print the exact context an agent task will receive.",
    usage: "bb tree context <node> [--json]",
  },
  {
    name: "artifact",
    summary: "Read or replace a task's Markdown output file.",
    usage:
      "bb tree artifact read|write <node> [--content <text>] [--content-file <path>] [--machine <id-or-name>] [--json]",
  },
  {
    name: "image",
    summary: "Attach an image to a note, or list the ones it carries.",
    usage:
      "bb tree image add|list <node> [--file <path>] [--machine <id-or-name>] [--json]",
  },
  {
    name: "start",
    summary: "Start an agent task's thread with its assembled context.",
    usage: "bb tree start <node> [--json]",
  },
  {
    name: "resend",
    summary: "Send the current context to an agent task's existing thread.",
    usage: "bb tree resend <node> [--json]",
  },
  {
    name: "handdown",
    summary: "Send a task's context to the tasks that depend on it.",
    usage: "bb tree handdown <node> [--json]",
  },
  {
    name: "complete",
    summary: "Save a task's output, compact it, and unblock its children.",
    usage: "bb tree complete <node> [--json]",
  },
  {
    name: "compact",
    summary: "Regenerate a task's summary without changing its state.",
    usage: "bb tree compact <node> [--json]",
  },
  {
    name: "summary",
    summary: "Replace a task's summary with text you write.",
    usage: "bb tree summary <node> --text <summary> [--json]",
  },
  {
    name: "reopen",
    summary: "Move a completed task back to ready.",
    usage: "bb tree reopen <node> [--discard-thread] [--json]",
  },
  {
    name: "working",
    summary: "Mark a task in progress without spawning a thread.",
    usage: "bb tree working <node> [--json]",
  },
  {
    name: "open",
    summary:
      "Give an agent task its own worktree off a branch and open its thread.",
    usage:
      "bb tree open <node> --base-branch <branch> [--message <text>] [--json]",
  },
  {
    name: "ack",
    summary: "Keep a stale task's output and clear its warning.",
    usage: "bb tree ack <node> [--json]",
  },
  {
    name: "layout",
    summary: "Re-lay out a tree's canvas positions.",
    usage: "bb tree layout <project> [--json]",
  },
] as const;

export interface TreeCliDeps {
  bb: Pick<BbPluginApi, "sdk" | "cli">;
  service: TreeService;
}

function describeWorkspace(workspace: WorkspaceTarget): string {
  if (workspace.kind === "project") return `bb project ${workspace.projectId}`;
  if (workspace.kind === "path") {
    return `${workspace.path} (the bb project that owns it)`;
  }
  if (workspace.kind === "environment") {
    return `shared environment ${workspace.environmentId}`;
  }
  return "a scratch workspace";
}

function nodeLine(node: TreeNode): string {
  const parts = [
    `${node.id}  ${NODE_STATE_LABELS[node.state].padEnd(11)} ${node.kind.padEnd(8)} ${node.title}`,
    `    file: ${node.artifactFile}`,
  ];
  if (node.dependsOn.length > 0) {
    parts.push(`    depends on: ${node.dependsOn.join(", ")}`);
  }
  if (node.kind === "agent") {
    parts.push(`    workspace: ${describeWorkspace(node.workspace)}`);
    if (node.threadId !== null) parts.push(`    thread: ${node.threadId}`);
  }
  if (node.summary.length > 0) parts.push(`    summary: ${node.summary}`);
  return parts.join("\n");
}

const HAND_DOWN_TEXT: Record<HandDownOutcome, string> = {
  sent: "received it in its thread",
  on_start: "has no thread yet, so it will receive this when it starts",
  note: "is a note, so it reads its parents itself",
  failed: "could not be reached",
};

function handDownLine(delivery: HandDownDelivery): string {
  const problem = delivery.problem === null ? "" : `\n    ${delivery.problem}`;
  return `${delivery.nodeId}  ${delivery.title} ${HAND_DOWN_TEXT[delivery.outcome]}.${problem}`;
}

function projectLine(project: TreeProject): string {
  return [
    `${project.id}  ${project.name}`,
    `    folder: ${project.directory}`,
    `    tasks: ${project.nodeCount}  ready: ${project.readyCount}  stale: ${project.staleCount}`,
  ].join("\n");
}

export function createTreeCli(deps: TreeCliDeps) {
  const { bb, service } = deps;

  function resolveProject(ref: string): TreeProject {
    const projects = service.listProjects();
    const match =
      projects.find((project) => project.id === ref) ??
      projects.find(
        (project) => project.name.toLowerCase() === ref.toLowerCase(),
      );
    if (match === undefined) {
      throw new CliUsageError(`No tree project matches "${ref}".`);
    }
    return match;
  }

  function resolveNode(ref: string, projectRef: string | undefined): TreeNode {
    const projects =
      projectRef === undefined
        ? service.listProjects()
        : [resolveProject(projectRef)];
    const candidates = projects.flatMap(
      (project) => service.getGraph(project.id).nodes,
    );
    const match =
      candidates.find((node) => node.id === ref) ??
      candidates.find((node) => node.artifactFile === ref) ??
      candidates.find((node) => node.title.toLowerCase() === ref.toLowerCase());
    if (match === undefined) {
      throw new CliUsageError(`No task matches "${ref}".`);
    }
    return match;
  }

  async function resolveInvokingHostId(
    context: PluginCliContext,
    machine: string | undefined,
  ): Promise<string | undefined> {
    if (machine !== undefined) {
      const hosts = hostListSchema.parse(await bb.sdk.hosts.list());
      const host = hosts.find(
        (candidate) =>
          candidate.id === machine ||
          candidate.name?.toLowerCase() === machine.toLowerCase(),
      );
      if (host === undefined) {
        throw new CliUsageError(`No machine matches "${machine}".`);
      }
      return host.id;
    }
    if (context.threadId === undefined) return undefined;
    const thread = threadSchema.parse(
      await bb.sdk.threads.get({ threadId: context.threadId }),
    );
    if (thread.environmentId === undefined || thread.environmentId === null) {
      return undefined;
    }
    const environment = environmentSchema.parse(
      await bb.sdk.environments.get({ environmentId: thread.environmentId }),
    );
    return environment.hostId;
  }

  async function readContentArgument(
    args: ParsedArgv,
    context: PluginCliContext,
  ): Promise<string> {
    const inline = args.options.get("content");
    const file = args.options.get("content-file");
    if (inline !== undefined && file !== undefined) {
      throw new CliUsageError("Pass --content or --content-file, not both.");
    }
    if (inline !== undefined) return inline;
    if (file === undefined) {
      throw new CliUsageError("--content or --content-file is required.");
    }
    const hostId = await resolveInvokingHostId(
      context,
      args.options.get("machine"),
    );
    const read = await bb.sdk.files.read({
      path: file,
      ...(hostId === undefined ? {} : { hostId }),
    });
    if ("notModified" in read || read.contentEncoding !== "utf8") {
      throw new CliUsageError(`${file} is not readable as UTF-8 text.`);
    }
    return read.content;
  }

  function parseWorkspace(raw: string): WorkspaceTarget {
    if (raw === "scratch" || raw === "tree") return { kind: "tree" };
    if (raw.startsWith("proj_")) return { kind: "project", projectId: raw };
    if (raw.startsWith("env_")) {
      return { kind: "environment", environmentId: raw };
    }
    if (raw.startsWith("/") || raw.startsWith("~")) {
      return { kind: "path", path: raw };
    }
    throw new CliUsageError(
      `--workspace must be "scratch", a bb project id, an environment id, or an absolute path; received "${raw}".`,
    );
  }

  function repeated(args: ParsedArgv, name: string): string[] {
    const value = args.options.get(name);
    if (value === undefined) return [];
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  function result(args: {
    json: boolean;
    payload: unknown;
    text: string;
  }): PluginCliResult {
    return {
      exitCode: 0,
      stdout: args.json
        ? `${JSON.stringify(args.payload, null, 2)}\n`
        : `${args.text}\n`,
    };
  }

  async function runProject(
    args: ParsedArgv,
    json: boolean,
  ): Promise<PluginCliResult> {
    const action = args.positionals[1] ?? "list";
    if (action === "list") {
      const projects = service.listProjects();
      return result({
        json,
        payload: { projects },
        text:
          projects.length === 0
            ? "No tree projects yet. Create one with `bb tree project create --name <name>`."
            : projects.map(projectLine).join("\n"),
      });
    }
    if (action === "reveal") {
      const project = resolveProject(requirePositional(args, 2, "A project"));
      const directory = await service.revealDirectory({
        projectId: project.id,
      });
      return result({
        json,
        payload: { directory },
        text: `Opened ${directory}.`,
      });
    }
    if (action === "attach") {
      const project = resolveProject(requirePositional(args, 2, "A project"));
      const attached = await service.setBbProject({
        projectId: project.id,
        bbProjectId: requireOption(args, "bb-project"),
      });
      return result({
        json,
        payload: { project: attached },
        text: projectLine(attached),
      });
    }
    if (action === "create") {
      const bbProject = args.options.get("bb-project");
      const project = await service.createProject({
        name: requireOption(args, "name"),
        ...(bbProject === undefined ? {} : { bbProjectId: bbProject }),
      });
      return result({ json, payload: { project }, text: projectLine(project) });
    }
    const ref = requirePositional(args, 2, "A project");
    if (action === "show") {
      const project = resolveProject(ref);
      const graph = service.getGraph(project.id);
      return result({
        json,
        payload: graph,
        text: [
          projectLine(graph.project),
          "",
          ...graph.nodes.map(nodeLine),
        ].join("\n"),
      });
    }
    if (action === "rename") {
      const project = service.renameProject({
        projectId: resolveProject(ref).id,
        name: requireOption(args, "name"),
      });
      return result({ json, payload: { project }, text: projectLine(project) });
    }
    if (action === "delete") {
      const project = resolveProject(ref);
      service.deleteProject({ projectId: project.id });
      return result({
        json,
        payload: { ok: true, deleted: project.id },
        text: `Removed ${project.name} from Trees. Its Markdown files are still in ${project.directory}.`,
      });
    }
    throw new CliUsageError(`Unknown project action "${action}".`);
  }

  async function runNode(
    args: ParsedArgv,
    json: boolean,
  ): Promise<PluginCliResult> {
    const action = args.positionals[1] ?? "list";
    const projectRef = args.options.get("project");
    if (action === "list") {
      if (projectRef === undefined) {
        throw new CliUsageError("--project is required to list tasks.");
      }
      const graph = service.getGraph(resolveProject(projectRef).id);
      return result({
        json,
        payload: graph,
        text:
          graph.nodes.length === 0
            ? "This tree has no tasks yet."
            : graph.nodes.map(nodeLine).join("\n"),
      });
    }
    if (action === "create") {
      if (projectRef === undefined) {
        throw new CliUsageError("--project is required to create a task.");
      }
      const kindRaw = args.options.get("kind") ?? "markdown";
      const kind = nodeKindSchema.safeParse(kindRaw);
      if (!kind.success) {
        throw new CliUsageError(
          `--kind must be one of ${NODE_KINDS.join(", ")}.`,
        );
      }
      const contextModeRaw = args.options.get("context-mode");
      const contextMode =
        contextModeRaw === undefined
          ? undefined
          : contextModeSchema.safeParse(contextModeRaw);
      if (contextMode !== undefined && !contextMode.success) {
        throw new CliUsageError(
          `--context-mode must be one of ${CONTEXT_MODES.join(", ")}.`,
        );
      }
      const workspaceRaw = args.options.get("workspace");
      const dependsOn = repeated(args, "depends-on").map(
        (ref) => resolveNode(ref, projectRef).id,
      );
      const position = optionalPosition(args);
      const createHandoff = parseHandoff(args);
      const node = await service.createNode({
        projectId: resolveProject(projectRef).id,
        title: requireOption(args, "title"),
        kind: kind.data,
        ...(args.options.get("instruction") === undefined
          ? {}
          : { instruction: requireOption(args, "instruction") }),
        ...(contextMode === undefined ? {} : { contextMode: contextMode.data }),
        ...(createHandoff === undefined ? {} : { handoff: createHandoff }),
        ...(args.options.get("brief") === undefined
          ? {}
          : { customBrief: requireOption(args, "brief") }),
        ...(workspaceRaw === undefined
          ? {}
          : { workspace: parseWorkspace(workspaceRaw) }),
        ...(position === null ? {} : { position }),
        dependsOn,
      });
      return result({ json, payload: { node }, text: nodeLine(node) });
    }
    const ref = requirePositional(args, 2, "A task");
    const target = resolveNode(ref, projectRef);
    if (action === "show") {
      return result({
        json,
        payload: { node: target },
        text: nodeLine(target),
      });
    }
    if (action === "update") {
      const contextModeRaw = args.options.get("context-mode");
      const contextMode =
        contextModeRaw === undefined
          ? undefined
          : contextModeSchema.safeParse(contextModeRaw);
      if (contextMode !== undefined && !contextMode.success) {
        throw new CliUsageError(
          `--context-mode must be one of ${CONTEXT_MODES.join(", ")}.`,
        );
      }
      const workspaceRaw = args.options.get("workspace");
      const includes = args.options.has("include")
        ? repeated(args, "include").map(
            (includeRef) => resolveNode(includeRef, projectRef).id,
          )
        : undefined;
      const updateHandoff = parseHandoff(args);
      const node = service.updateNode({
        nodeId: target.id,
        ...(args.options.get("title") === undefined
          ? {}
          : { title: requireOption(args, "title") }),
        ...(args.options.get("instruction") === undefined
          ? {}
          : { instruction: requireOption(args, "instruction") }),
        ...(contextMode === undefined ? {} : { contextMode: contextMode.data }),
        ...(updateHandoff === undefined ? {} : { handoff: updateHandoff }),
        ...(args.options.get("brief") === undefined
          ? {}
          : { customBrief: requireOption(args, "brief") }),
        ...(workspaceRaw === undefined
          ? {}
          : { workspace: parseWorkspace(workspaceRaw) }),
        ...(includes === undefined ? {} : { contextIncludes: includes }),
      });
      return result({ json, payload: { node }, text: nodeLine(node) });
    }
    if (action === "move") {
      const x = requireCoordinate(args, "x");
      const y = requireCoordinate(args, "y");
      service.moveNode({ nodeId: target.id, x, y });
      return result({
        json,
        payload: { ok: true },
        text: `Moved ${target.title} to ${x}, ${y}.`,
      });
    }
    if (action === "delete") {
      service.deleteNode({ nodeId: target.id });
      return result({
        json,
        payload: { ok: true, deleted: target.id },
        text: `Deleted ${target.title}. Its children now depend on its parents, and ${target.artifactFile} is still on disk.`,
      });
    }
    throw new CliUsageError(`Unknown node action "${action}".`);
  }

  async function run(
    argv: readonly string[],
    context: PluginCliContext,
  ): Promise<PluginCliResult> {
    const args = parseArgv(argv);
    const json = args.flags.has("json");
    const command = args.positionals[0];
    const projectRef = args.options.get("project");

    if (command === undefined || command === "help") {
      return { exitCode: 0, stdout: `${USAGE}\n` };
    }
    if (command === "project") return await runProject(args, json);
    if (command === "node") return await runNode(args, json);
    if (command === "ready") {
      const entries = service.listReady({
        projectId:
          projectRef === undefined ? null : resolveProject(projectRef).id,
      });
      return result({
        json,
        payload: { entries },
        text:
          entries.length === 0
            ? "Nothing is ready. Complete an upstream task to unblock the next one."
            : entries
                .map(
                  (entry) => `${entry.project.name}\n${nodeLine(entry.node)}`,
                )
                .join("\n\n"),
      });
    }
    if (command === "dep") {
      const action = args.positionals[1];
      const parent = resolveNode(requireOption(args, "parent"), projectRef);
      const child = resolveNode(requireOption(args, "child"), projectRef);
      if (action === "add") {
        service.addDependency({ parentId: parent.id, childId: child.id });
        return result({
          json,
          payload: { ok: true },
          text: `${child.title} now depends on ${parent.title}.`,
        });
      }
      if (action === "remove") {
        service.removeDependency({ parentId: parent.id, childId: child.id });
        return result({
          json,
          payload: { ok: true },
          text: `${child.title} no longer depends on ${parent.title}.`,
        });
      }
      throw new CliUsageError(`Unknown dep action "${String(action)}".`);
    }
    if (command === "context") {
      const node = resolveNode(
        requirePositional(args, 1, "A task"),
        projectRef,
      );
      const preview = await service.previewContext({ nodeId: node.id });
      return result({ json, payload: preview, text: preview.prompt });
    }
    if (command === "artifact") {
      const action = args.positionals[1];
      const node = resolveNode(
        requirePositional(args, 2, "A task"),
        projectRef,
      );
      if (action === "read") {
        const artifact = await service.readArtifact({ nodeId: node.id });
        if (artifact.problem !== null) {
          return {
            exitCode: 1,
            stderr: `Could not read ${node.artifactFile}: ${artifact.problem}\n`,
          };
        }
        return result({
          json,
          payload: artifact,
          text: artifact.content,
        });
      }
      if (action === "write") {
        const content = await readContentArgument(args, context);
        const artifact = await service.readArtifact({ nodeId: node.id });
        const written = await service.writeArtifact({
          nodeId: node.id,
          content,
          expectedSha256: artifact.sha256,
        });
        return result({
          json,
          payload: written,
          text: `Wrote ${node.artifactFile}.`,
        });
      }
      throw new CliUsageError(`Unknown artifact action "${String(action)}".`);
    }
    if (command === "image") {
      const action = args.positionals[1];
      const node = resolveNode(
        requirePositional(args, 2, "A task"),
        projectRef,
      );
      if (action === "list") {
        const artifact = await service.readArtifact({ nodeId: node.id });
        const project = service.getProject(node.projectId);
        const images = referencedImages(artifact.content).map((image) => ({
          ...image,
          path: assetPath({
            directory: project.directory,
            assetFile: image.assetFile,
          }),
        }));
        return result({
          json,
          payload: { images },
          text:
            images.length === 0
              ? `${node.title} carries no images.`
              : images
                  .map((image) => `${image.path}\n    alt: ${image.alt}`)
                  .join("\n"),
        });
      }
      if (action === "add") {
        const file = requireOption(args, "file");
        const hostId = await resolveInvokingHostId(
          context,
          args.options.get("machine"),
        );
        const read = await bb.sdk.files.read({
          path: file,
          ...(hostId === undefined ? {} : { hostId }),
        });
        if ("notModified" in read) {
          throw new CliUsageError(`${file} could not be read.`);
        }
        const contentBase64 =
          read.contentEncoding === "base64"
            ? read.content
            : Buffer.from(read.content, "utf8").toString("base64");
        const attached = await service.attachImage({
          nodeId: node.id,
          fileName: file.split("/").at(-1) ?? file,
          contentBase64,
        });
        /*
         * An image the document does not point at is a file nobody sees and
         * nothing sends downstream, so adding one references it.
         */
        const artifact = await service.readArtifact({ nodeId: node.id });
        await service.writeArtifact({
          nodeId: node.id,
          content: `${artifact.content.replace(/\s*$/u, "")}\n\n${attached.markdown}\n`,
          expectedSha256: artifact.sha256,
        });
        return result({
          json,
          payload: { image: attached },
          text: `Added ${attached.assetFile} to ${node.artifactFile}.`,
        });
      }
      throw new CliUsageError(`Unknown image action "${String(action)}".`);
    }
    if (command === "layout") {
      const project = resolveProject(requirePositional(args, 1, "A project"));
      service.autoLayout({ projectId: project.id });
      return result({
        json,
        payload: { ok: true },
        text: `Re-laid out ${project.name}.`,
      });
    }

    const node = resolveNode(requirePositional(args, 1, "A task"), projectRef);
    if (command === "start") {
      const started = await service.startNode({ nodeId: node.id });
      return result({
        json,
        payload: { node: started },
        text: nodeLine(started),
      });
    }
    if (command === "resend") {
      const resent = await service.resendContext({ nodeId: node.id });
      return result({
        json,
        payload: { node: resent },
        text: nodeLine(resent),
      });
    }
    if (command === "handdown") {
      const { deliveries } = await service.handDownContext({ nodeId: node.id });
      return result({
        json,
        payload: { deliveries },
        text:
          deliveries.length === 0
            ? `${node.title} has no tasks depending on it.`
            : deliveries.map((delivery) => handDownLine(delivery)).join("\n"),
      });
    }
    if (command === "complete") {
      // The panel lets the summary land in the background; a CLI caller waits,
      // so the summary is ready for whatever it does next.
      const { node: completed } = await service.completeNode({
        nodeId: node.id,
        awaitSummary: true,
      });
      const warning =
        completed.summaryProblem === null
          ? ""
          : `\n    warning: the summary could not be generated (${completed.summaryProblem}). Write one with \`bb tree summary\`.`;
      return result({
        json,
        payload: { node: completed, summaryProblem: completed.summaryProblem },
        text: `${nodeLine(completed)}${warning}`,
      });
    }
    if (command === "compact") {
      service.compactNode({ nodeId: node.id });
      await service.runPendingSummaries();
      const compacted = service.getNode(node.id);
      return result({
        json,
        payload: { node: compacted },
        text: nodeLine(compacted),
      });
    }
    if (command === "summary") {
      const updated = service.setSummary({
        nodeId: node.id,
        summary: requireOption(args, "text"),
      });
      return result({
        json,
        payload: { node: updated },
        text: nodeLine(updated),
      });
    }
    if (command === "reopen") {
      const reopened = service.reopenNode({
        nodeId: node.id,
        discardThread: args.flags.has("discard-thread"),
      });
      return result({
        json,
        payload: { node: reopened },
        text: nodeLine(reopened),
      });
    }
    if (command === "open") {
      const opened = await service.openThread({
        nodeId: node.id,
        baseBranch: requireOption(args, "base-branch"),
        prompt: args.options.get("message") ?? node.title,
      });
      return result({
        json,
        payload: { node: opened },
        text: nodeLine(opened),
      });
    }
    if (command === "working") {
      const working = service.markWorking({ nodeId: node.id });
      return result({
        json,
        payload: { node: working },
        text: nodeLine(working),
      });
    }
    if (command === "ack") {
      const acknowledged = service.acknowledgeStale({ nodeId: node.id });
      return result({
        json,
        payload: { node: acknowledged },
        text: nodeLine(acknowledged),
      });
    }
    throw new CliUsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }

  return async function runCli(
    argv: readonly string[],
    context: PluginCliContext,
  ): Promise<PluginCliResult> {
    try {
      return await run(argv, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stderr: `${message}\n` };
    }
  };
}
