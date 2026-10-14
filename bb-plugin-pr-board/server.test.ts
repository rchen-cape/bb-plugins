import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { RunOptions } from "./github";
import { FINDINGS_TOOL, REVIEW_SKILL, SUGGESTIONS_TOOL, createPlugin, parsePullArgument, reviewMessage, summaryPrompt } from "./server";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);

const PULL_RESPONSE = {
  data: {
    viewer: { login: "me" },
    repository: {
      pullRequest: {
        id: "PR_node",
        number: 7,
        title: "Add thing",
        body: "Adds the thing.",
        url: "https://github.com/acme/app/pull/7",
        state: "OPEN",
        isDraft: false,
        isCrossRepository: false,
        additions: 10,
        deletions: 2,
        headRefName: "thing",
        baseRefName: "main",
        headRefOid: HEAD,
        baseRefOid: BASE,
        author: { login: "alice", avatarUrl: "https://a" },
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              isResolved: false,
              isOutdated: false,
              path: "a.go",
              line: 2,
              startLine: null,
              diffSide: "RIGHT",
              comments: {
                nodes: [{ id: "c1", databaseId: 11, body: "Rename b", createdAt: "2026-10-01T00:00:00Z", url: "u", author: { login: "carol" } }],
              },
            },
          ],
        },
        comments: { nodes: [{ id: "IC_1", body: "Add a test", createdAt: "2026-10-02T00:00:00Z", url: "u", author: { login: "dave" } }] },
        reviews: { nodes: [] },
      },
    },
  },
};

const VIEWED_RESPONSE = {
  data: {
    repository: {
      pullRequest: {
        files: { nodes: [{ path: "a.go", viewerViewedState: "VIEWED" }], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};

function searchNode(number: number, overrides: { author?: string; comments?: string[]; threadLast?: string[] } = {}) {
  const user = (login: string) => ({ __typename: "User", login, avatarUrl: null });
  return {
    repository: { nameWithOwner: "acme/app" },
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: `2026-10-0${number}T00:00:00Z`,
    headRefName: "b",
    baseRefName: "main",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: null,
    author: user(overrides.author ?? "alice"),
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: (overrides.comments ?? []).map((login, index) => ({ createdAt: `2026-10-0${index + 1}T00:00:00Z`, author: user(login) })),
    },
    reviewThreads: {
      nodes: (overrides.threadLast ?? []).map((login) => ({ isResolved: false, comments: { nodes: [{ author: user(login) }] } })),
    },
    commits: { nodes: [] },
  };
}

function searchResponse(q: string) {
  const nodes = q.includes("author:@me")
    ? [searchNode(1, { author: "me", comments: ["alice"] })]
    : q.includes("mentions:@me")
      ? [searchNode(2)]
      : q.includes("user-review-requested:@me")
        ? [searchNode(6)]
      : q.includes("commenter:@me")
        ? [searchNode(3, { comments: ["me"] }), searchNode(4, { comments: ["me", "alice"] })]
        : [searchNode(5, { threadLast: ["me"] })];
  return { data: { search: { nodes } } };
}

function fakeRunner() {
  const calls: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];
  const run = vi.fn(async (command: string, args: readonly string[], options: RunOptions) => {
    calls.push({ command, args, options });
    if (args[0] === "version") {
      if (command === "gh") return "gh version 2";
      throw new Error("not installed");
    }
    if (args[0] === "api" && args[1] === "user") return "me\n";
    if (args[0] === "api" && args[1] === "graphql") {
      const { query, variables } = JSON.parse(options.input ?? "{}") as { query: string; variables: { q?: string } };
      if (variables.q !== undefined) return JSON.stringify(searchResponse(variables.q));
      return JSON.stringify(query.includes("viewerViewedState") ? VIEWED_RESPONSE : PULL_RESPONSE);
    }
    if (args.includes("--paginate")) {
      return JSON.stringify([[{ filename: "a.go", status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]]);
    }
    if (args[0] === "api" && String(args[1]).includes("/compare/")) return `${MERGE_BASE}\n`;
    if (args[0] === "pr" && args[1] === "checkout") return "";
    if (args[0] === "api" && args[1] === "--method" && String(args[3]).endsWith("/issues/7/comments")) return "{}";
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  });
  return { run, calls };
}

function setup() {
  const runner = fakeRunner();
  const thread = makeThreadResponse({ id: "thr_review", environmentId: "env_1", status: "idle", deletedAt: null, archivedAt: null });
  const { bb, harness } = createFakePluginHost({
    pluginId: "pr-board",
    agentSkillIds: ["pr-board"],
    settings: { repos: "acme/app" },
    sdk: {
      projects: { list: async () => [{ id: "proj_app", gitRemoteUrl: "git@github.com:acme/app.git" }] as never },
      system: { config: async () => ({ primaryHostId: "host_1" }) as never },
      threads: {
        spawn: async () => thread as never,
        get: async () => thread as never,
        send: async () => ({ delivery: "queued" }) as never,
      },
      environments: { get: async () => ({ id: "env_1", status: "ready", path: "/tmp/worktree", hostId: "host_1" }) as never },
    },
  });
  createPlugin({ run: runner.run, pollMs: 1, now: Date.now })(bb);
  return { harness, runner };
}

describe("prompts", () => {
  it("asks for a simple summary first and names the diff command", () => {
    const prompt = summaryPrompt({
      repo: "acme/app",
      number: 7,
      nodeId: "n",
      title: "Add thing",
      body: "",
      url: "https://github.com/acme/app/pull/7",
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      author: { login: "alice", avatarUrl: null },
      headRefName: "thing",
      baseRefName: "main",
      headSha: HEAD,
      mergeBaseSha: MERGE_BASE,
      additions: 1,
      deletions: 0,
      viewer: "me",
      files: [{ path: "a.go", previousPath: null, status: "modified", additions: 1, deletions: 0, patch: null, viewed: false }],
      threads: [],
      conversation: [],
    });
    expect(prompt).toContain("Summarize this PR very simply");
    expect(prompt).toContain("gh pr diff 7 -R acme/app");
    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("- a.go (+1/-0)");
  });

  it("starts the review message with the skill command and asks for recorded findings", () => {
    const message = reviewMessage({ repo: "acme/app", number: 7, baseRefName: "main" });
    expect(message.startsWith(`${REVIEW_SKILL} review pr 7`)).toBe(true);
    expect(message).toContain(FINDINGS_TOOL);
  });
});

describe("parsePullArgument", () => {
  it.each([
    ["https://github.com/acme/app/pull/12/files", { repo: "acme/app", number: 12 }],
    ["acme/app#12", { repo: "acme/app", number: 12 }],
    ["12", { repo: "acme/default", number: 12 }],
    ["twelve", null],
  ])("parses %s", (value, expected) => {
    expect(parsePullArgument(value, "acme/default")).toEqual(expected);
  });
});

describe("board", () => {
  it("shows my PRs, PRs mentioning me or requesting my review, and PRs where my comment is still the latest", async () => {
    const { harness, runner } = setup();
    const board = (await harness.behavior.callRpc("board", { refresh: false })) as {
      viewer: string;
      cards: Array<{ number: number; isAuthor: boolean; isMentioned: boolean; isRequested: boolean; isAwaitingReply: boolean; unansweredComments: number }>;
    };
    expect(board.viewer).toBe("me");
    expect(
      board.cards.map((card) => [card.number, card.isAuthor, card.isMentioned, card.isRequested, card.isAwaitingReply, card.unansweredComments]),
    ).toEqual([
      [6, false, false, true, false, 0],
      [5, false, false, false, true, 0],
      [3, false, false, false, true, 0],
      [2, false, true, false, false, 0],
      [1, true, false, false, false, 1],
    ]);
    const searches = runner.calls.flatMap((call) => {
      const q = (JSON.parse(call.options.input ?? "{}") as { variables?: { q?: string } }).variables?.q;
      return q === undefined ? [] : [q];
    });
    expect(searches.every((q) => q.startsWith("is:pr is:open archived:false repo:acme/app "))).toBe(true);
  });
});

describe("review threads", () => {
  it("spawns one worktree thread per PR, checks the PR out, then queues the review", async () => {
    const { harness, runner } = setup();
    const first = await harness.behavior.callRpc("openReview", { repo: "acme/app", number: 7 });
    expect(first).toEqual({ threadId: "thr_review", created: true });

    const [spawn] = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawn?.[0]).toMatchObject({
      projectId: "proj_app",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: "host_1" },
        inputs: { branch: { kind: "named", name: "origin/thing" } },
      },
      title: "Review app#7: Add thing",
      pluginMetadata: { repo: "acme/app", number: 7 },
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      permissionMode: "auto",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
    });

    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    const checkout = runner.calls.find((call) => call.args[0] === "pr" && call.args[1] === "checkout");
    expect(checkout?.options.cwd).toBe("/tmp/worktree");
    const [send] = harness.inspection.sdk.callsTo("threads.send");
    expect(JSON.stringify(send?.[0])).toContain(`${REVIEW_SKILL} review pr 7`);

    const second = await harness.behavior.callRpc("openReview", { repo: "acme/app", number: 7 });
    expect(second).toEqual({ threadId: "thr_review", created: false });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
});

describe("review execution settings", () => {
  it("spawns with the configured model, effort, and mode, and the project's model when the model is empty", async () => {
    const runner = fakeRunner();
    const thread = makeThreadResponse({ id: "thr_review", environmentId: "env_1", status: "idle", deletedAt: null, archivedAt: null });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-board",
      agentSkillIds: ["pr-board"],
      settings: { repos: "acme/app", reviewModel: " ", reviewReasoning: "xhigh", reviewPermissionMode: "accept-edits" },
      sdk: {
        projects: { list: async () => [{ id: "proj_app", gitRemoteUrl: "git@github.com:acme/app.git" }] as never },
        system: { config: async () => ({ primaryHostId: "host_1" }) as never },
        threads: { spawn: async () => thread as never, get: async () => null as never, send: async () => ({ delivery: "queued" }) as never },
        environments: { get: async () => ({ id: "env_1", status: "ready", path: "/tmp/worktree", hostId: "host_1" }) as never },
      },
    });
    createPlugin({ run: runner.run, pollMs: 1, now: Date.now })(bb);
    await harness.behavior.callRpc("openReview", { repo: "acme/app", number: 7 });
    const [spawn] = harness.inspection.sdk.callsTo("threads.spawn");
    const args = spawn?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({ providerId: "claude-code", reasoningLevel: "xhigh", permissionMode: "accept-edits" });
    expect(args).not.toHaveProperty("model");
    expect(args.executionInputSources).toEqual({ providerId: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" });
  });
});

describe("findings tool", () => {
  it("is offered only to threads that carry review metadata", async () => {
    const { harness } = setup();
    const review = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { repo: "acme/app", number: 7 } }),
    );
    const other = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(review.tools.map((tool) => tool.name)).toEqual([FINDINGS_TOOL]);
    expect(other.tools).toEqual([]);
    expect(other.skills).toEqual(["pr-board"]);
  });

  it("records findings for the thread's PR and replaces earlier ones", async () => {
    const { harness } = setup();
    await harness.behavior.callRpc("openReview", { repo: "acme/app", number: 7 });
    const finding = { path: "./a.go", startLine: 9, endLine: 3, severity: "major", title: "Split this", body: "Too big" };
    await harness.behavior.callAgentTool(FINDINGS_TOOL, { findings: [finding, { ...finding, title: "Second" }] }, { threadId: "thr_review" });
    const result = await harness.behavior.callAgentTool(FINDINGS_TOOL, { findings: [finding] }, { threadId: "thr_review" });
    expect(result).toContain("Recorded 1 finding for acme/app#7");

    const state = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as {
      findings: Array<Record<string, unknown>>;
      agent: { findings: number };
    };
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ path: "a.go", side: "additions", startLine: 3, endLine: 9, headSha: HEAD });
    expect(state.agent.findings).toBe(1);
  });

  it("refuses threads that PR Board did not start", async () => {
    const { harness } = setup();
    const result = await harness.behavior.callAgentTool(
      FINDINGS_TOOL,
      { findings: [{ path: "a.go", severity: "nit", title: "x", body: "" }] },
      { threadId: "thr_other" },
    );
    expect(result).toMatchObject({ isError: true });
  });
});

describe("drafts", () => {
  it("keeps drafts per PR and will not move one to another PR", async () => {
    const { harness } = setup();
    const target = { path: "a.go", side: "additions", startLine: 2, endLine: 2, body: "Why?" };
    const draft = (await harness.behavior.callRpc("saveDraft", { repo: "acme/app", number: 7, id: null, ...target })) as { id: string };
    await expect(
      harness.behavior.callRpc("saveDraft", { repo: "acme/app", number: 8, id: draft.id, ...target }),
    ).rejects.toThrow();
    const state = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as { drafts: unknown[] };
    expect(state.drafts).toHaveLength(1);
  });
});

describe("address comments", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "pr-board-address-"));
    await writeFile(join(worktree, "a.go"), "package a\n\nfunc b() {}\n");
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  function addressSetup({ gitStatus = "", heads = [HEAD], pullError }: { gitStatus?: string; heads?: string[]; pullError?: string } = {}) {
    const runner = fakeRunner();
    const git: string[][] = [];
    const remaining = [...heads];
    const run = vi.fn(async (command: string, args: readonly string[], options: RunOptions) => {
      if (command !== "git") return runner.run(command, args, options);
      git.push([...args]);
      if (args[0] === "status") return gitStatus;
      if (args[0] === "rev-parse") return `${remaining.length > 1 ? remaining.shift() : remaining[0]}\n`;
      if (args[0] === "pull") {
        if (pullError !== undefined) throw new Error(pullError);
        return "";
      }
      return runner.run(command, args, options);
    });
    const thread = makeThreadResponse({ id: "thr_address", environmentId: "env_1", status: "idle", deletedAt: null, archivedAt: null });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-board",
      agentSkillIds: ["pr-board"],
      settings: { repos: "acme/app" },
      sdk: {
        projects: { list: async () => [{ id: "proj_app", gitRemoteUrl: "git@github.com:acme/app.git" }] as never },
        system: { config: async () => ({ primaryHostId: "host_1" }) as never },
        threads: {
          spawn: async () => thread as never,
          get: async () => thread as never,
          send: async () => ({ delivery: "queued" }) as never,
        },
        environments: { get: async () => ({ id: "env_1", status: "ready", path: worktree, hostId: "host_1" }) as never },
      },
    });
    createPlugin({ run, pollMs: 1, now: Date.now })(bb);
    return { harness, runner, git };
  }

  const record = (harness: ReturnType<typeof addressSetup>["harness"], suggestions: unknown[]) =>
    harness.behavior.callAgentTool(SUGGESTIONS_TOOL, { suggestions }, { threadId: "thr_address" });

  it("starts an address thread that gets only the suggestions tool, then re-sends the comments to it", async () => {
    const { harness, runner } = addressSetup();
    const first = await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    expect(first).toEqual({ threadId: "thr_address", created: true, delivery: "queued" });
    const [spawn] = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawn?.[0]).toMatchObject({ pluginMetadata: { repo: "acme/app", number: 7, kind: "address" } });
    expect(JSON.stringify(spawn?.[0])).toContain("[PRRT_1] a.go line 2");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    expect(runner.calls.find((call) => call.args[0] === "pr" && call.args[1] === "checkout")?.options.cwd).toBe(worktree);
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.send")[0]?.[0])).toContain(SUGGESTIONS_TOOL);

    const again = await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    expect(again).toEqual({ threadId: "thr_address", created: false, delivery: "queued" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.send")[1]?.[0])).toContain("[IC_1]");

    const address = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { repo: "acme/app", number: 7, kind: "address" } }),
    );
    expect(address.tools.map((tool) => tool.name)).toEqual([SUGGESTIONS_TOOL]);
  });

  it("moves the address worktree to the PR's new commits before sending the comments again", async () => {
    const { harness, git } = addressSetup({ heads: ["4".repeat(40), HEAD] });
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    expect(git).toEqual([["rev-parse", "HEAD"], ["pull", "--ff-only"], ["rev-parse", "HEAD"]]);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("does not send the comments again when the address worktree cannot reach the PR's new commits", async () => {
    const { harness } = addressSetup({ heads: ["4".repeat(40)], pullError: "Your local changes to a.go would be overwritten by merge" });
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    await expect(harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 })).rejects.toThrow(
      "Could not update the address thread's worktree to the PR's latest commit 111111111111: Your local changes to a.go would be overwritten by merge",
    );
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("rejects suggestions with unknown comments or edits that do not match, and records nothing", async () => {
    const { harness } = addressSetup();
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    const result = await record(harness, [
      { commentId: "PRRT_1", summary: "Rename", changes: [{ path: "a.go", find: "func c() {}", replace: "func d() {}" }] },
      { commentId: "nope", summary: "Reply", reply: "Thanks" },
      { commentId: "IC_1", summary: "Empty" },
    ]);
    expect(result).toMatchObject({ isError: true });
    const text = JSON.stringify(result);
    expect(text).toContain("not found in a.go");
    expect(text).toContain("no unresolved code comment");
    expect(text).toContain("give a reply, changes, or both");
    const state = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as { suggestions: unknown[] };
    expect(state.suggestions).toEqual([]);
  });

  it("records, previews, applies, and dismisses suggestions in the address thread's worktree", async () => {
    const { harness } = addressSetup();
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    const result = await record(harness, [
      { commentId: "PRRT_1", summary: "Rename b to c", reply: "Renamed.", changes: [{ path: `${worktree}/a.go`, find: "func b() {}", replace: "func c() {}" }] },
      { commentId: "IC_1", summary: "Add a test", changes: [{ path: "a_test.go", find: "", replace: "package a\n" }] },
    ]);
    expect(result).toContain("Recorded 2 suggestions for acme/app#7");
    const state = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as {
      addressAgent: { threadId: string | null };
      suggestions: Array<{ id: string; commentId: string; edits: Array<{ path: string }>; replyState: string; changeState: string }>;
    };
    expect(state.addressAgent.threadId).toBe("thr_address");
    const [rename, test] = state.suggestions;
    expect(rename).toMatchObject({ commentId: "PRRT_1", edits: [{ path: "a.go" }], replyState: "open", changeState: "open" });

    const preview = await harness.behavior.callRpc("suggestionFiles", { id: rename!.id });
    expect(preview).toEqual({ files: [{ path: "a.go", before: "package a\n\nfunc b() {}\n", after: "package a\n\nfunc c() {}\n" }], error: null });

    await harness.behavior.callRpc("applySuggestion", { id: rename!.id });
    expect(await readFile(join(worktree, "a.go"), "utf8")).toBe("package a\n\nfunc c() {}\n");
    await expect(harness.behavior.callRpc("applySuggestion", { id: rename!.id })).rejects.toThrow("already applied");
    await expect(harness.behavior.callRpc("setSuggestionState", { id: rename!.id, part: "change", state: "dismissed" })).rejects.toThrow(
      "already applied",
    );
    expect(await harness.behavior.callRpc("suggestionFiles", { id: rename!.id })).toMatchObject({ files: [], error: expect.stringContaining("no longer applies") });

    await harness.behavior.callRpc("setSuggestionState", { id: rename!.id, part: "reply", state: "used" });
    await harness.behavior.callRpc("setSuggestionState", { id: test!.id, part: "change", state: "dismissed" });
    await expect(harness.behavior.callRpc("applySuggestion", { id: test!.id })).rejects.toThrow("already applied or dismissed");
    const after = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as typeof state;
    expect(after.suggestions.map((suggestion) => [suggestion.replyState, suggestion.changeState])).toEqual([
      ["used", "applied"],
      ["open", "dismissed"],
    ]);

    await record(harness, [{ commentId: "IC_1", summary: "Reply instead", reply: "Added one." }]);
    const rerun = (await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as typeof state;
    expect(rerun.suggestions.map((suggestion) => suggestion.id === rename!.id || suggestion.commentId)).toEqual([true, "IC_1"]);
  });

  it("retires the untouched half of a kept suggestion when a re-run replaces it", async () => {
    const { harness } = addressSetup();
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    const both = { commentId: "PRRT_1", summary: "Rename", reply: "Renamed.", changes: [{ path: "a.go", find: "func b() {}", replace: "func c() {}" }] };
    await record(harness, [both]);
    const read = async () =>
      ((await harness.behavior.callRpc("reviewState", { repo: "acme/app", number: 7 })) as {
        suggestions: Array<{ id: string; replyState: string; changeState: string }>;
      }).suggestions;
    const [first] = await read();
    await harness.behavior.callRpc("setSuggestionState", { id: first!.id, part: "reply", state: "used" });
    await record(harness, [both]);
    expect((await read()).map((suggestion) => [suggestion.id === first!.id, suggestion.replyState, suggestion.changeState])).toEqual([
      [true, "used", "dismissed"],
      [false, "open", "open"],
    ]);
  });

  it("submits accepted changes through the address thread only when there is one with changes", async () => {
    const empty = addressSetup();
    await expect(empty.harness.behavior.callRpc("submitAddress", { repo: "acme/app", number: 7 })).rejects.toThrow("Click Address comments first");
    await empty.harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    await expect(empty.harness.behavior.callRpc("submitAddress", { repo: "acme/app", number: 7 })).rejects.toThrow("no accepted changes");

    const { harness } = addressSetup({ gitStatus: " M a.go\n?? a_test.go\n" });
    await harness.behavior.callRpc("addressComments", { repo: "acme/app", number: 7 });
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    const result = await harness.behavior.callRpc("submitAddress", { repo: "acme/app", number: 7 });
    expect(result).toEqual({ threadId: "thr_address", delivery: "queued" });
    const message = JSON.stringify(harness.inspection.sdk.callsTo("threads.send")[1]?.[0]);
    expect(message).toContain("Changed files: a.go, a_test.go");
    expect(message).toContain(".github/workflows/");
    expect(message).toContain("HEAD:thing");
    expect(message.toLowerCase()).toContain("never force-push");
    expect(message).toContain("edits that keep the code's behavior the same");
    expect(message).toContain("Do not change logic, tests, or test expectations");
    expect(message).toContain("commit them separately");
  });

  it("posts a conversation comment through gh", async () => {
    const { harness, runner } = addressSetup();
    await harness.behavior.callRpc("postConversationComment", { repo: "acme/app", number: 7, body: "Thanks!" });
    const post = runner.calls.find((call) => String(call.args[3]).endsWith("/issues/7/comments"));
    expect(post?.options.input).toBe(JSON.stringify({ body: "Thanks!" }));
  });
});
