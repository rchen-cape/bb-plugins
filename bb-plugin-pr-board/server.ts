import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { columnFor, humanFeedbackCount, isAwaitingReplyFrom, reviewersOf, type PullSnapshot } from "./board.js";
import { UPDATES_CHANNEL } from "./channel.js";
import {
  rpcContract,
  severitySchema,
  sideSchema,
  type AgentState,
  type Board,
  type BoardCard,
  type FileContent,
  type PullDetail,
} from "./contract.js";
import { findDefinitions } from "./definitions.js";
import { createGitHub, runCommand, type Gh, type Runner } from "./github.js";
import { createStore, type PullKey } from "./store.js";

export { rpcContract };

const WORKTREE_PROVIDER_ID = "git-worktree";
const REVIEW_PROVIDER_ID = "claude-code";
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export const REVIEW_SKILL = "/thermo-nuclear-code-quality-review";
export const FINDINGS_TOOL = "pr_board_record_findings";
const SKILL_NAME = "pr-board";
const BOARD_TTL_MS = 30_000;
const PULL_TTL_MS = 30_000;
const VIEWER_TTL_MS = 60 * 60_000;
const FILE_CACHE_BYTES = 64 * 1024 * 1024;
const ENVIRONMENT_TIMEOUT_MS = 5 * 60_000;
const BODY_LIMIT = 4_000;
const TITLE_LIMIT = 120;
const MAX_EXTERNAL_BYTES = 2 * 1024 * 1024;

const TOOL_CANDIDATES: Record<"gh" | "gopls", string[]> = {
  gh: ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
  gopls: ["gopls", join(homedir(), "go/bin/gopls"), "/opt/homebrew/bin/gopls", "/usr/local/bin/gopls"],
};

interface Cached<T> {
  value: T;
  at: number;
}

function fresh<T>(entry: Cached<T> | undefined, ttlMs: number, now: number): entry is Cached<T> {
  return entry !== undefined && now - entry.at < ttlMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pullKey(pull: PullKey): string {
  return `${pull.repo}#${pull.number}`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function parseRepoList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo)))];
}

export function boardQueries(repos: readonly string[]) {
  const base = ["is:pr", "is:open", "archived:false", ...repos.map((repo) => `repo:${repo}`)].join(" ");
  return {
    authored: `${base} author:@me`,
    mentioned: `${base} mentions:@me`,
    requested: `${base} user-review-requested:@me`,
    commented: `${base} commenter:@me`,
    reviewed: `${base} reviewed-by:@me`,
  };
}

export function parsePullArgument(value: string, defaultRepo: string | undefined): PullKey | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(value);
  if (url !== null) return { repo: url[1]!, number: Number(url[2]) };
  const key = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
  if (key !== null) return { repo: key[1]!, number: Number(key[2]) };
  if (/^\d+$/.test(value) && defaultRepo !== undefined) return { repo: defaultRepo, number: Number(value) };
  return null;
}

export function reviewThreadTitle(pull: Pick<PullDetail, "repo" | "number" | "title">): string {
  return truncate(`Review ${pull.repo.slice(pull.repo.indexOf("/") + 1)}#${pull.number}: ${pull.title}`, TITLE_LIMIT);
}

export function summaryPrompt(pull: PullDetail): string {
  const body = pull.body.trim().length === 0 ? "(no description)" : truncate(pull.body.trim(), BODY_LIMIT);
  const files = pull.files.slice(0, 60).map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`);
  if (pull.files.length > files.length) files.push(`- …and ${pull.files.length - files.length} more`);
  return [
    `You are the review thread for ${pullKey(pull)} "${pull.title}" by @${pull.author.login}: ${pull.url}`,
    `Branch ${pull.headRefName} into ${pull.baseRefName}, +${pull.additions}/-${pull.deletions} across ${pull.files.length} files.`,
    "",
    "PR description:",
    body,
    "",
    "Changed files:",
    ...files,
    "",
    `Summarize this PR very simply for a reviewer. Read the diff with \`gh pr diff ${pull.number} -R ${pull.repo}\`.`,
    "- One or two plain sentences: what changes and why.",
    "- A short list of the main changes, grouped by area, naming the key files.",
    "- Anything that looks risky or deserves a closer look.",
    "Keep it short. Do not review code quality yet; a full review runs next.",
  ].join("\n");
}

export function reviewMessage(pull: Pick<PullDetail, "repo" | "number" | "baseRefName">): string {
  return [
    `${REVIEW_SKILL} review pr ${pull.number} (${pull.repo}).`,
    `The PR head is checked out in this worktree; review its changes against the merge base with ${pull.baseRefName}.`,
    `When the review is done, call the ${FINDINGS_TOOL} tool once with every finding: the repository-relative file path,`,
    `the line range on the PR's new code (side "additions") or on removed code (side "deletions"), a severity, a one-line title, and the explanation.`,
  ].join(" ");
}

export function askMessage(
  pull: Pick<PullDetail, "repo" | "number" | "headSha" | "mergeBaseSha">,
  target: { path: string; side: "additions" | "deletions"; startLine: number; endLine: number },
  code: string | null,
  question: string,
): string {
  const lines = target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}-${target.endLine}`;
  const version =
    target.side === "additions" ? `the PR head ${pull.headSha.slice(0, 12)}` : `the merge base ${pull.mergeBaseSha.slice(0, 12)}`;
  return [
    `Question from the PR Board diff about ${target.path} ${lines} at ${version}:`,
    ...(code === null ? [] : ["", "```", code, "```"]),
    "",
    question,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PluginDeps {
  run: Runner;
  pollMs: number;
  now: () => number;
}

const findingInputSchema = z.object({
  path: z.string().min(1).max(1024),
  side: sideSchema.default("additions"),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  severity: severitySchema,
  title: z.string().min(1).max(300),
  body: z.string().max(10_000),
});

function normalizeFindingPath(path: string, worktree: string | null): string {
  const withoutRoot = worktree !== null && path.startsWith(`${worktree}/`) ? path.slice(worktree.length + 1) : path;
  return withoutRoot.replace(/^(\.\/|\/)+/, "");
}

export function createPlugin(deps: PluginDeps) {
  return function plugin(bb: BbPluginApi): void {
    const settings = bb.settings.define({
      repos: {
        type: "string",
        label: "Repositories",
        description: 'Optional comma-separated "owner/repo" list that limits the board. Empty shows your PRs from every repository.',
        default: "",
      },
      reviewProject: {
        type: "project",
        label: "Review project",
        description: "Project that review threads start in when no project's git remote matches the PR's repository.",
      },
      reviewModel: {
        type: "string",
        label: "Review model",
        description: "Claude Code model new review threads run on. `bb provider models claude-code` lists the ids. Empty uses the project's default.",
        default: "claude-opus-5-5",
      },
      reviewReasoning: {
        type: "select",
        label: "Review reasoning effort",
        description: "Reasoning effort of new review threads.",
        options: [...REASONING_LEVELS],
        default: "high",
      },
      reviewPermissionMode: {
        type: "select",
        label: "Review permission mode",
        description: '"auto" is Approve for me, "accept-edits" is Accept Edits, and "full" is Full Access.',
        options: [...PERMISSION_MODES],
        default: "auto",
      },
    });
    const store = createStore(bb.storage);
    const disposed = new AbortController();
    bb.onDispose(() => disposed.abort());

    const resolvedTools = new Map<string, Promise<string | null>>();
    function resolveTool(name: "gh" | "gopls"): Promise<string | null> {
      let pending = resolvedTools.get(name);
      if (pending === undefined) {
        pending = (async () => {
          for (const candidate of TOOL_CANDIDATES[name]) {
            try {
              await deps.run(candidate, ["version"], { timeoutMs: 15_000 });
              return candidate;
            } catch {
              continue;
            }
          }
          return null;
        })();
        resolvedTools.set(name, pending);
      }
      return pending;
    }

    const gh: Gh = async (args, options = {}) => {
      const path = await resolveTool("gh");
      if (path === null) throw new Error("gh is not installed or not on PATH");
      return deps.run(path, args, { ...options, timeoutMs: options.timeoutMs ?? 30_000 });
    };
    const github = createGitHub(gh);

    async function repos(): Promise<string[]> {
      return parseRepoList((await settings.get()).repos);
    }

    function publish(pull: PullKey): void {
      bb.realtime.publish(UPDATES_CHANNEL, { repo: pull.repo, number: pull.number });
    }

    let viewerCache: Cached<string> | undefined;
    async function viewer(): Promise<string> {
      if (fresh(viewerCache, VIEWER_TTL_MS, deps.now())) return viewerCache.value;
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      viewerCache = { value: login, at: deps.now() };
      return login;
    }

    const boardCache = new Map<string, Cached<PullSnapshot[]>>();
    async function searchPulls(query: string, refresh: boolean): Promise<PullSnapshot[]> {
      const cached = boardCache.get(query);
      if (!refresh && fresh(cached, BOARD_TTL_MS, deps.now())) return cached.value;
      const pulls = await github.searchPulls(query);
      boardCache.set(query, { value: pulls, at: deps.now() });
      return pulls;
    }

    const pullCache = new Map<string, Cached<Promise<PullDetail>>>();
    function pullDetail(pull: PullKey, refresh: boolean): Promise<PullDetail> {
      const key = pullKey(pull);
      const cached = pullCache.get(key);
      if (!refresh && fresh(cached, PULL_TTL_MS, deps.now())) return cached.value;
      const pending = github.pullDetail(pull.repo, pull.number);
      pullCache.set(key, { value: pending, at: deps.now() });
      pending.catch(() => {
        if (pullCache.get(key)?.value === pending) pullCache.delete(key);
      });
      return pending;
    }

    function invalidatePull(pull: PullKey): void {
      pullCache.delete(pullKey(pull));
      boardCache.clear();
    }

    const fileCache = new Map<string, FileContent>();
    let fileCacheBytes = 0;
    async function fileAt(repo: string, sha: string, path: string): Promise<FileContent> {
      const key = `${repo}@${sha}:${path}`;
      const cached = fileCache.get(key);
      if (cached !== undefined) return cached;
      const content = await github.fileAt(repo, sha, path);
      fileCache.set(key, content);
      fileCacheBytes += content.content?.length ?? 0;
      for (const [oldest, entry] of fileCache) {
        if (fileCacheBytes <= FILE_CACHE_BYTES) break;
        fileCache.delete(oldest);
        fileCacheBytes -= entry.content?.length ?? 0;
      }
      return content;
    }

    async function liveThread(threadId: string) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return thread.deletedAt === null && thread.archivedAt === null ? thread : null;
      } catch {
        return null;
      }
    }

    async function reviewThreadFor(pull: PullKey) {
      for (const threadId of store.threadsForPull(pull)) {
        const thread = await liveThread(threadId);
        if (thread !== null) return thread;
      }
      return null;
    }

    async function agentState(pull: PullKey, findings: number): Promise<AgentState> {
      const thread = await reviewThreadFor(pull);
      return {
        threadId: thread?.id ?? null,
        running: thread !== null && (thread.status === "active" || thread.status === "starting"),
        findings,
      };
    }

    async function board(refresh: boolean): Promise<Board> {
      const repoList = await repos();
      const me = await viewer();
      const errors: Board["errors"] = [];
      const queries = boardQueries(repoList);
      const search = (query: string) =>
        searchPulls(query, refresh).catch((error: unknown): PullSnapshot[] => {
          errors.push({ search: query, message: errorMessage(error) });
          return [];
        });
      const [authored, mentioned, requested, commented, reviewed] = await Promise.all([
        search(queries.authored),
        search(queries.mentioned),
        search(queries.requested),
        search(queries.commented),
        search(queries.reviewed),
      ]);
      const mentionedKeys = new Set(mentioned.map(pullKey));
      const requestedKeys = new Set(requested.map(pullKey));
      const pulls = new Map<string, PullSnapshot>();
      for (const pull of [...authored, ...mentioned, ...requested]) pulls.set(pullKey(pull), pull);
      for (const pull of [...commented, ...reviewed]) {
        if (isAwaitingReplyFrom(pull, me)) pulls.set(pullKey(pull), pull);
      }
      const findingCounts = store.findingCounts();
      const cards = await Promise.all(
        [...pulls.values()].map(
          async (pull): Promise<BoardCard> => ({
            repo: pull.repo,
            number: pull.number,
            title: pull.title,
            url: pull.url,
            column: columnFor(pull),
            author: { login: pull.author?.login ?? "ghost", avatarUrl: pull.author?.avatarUrl ?? null },
            createdAt: pull.createdAt,
            updatedAt: pull.updatedAt,
            headRefName: pull.headRefName,
            baseRefName: pull.baseRefName,
            additions: pull.additions,
            deletions: pull.deletions,
            changedFiles: pull.changedFiles,
            checks: pull.checks,
            reviewers: reviewersOf(pull),
            humanComments: humanFeedbackCount(pull),
            unresolvedThreads: pull.unresolvedThreads,
            isAuthor: pull.author?.login === me,
            isMentioned: mentionedKeys.has(pullKey(pull)),
            isRequested: requestedKeys.has(pullKey(pull)),
            isAwaitingReply: pull.author?.login !== me && isAwaitingReplyFrom(pull, me),
            agent: await agentState(pull, findingCounts.get(pullKey(pull)) ?? 0),
          }),
        ),
      );
      cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const fetchedAt = Math.min(deps.now(), ...Object.values(queries).map((query) => boardCache.get(query)?.at ?? deps.now()));
      return { viewer: me, repos: repoList, fetchedAt: new Date(fetchedAt).toISOString(), cards, errors };
    }

    async function resolveProjectId(repo: string): Promise<string> {
      const projects = await bb.sdk.projects.list();
      const pattern = new RegExp(`[:/]${repo.replaceAll(".", "\\.")}(\\.git)?/?$`, "i");
      const match = projects.find((project) => project.gitRemoteUrl !== null && pattern.test(project.gitRemoteUrl));
      if (match !== undefined) return match.id;
      const { reviewProject } = await settings.get();
      if (typeof reviewProject === "string" && reviewProject.length > 0) return reviewProject;
      throw new Error(`No bb project has ${repo} as its git remote. Set the PR Board "Review project" setting.`);
    }

    async function serverHostId(): Promise<string> {
      const { primaryHostId } = await bb.sdk.system.config();
      if (primaryHostId === null) throw new Error("bb has no server machine to create the review worktree on.");
      return primaryHostId;
    }

    async function worktree(threadId: string, waitUntil: number | null): Promise<{ id: string; path: string } | null> {
      const hostId = await serverHostId();
      for (;;) {
        const thread = await liveThread(threadId);
        if (thread === null) return null;
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (environment.status === "ready" && environment.path !== null) {
            return environment.hostId === hostId ? { id: environment.id, path: environment.path } : null;
          }
          if (environment.status !== "creating" && environment.status !== "provisioning") return null;
        }
        if (waitUntil === null || deps.now() >= waitUntil || disposed.signal.aborted) return null;
        await sleep(deps.pollMs);
      }
    }

    async function checkout(path: string, pull: PullDetail): Promise<void> {
      const args = ["pr", "checkout", String(pull.number), "-R", pull.repo];
      try {
        await gh(args, { timeoutMs: 120_000, cwd: path });
      } catch (error) {
        bb.log.info(`gh pr checkout ${pull.number} failed (${errorMessage(error)}); retrying as review/pr-${pull.number}`);
        await gh([...args, "--branch", `review/pr-${pull.number}`, "--force"], { timeoutMs: 120_000, cwd: path });
      }
    }

    async function sendReview(threadId: string, pull: PullDetail): Promise<"sent" | "queued"> {
      const result = await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: reviewMessage(pull), mentions: [] }],
      });
      publish(pull);
      return result.delivery;
    }

    async function prepareAndReview(threadId: string, pull: PullDetail): Promise<void> {
      const environment = await worktree(threadId, deps.now() + ENVIRONMENT_TIMEOUT_MS);
      if (environment === null) {
        bb.log.warn(`the worktree for ${threadId} was not ready; sending the review without gh pr checkout`);
      } else {
        await checkout(environment.path, pull).catch((error: unknown) =>
          bb.log.warn(`could not check out ${pullKey(pull)} in ${environment.path}: ${errorMessage(error)}`),
        );
      }
      if (!disposed.signal.aborted) await sendReview(threadId, pull);
    }

    async function reviewExecution() {
      const { reviewModel, reviewReasoning, reviewPermissionMode } = await settings.get();
      const model = reviewModel.trim();
      const explicit = "explicit" as const;
      return {
        providerId: REVIEW_PROVIDER_ID,
        ...(model.length === 0 ? {} : { model }),
        reasoningLevel: z.enum(REASONING_LEVELS).catch("high").parse(reviewReasoning),
        permissionMode: z.enum(PERMISSION_MODES).catch("auto").parse(reviewPermissionMode),
        executionInputSources: {
          providerId: explicit,
          ...(model.length === 0 ? {} : { model: explicit }),
          reasoningLevel: explicit,
          permissionMode: explicit,
        },
      };
    }

    const opening = new Map<string, Promise<{ threadId: string; created: boolean }>>();
    async function openReviewOnce(pull: PullKey): Promise<{ threadId: string; created: boolean }> {
      const existing = await reviewThreadFor(pull);
      if (existing !== null) return { threadId: existing.id, created: false };
      const detail = await pullDetail(pull, true);
      if (detail.state !== "OPEN") throw new Error(`${pullKey(pull)} is ${detail.state.toLowerCase()}, not open`);
      const [projectId, hostId, execution] = await Promise.all([resolveProjectId(pull.repo), serverHostId(), reviewExecution()]);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: {
          type: "provider",
          environmentProviderId: WORKTREE_PROVIDER_ID,
          machine: { type: "existing", hostId },
          inputs: { branch: detail.isCrossRepository ? { kind: "default" } : { kind: "named", name: `origin/${detail.headRefName}` } },
        },
        ...execution,
        title: reviewThreadTitle(detail),
        prompt: summaryPrompt(detail),
        pluginMetadata: { repo: pull.repo, number: pull.number },
      });
      store.recordThread(thread.id, pull, deps.now());
      publish(pull);
      void prepareAndReview(thread.id, detail).catch((error: unknown) =>
        bb.log.warn(`could not start the review of ${pullKey(pull)} in ${thread.id}: ${errorMessage(error)}`),
      );
      bb.log.info(`started review thread ${thread.id} for ${pullKey(pull)}`);
      return { threadId: thread.id, created: true };
    }

    function openReview(pull: PullKey): Promise<{ threadId: string; created: boolean }> {
      const key = pullKey(pull);
      let pending = opening.get(key);
      if (pending === undefined) {
        pending = openReviewOnce(pull).finally(() => opening.delete(key));
        opening.set(key, pending);
      }
      return pending;
    }

    async function runReview(pull: PullKey): Promise<{ threadId: string; delivery: "sent" | "queued" }> {
      const { threadId, created } = await openReview(pull);
      if (created) return { threadId, delivery: "queued" };
      return { threadId, delivery: await sendReview(threadId, await pullDetail(pull, false)) };
    }

    async function reviewState(pull: PullKey) {
      const findings = store.findings(pull);
      return {
        agent: await agentState(pull, findings.filter((finding) => !finding.dismissed).length),
        findings,
        drafts: store.drafts(pull),
      };
    }

    const externalFiles = new Set<string>();
    async function definition(input: z.infer<(typeof rpcContract)["definition"]["input"]>) {
      const thread = await reviewThreadFor(input);
      const environment = thread === null ? null : await worktree(thread.id, null);
      if (environment === null) {
        return {
          symbol: input.symbol,
          source: "search" as const,
          definitions: [],
          message:
            thread === null
              ? "Go to definition needs the review thread's worktree. Open the review thread first."
              : "The review worktree is still being prepared. Try again in a moment.",
        };
      }
      const detail = await pullDetail(input, false);
      const head = (await deps.run("git", ["rev-parse", "HEAD"], { cwd: environment.path, timeoutMs: 15_000 })).trim();
      const result = await findDefinitions(deps.run, await resolveTool("gopls"), {
        worktree: environment.path,
        sha: input.sha,
        atHead: input.sha === detail.headSha && head === detail.headSha,
        path: input.path,
        line: input.line,
        character: input.character,
        symbol: input.symbol,
      });
      for (const found of result.definitions) if (found.external) externalFiles.add(found.path);
      return result;
    }

    async function externalFile(path: string): Promise<FileContent> {
      if (!externalFiles.has(path)) throw new Error("That file was not returned by a definition lookup.");
      const info = await stat(path).catch(() => null);
      if (info === null) return { content: null, unavailable: "missing" };
      if (info.size > MAX_EXTERNAL_BYTES) return { content: null, unavailable: "too-large" };
      const content = await readFile(path, "utf8");
      return content.includes("\u0000") ? { content: null, unavailable: "binary" } : { content, unavailable: null };
    }

    bb.rpc.register(rpcContract, {
      board: ({ refresh }) => board(refresh),
      pull: ({ repo, number, refresh }) => pullDetail({ repo, number }, refresh),
      fileAt: ({ repo, sha, path }) => fileAt(repo, sha, path),
      externalFile: ({ path }) => externalFile(path),
      reviewState: (pull) => reviewState(pull),
      pullForThread: ({ threadId }) => store.pullForThread(threadId),
      openReview: (pull) => openReview(pull),
      runReview: (pull) => runReview(pull),
      definition: (input) => definition(input),
      saveDraft: ({ repo, number, ...draft }) => {
        const saved = store.saveDraft({ repo, number }, draft, deps.now());
        publish({ repo, number });
        return saved;
      },
      deleteDraft: ({ id }) => {
        const pull = store.deleteDraft(id);
        if (pull !== null) publish(pull);
        return {};
      },
      submitReview: async ({ repo, number, headSha, event, body }) => {
        const pull = { repo, number };
        const comments = store.drafts(pull);
        const url = await github.submitReview(repo, number, { headSha, event, body, comments });
        store.clearDrafts(pull);
        invalidatePull(pull);
        publish(pull);
        return { url, comments: comments.length };
      },
      postComment: async ({ repo, number, headSha, body, ...target }) => {
        await github.postComment(repo, number, headSha, target, body);
        invalidatePull({ repo, number });
        publish({ repo, number });
        return {};
      },
      reply: async ({ repo, number, commentId, body }) => {
        await github.reply(repo, number, commentId, body);
        invalidatePull({ repo, number });
        publish({ repo, number });
        return {};
      },
      resolveThread: async ({ repo, number, threadId, resolved }) => {
        await github.resolveThread(threadId, resolved);
        invalidatePull({ repo, number });
        publish({ repo, number });
        return {};
      },
      setViewed: async ({ repo, number, pullNodeId, path, viewed }) => {
        await github.setViewed(pullNodeId, path, viewed);
        pullCache.delete(pullKey({ repo, number }));
        return {};
      },
      askAgent: async ({ repo, number, question, ...target }) => {
        const pull = { repo, number };
        const [{ threadId }, detail] = await Promise.all([openReview(pull), pullDetail(pull, false)]);
        const file = detail.files.find((candidate) => candidate.path === target.path);
        const sourcePath = target.side === "deletions" ? (file?.previousPath ?? target.path) : target.path;
        const source = await fileAt(repo, target.side === "additions" ? detail.headSha : detail.mergeBaseSha, sourcePath).catch(() => null);
        const code = source?.content?.split("\n").slice(target.startLine - 1, target.endLine).join("\n") ?? null;
        const result = await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text: askMessage(detail, target, code, question), mentions: [] }],
        });
        publish(pull);
        return { threadId, delivery: result.delivery };
      },
      dismissFinding: ({ id, dismissed }) => {
        const pull = store.dismissFinding(id, dismissed);
        if (pull !== null) publish(pull);
        return {};
      },
    });

    bb.agents.registerTool({
      name: FINDINGS_TOOL,
      description:
        "Record the findings of a code review of this thread's pull request so PR Board highlights them in the user's diff view. Each call replaces the findings recorded before unless replace is false.",
      instructions: `This thread reviews a pull request for PR Board. After a code review, call ${FINDINGS_TOOL} once with every finding, using repository-relative paths and line numbers from the PR's head (side "additions") or base (side "deletions").`,
      presentation: { label: { pending: "Recording review findings", completed: "Recorded review findings" } },
      parameters: z.object({
        findings: z.array(findingInputSchema).max(200),
        replace: z.boolean().default(true),
      }),
      async execute({ findings, replace }, { threadId }) {
        const pull = store.pullForThread(threadId);
        if (pull === null) {
          return { content: [{ type: "text", text: "This thread is not a PR Board review thread." }], isError: true };
        }
        const environment = await worktree(threadId, null).catch(() => null);
        const headSha = await pullDetail(pull, false)
          .then((detail) => detail.headSha)
          .catch(() => null);
        store.recordFindings(
          threadId,
          pull,
          headSha,
          findings.map((finding) => {
            const startLine = finding.startLine ?? finding.endLine ?? null;
            const endLine = finding.endLine ?? finding.startLine ?? null;
            return {
              path: normalizeFindingPath(finding.path, environment?.path ?? null),
              side: finding.side,
              startLine: startLine !== null && endLine !== null ? Math.min(startLine, endLine) : null,
              endLine: startLine !== null && endLine !== null ? Math.max(startLine, endLine) : null,
              severity: finding.severity,
              title: finding.title,
              body: finding.body,
            };
          }),
          replace,
        );
        publish(pull);
        return `Recorded ${findings.length} finding${findings.length === 1 ? "" : "s"} for ${pullKey(pull)}. They are highlighted in PR Board's diff view.`;
      },
    });

    bb.agents.configure((context) => {
      const { repo, number } = context.pluginMetadata;
      const isReviewThread = typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && typeof number === "number";
      return { tools: isReviewThread ? [FINDINGS_TOOL] : [], skills: [SKILL_NAME] };
    });

    const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;
    const pullPositional = [
      { name: "pull", description: "PR number (first configured repo), owner/repo#n, or PR URL", required: true },
    ] as const;

    async function pullArgument(value: string): Promise<PullKey> {
      const pull = parsePullArgument(value, (await repos())[0]);
      if (pull !== null) return pull;
      throw new PluginCliError(`"${value}" is not a PR number, owner/repo#n, or PR URL`, {
        code: "invalid_pull",
        hint: "For example `bb pr-board open 596` or `bb pr-board open private-tech-inc/hss#596`.",
      });
    }

    const output = (json: boolean | undefined, value: unknown, lines: string[]) => ({
      exitCode: 0,
      stdout: json === true ? `${JSON.stringify(value)}\n` : lines.map((line) => `${line}\n`).join(""),
    });

    bb.cli.register(
      defineCli({
        name: "pr-board",
        summary: "Kanban board of open PRs, agent review threads, and their recorded review findings",
        commands: {
          board: cliCommand({
            summary: "List your open PRs, PRs that mention you or request your review, and PRs awaiting a reply to your comment, by board column",
            options: { ...jsonOption, refresh: { type: "boolean", description: "Bypass the 30 second cache" } },
            async run(input) {
              const result = await board(input.options.refresh === true);
              return output(input.options.json, result, [
                ...result.cards.map((card) =>
                  [card.column, pullKey(card), card.author.login, card.agent.threadId ?? "-", card.title].join("\t"),
                ),
                ...result.errors.map((error) => `error\t${error.search}\t${error.message}`),
              ]);
            },
          }),
          open: cliCommand({
            summary: "Find or start a PR's review thread; a new thread summarizes the PR and then runs the review",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const result = await openReview(await pullArgument(input.positionals.pull));
              return output(input.options.json, result, [`${result.created ? "started" : "existing"}\t${result.threadId}`]);
            },
          }),
          review: cliCommand({
            summary: "Run the thermo-nuclear code quality review again in a PR's review thread",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const result = await runReview(await pullArgument(input.positionals.pull));
              return output(input.options.json, result, [`${result.delivery}\t${result.threadId}`]);
            },
          }),
          findings: cliCommand({
            summary: "List the review findings recorded for a PR",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const findings = store.findings(await pullArgument(input.positionals.pull));
              return output(
                input.options.json,
                findings,
                findings.map((finding) =>
                  [
                    finding.severity,
                    finding.startLine === null ? finding.path : `${finding.path}:${finding.startLine}-${finding.endLine}`,
                    finding.side,
                    finding.dismissed ? "dismissed" : "open",
                    finding.title,
                  ].join("\t"),
                ),
              );
            },
          }),
        },
      }),
    );
  };
}

export default createPlugin({ run: runCommand, pollMs: 2_000, now: Date.now });
