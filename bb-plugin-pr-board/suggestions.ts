import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ConversationComment, PullDetail, ReviewThread, SuggestionEdit } from "./contract.js";

export const SUGGESTIONS_TOOL = "pr_board_record_suggestions";
export const RECORD_FIX_TOOL = "pr_board_record_fix";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const COMMENT_LIMIT = 1_500;

export interface FilePreview {
  path: string;
  before: string | null;
  after: string;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function applyEdit(content: string | null, given: SuggestionEdit): string {
  const crlf = content !== null && content.includes("\r\n") && !given.find.includes("\r");
  const edit = crlf ? { ...given, find: given.find.replaceAll("\n", "\r\n"), replace: given.replace.replaceAll("\n", "\r\n") } : given;
  if (edit.find === "") {
    if (content !== null) throw new Error(`${edit.path} already exists; give the exact text to replace`);
    return edit.replace;
  }
  if (content === null) throw new Error(`${edit.path} does not exist`);
  const first = content.indexOf(edit.find);
  if (first === -1) throw new Error(`the text to replace was not found in ${edit.path}`);
  if (content.indexOf(edit.find, first + 1) !== -1) {
    throw new Error(`the text to replace matches more than one place in ${edit.path}; include more surrounding lines`);
  }
  return content.slice(0, first) + edit.replace + content.slice(first + edit.find.length);
}

async function nearestExisting(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return real;
    if (dirname(current) === current) return current;
  }
}

async function worktreeFile(root: string, path: string): Promise<string> {
  if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`"${path}" is not a repository-relative path`);
  }
  const absolute = resolve(root, path);
  const realRoot = await realpath(root);
  const container = await nearestExisting(dirname(absolute));
  if (container !== realRoot && !container.startsWith(`${realRoot}${sep}`)) throw new Error(`"${path}" is outside the worktree`);
  const link = await lstat(absolute).catch(() => null);
  if (link?.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (link !== null && link.isFile() && link.nlink > 1) throw new Error(`${path} is a hard link`);
  return absolute;
}

async function readWorktreeFile(root: string, path: string): Promise<string | null> {
  const absolute = await worktreeFile(root, path);
  const info = await stat(absolute).catch(() => null);
  if (info === null) return null;
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to change here`);
  const bytes = await readFile(absolute);
  const content = bytes.toString("utf8");
  if (content.includes("\u0000")) throw new Error(`${path} is a binary file`);
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error(`${path} is not UTF-8 text`);
  return content;
}

export async function previewEdits(root: string, edits: readonly SuggestionEdit[]): Promise<FilePreview[]> {
  const files = new Map<string, FilePreview>();
  for (const edit of edits) {
    const file = files.get(edit.path);
    const before = file === undefined ? await readWorktreeFile(root, edit.path) : file.before;
    files.set(edit.path, { path: edit.path, before, after: applyEdit(file === undefined ? before : file.after, edit) });
  }
  return [...files.values()];
}

export async function writePreviews(root: string, files: readonly FilePreview[]): Promise<void> {
  const staged: Array<{ temp: string; absolute: string }> = [];
  try {
    for (const file of files) {
      const absolute = await worktreeFile(root, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      const temp = `${absolute}.pr-board-${randomUUID()}.tmp`;
      staged.push({ temp, absolute });
      await writeFile(temp, file.after, { encoding: "utf8", flag: "wx" });
      const existing = await stat(absolute).catch(() => null);
      if (existing !== null) await chmod(temp, existing.mode & 0o7777);
    }
  } catch (error) {
    await Promise.all(staged.map(({ temp }) => rm(temp, { force: true })));
    throw error;
  }
  for (const { temp, absolute } of staged) await rename(temp, absolute);
}

export function commentsToAddress(detail: PullDetail): { threads: ReviewThread[]; conversation: ConversationComment[] } {
  const awaiting = new Set(detail.awaitingReply);
  return {
    threads: detail.threads.filter((thread) => {
      const last = thread.comments.at(-1);
      return !thread.isResolved && last !== undefined && last.author.login !== detail.viewer;
    }),
    conversation: detail.conversation.filter((comment) => awaiting.has(comment.id)),
  };
}

export function addressableIds(detail: PullDetail): Set<string> {
  const { threads, conversation } = commentsToAddress(detail);
  return new Set([...threads.map((thread) => thread.id), ...conversation.map((comment) => comment.id)]);
}

export function pullCommentIds(detail: Pick<PullDetail, "threads" | "conversation">): Set<string> {
  return new Set([...detail.threads.map((thread) => thread.id), ...detail.conversation.map((comment) => comment.id)]);
}

export const FIX_INSTRUCTION = `If the user asks you in this thread to fix a specific comment yourself, edit the files then, and right after the edit, before any commit, call the ${RECORD_FIX_TOOL} tool with that comment's id and the repository-relative files you changed for it, so PR Board shows the fix under the comment.`;

function commentList(detail: PullDetail): string[] {
  const { threads, conversation } = commentsToAddress(detail);
  const who = (login: string) => (login === detail.viewer ? `@${login} (you)` : `@${login}`);
  const body = (text: string) => truncate(text.trim(), COMMENT_LIMIT).replaceAll("\n", "\n    ");
  const lines: string[] = [];
  if (threads.length > 0) {
    lines.push("Unresolved code comments where someone else replied last:");
    for (const thread of threads) {
      const range = thread.line === null ? "" : thread.startLine !== null && thread.startLine !== thread.line ? ` lines ${thread.startLine}-${thread.line}` : ` line ${thread.line}`;
      lines.push(`[${thread.id}] ${thread.path}${range}${thread.side === "deletions" ? " (old side)" : ""}${thread.isOutdated ? " (outdated)" : ""}`);
      for (const comment of thread.comments) lines.push(`  ${who(comment.author.login)}: ${body(comment.body)}`);
    }
  }
  if (conversation.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Conversation comments posted after your last reply, oldest first:");
    for (const comment of conversation) {
      lines.push(`[${comment.id}] ${who(comment.author.login)}${comment.kind === "review" ? " (review)" : ""}: ${body(comment.body)}`);
    }
  }
  return lines.length === 0 ? ["No comments are waiting for a reply from you."] : lines;
}

export function addressThreadTitle(pull: Pick<PullDetail, "repo" | "number" | "title">): string {
  return truncate(`Address comments ${pull.repo.slice(pull.repo.indexOf("/") + 1)}#${pull.number}: ${pull.title}`, 120);
}

export interface StackPull {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

export interface PullStack {
  below: StackPull[];
  above: StackPull[];
}

export function pullStack(pull: Pick<PullDetail, "number" | "headRefName" | "baseRefName">, open: readonly StackPull[]): PullStack {
  const sameRepo = open.filter((candidate) => !candidate.isCrossRepository && candidate.number !== pull.number);
  const seen = new Set([pull.headRefName]);
  const below: StackPull[] = [];
  for (let base = pull.baseRefName; !seen.has(base); ) {
    seen.add(base);
    const parent = sameRepo.find((candidate) => candidate.headRefName === base);
    if (parent === undefined) break;
    below.unshift(parent);
    base = parent.baseRefName;
  }
  const above: StackPull[] = [];
  const queue = [pull.headRefName];
  for (let branch = queue.shift(); branch !== undefined; branch = queue.shift()) {
    for (const child of sameRepo.filter((candidate) => candidate.baseRefName === branch && !seen.has(candidate.headRefName))) {
      seen.add(child.headRefName);
      above.push(child);
      queue.push(child.headRefName);
    }
  }
  return { below, above };
}

function stackLines(pull: PullDetail, stack: PullStack): string[] {
  if (stack.below.length + stack.above.length === 0) return [];
  const line = (entry: Pick<StackPull, "number" | "title" | "headRefName" | "baseRefName">, where: string) =>
    `  #${entry.number} ${entry.headRefName} into ${entry.baseRefName} "${truncate(entry.title, 100)}" (${where})`;
  return [
    "",
    "This PR is part of a stack of open PRs, bottom first:",
    ...stack.below.map((entry) => line(entry, "below: this PR builds on it")),
    line(pull, "this PR"),
    ...stack.above.map((entry) => line(entry, "above: builds on this PR")),
    "Before suggesting a change for a comment, check the rest of the stack with git, not gh (it costs no GitHub API calls):",
    "- PRs above: `git fetch origin <branch>` and `git diff HEAD...origin/<branch> -- <path>`. If one already makes the change the comment asks for, suggest only a reply that names it (for example \"Addressed in #123\") and no change.",
    "- PRs below: if the code the comment is about comes from a PR below (its changes are already in this branch; compare with `git diff origin/<its base>...origin/<its branch> -- <path>`), say the fix belongs in that PR and suggest only a reply.",
  ];
}

export function addressPrompt(pull: PullDetail, stack: PullStack = { below: [], above: [] }): string {
  return [
    `You are the comment-addressing thread for ${pull.repo}#${pull.number} "${pull.title}" by @${pull.author.login}: ${pull.url}`,
    `Branch ${pull.headRefName} into ${pull.baseRefName}. PR Board shows your suggestions under each comment, and the user decides what to apply or post.`,
    ...stackLines(pull, stack),
    "",
    ...commentList(pull),
    "",
    "Summarize in a short list what the reviewers ask for. Do not read or change files yet: the PR head is still being checked out in this worktree.",
  ].join("\n");
}

export function addressMessage(pull: PullDetail, withList: boolean, stack: PullStack = { below: [], above: [] }): string {
  return [
    withList
      ? "Here are the PR's current comments. Suggest again how to address them; your new suggestions replace the earlier ones."
      : "The PR head is now checked out in this worktree. Suggest how to address the comments listed above.",
    `The PR head is ${pull.headSha}. If \`git rev-parse HEAD\` differs, run \`git pull --ff-only\` first; if that fails, say so and stop.`,
    ...(withList ? [...stackLines(pull, stack), "", ...commentList(pull), ""] : []),
    "- Suggest by default: for these suggestions, do not edit, create, or delete files, and do not commit or push. PR Board applies a change only when the user accepts it. The worktree may already hold changes the user accepted from earlier suggestions, so read the current files.",
    `- ${FIX_INSTRUCTION}`,
    "- Every listed comment is waiting for your reply: someone else spoke last. Address only these; comments where you replied last are left out on purpose. For each one, propose a code change, a reply, or both. Skip ones that need nothing, such as bot status reports.",
    "- A change is a list of edits. Each edit has a repository-relative `path`, `find` (text copied exactly from the current file that appears there exactly once; include a few surrounding lines), and `replace` (the new text). Use an empty `find` to create a new file. Edits in one change apply in order, so a later `find` must match the file after the earlier edits; do not overlap them.",
    `- A reply is what @${pull.viewer} could post: short and specific. With a change, the reply can say what changed. A reply to a conversation comment is posted as a new PR comment, so start it with an @mention of the commenter.`,
    `- When done, call the ${SUGGESTIONS_TOOL} tool once with every suggestion, using the comment ids in brackets. If it reports errors, nothing was recorded: fix those suggestions and call it again with every suggestion, including the ones without errors.`,
  ].join("\n");
}

export function submitAddressMessage(pull: PullDetail, changedFiles: readonly string[]): string {
  return [
    `The user clicked Submit Address. Check, commit, and push the changes they accepted, to the PR's head branch \`${pull.headRefName}\` of ${pull.repo}#${pull.number}.`,
    "Never force-push. The only edits you may make are ones that do not change what the code does, to get the checks to pass (step 3).",
    "Every commit you make, merge commits included, must be signed with the user's git signing key: use `git commit -S` and `git merge -S`, and never pass `--no-gpg-sign`, set `commit.gpgsign=false`, or change the signing config. If signing fails only because the sandbox blocks `~/.gnupg` or the gpg agent, retry the same signed command outside the sandbox. If it still fails, stop without pushing and report the error.",
    "Commits must be attributed to the user alone. This overrides any attribution instruction you were given: do not add a `Co-Authored-By` trailer, a \"Generated with\" line, or any other mention of Claude, Anthropic, or an AI assistant to a commit message, and do not change the commit author or committer.",
    "",
    `Changed files: ${changedFiles.join(", ")}`,
    "",
    "1. Run `git status` and `git diff` to see the accepted changes.",
    "2. Make sure they will pass the PR's GitHub Actions: read the workflows in `.github/workflows/` that run on pull requests, and run their check, lint, typecheck, build, and test steps locally in this worktree. Skip steps that deploy or need secrets or services you do not have, and list what you skipped.",
    "3. If a check fails, you may fix it only with edits that keep the code's behavior the same: formatter output, lint auto-fixes and style fixes, import order, unused imports, type annotations, comments, and regenerating generated files or lockfiles the checks expect. Run the checks again after fixing. Do not change logic, tests, or test expectations, and do not disable rules, skip checks, or add ignore comments. If a check still fails, or passing it needs a logic change, stop: undo your own fixes (keep the accepted changes), do not commit or push, and report each failure with its output.",
    "4. If every check passes, commit the accepted changes, signed, with a message that names the comments they address. If you made fixes in step 3, commit them separately afterwards, signed, with a message that lists each one.",
    `5. Fetch the PR branch and merge it into this branch, signed, if it has new commits. If the merge conflicts, run \`git merge --abort\` and stop without pushing. If the merge brought new commits, run the checks again and stop on a failure.`,
    "6. Before pushing, run `git log --format='%h %G? %an <%ae> %s%n%b' @{upstream}..HEAD` and check that every commit you made shows a signature (`G` or `U`, not `N`). If one is unsigned, stop without pushing and report it. Also check that no commit you made mentions Claude, Anthropic, or an AI assistant in its author or message; if one does, reword it with `git commit --amend -S` (or `git rebase -S` for an older one, never touching commits that were already pushed) to remove the attribution, then check again.",
    `7. Push to \`${pull.headRefName}\` on the remote \`gh pr checkout\` set as this branch's upstream (\`git rev-parse --abbrev-ref @{upstream}\`), for example \`git push <remote> HEAD:${pull.headRefName}\`. Do not push anywhere else and do not merge the pull request.`,
    `8. Watch the PR's checks with \`gh pr checks ${pull.number} -R ${pull.repo} --watch\` and report the commit shas, what you ran and skipped, every fix you made in step 3 and why, and the result of each check.`,
  ].join("\n");
}
