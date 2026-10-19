import type { AddressChanges, AddressCommit, AddressCounts, ChangeLetter, ChangedFile, CommentFixStatus, FixState } from "./contract.js";
import type { CommentFix } from "./store.js";

export type Git = (args: readonly string[], okExitCodes?: readonly number[]) => Promise<string>;

export interface LoggedCommit {
  sha: string;
  shortSha: string;
  subject: string;
  files: ChangedFile[];
}

interface FileOutcome {
  path: string;
  state: FixState;
  sha: string | null;
}

interface FixOutcome {
  fix: CommentFix;
  state: FixState;
  sha: string | null;
  files: FileOutcome[];
}

interface Lookup {
  head: string;
  dirty: ReadonlySet<string>;
  ours(commit: LoggedCommit): boolean;
  isPushed(sha: string): boolean;
}

const COMMIT_LIMIT = 50;
const FIX_LOG_LIMIT = 200;
const REFLOG_LIMIT = 1_000;
const RECORD = "\u001e";
const FIELD = "\u001f";
const LOG_FORMAT = "--format=%x1e%H%x1f%h%x1f%s";
const LOCAL_COMMIT = /^(commit|cherry-pick|revert|rebase[^:(]*\((pick|reword|edit|squash|fixup)\))/;
const STATE_ORDER: Record<FixState, number> = { uncommitted: 0, committed: 1, pushed: 2, none: 3 };

export function unavailableChanges(reason: string): AddressChanges {
  return { available: false, reason, head: null, upstream: null, uncommitted: [], unpushed: [], pushed: [], comments: [] };
}

export function addressCounts(changes: AddressChanges): AddressCounts | null {
  if (!changes.available) return null;
  return { uncommitted: changes.uncommitted.length, unpushed: changes.unpushed.length, pushed: changes.pushed.length };
}

export function statusLetter(index: string, worktree: string): ChangeLetter {
  if (index === "?" && worktree === "?") return "U";
  if (index === "D" || worktree === "D") return "D";
  if (index === "R" || worktree === "R") return "R";
  if (index === "A" || index === "C") return "A";
  return "M";
}

export function parseStatus(output: string): ChangedFile[] {
  const entries = output.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const [x = " ", y = " "] = entry;
    const moved = "RC".includes(x) || "RC".includes(y);
    const previousPath = moved ? (entries[++index] ?? null) : null;
    files.push({ path: entry.slice(3), previousPath, status: statusLetter(x, y) });
  }
  return files;
}

function nameStatusLetter(code: string): ChangeLetter {
  if (code.startsWith("R")) return "R";
  if (code.startsWith("A") || code.startsWith("C")) return "A";
  if (code.startsWith("D")) return "D";
  return "M";
}

export function parseLog(output: string): LoggedCommit[] {
  return output
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const [header = "", ...lines] = record.split("\n");
      const [sha = "", shortSha = "", subject = ""] = header.split(FIELD);
      const files = lines
        .filter((line) => line.includes("\t"))
        .map((line): ChangedFile => {
          const [code = "", first = "", second] = line.split("\t");
          return second === undefined
            ? { path: first, previousPath: null, status: nameStatusLetter(code) }
            : { path: second, previousPath: first, status: nameStatusLetter(code) };
        });
      return { sha, shortSha, subject, files };
    });
}

export function localCommits(reflog: string): Set<string> {
  return new Set(
    reflog.split("\n").flatMap((line) => {
      const [sha = "", subject = ""] = line.split(FIELD);
      return sha.length > 0 && LOCAL_COMMIT.test(subject) ? [sha] : [];
    }),
  );
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function touches(commit: Pick<LoggedCommit, "files">, path: string): boolean {
  return commit.files.some((file) => file.path === path || file.previousPath === path);
}

function best<T extends { state: FixState }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>((chosen, item) => (chosen === undefined || STATE_ORDER[item.state] <= STATE_ORDER[chosen.state] ? item : chosen), undefined);
}

async function logSince(git: Git, base: string, limit: number, paths: readonly string[] = []): Promise<LoggedCommit[]> {
  const pathspec = paths.length === 0 ? [] : ["--", ...paths];
  return parseLog(await git(["-c", "core.quotePath=false", "log", `--max-count=${limit}`, "-M", "--name-status", LOG_FORMAT, `${base}..HEAD`, ...pathspec]));
}

async function fixLogs(git: Git, fixes: readonly CommentFix[], lookup: Lookup): Promise<Map<string, LoggedCommit[]>> {
  const logs = new Map<string, LoggedCommit[]>();
  const bases = [...new Set(fixes.map((fix) => fix.baseHead))].filter((base) => base !== lookup.head);
  await Promise.all(
    bases.map(async (base) => {
      const paths = [...new Set(fixes.filter((fix) => fix.baseHead === base).flatMap((fix) => fix.files))];
      const commits = await logSince(git, base, FIX_LOG_LIMIT, paths).catch((): LoggedCommit[] => []);
      logs.set(base, commits.filter((commit) => lookup.ours(commit)).reverse());
    }),
  );
  return logs;
}

function fileOutcome(path: string, oldestFirst: readonly LoggedCommit[], lookup: Lookup): FileOutcome {
  const commit = oldestFirst.find((candidate) => touches(candidate, path));
  if (commit !== undefined) return { path, state: lookup.isPushed(commit.sha) ? "pushed" : "committed", sha: commit.sha };
  return { path, state: lookup.dirty.has(path) ? "uncommitted" : "none", sha: null };
}

async function fixOutcomes(git: Git, fixes: readonly CommentFix[], lookup: Lookup): Promise<FixOutcome[]> {
  const logs = await fixLogs(git, fixes, lookup);
  return fixes.map((fix) => {
    const files = fix.files.map((path) => fileOutcome(path, logs.get(fix.baseHead) ?? [], lookup));
    const chosen = best(files);
    return { fix, state: chosen?.state ?? "none", sha: chosen?.sha ?? null, files };
  });
}

function commentIdsWhere(outcomes: readonly FixOutcome[], matches: (file: FileOutcome) => boolean): string[] {
  return [...new Set(outcomes.filter((outcome) => outcome.files.some(matches)).map((outcome) => outcome.fix.commentId))];
}

function commentStatuses(outcomes: readonly FixOutcome[]): CommentFixStatus[] {
  const grouped = new Map<string, FixOutcome[]>();
  for (const outcome of outcomes) grouped.set(outcome.fix.commentId, [...(grouped.get(outcome.fix.commentId) ?? []), outcome]);
  return [...grouped].map(([commentId, list]) => {
    const chosen = best(list);
    return {
      commentId,
      state: chosen?.state ?? "none",
      files: [...new Set(list.flatMap((outcome) => outcome.fix.files))],
      sha: chosen?.sha ?? null,
      sources: [...new Set(list.map((outcome) => outcome.fix.source))],
    };
  });
}

async function knownCommit(git: Git, sha: string | null): Promise<string | null> {
  if (sha === null) return null;
  return git(["cat-file", "-e", `${sha}^{commit}`]).then(
    () => sha,
    () => null,
  );
}

export async function readAddressChanges(
  git: Git,
  fixes: readonly CommentFix[],
  startHead: string | null,
  remoteHead: string | null = null,
): Promise<AddressChanges> {
  const [status, head, upstream, local] = await Promise.all([
    git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    git(["rev-parse", "HEAD"]).then((output) => output.trim()),
    git(["rev-parse", "@{u}"]).then(
      (output) => output.trim(),
      () => null,
    ),
    git(["log", "-g", `--max-count=${REFLOG_LIMIT}`, "--format=%H%x1f%gs", "HEAD"]).then(localCommits, () => null),
  ]);
  const dirty = parseStatus(status);
  const start = startHead ?? fixes[0]?.baseHead ?? upstream ?? head;
  const ours = (commit: LoggedCommit) => local === null || local.has(commit.sha);
  const commits = start === head ? [] : (await logSince(git, start, COMMIT_LIMIT)).filter(ours);
  const pushedRefs = [upstream, await knownCommit(git, remoteHead)].filter((ref): ref is string => ref !== null);
  const unpushed = pushedRefs.length === 0 ? null : new Set(lines(await git(["rev-list", "HEAD", "--not", ...pushedRefs])));
  const lookup: Lookup = {
    head,
    dirty: new Set(dirty.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath]))),
    ours,
    isPushed: (sha) => unpushed !== null && !unpushed.has(sha),
  };
  const outcomes = await fixOutcomes(git, fixes, lookup);
  const toCommit = (commit: LoggedCommit): AddressCommit => ({ ...commit, commentIds: commentIdsWhere(outcomes, (file) => file.sha === commit.sha) });
  return {
    available: true,
    reason: null,
    head,
    upstream,
    uncommitted: dirty.map((file) => ({
      ...file,
      commentIds: commentIdsWhere(outcomes, (fixed) => fixed.state === "uncommitted" && (fixed.path === file.path || fixed.path === file.previousPath)),
    })),
    unpushed: commits.filter((commit) => !lookup.isPushed(commit.sha)).map(toCommit),
    pushed: commits.filter((commit) => lookup.isPushed(commit.sha)).map(toCommit),
    comments: commentStatuses(outcomes),
  };
}

export function locateFiles(changes: AddressChanges, files: readonly string[]): { missing: string[]; oldestCommit: string | null } {
  const dirty = new Set(changes.uncommitted.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath])));
  const commits = [...changes.unpushed, ...changes.pushed];
  const newest = (path: string) => commits.findIndex((commit) => touches(commit, path));
  const missing = files.filter((path) => !dirty.has(path) && newest(path) === -1);
  const committed = files.filter((path) => !dirty.has(path)).map(newest).filter((index) => index !== -1);
  return { missing, oldestCommit: committed.length === 0 ? null : (commits[Math.max(...committed)]?.sha ?? null) };
}

export async function readDiff(git: Git, changes: AddressChanges, path: string, sha: string | null): Promise<string> {
  const paths = (file: ChangedFile) => (file.previousPath === null ? [file.path] : [file.previousPath, file.path]);
  if (sha === null) {
    const file = changes.uncommitted.find((candidate) => candidate.path === path);
    if (file === undefined) throw new Error(`${path} has no uncommitted change in the address thread's worktree.`);
    if (file.status === "U") return git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file.path], [1]);
    return git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "-M", "HEAD", "--", ...paths(file)]);
  }
  const commit = [...changes.unpushed, ...changes.pushed].find((candidate) => candidate.sha === sha);
  if (commit === undefined) throw new Error("That commit is not one of the address thread's commits.");
  const file = commit.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is not changed in commit ${commit.shortSha}.`);
  return git(["-c", "core.quotePath=false", "show", "--no-ext-diff", "-M", "--format=", commit.sha, "--", ...paths(file)]);
}
