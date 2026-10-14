---
name: pr-board
description: List open PRs by board column, open or re-run a PR's review thread, and read the review findings PR Board highlights in its diff view, with the bb pr-board commands and the pr_board_record_findings tool.
---

# PR Board

PR Board shows open PRs the signed-in `gh` user opened, is @-mentioned in, is directly requested to
review, or commented on or reviewed with their comment still the latest, in four columns,
and opens one review thread per PR. The optional Repositories setting limits it
to those repositories. A review thread works in a worktree on the PR's
head, summarizes the PR, then runs `/thermo-nuclear-code-quality-review`.

## Commands

```
bb pr-board board [--refresh] [--json]
bb pr-board open <n | owner/repo#n | PR URL> [--json]
bb pr-board review <n | owner/repo#n | PR URL> [--json]
bb pr-board findings <n | owner/repo#n | PR URL> [--json]
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
