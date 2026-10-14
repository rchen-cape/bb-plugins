Track open pull requests on a board and review them with an agent beside a
side-by-side diff.

## What you get

- A **PR Board** page with Draft, Open, Reviewing, and Ready columns.
- A review page per PR: changed files, a side-by-side diff, inline GitHub
  comments, pending review comments, and the agent's findings highlighted in
  amber.
- A review thread per PR, started with **Run review**, that summarizes the
  change and runs `/thermo-nuclear-code-quality-review`.
- A Comments tab, and an **Address comments** thread that suggests code changes
  and replies for each comment. You accept a change into the thread's worktree,
  or use a reply as the start of your own.
- ⌘-click go to definition, using gopls for Go and a definition search for
  other languages.

## How it works

The plugin reads GitHub through the `gh` CLI on the bb server and keeps
findings and pending comments in its own database. Comments and reviews post
to GitHub only when you submit them.
