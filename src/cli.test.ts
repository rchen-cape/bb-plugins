import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import treesPlugin from "../server";
import { parseArgv } from "./cli";
import type { TreeNode, TreeProject } from "./model";

const ROOT = "/tmp/bb-trees-cli-test";

interface Fakes {
  files: Map<string, string>;
  spawns: { id: string; projectId: string; environment: unknown }[];
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildSdk(fakes: Fakes) {
  const busy = new Map<string, number>();
  let counter = 0;
  return {
    hosts: {
      list: async () => [
        { id: "host_1", connected: true, name: "primary" },
        { id: "host_2", connected: false, name: "laptop" },
      ],
    },
    projects: {
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
    environments: { get: async () => ({ id: "env_1", hostId: "host_2" }) },
    files: {
      mkdir: async () => ({ created: true }),
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
            return { outcome: "conflict" as const, currentSha256: current };
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
      spawn: async (args: { projectId: string; environment: unknown }) => {
        counter += 1;
        const id = `th_${counter}`;
        busy.set(id, 1);
        fakes.spawns.push({
          id,
          projectId: args.projectId,
          environment: args.environment,
        });
        return { id, status: "idle" };
      },
      get: async ({ threadId }: { threadId: string }) => {
        const remaining = busy.get(threadId) ?? 0;
        if (remaining > 0) {
          busy.set(threadId, remaining - 1);
          return { id: threadId, status: "active", environmentId: "env_1" };
        }
        return { id: threadId, status: "idle", environmentId: "env_1" };
      },
      send: async () => ({ ok: true, delivery: "sent" }),
      output: async () => ({ output: "worker summary" }),
      archive: async ({ threadId }: { threadId: string }) => ({
        archived: [threadId],
      }),
      stop: async () => ({ ok: true }),
    },
  };
}

async function loadPlugin(fakes: Fakes): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "trees",
    settings: { rootDirectory: ROOT },
    sdk: buildSdk(fakes),
  });
  await treesPlugin(host.bb);
  return host;
}

async function run(
  host: FakePluginHost,
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await host.harness.behavior.runCli(argv, {});
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runJson<T>(host: FakePluginHost, argv: string[]): Promise<T> {
  const result = await run(host, [...argv, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe("parseArgv", () => {
  it("separates positionals, valued options, and bare flags", () => {
    const parsed = parseArgv([
      "node",
      "create",
      "--project",
      "Auth",
      "--title=Write it",
      "--json",
    ]);
    expect(parsed.positionals).toEqual(["node", "create"]);
    expect(parsed.options.get("project")).toBe("Auth");
    expect(parsed.options.get("title")).toBe("Write it");
    expect(parsed.flags.has("json")).toBe(true);
  });

  it("treats an option followed by another option as a flag", () => {
    const parsed = parseArgv(["reopen", "trn_1", "--discard-thread", "--json"]);
    expect(parsed.flags.has("discard-thread")).toBe(true);
    expect(parsed.flags.has("json")).toBe(true);
    expect(parsed.options.size).toBe(0);
  });

  it("keeps an empty option value rather than swallowing the next token", () => {
    const parsed = parseArgv(["summary", "trn_1", "--text="]);
    expect(parsed.options.get("text")).toBe("");
  });
});

describe("bb tree", () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = { files: new Map(), spawns: [] };
  });

  it("prints usage rather than failing when invoked bare", async () => {
    const host = await loadPlugin(fakes);
    const result = await run(host, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bb tree ready");
  });

  it("creates a project and lists it", async () => {
    const host = await loadPlugin(fakes);
    const created = await runJson<{ project: TreeProject }>(host, [
      "project",
      "create",
      "--name",
      "Build auth",
    ]);
    expect(created.project.directory).toBe(`${ROOT}/build_auth`);

    const listed = await runJson<{ projects: TreeProject[] }>(host, [
      "project",
      "list",
    ]);
    expect(listed.projects.map((project) => project.name)).toEqual([
      "Build auth",
    ]);
  });

  it("resolves a project by name and a task by title", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Build auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "build AUTH",
      "--title",
      "Write auth requirements",
      "--kind",
      "markdown",
    ]);
    const shown = await runJson<{ node: TreeNode }>(host, [
      "node",
      "show",
      "Write auth requirements",
    ]);
    expect(shown.node.artifactFile).toBe("01_write_auth_requirements.md");
  });

  /*
   * The panel places a task where the draft card stood, so a coordinate is a
   * real part of the contract rather than something only a drag can reach.
   */
  it("places a task where it is told and moves it afterwards", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Build auth"]);
    const created = await runJson<{ node: TreeNode }>(host, [
      "node",
      "create",
      "--project",
      "Build auth",
      "--title",
      "Write auth requirements",
      "--x",
      "208",
      "--y",
      "124",
    ]);
    expect([created.node.x, created.node.y]).toEqual([208, 124]);

    await runJson(host, [
      "node",
      "move",
      "Write auth requirements",
      "--x",
      "0",
      "--y",
      "0",
    ]);
    const moved = await runJson<{ node: TreeNode }>(host, [
      "node",
      "show",
      "Write auth requirements",
    ]);
    expect([moved.node.x, moved.node.y]).toEqual([0, 0]);
  });

  it("refuses half a coordinate rather than guessing the other half", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Build auth"]);
    const result = await run(host, [
      "node",
      "create",
      "--project",
      "Build auth",
      "--title",
      "Lopsided",
      "--x",
      "40",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--x and --y go together.");
  });

  it("names the unknown reference instead of failing opaquely", async () => {
    const host = await loadPlugin(fakes);
    const result = await run(host, ["node", "show", "nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No task matches "nope"');
  });

  it("wires dependencies by title and refuses a loop", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "First",
      "--kind",
      "markdown",
    ]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Second",
      "--kind",
      "markdown",
      "--depends-on",
      "First",
    ]);

    const loop = await run(host, [
      "dep",
      "add",
      "--parent",
      "Second",
      "--child",
      "First",
    ]);
    expect(loop.exitCode).toBe(1);
    expect(loop.stderr).toContain("create a loop");
  });

  it("lists ready tasks and hides the blocked ones", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "First",
      "--kind",
      "markdown",
    ]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Second",
      "--kind",
      "markdown",
      "--depends-on",
      "First",
    ]);

    const ready = await runJson<{ entries: { node: TreeNode }[] }>(host, [
      "ready",
    ]);
    expect(ready.entries.map((entry) => entry.node.title)).toEqual(["First"]);
  });

  it("narrows the ready list to one tree when asked", async () => {
    const host = await loadPlugin(fakes);
    for (const name of ["Auth", "Billing"]) {
      await runJson(host, ["project", "create", "--name", name]);
      await runJson(host, [
        "node",
        "create",
        "--project",
        name,
        "--title",
        `${name} first`,
        "--kind",
        "markdown",
      ]);
    }

    const all = await runJson<{ entries: { node: TreeNode }[] }>(host, [
      "ready",
    ]);
    expect(all.entries.map((entry) => entry.node.title)).toEqual([
      "Auth first",
      "Billing first",
    ]);

    const scoped = await runJson<{ entries: { node: TreeNode }[] }>(host, [
      "ready",
      "--project",
      "Billing",
    ]);
    expect(scoped.entries.map((entry) => entry.node.title)).toEqual([
      "Billing first",
    ]);
  });

  it("says nothing is ready in plain output rather than printing an empty list", async () => {
    const host = await loadPlugin(fakes);
    const result = await run(host, ["ready"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing is ready");
  });

  it("writes a task file from inline content and reads it back", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Notes",
      "--kind",
      "markdown",
    ]);
    const write = await run(host, [
      "artifact",
      "write",
      "Notes",
      "--content",
      "# Notes\n\nUsers need OAuth2.\n",
    ]);
    expect(write.exitCode, write.stderr).toBe(0);
    const read = await run(host, ["artifact", "read", "Notes"]);
    expect(read.stdout).toContain("Users need OAuth2.");
  });

  it("refuses inline content and a file path together", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Notes",
      "--kind",
      "markdown",
    ]);
    const result = await run(host, [
      "artifact",
      "write",
      "Notes",
      "--content",
      "a",
      "--content-file",
      "/tmp/b.md",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not both");
  });

  it("names an unknown machine for --machine rather than reading the wrong disk", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Notes",
      "--kind",
      "markdown",
    ]);
    const result = await run(host, [
      "artifact",
      "write",
      "Notes",
      "--content-file",
      "/tmp/b.md",
      "--machine",
      "desktop",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No machine matches "desktop"');
  });

  it("prints the assembled context for a task", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Specs",
      "--kind",
      "agent",
      "--instruction",
      "Generate the OpenAPI schema.",
    ]);
    const result = await run(host, ["context", "Specs"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("## Task");
    expect(result.stdout).toContain("Generate the OpenAPI schema.");
    expect(result.stdout).toContain("## Deliverable");
  });

  it("reports what became of each child when handing the context down", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Research",
      "--kind",
      "markdown",
    ]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Specs",
      "--kind",
      "agent",
      "--instruction",
      "Generate it.",
      "--depends-on",
      "Research",
    ]);

    const handed = await run(host, ["handdown", "Research"]);
    expect(handed.exitCode, handed.stderr).toBe(0);
    expect(handed.stdout).toContain("Specs has no thread yet");

    const childless = await run(host, ["handdown", "Specs"]);
    expect(childless.exitCode, childless.stderr).toBe(0);
    expect(childless.stdout).toContain("no tasks depending on it");
  });

  it("starts an agent task in a directory named on the command line", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    await runJson(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Middleware",
      "--kind",
      "agent",
      "--instruction",
      "Write it.",
      "--workspace",
      "/Users/me/Development/api",
    ]);
    const started = await runJson<{ node: TreeNode }>(host, [
      "start",
      "Middleware",
    ]);
    expect(started.node.state).toBe("in_progress");
    expect(fakes.spawns.at(-1)?.projectId).toBe("proj_api");
    expect(fakes.spawns.at(-1)?.environment).toEqual({
      type: "project-default",
    });
  });

  it("refuses a workspace value that is neither a project nor an absolute path", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    const result = await run(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Middleware",
      "--kind",
      "agent",
      "--workspace",
      "somewhere",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--workspace must be");
  });

  it("sets and rejects the handoff from the command line", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    const created = await runJson<{ node: TreeNode }>(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Research",
      "--handoff",
      "full",
    ]);
    expect(created.node.handoff).toBe("full");

    const updated = await runJson<{ node: TreeNode }>(host, [
      "node",
      "update",
      "Research",
      "--handoff",
      "custom",
    ]);
    expect(updated.node.handoff).toBe("custom");

    const bad = await run(host, [
      "node",
      "update",
      "Research",
      "--handoff",
      "everything",
    ]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain(
      "--handoff must be one of summary, custom, full.",
    );
  });

  it("rejects an unknown kind by listing the valid ones", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    const result = await run(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Thing",
      "--kind",
      "chat",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("markdown, agent");
  });

  it("warns on stdout when a completion could not be compacted", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    const created = await runJson<{ node: TreeNode }>(host, [
      "node",
      "create",
      "--project",
      "Auth",
      "--title",
      "Notes",
      "--kind",
      "markdown",
    ]);
    fakes.files.set(created.node.artifactPath, "# Notes\n\nReal content.\n");
    host.harness.sdk.stub("threads.spawn", async () => {
      throw new Error("provider unavailable");
    });

    const result = await run(host, ["complete", "Notes"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("warning:");
    expect(result.stdout).toContain("provider unavailable");
  });

  it("says where the Markdown stays when a project is deleted", async () => {
    const host = await loadPlugin(fakes);
    await runJson(host, ["project", "create", "--name", "Auth"]);
    const result = await run(host, ["project", "delete", "Auth"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${ROOT}/auth`);
  });
});
