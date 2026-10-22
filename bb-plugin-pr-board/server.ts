import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { columnFor, hasTakenPart, humanFeedbackCount, isAwaitingReplyFrom, reviewersOf, unansweredCount, type PullSnapshot } from "./board.js";
import { addressCounts, locateFiles, readAddressChanges, readDiff, unavailableChanges, type Git } from "./changes.js";
import { UPDATES_CHANNEL } from "./channel.js";
import {
  rpcContract,
  severitySchema,
  sideSchema,
  type AddressChanges,
  type AddressCommit,
  type AgentState,
  type Board,
  type BoardCard,
  type ExplainRequest,
  type FileContent,
  type PullDetail,
} from "./contract.js";
import { findDefinitions } from "./definitions.js";
import { createGitHub, detailVersion, runCommand, type Gh, type ListedPull, type Runner } from "./github.js";
import { createGoplsSessions } from "./gopls.js";
import { createStore, type NewFix, type PullKey } from "./store.js";
import {
  FIX_INSTRUCTION,
  RECORD_FIX_TOOL,
  SUGGESTIONS_TOOL,
  addressMessage,
  addressPrompt,
  addressThreadTitle,
  addressableIds,
  previewEdits,
  pullCommentIds,
  pullStack,
  type PullStack,
  submitAddressMessage,
  writePreviews,
} from "./suggestions.js";

export { RECORD_FIX_TOOL, SUGGESTIONS_TOOL, rpcContract };

const WORKTREE_PROVIDER_ID = "git-worktree";
const REVIEW_PROVIDER_ID = "claude-code";
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export const REVIEW_SKILL = "/thermo-nuclear-code-quality-review";
export const FINDINGS_TOOL = "pr_board_record_findings";
export const EXPLAIN_SKILL = "/simple-english";
const SIMPLE_ENGLISH_DIR = "~/.claude/skills/simple-english";
const SIMPLE_ENGLISH_LINT = `python3 ${SIMPLE_ENGLISH_DIR}/scripts/ste_lint.py`;
export const EXPLAIN_LINT = `${SIMPLE_ENGLISH_LINT} --type reply --gate`;
export const FINDINGS_LINT = `${SIMPLE_ENGLISH_LINT} --type descriptive --gate`;
const SKILL_NAME = "pr-board";
const LIST_TTL_MS = 50_000;
const DETAIL_REFRESH_MS = 15 * 60_000;
const PULL_TTL_MS = 50_000;
const WARM_DELAY_MS = 1_000;
const VIEWER_TTL_MS = 60 * 60_000;
const FILE_CACHE_BYTES = 64 * 1024 * 1024;
const ENVIRONMENT_TIMEOUT_MS = 5 * 60_000;
const BODY_LIMIT = 4_000;
const TITLE_LIMIT = 120;
const MAX_EXTERNAL_BYTES = 2 * 1024 * 1024;
const CHANGES_TTL_MS = 3_000;
const CARD_CHANGES_CONCURRENCY = 4;

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
    involved: `${base} involves:@me sort:updated-desc`,
    requested: `${base} user-review-requested:@me sort:updated-desc`,
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
    `Each title and explanation becomes a review comment on the PR, so write them in Simple English:`,
    `read ${SIMPLE_ENGLISH_DIR}/SKILL.md and follow its Document rules (plain words, short sentences, active voice, terms defined at first use, no bold, no em-dashes).`,
    `Make each title one short plain sentence.`,
    `Before you call the tool, write every title and explanation to one file in $TMPDIR and run \`${FINDINGS_LINT} <file>\`.`,
    `Fix what it counts and run it again until it exits 0.`,
  ].join(" ");
}

export function explainThreadTitle(pull: Pick<PullDetail, "repo" | "number" | "title">): string {
  return truncate(`Explain ${pull.repo.slice(pull.repo.indexOf("/") + 1)}#${pull.number}: ${pull.title}`, TITLE_LIMIT);
}

export function explainPrompt(pull: PullDetail): string {
  const body = pull.body.trim().length === 0 ? "(no description)" : truncate(pull.body.trim(), BODY_LIMIT);
  return [
    `${EXPLAIN_SKILL} Follow this skill's Reply rules for every answer you write in this thread.`,
    "",
    `You are the explain thread for ${pullKey(pull)} "${pull.title}" by @${pull.author.login}: ${pull.url}`,
    `Branch ${pull.headRefName} into ${pull.baseRefName}, +${pull.additions}/-${pull.deletions} across ${pull.files.length} files. Head commit ${pull.headSha}.`,
    "",
    "PR description:",
    body,
    "",
    "The user sends you parts of this PR: code from the diff, the description, comments, review comments, or review findings.",
    "Help the user understand what each part means.",
    `- Read the diff with \`gh pr diff ${pull.number} -R ${pull.repo}\`. Read a whole file at the PR head with \`gh api 'repos/${pull.repo}/contents/<path>?ref=${pull.headSha}' -H 'Accept: application/vnd.github.raw'\`.`,
    "- Start with the plain meaning in one or two sentences. Then say why it matters in this PR.",
    "- Define each technical term once, in plain words. Do not assume the user knows the codebase.",
    `- Before you send each answer, write the draft to a file in $TMPDIR and run \`${EXPLAIN_LINT} <file>\`. It exits 1 and counts each em-dash, bold span, header, and bullet. Fix each one and run it again until it exits 0.`,
    "- Explain the quoted text. Do not rewrite it unless the user asks.",
    "- Do not edit files, check out branches, or post anything to GitHub.",
    "",
    "Reply now with one short sentence that says you are ready. Do not read the diff yet.",
  ].join("\n");
}

const EXPLAIN_SOURCES: Record<ExplainRequest["source"], string> = {
  code: "Code from the diff",
  description: "The PR description",
  comment: "A PR comment",
  "review-comment": "A review comment",
  finding: "A review finding",
  other: "Text from the PR page",
};

function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function explainMessage(request: ExplainRequest): string {
  const fence = fenceFor(request.quote);
  const question = request.question.trim();
  return [
    `${EXPLAIN_SOURCES[request.source]}: ${request.label}`,
    "",
    fence,
    request.quote,
    fence,
    "",
    question.length === 0 ? "What does this mean, and why is it here?" : question,
    "",
    `(Before you reply, write your draft to a file in $TMPDIR and run \`${EXPLAIN_LINT} <file>\` until it exits 0.)`,
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

const suggestionInputSchema = z.object({
  commentId: z.string().min(1),
  summary: z.string().min(1).max(300),
  reply: z.string().max(65_000).nullable().optional(),
  changes: z
    .array(z.object({ path: z.string().min(1).max(1024), find: z.string().max(200_000), replace: z.string().max(200_000) }))
    .max(30)
    .default([]),
});

const findingInputSchema = z.object({
  path: z.string().min(1).max(1024),
  side: sideSchema.default("additions"),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  severity: severitySchema,
  title: z.string().min(1).max(300),
  body: z.string().max(10_000),
});

const fixInputSchema = z.object({
  commentId: z.string().min(1),
  files: z.array(z.string().min(1).max(1024)).min(1).max(100),
  summary: z.string().min(1).max(300),
});

function normalizeFindingPath(path: string, worktree: string | null): string {
  const withoutRoot = worktree !== null && path.startsWith(`${worktree}/`) ? path.slice(worktree.length + 1) : path;
  return withoutRoot.replace(/^(\.\/|\/)+/, "");
}

function toolError(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

function addressesLabel(commentIds: readonly string[]): string {
  return commentIds.length === 0 ? "" : `\taddresses ${commentIds.join(", ")}`;
}

function commitSection(title: string, commits: readonly AddressCommit[]): string[] {
  return [
    `${title} (${commits.length})`,
    ...commits.flatMap((commit) => [
      `  ${commit.shortSha}\t${commit.subject}${addressesLabel(commit.commentIds)}`,
      ...commit.files.map((file) => `    ${file.status}\t${file.path}`),
    ]),
  ];
}

export function changesLines(changes: AddressChanges): string[] {
  if (!changes.available) return [changes.reason ?? "The address thread's worktree is not available."];
  return [
    `Uncommitted (${changes.uncommitted.length})`,
    ...changes.uncommitted.map((file) => `  ${file.status}\t${file.path}${addressesLabel(file.commentIds)}`),
    ...commitSection("Committed, not pushed", changes.unpushed),
    ...commitSection("Pushed", changes.pushed),
  ];
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

    const changesCache = new Map<string, Cached<Promise<AddressChanges>>>();
    function publish(pull: PullKey): void {
      changesCache.delete(pullKey(pull));
      bb.realtime.publish(UPDATES_CHANNEL, { repo: pull.repo, number: pull.number });
    }

    let viewerCache: Cached<string> | undefined;
    async function viewer(): Promise<string> {
      if (fresh(viewerCache, VIEWER_TTL_MS, deps.now())) return viewerCache.value;
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      viewerCache = { value: login, at: deps.now() };
      return login;
    }

    interface Listing {
      key: string;
      involved: ListedPull[];
      requested: ListedPull[];
      errors: Board["errors"];
    }
    let listing: Cached<Listing> | undefined;
    const snapshots = new Map<string, Cached<PullSnapshot>>();
    const stalePulls = new Map<string, number>();
    let invalidations = 0;

    async function listBoard(queries: ReturnType<typeof boardQueries>, refresh: boolean): Promise<Cached<Listing>> {
      const key = JSON.stringify(queries);
      const previous = listing?.value.key === key ? listing.value : undefined;
      if (!refresh && previous !== undefined && fresh(listing, LIST_TTL_MS, deps.now())) return listing;
      const startedAt = deps.now();
      const generation = invalidations;
      const errors: Board["errors"] = [];
      const list = (query: string, fallback: ListedPull[] | undefined) =>
        github.listPulls(query).catch((error: unknown): ListedPull[] => {
          errors.push({ search: query, message: errorMessage(error) });
          return fallback ?? [];
        });
      const [involved, requested] = await Promise.all([
        list(queries.involved, previous?.involved),
        list(queries.requested, previous?.requested),
      ]);
      const result = { value: { key, involved, requested, errors }, at: startedAt };
      listing = generation === invalidations ? result : { ...result, at: Number.NEGATIVE_INFINITY };
      return result;
    }

    async function boardSnapshots(listed: readonly ListedPull[], refresh: boolean): Promise<{ pulls: PullSnapshot[]; errors: Board["errors"] }> {
      const now = deps.now();
      const seen = invalidations;
      const errors: Board["errors"] = [];
      const clearStale = (key: string) => {
        if ((stalePulls.get(key) ?? Number.POSITIVE_INFINITY) <= seen) stalePulls.delete(key);
      };
      const needed = listed
        .filter((entry) => {
          const known = snapshots.get(entry.id);
          return (
            refresh ||
            known === undefined ||
            entry.updatedAt > known.value.updatedAt ||
            now - known.at >= DETAIL_REFRESH_MS ||
            stalePulls.has(pullKey(known.value))
          );
        })
        .map((entry) => entry.id);
      if (needed.length > 0) {
        const fetched = await github.pullSnapshots(needed);
        for (const pull of fetched.pulls) {
          snapshots.set(pull.id, { value: pull, at: now });
          clearStale(pullKey(pull));
        }
        for (const message of fetched.errors) errors.push({ search: "PR details", message });
      }
      const ids = new Set(listed.map((entry) => entry.id));
      for (const id of snapshots.keys()) if (!ids.has(id)) snapshots.delete(id);
      const pulls = listed.flatMap((entry) => {
        const known = snapshots.get(entry.id);
        return known === undefined ? [] : [{ ...known.value, checks: entry.checks }];
      });
      const shown = new Set(pulls.map(pullKey));
      for (const key of [...stalePulls.keys()]) if (!shown.has(key)) clearStale(key);
      return { pulls, errors };
    }

    interface KnownPull {
      detail: PullDetail;
      version: string;
      checkedAt: number;
    }
    const knownPulls = new Map<string, KnownPull>();
    const pullRuns = new Map<string, Promise<PullDetail>>();

    function knownPull(pull: PullKey): KnownPull | undefined {
      const key = pullKey(pull);
      const known = knownPulls.get(key);
      if (known !== undefined) return known;
      const saved = store.pullDetail(pull);
      if (saved === null) return undefined;
      const loaded = { ...saved, checkedAt: Number.NEGATIVE_INFINITY };
      knownPulls.set(key, loaded);
      return loaded;
    }

    function boardSaysUnchanged(pull: PullKey, detail: PullDetail): boolean {
      if (listing === undefined || !fresh(listing, LIST_TTL_MS, deps.now())) return false;
      const snapshot = [...snapshots.values()].find((entry) => pullKey(entry.value) === pullKey(pull));
      if (snapshot === undefined) return false;
      const listed = [...listing.value.involved, ...listing.value.requested].find((entry) => entry.id === snapshot.value.id);
      return listed !== undefined && listed.updatedAt === detail.updatedAt;
    }

    async function loadPull(pull: PullKey, refresh: boolean): Promise<PullDetail> {
      const generation = invalidations;
      const known = refresh ? undefined : knownPull(pull);
      if (known !== undefined) {
        if (deps.now() - known.checkedAt < PULL_TTL_MS) return known.detail;
        if (boardSaysUnchanged(pull, known.detail) || (await github.pullVersion(pull.repo, pull.number)) === known.version) {
          if (generation === invalidations) known.checkedAt = deps.now();
          return known.detail;
        }
      }
      const detail = await github.pullDetail(pull.repo, pull.number);
      const version = detailVersion(detail);
      knownPulls.set(pullKey(pull), { detail, version, checkedAt: generation === invalidations ? deps.now() : Number.NEGATIVE_INFINITY });
      store.savePullDetail(pull, version, detail);
      return detail;
    }

    function pullDetail(pull: PullKey, refresh: boolean): Promise<PullDetail> {
      const key = pullKey(pull);
      const running = pullRuns.get(key);
      if (running !== undefined && !refresh) return running;
      const run = loadPull(pull, refresh).finally(() => {
        if (pullRuns.get(key) === run) pullRuns.delete(key);
      });
      pullRuns.set(key, run);
      return run;
    }

    function invalidatePull(pull: PullKey): void {
      const known = knownPulls.get(pullKey(pull));
      if (known !== undefined) known.checkedAt = Number.NEGATIVE_INFINITY;
      pullRuns.delete(pullKey(pull));
      invalidations += 1;
      stalePulls.set(pullKey(pull), invalidations);
      if (listing !== undefined) listing = { ...listing, at: Number.NEGATIVE_INFINITY };
      warmBoard();
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

    async function addressThreadFor(pull: PullKey) {
      for (const threadId of store.addressThreadsForPull(pull)) {
        const thread = await liveThread(threadId);
        if (thread !== null) return thread;
      }
      return null;
    }

    async function explainThreadFor(pull: PullKey) {
      for (const threadId of store.explainThreadsForPull(pull)) {
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

    interface BoardSource {
      me: string;
      repoList: string[];
      listed: Cached<Listing>;
      details: { pulls: PullSnapshot[]; errors: Board["errors"] };
    }

    // Board requests that arrive together share one GitHub check.
    let sourceRun: { promise: Promise<BoardSource>; generation: number; refresh: boolean } | null = null;
    function boardSource(refresh: boolean): Promise<BoardSource> {
      if (sourceRun !== null && sourceRun.generation === invalidations && (sourceRun.refresh || !refresh)) return sourceRun.promise;
      const run = { promise: fetchBoardSource(refresh), generation: invalidations, refresh };
      sourceRun = run;
      run.promise
        .finally(() => {
          if (sourceRun === run) sourceRun = null;
        })
        .catch(() => undefined);
      return run.promise;
    }

    async function fetchBoardSource(refresh: boolean): Promise<BoardSource> {
      const repoList = await repos();
      const me = await viewer();
      const listed = await listBoard(boardQueries(repoList), refresh);
      const unique = new Map([...listed.value.involved, ...listed.value.requested].map((entry) => [entry.id, entry]));
      const details = await boardSnapshots([...unique.values()], refresh);
      return { me, repoList, listed, details };
    }

    // Checks GitHub again soon after you act on a PR, so the board is ready when you go back to it.
    let warmTimer: ReturnType<typeof setTimeout> | undefined;
    function warmBoard(): void {
      if (listing === undefined || disposed.signal.aborted) return;
      clearTimeout(warmTimer);
      warmTimer = setTimeout(() => {
        boardSource(false).catch((error: unknown) => bb.log.warn(`could not check the board after an action: ${errorMessage(error)}`));
      }, WARM_DELAY_MS);
    }
    disposed.signal.addEventListener("abort", () => clearTimeout(warmTimer));

    // Builds the cards on every call, so findings, agents, and worktree changes are never older than the request.
    async function board(refresh: boolean): Promise<Board> {
      const { me, repoList, listed, details } = await boardSource(refresh);
      const { involved, requested } = listed.value;
      const involvedIds = new Set(involved.map((entry) => entry.id));
      const requestedIds = new Set(requested.map((entry) => entry.id));
      const errors = [...listed.value.errors, ...details.errors];
      const isMentioned = (pull: PullSnapshot) => involvedIds.has(pull.id) && pull.author?.login !== me && !hasTakenPart(pull, me);
      const pulls = details.pulls.filter(
        (pull) => pull.author?.login === me || requestedIds.has(pull.id) || isMentioned(pull) || isAwaitingReplyFrom(pull, me),
      );
      const findingCounts = store.findingCounts();
      const changeCounts = cardChangeCounts(pulls);
      const cards = await Promise.all(
        pulls.map(
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
            unansweredComments: unansweredCount(pull, me),
            isAuthor: pull.author?.login === me,
            isMentioned: isMentioned(pull),
            isRequested: requestedIds.has(pull.id),
            isAwaitingReply: pull.author?.login !== me && isAwaitingReplyFrom(pull, me),
            agent: await agentState(pull, findingCounts.get(pullKey(pull)) ?? 0),
            address: (await changeCounts).get(pullKey(pull)) ?? null,
          }),
        ),
      );
      cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { viewer: me, repos: repoList, fetchedAt: new Date(listed.at).toISOString(), cards, errors };
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

    async function checkout(path: string, pull: PullDetail, fallbackBranch: string): Promise<void> {
      const args = ["pr", "checkout", String(pull.number), "-R", pull.repo];
      try {
        await gh(args, { timeoutMs: 120_000, cwd: path });
      } catch (error) {
        bb.log.info(`gh pr checkout ${pull.number} failed (${errorMessage(error)}); retrying as ${fallbackBranch}`);
        await gh([...args, "--branch", fallbackBranch, "--force"], { timeoutMs: 120_000, cwd: path });
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

    async function prepareThen(threadId: string, pull: PullDetail, fallbackBranch: string, next: () => Promise<unknown>): Promise<void> {
      const environment = await worktree(threadId, deps.now() + ENVIRONMENT_TIMEOUT_MS);
      if (environment === null) {
        bb.log.warn(`the worktree for ${threadId} was not ready; continuing without gh pr checkout`);
      } else {
        await checkout(environment.path, pull, fallbackBranch).catch((error: unknown) =>
          bb.log.warn(`could not check out ${pullKey(pull)} in ${environment.path}: ${errorMessage(error)}`),
        );
      }
      if (!disposed.signal.aborted) await next();
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

    async function spawnPullThread(detail: PullDetail, title: string, prompt: string, pluginMetadata: Record<string, string | number>) {
      if (detail.state !== "OPEN") throw new Error(`${pullKey(detail)} is ${detail.state.toLowerCase()}, not open`);
      const [projectId, hostId, execution] = await Promise.all([resolveProjectId(detail.repo), serverHostId(), reviewExecution()]);
      return bb.sdk.threads.spawn({
        projectId,
        environment: {
          type: "provider",
          environmentProviderId: WORKTREE_PROVIDER_ID,
          machine: { type: "existing", hostId },
          inputs: { branch: detail.isCrossRepository ? { kind: "default" } : { kind: "named", name: `origin/${detail.headRefName}` } },
        },
        ...execution,
        title,
        prompt,
        pluginMetadata,
      });
    }

    const opening = new Map<string, Promise<{ threadId: string; created: boolean }>>();
    async function openReviewOnce(pull: PullKey): Promise<{ threadId: string; created: boolean }> {
      const existing = await reviewThreadFor(pull);
      if (existing !== null) return { threadId: existing.id, created: false };
      const detail = await pullDetail(pull, true);
      const thread = await spawnPullThread(detail, reviewThreadTitle(detail), summaryPrompt(detail), { repo: pull.repo, number: pull.number });
      store.recordThread(thread.id, pull, deps.now());
      publish(pull);
      void prepareThen(thread.id, detail, `review/pr-${pull.number}`, () => sendReview(thread.id, detail)).catch((error: unknown) =>
        bb.log.warn(`could not start the review of ${pullKey(pull)} in ${thread.id}: ${errorMessage(error)}`),
      );
      bb.log.info(`started review thread ${thread.id} for ${pullKey(pull)}`);
      return { threadId: thread.id, created: true };
    }

    /** The explain thread only reads the PR through `gh`, so it runs in the project's default environment, not on the PR head. */
    const explaining = new Map<string, Promise<{ threadId: string; created: boolean }>>();
    async function openExplainOnce(pull: PullKey): Promise<{ threadId: string; created: boolean }> {
      const existing = await explainThreadFor(pull);
      if (existing !== null) return { threadId: existing.id, created: false };
      const detail = await pullDetail(pull, false);
      const [projectId, execution] = await Promise.all([resolveProjectId(detail.repo), reviewExecution()]);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        ...execution,
        title: explainThreadTitle(detail),
        prompt: explainPrompt(detail),
        pluginMetadata: { repo: pull.repo, number: pull.number, kind: "explain" },
      });
      store.recordExplainThread(thread.id, pull, deps.now());
      publish(pull);
      bb.log.info(`started explain thread ${thread.id} for ${pullKey(pull)}`);
      return { threadId: thread.id, created: true };
    }

    function openExplain(pull: PullKey): Promise<{ threadId: string; created: boolean }> {
      const key = pullKey(pull);
      let pending = explaining.get(key);
      if (pending === undefined) {
        pending = openExplainOnce(pull).finally(() => explaining.delete(key));
        explaining.set(key, pending);
      }
      return pending;
    }

    async function explain(pull: PullKey, request: ExplainRequest): Promise<{ threadId: string; delivery: "sent" | "queued" }> {
      const { threadId } = await openExplain(pull);
      const result = await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: explainMessage(request), mentions: [] }],
      });
      publish(pull);
      return { threadId, delivery: result.delivery };
    }

    async function sendAddress(threadId: string, pull: PullDetail, withList: boolean, stack?: PullStack): Promise<"sent" | "queued"> {
      const result = await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: addressMessage(pull, withList, stack), mentions: [] }],
      });
      publish(pull);
      return result.delivery;
    }

    async function updateAddressWorktree(threadId: string, pull: PullDetail): Promise<void> {
      const environment = await worktree(threadId, null);
      if (environment === null) throw new Error("The address thread's worktree is not available, so it cannot be updated to the PR's new commits.");
      const git = (args: string[], timeoutMs = 30_000) => deps.run("git", args, { cwd: environment.path, timeoutMs });
      const head = async () => (await git(["rev-parse", "HEAD"])).trim();
      if ((await head()) === pull.headSha) return;
      await git(["pull", "--ff-only"], 120_000).catch((error: unknown) => {
        throw new Error(
          `Could not update the address thread's worktree to the PR's latest commit ${pull.headSha.slice(0, 12)}: ${errorMessage(error)}. Submit or undo the accepted changes that conflict, then try again.`,
        );
      });
      const updated = await head();
      if (updated !== pull.headSha) {
        throw new Error(
          `The address thread's worktree is at ${updated.slice(0, 12)} after pulling, not the PR's latest commit ${pull.headSha.slice(0, 12)}. It may hold local commits that are not pushed.`,
        );
      }
      bb.log.info(`updated the address worktree of ${pullKey(pull)} to ${pull.headSha}`);
    }

    type AddressResult = { threadId: string; created: boolean; delivery: "sent" | "queued" };
    const addressing = new Map<string, Promise<AddressResult>>();
    const preparing = new Set<string>();
    async function addressOnce(pull: PullKey): Promise<AddressResult> {
      const detail = await pullDetail(pull, true);
      const existing = await addressThreadFor(pull);
      if (existing !== null && preparing.has(existing.id)) return { threadId: existing.id, created: false, delivery: "queued" };
      if (addressableIds(detail).size === 0) throw new Error("No comments are waiting for your reply, so there is nothing to address.");
      const stack = await github.openPullBranches(pull.repo).then(
        (open) => pullStack(detail, open),
        (error: unknown) => {
          bb.log.warn(`could not read the PR stack of ${pullKey(pull)}: ${errorMessage(error)}`);
          return undefined;
        },
      );
      if (existing !== null) {
        await updateAddressWorktree(existing.id, detail);
        return { threadId: existing.id, created: false, delivery: await sendAddress(existing.id, detail, true, stack) };
      }
      const thread = await spawnPullThread(detail, addressThreadTitle(detail), addressPrompt(detail, stack), {
        repo: pull.repo,
        number: pull.number,
        kind: "address",
      });
      store.recordAddressThread(thread.id, pull, deps.now());
      store.setStartHead(thread.id, detail.headSha);
      publish(pull);
      preparing.add(thread.id);
      void prepareThen(thread.id, detail, `address/pr-${pull.number}`, () => sendAddress(thread.id, detail, false))
        .catch((error: unknown) =>
          bb.log.warn(`could not start addressing the comments of ${pullKey(pull)} in ${thread.id}: ${errorMessage(error)}`),
        )
        .finally(() => preparing.delete(thread.id));
      bb.log.info(`started address thread ${thread.id} for ${pullKey(pull)}`);
      return { threadId: thread.id, created: true, delivery: "queued" };
    }

    function addressComments(pull: PullKey): Promise<AddressResult> {
      const key = pullKey(pull);
      let pending = addressing.get(key);
      if (pending === undefined) {
        pending = addressOnce(pull).finally(() => addressing.delete(key));
        addressing.set(key, pending);
      }
      return pending;
    }

    async function submitAddress(pull: PullKey): Promise<{ threadId: string; delivery: "sent" | "queued" }> {
      const thread = await addressThreadFor(pull);
      if (thread === null) throw new Error("This PR has no address thread yet. Click Address comments first.");
      const environment = await worktree(thread.id, null);
      if (environment === null) throw new Error("The address thread's worktree is not available.");
      const status = await deps.run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: environment.path, timeoutMs: 30_000 });
      const changed = status
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3));
      if (changed.length === 0) throw new Error("The address thread's worktree has no accepted changes to submit.");
      const detail = await pullDetail(pull, true);
      const result = await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "auto",
        input: [{ type: "text", text: submitAddressMessage(detail, changed), mentions: [] }],
      });
      publish(pull);
      return { threadId: thread.id, delivery: result.delivery };
    }

    function worktreeGit(path: string): Git {
      return (args, okExitCodes) => deps.run("git", args, { cwd: path, timeoutMs: 30_000, ...(okExitCodes === undefined ? {} : { okExitCodes }) });
    }

    async function loadAddressChanges(pull: PullKey): Promise<AddressChanges> {
      const thread = await addressThreadFor(pull);
      if (thread === null) return unavailableChanges("This PR has no address thread yet. Click Address comments first.");
      const environment = await worktree(thread.id, null).catch(() => null);
      if (environment === null) return unavailableChanges("The address thread's worktree is not available.");
      const remoteHead = await pullDetail(pull, false).then(
        (detail) => detail.headSha,
        () => null,
      );
      return readAddressChanges(worktreeGit(environment.path), store.fixes(pull, thread.id), store.startHead(thread.id), remoteHead).catch((error: unknown) => {
        bb.log.warn(`could not read the address changes of ${pullKey(pull)}: ${errorMessage(error)}`);
        return unavailableChanges(`Could not read the address thread's worktree: ${errorMessage(error)}`);
      });
    }

    function addressChanges(pull: PullKey, refresh = false): Promise<AddressChanges> {
      const key = pullKey(pull);
      const cached = changesCache.get(key);
      if (!refresh && fresh(cached, CHANGES_TTL_MS, deps.now())) return cached.value;
      const value = loadAddressChanges(pull);
      changesCache.set(key, { value, at: deps.now() });
      value.catch(() => {
        if (changesCache.get(key)?.value === value) changesCache.delete(key);
      });
      return value;
    }

    async function cardChangeCounts(pulls: readonly PullKey[]): Promise<Map<string, BoardCard["address"]>> {
      const queue = pulls.filter((pull) => store.addressThreadsForPull(pull).length > 0);
      const counts = new Map<string, BoardCard["address"]>();
      const worker = async () => {
        for (let pull = queue.shift(); pull !== undefined; pull = queue.shift()) {
          const key = pullKey(pull);
          counts.set(
            key,
            await addressChanges(pull).then(addressCounts, (error: unknown) => {
              bb.log.warn(`could not count the address changes of ${key}: ${errorMessage(error)}`);
              return null;
            }),
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(CARD_CHANGES_CONCURRENCY, queue.length) }, worker));
      return counts;
    }

    async function addressDiff(pull: PullKey, path: string, sha: string | null): Promise<{ patch: string }> {
      const thread = await addressThreadFor(pull);
      const environment = thread === null ? null : await worktree(thread.id, null);
      if (environment === null) throw new Error("The address thread's worktree is not available.");
      const changes = await addressChanges(pull);
      return { patch: await readDiff(worktreeGit(environment.path), changes, path, sha) };
    }

    // Opens VS Code on the server machine, which is the user's machine in bb desktop.
    async function openAddressWorktree(pull: PullKey): Promise<void> {
      const thread = await addressThreadFor(pull);
      const environment = thread === null ? null : await worktree(thread.id, null);
      if (environment === null) throw new Error("The address thread's worktree is not available.");
      const [command, args] = process.platform === "darwin" ? ["open", ["-a", "Visual Studio Code", environment.path]] : ["code", [environment.path]];
      await deps.run(command, args, { timeoutMs: 30_000 }).catch((error: unknown) => {
        throw new Error(`Could not open ${environment.path} in VS Code: ${errorMessage(error)}`);
      });
    }

    async function suggestionTarget(id: string) {
      const found = store.suggestion(id);
      if (found === null) throw new Error("That suggestion no longer exists.");
      return found;
    }

    let applying: Promise<unknown> = Promise.resolve();
    function applySuggestion(id: string): Promise<void> {
      const next = applying.then(async () => {
        const { suggestion, threadId, pull } = await suggestionTarget(id);
        if (suggestion.changeState !== "open") throw new Error("This change was already applied or dismissed.");
        const environment = await worktree(threadId, null);
        if (environment === null) throw new Error("The address thread's worktree is not available, so the change cannot be applied.");
        const files = await previewEdits(environment.path, suggestion.edits).catch((error: unknown) => {
          throw new Error(`This change no longer applies: ${errorMessage(error)}`);
        });
        const baseHead = (await worktreeGit(environment.path)(["rev-parse", "HEAD"])).trim();
        await writePreviews(environment.path, files);
        store.setChangeState(id, "applied");
        store.setStartHead(threadId, baseHead);
        store.recordFixes(
          threadId,
          pull,
          [{ commentId: suggestion.commentId, source: "suggestion", suggestionId: id, files: files.map((file) => file.path), baseHead, summary: suggestion.summary }],
          deps.now(),
        );
        publish(pull);
      });
      applying = next.catch(() => undefined);
      return next;
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
      const [address, explainer] = await Promise.all([addressThreadFor(pull), explainThreadFor(pull)]);
      return {
        agent: await agentState(pull, findings.filter((finding) => !finding.dismissed).length),
        findings,
        drafts: store.drafts(pull),
        addressAgent: {
          threadId: address?.id ?? null,
          running: address !== null && (address.status === "active" || address.status === "starting"),
        },
        suggestions: address === null ? [] : store.suggestions(pull, address.id),
        explainAgent: {
          threadId: explainer?.id ?? null,
          running: explainer !== null && (explainer.status === "active" || explainer.status === "starting"),
        },
      };
    }

    /** Path of a bb project's checkout of `repo` on the server machine, so go to definition works without a review thread. */
    async function localCheckout(repo: string): Promise<string | null> {
      const [projects, hostId] = await Promise.all([bb.sdk.projects.list(), serverHostId().catch(() => null)]);
      const pattern = new RegExp(`[:/]${repo.replaceAll(".", "\\.")}(\\.git)?/?$`, "i");
      const project = projects.find((candidate) => candidate.gitRemoteUrl !== null && pattern.test(candidate.gitRemoteUrl));
      const sources = (project?.sources ?? []).filter((source) => source.hostId === hostId);
      return (sources.find((source) => source.isDefault) ?? sources[0])?.path ?? null;
    }

    const goplsSessions = createGoplsSessions();
    bb.onDispose(() => goplsSessions.dispose());
    const externalFiles = new Set<string>();
    async function definition(input: z.infer<(typeof rpcContract)["definition"]["input"]>) {
      const thread = await reviewThreadFor(input);
      const environment = thread === null ? null : await worktree(thread.id, null);
      const root = environment?.path ?? (await localCheckout(input.repo));
      if (root === null) {
        return {
          symbol: input.symbol,
          source: "search" as const,
          definitions: [],
          message: `Go to definition needs a checkout of ${input.repo}. Add it as a bb project, or click Run review.`,
        };
      }
      const detail = await pullDetail(input, false);
      const head = (await deps.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 })).trim();
      const gopls = await resolveTool("gopls");
      const result = await findDefinitions(deps.run, gopls === null ? null : { path: gopls, sessions: goplsSessions }, {
        worktree: root,
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
      pullForThread: ({ threadId }) =>
        store.pullForThread(threadId) ?? store.pullForAddressThread(threadId) ?? store.pullForExplainThread(threadId),
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
        const known = knownPulls.get(pullKey({ repo, number }));
        if (known !== undefined) {
          known.detail = { ...known.detail, files: known.detail.files.map((file) => (file.path === path ? { ...file, viewed } : file)) };
          store.savePullDetail({ repo, number }, known.version, known.detail);
        }
        return {};
      },
      dismissFinding: ({ id, dismissed }) => {
        const pull = store.dismissFinding(id, dismissed);
        if (pull !== null) publish(pull);
        return {};
      },
      addressComments: (pull) => addressComments(pull),
      suggestionFiles: async ({ id }) => {
        const { suggestion, threadId } = await suggestionTarget(id);
        const environment = await worktree(threadId, null);
        if (environment === null) return { files: [], error: "The address thread's worktree is not available." };
        return previewEdits(environment.path, suggestion.edits).then(
          (files) => ({ files, error: null }),
          (error: unknown) => ({ files: [], error: `This change no longer applies: ${errorMessage(error)}` }),
        );
      },
      applySuggestion: async ({ id }) => {
        await applySuggestion(id);
        return {};
      },
      setSuggestionState: async (input) => {
        const { suggestion, pull } = await suggestionTarget(input.id);
        if (input.part === "reply") store.setReplyState(input.id, input.state);
        else if (suggestion.changeState === "applied") throw new Error("This change was already applied.");
        else store.setChangeState(input.id, input.state);
        publish(pull);
        return {};
      },
      openExplain: (pull) => openExplain(pull),
      explain: ({ repo, number, ...request }) => explain({ repo, number }, request),
      submitAddress: (pull) => submitAddress(pull),
      postConversationComment: async ({ repo, number, body }) => {
        await github.postIssueComment(repo, number, body);
        invalidatePull({ repo, number });
        publish({ repo, number });
        return {};
      },
      addressChanges: ({ repo, number, refresh }) => addressChanges({ repo, number }, refresh === true),
      addressDiff: ({ repo, number, path, sha }) => addressDiff({ repo, number }, path, sha),
      openAddressWorktree: async (pull) => {
        await openAddressWorktree(pull);
        return {};
      },
    });

    async function recordFixes(threadId: string, fixes: ReadonlyArray<z.infer<typeof fixInputSchema>>) {
      const pull = store.pullForAddressThread(threadId);
      if (pull === null) return toolError("This thread is not a PR Board address-comments thread.");
      const environment = await worktree(threadId, null).catch(() => null);
      if (environment === null) return toolError("This thread's worktree is not ready yet. Try again in a moment.");
      const ids = pullCommentIds(await pullDetail(pull, false));
      const changes = await addressChanges(pull, true);
      if (!changes.available || changes.head === null) return toolError(changes.reason ?? "Could not read this thread's worktree.");
      const errors: string[] = [];
      const located = fixes.map((fix, index) => {
        const label = `fix ${index + 1} (${fix.commentId})`;
        const files = [...new Set(fix.files.map((path) => posix.normalize(normalizeFindingPath(path, environment.path))))];
        if (!ids.has(fix.commentId)) errors.push(`${label}: this PR has no code comment thread or conversation comment with that id`);
        const { missing, oldestCommit } = locateFiles(changes, files);
        for (const path of missing) {
          errors.push(`${label}: ${path} has no uncommitted change in this worktree and is not in a commit made here since the address thread started`);
        }
        return { fix, files, oldestCommit };
      });
      if (errors.length > 0) {
        return toolError(`Nothing was recorded. Fix these and call ${RECORD_FIX_TOOL} again with every fix:\n${errors.join("\n")}`);
      }
      const git = worktreeGit(environment.path);
      const head = changes.head;
      const recorded = await Promise.all(
        located.map(async ({ fix, files, oldestCommit }): Promise<NewFix> => ({
          commentId: fix.commentId,
          source: "thread",
          suggestionId: null,
          files,
          baseHead: oldestCommit === null ? head : (await git(["rev-parse", `${oldestCommit}^`])).trim(),
          summary: fix.summary.trim(),
        })),
      );
      store.setStartHead(threadId, recorded[0]?.baseHead ?? head);
      store.recordFixes(threadId, pull, recorded, deps.now());
      publish(pull);
      return `Linked ${recorded.length} fix${recorded.length === 1 ? "" : "es"} to comments on ${pullKey(pull)}. PR Board shows each one under its comment as uncommitted, committed, or pushed.`;
    }

    bb.agents.registerTool({
      name: RECORD_FIX_TOOL,
      description:
        "Link file changes you made in this thread's worktree to the pull request comments they address, so PR Board shows under each comment whether its fix is uncommitted, committed, or pushed.",
      instructions: `This thread addresses a pull request's comments for PR Board. ${FIX_INSTRUCTION} Use the comment ids in brackets from the comment list. Do not call it for edits PR Board applied from an accepted suggestion; those are linked already.`,
      presentation: { label: { pending: "Linking changes to comments", completed: "Linked changes to comments" } },
      parameters: z.object({ fixes: z.array(fixInputSchema).min(1).max(50) }),
      execute: ({ fixes }, { threadId }) => recordFixes(threadId, fixes),
    });

    bb.events.on("thread.idle", ({ thread }) => {
      const pull = store.pullForAddressThread(thread.id);
      if (pull !== null) publish(pull);
    });

    bb.agents.registerTool({
      name: SUGGESTIONS_TOOL,
      description:
        "Record suggested code changes and replies for this thread's pull request comments so PR Board shows them under each comment. Each call replaces the suggestions recorded before unless replace is false.",
      instructions: `This thread addresses the comments of a pull request for PR Board by suggesting changes and replies, without changing files unless the user asks it to. Call ${SUGGESTIONS_TOOL} once with every suggestion, using the comment ids from the comment list.`,
      presentation: { label: { pending: "Recording comment suggestions", completed: "Recorded comment suggestions" } },
      parameters: z.object({
        suggestions: z.array(suggestionInputSchema).max(200),
        replace: z.boolean().default(true),
      }),
      async execute({ suggestions, replace }, { threadId }) {
        const pull = store.pullForAddressThread(threadId);
        if (pull === null) {
          return { content: [{ type: "text", text: "This thread is not a PR Board address-comments thread." }], isError: true };
        }
        const environment = await worktree(threadId, null).catch(() => null);
        if (environment === null) {
          return { content: [{ type: "text", text: "This thread's worktree is not ready yet. Try again in a moment." }], isError: true };
        }
        const ids = addressableIds(await pullDetail(pull, false));
        const errors: string[] = [];
        const normalized = await Promise.all(
          suggestions.map(async (suggestion, index) => {
            const label = `suggestion ${index + 1} (${suggestion.commentId})`;
            const reply = suggestion.reply?.trim() ? suggestion.reply.trim() : null;
            const edits = suggestion.changes.map((change) => ({ ...change, path: posix.normalize(normalizeFindingPath(change.path, environment.path)) }));
            if (!ids.has(suggestion.commentId)) errors.push(`${label}: no unresolved code comment or conversation comment by someone else has that id`);
            if (reply === null && edits.length === 0) errors.push(`${label}: give a reply, changes, or both`);
            for (const edit of edits) if (edit.find === edit.replace) errors.push(`${label}: an edit to ${edit.path} changes nothing`);
            await previewEdits(environment.path, edits).catch((error: unknown) => errors.push(`${label}: ${errorMessage(error)}`));
            return { commentId: suggestion.commentId, summary: suggestion.summary.trim(), reply, edits };
          }),
        );
        if (errors.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Nothing was recorded. Fix these and call ${SUGGESTIONS_TOOL} again with every suggestion, including the ones without errors:\n${errors.join("\n")}`,
              },
            ],
            isError: true,
          };
        }
        store.recordSuggestions(threadId, pull, normalized, replace);
        publish(pull);
        return `Recorded ${normalized.length} suggestion${normalized.length === 1 ? "" : "s"} for ${pullKey(pull)}. PR Board shows them under each comment.`;
      },
    });

    bb.agents.registerTool({
      name: FINDINGS_TOOL,
      description:
        "Record the findings of a code review of this thread's pull request so PR Board highlights them in the user's diff view. Each call replaces the findings recorded before unless replace is false.",
      instructions: `This thread reviews a pull request for PR Board. After a code review, call ${FINDINGS_TOOL} once with every finding, using repository-relative paths and line numbers from the PR's head (side "additions") or base (side "deletions"). Each title and body becomes a PR review comment, so write them by the Document rules in ${SIMPLE_ENGLISH_DIR}/SKILL.md.`,
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
      const { repo, number, kind } = context.pluginMetadata;
      const isPullThread = typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && typeof number === "number";
      const tools = !isPullThread || kind === "explain" ? [] : kind === "address" ? [SUGGESTIONS_TOOL, RECORD_FIX_TOOL] : [FINDINGS_TOOL];
      return { tools, skills: [SKILL_NAME] };
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
            options: { ...jsonOption, refresh: { type: "boolean", description: "Check GitHub now and fetch every PR's details again, instead of reusing the last minute's check and only changed PRs" } },
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
          address: cliCommand({
            summary: "Start or re-run a PR's address-comments thread, which suggests code changes and replies for its comments without changing files",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const result = await addressComments(await pullArgument(input.positionals.pull));
              return output(input.options.json, result, [`${result.created ? "started" : result.delivery}\t${result.threadId}`]);
            },
          }),
          "submit-address": cliCommand({
            summary:
              "Have a PR's address thread run the PR's GitHub Actions checks on its accepted changes, then commit them and push to the PR branch",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const result = await submitAddress(await pullArgument(input.positionals.pull));
              return output(input.options.json, result, [`${result.delivery}\t${result.threadId}`]);
            },
          }),
          suggestions: cliCommand({
            summary: "List the comment suggestions recorded for a PR",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const pull = await pullArgument(input.positionals.pull);
              const thread = await addressThreadFor(pull);
              const suggestions = thread === null ? [] : store.suggestions(pull, thread.id);
              return output(
                input.options.json,
                suggestions,
                suggestions.map((suggestion) =>
                  [
                    suggestion.commentId,
                    suggestion.edits.length === 0 ? "-" : `change:${suggestion.changeState}`,
                    suggestion.reply === null ? "-" : `reply:${suggestion.replyState}`,
                    suggestion.summary,
                  ].join("\t"),
                ),
              );
            },
          }),
          changes: cliCommand({
            summary:
              "List a PR's changes from Address comments in its address thread's worktree: uncommitted files, commits not pushed, and pushed commits, with the comments each one addresses",
            positionals: pullPositional,
            options: jsonOption,
            async run(input) {
              const changes = await addressChanges(await pullArgument(input.positionals.pull), true);
              return output(input.options.json, changes, changesLines(changes));
            },
          }),
        },
      }),
    );
  };
}

export default createPlugin({ run: runCommand, pollMs: 2_000, now: Date.now });
