---
name: pr-board
description: List open PRs by board column, open or re-run a PR's review thread or address-comments thread, read the review findings and comment suggestions PR Board shows in its review page, and list the address thread's uncommitted, unpushed, and pushed changes per comment, with the bb pr-board commands and the pr_board_record_findings, pr_board_record_suggestions, and pr_board_record_fix tools.
---

# PR Board

PR Board shows open PRs the signed-in `gh` user opened, is @-mentioned in, is directly requested to
review, or commented on or reviewed with their comment still the latest, in four columns,
and opens one review thread per PR. The optional Repositories setting limits it
to those repositories. A review thread works in a worktree on the PR's
head, summarizes the PR, then runs `/thermo-nuclear-code-quality-review`. A
separate address-comments thread suggests code changes and replies for the PR's
comments without changing files, unless the user asks it to fix one.

## Commands

```
bb pr-board board [--refresh] [--json]
bb pr-board open <n | owner/repo#n | PR URL> [--json]
bb pr-board review <n | owner/repo#n | PR URL> [--json]
bb pr-board findings <n | owner/repo#n | PR URL> [--json]
bb pr-board address <n | owner/repo#n | PR URL> [--json]
bb pr-board submit-address <n | owner/repo#n | PR URL> [--json]
bb pr-board suggestions <n | owner/repo#n | PR URL> [--json]
bb pr-board changes <n | owner/repo#n | PR URL> [--json]
```

- `board` prints `column  owner/repo#n  author  threadId-or-dash  title`.
  Columns: `draft`, `open` (no human comments yet), `reviewing` (someone other
  than the author, a bot, or Copilot commented or reviewed), `ready` (approved).
  Without `--refresh` it reuses the last minute's GitHub check and refetches
  only changed PRs. `--refresh` fetches every PR again and costs more of the
  user's GitHub API limit, so use it only when fresh data matters.
- `open` finds the PR's review thread or starts one, and prints `started` or
  `existing` with the thread id. Starting one spawns an agent, so only run it
  when the user asks for a review thread.
- `review` sends the review command to the PR's thread again; it is queued if
  the agent is busy.
- `findings` prints `severity  path:start-end  side  open|dismissed  title`.
- `address` starts the PR's address-comments thread, or sends it the current
  comments again, and prints `started`, `sent`, or `queued` with the thread id.
  It spawns an agent, so only run it when the user asks.
- `submit-address` asks the PR's address thread to run the PR's GitHub Actions
  checks on its accepted changes, fix failures only with edits that do not
  change behavior (formatting, lint, imports, type annotations, generated
  files), and, if the checks pass, commit them signed and push them to the PR
  branch. It prints `sent` or `queued` with the thread id. It pushes code, so
  only run it when the user asks.
- `suggestions` prints `commentId  change:open|applied|dismissed  reply:open|used|dismissed  summary`,
  with `-` for a missing change or reply.
- `changes` reads the address thread's worktree with `git` and prints three
  sections: `Uncommitted (N)` with `status  path  addresses <commentIds>`
  rows, then `Committed, not pushed (N)` and `Pushed (N)` with
  `shortSha  subject  addresses <commentIds>` rows and their files indented
  below. Status letters: `M`, `A`, `D`, `R`, `U` (untracked). Only commits
  made in the worktree count. `--json` adds `comments`: per comment id, the
  fix `state` (`uncommitted`, `committed`, `pushed`, or `none`), its files,
  sha, and `sources` (`suggestion` or `thread`). Without an address thread or
  worktree it prints why.

A bare number uses the first repository in the Repositories setting, and needs
that setting.

## Recording findings

In a PR Board review thread, after a code review, call
`pr_board_record_findings` once with every finding:

- `path`: repository-relative path.
- `side`: `additions` for lines in the PR's new code, `deletions` for removed
  lines.
- `startLine` / `endLine`: line numbers on that side; omit both for a finding
  about the whole file.
- `severity`: `blocker`, `major`, `minor`, or `nit`.
- `title`: one line. `body`: the explanation, in Markdown.

A call replaces the findings recorded earlier for the PR. Pass
`replace: false` to append instead. The tool exists only in threads PR Board
started.

## Recording comment suggestions

In a PR Board address-comments thread, suggest changes instead of editing
files, unless the user asks you to fix a comment yourself. Call
`pr_board_record_suggestions` once with a suggestion for each comment that needs
a response:

- `commentId`: the id in brackets from the comment list.
- `summary`: one line saying what the suggestion does.
- `reply`: optional text the user could post.
- `changes`: optional edits, each with a repository-relative `path`, `find`
  (text that appears exactly once in the current file; empty to create a file),
  and `replace`.

The tool refuses the whole call, listing every problem, when a comment id is
unknown or an edit does not match the worktree. A call replaces the earlier
suggestions unless `replace` is false.

## Linking fixes to comments

When the user asks the address thread to fix a specific comment, edit the
files, then, right after the edit and before any commit, call
`pr_board_record_fix` with:

- `fixes`: one entry per comment, each with the `commentId` (the id in
  brackets from the comment list), the repository-relative `files` you changed
  for it, and a one-line `summary`.

PR Board then shows the comment's fix as uncommitted, committed, or pushed.
The tool refuses the whole call when a comment id is not on the PR or a file
has no change in the worktree and is not in a commit made there since the
thread started. Do not call it for changes the user accepted from a
suggestion; PR Board links those itself. The tool exists only in address
threads.
