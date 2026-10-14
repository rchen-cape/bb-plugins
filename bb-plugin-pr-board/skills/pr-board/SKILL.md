---
name: pr-board
description: List open PRs by board column, open or re-run a PR's review thread or address-comments thread, and read the review findings and comment suggestions PR Board shows in its review page, with the bb pr-board commands and the pr_board_record_findings and pr_board_record_suggestions tools.
---

# PR Board

PR Board shows open PRs the signed-in `gh` user opened, is @-mentioned in, is directly requested to
review, or commented on or reviewed with their comment still the latest, in four columns,
and opens one review thread per PR. The optional Repositories setting limits it
to those repositories. A review thread works in a worktree on the PR's
head, summarizes the PR, then runs `/thermo-nuclear-code-quality-review`. A
separate address-comments thread suggests code changes and replies for the PR's
comments without changing files.

## Commands

```
bb pr-board board [--refresh] [--json]
bb pr-board open <n | owner/repo#n | PR URL> [--json]
bb pr-board review <n | owner/repo#n | PR URL> [--json]
bb pr-board findings <n | owner/repo#n | PR URL> [--json]
bb pr-board address <n | owner/repo#n | PR URL> [--json]
bb pr-board submit-address <n | owner/repo#n | PR URL> [--json]
bb pr-board suggestions <n | owner/repo#n | PR URL> [--json]
```

- `board` prints `column  owner/repo#n  author  threadId-or-dash  title`.
  Columns: `draft`, `open` (no human comments yet), `reviewing` (someone other
  than the author, a bot, or Copilot commented or reviewed), `ready` (approved).
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
  checks on its accepted changes and, if they pass, commit and push them to the
  PR branch. It prints `sent` or `queued` with the thread id. It pushes code, so
  only run it when the user asks.
- `suggestions` prints `commentId  change:open|applied|dismissed  reply:open|used|dismissed  summary`,
  with `-` for a missing change or reply.

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

In a PR Board address-comments thread, do not edit files. Call
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
