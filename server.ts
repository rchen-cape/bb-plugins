import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createTreeCli, TREE_CLI_COMMANDS } from "./src/cli.js";
import { migrations } from "./src/data.js";
import { resolveRootDirectory } from "./src/paths.js";
import { createRpcHandlers, treesRpcContract } from "./src/rpc.js";
import { createTreeService } from "./src/service.js";

export { treesRpcContract } from "./src/rpc.js";

const DEFAULT_ROOT_DIRECTORY = "~/Trees";
const REVEAL_TIMEOUT_MS = 5_000;
const run = promisify(execFile);

function revealCommand(directory: string): {
  command: string;
  args: string[];
} {
  if (process.platform === "darwin") {
    return { command: "open", args: [directory] };
  }
  if (process.platform === "win32") {
    return { command: "explorer.exe", args: [directory] };
  }
  return { command: "xdg-open", args: [directory] };
}
const RECONCILE_INTERVAL_MS = 60_000;
const SUMMARY_POLL_INTERVAL_MS = 1_500;

const bbEnvironmentListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      name: z.string().nullable(),
      projectId: z.string().min(1),
      isWorktree: z.boolean(),
      branchName: z.string().nullable(),
      path: z.string().nullable(),
      status: z.string(),
    })
    .loose(),
);

function sharedEnvironmentLabel(args: {
  projectName: string | null;
  environment: {
    name: string | null;
    isWorktree: boolean;
    branchName: string | null;
    path: string | null;
  };
}): string {
  const { environment } = args;
  const where =
    environment.branchName ??
    environment.name ??
    environment.path?.split("/").pop() ??
    "workspace";
  const shape = environment.isWorktree ? "worktree" : "checkout";
  return args.projectName === null
    ? `${where} (${shape})`
    : `${args.projectName} · ${where} (${shape})`;
}

const bbProjectListSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string() }).loose(),
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    rootDirectory: {
      type: "string",
      label: "Trees folder",
      default: DEFAULT_ROOT_DIRECTORY,
      experimental_schema: z
        .string()
        .min(1, "A Trees folder path is required")
        .max(1024, "That path is too long"),
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const service = createTreeService({
    bb,
    db,
    resolveRootDirectory: async () => {
      const values = await settings.get();
      return resolveRootDirectory({
        rawPath: values.rootDirectory,
        homeDirectory: os.homedir(),
      });
    },
    revealDirectory: async (directory) => {
      const { command, args } = revealCommand(directory);
      try {
        await run(command, args, { timeout: REVEAL_TIMEOUT_MS });
      } catch (error) {
        throw new Error(
          `bb could not open ${directory} in the file manager: ${errorText(error)}`,
        );
      }
    },
  });

  bb.rpc.register(
    treesRpcContract,
    createRpcHandlers({
      service,
      listBbProjects: async () =>
        bbProjectListSchema
          .parse(await bb.sdk.projects.list())
          .map((project) => ({ id: project.id, name: project.name })),
      listSharedEnvironments: async () => {
        const [projects, environments] = await Promise.all([
          bbProjectListSchema.parse(await bb.sdk.projects.list()),
          bbEnvironmentListSchema.parse(await bb.sdk.environments.list()),
        ]);
        const projectNames = new Map(
          projects.map((project) => [project.id, project.name]),
        );
        return environments
          .filter(
            (environment) =>
              environment.status === "ready" && environment.path !== null,
          )
          .map((environment) => ({
            id: environment.id,
            projectId: environment.projectId,
            label: sharedEnvironmentLabel({
              projectName: projectNames.get(environment.projectId) ?? null,
              environment,
            }),
          }));
      },
    }),
  );

  bb.cli.register({
    name: "tree",
    summary:
      "Plan work as a dependency graph of atomic tasks and pass each finished task's context to the next.",
    commands: [...TREE_CLI_COMMANDS],
    run: createTreeCli({ bb, service }),
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    try {
      service.clearThread(thread.id);
    } catch (error) {
      bb.log.warn(
        `Trees could not detach the deleted thread ${thread.id}: ${errorText(error)}`,
      );
    }
  });

  bb.background.service("trees-summaries", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await service.runPendingSummaries();
        } catch (error) {
          bb.log.warn(
            `Trees could not run a queued summary: ${errorText(error)}`,
          );
        }
        await sleep(SUMMARY_POLL_INTERVAL_MS, signal);
      }
    },
  });

  bb.background.service("trees-reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await service.reconcileArtifacts();
        } catch (error) {
          bb.log.warn(
            `Trees could not reconcile task files: ${errorText(error)}`,
          );
        }
        await sleep(RECONCILE_INTERVAL_MS, signal);
      }
    },
  });
}
