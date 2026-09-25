---
name: trees
description: Work with Trees, BB's dependency-graph to-do list. Use when a request mentions a tree, a tree task, `bb tree`, node dependencies that gate each other, or when this thread was started by a Trees task and needs to know how its output is saved.
---

# Trees

Trees keeps a project as a directed acyclic graph of atomic tasks. A task is
either a **note** you write as Markdown or an **agent task** that runs in its
own BB thread. A task becomes ready only when every task it depends on is
completed, and each completed task passes a compacted summary down to the tasks
that depend on it.

Every task owns one Markdown file in the tree's folder, named from its position
and title, such as `02_tech_spec.md`.

## If this thread is a tree task

The first message you received is the task's assembled context: the upstream
summaries, the instruction, and the deliverable contract. When the work is
done, **post the deliverable itself as your final message**. Trees writes that
message verbatim into the task's Markdown file and hands it to the tasks
downstream. Do not finish with a status report about the work; finish with the
work.

Trees then asks you, in the same thread, for a summary spec of at most 200
words. Answer with the summary text alone — that text is all a downstream task
receives under the default context mode.

## The `bb tree` command

Add `--json` to any command for machine-readable output. A task or project can
be named by its id, and a task can also be named by its file name or its exact
title.

| Command                                                         | Purpose                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb tree ready [--project <tree>]`                              | Every task whose dependencies are satisfied, across all trees or in one. Start here.                                                                                                                         |
| `bb tree project list\|create\|show\|rename\|delete\|attach`    | Manage trees. `--bb-project <proj-id>` points the tree at the project its agent tasks get worktrees from; the tree's files stay in the Trees folder.                                                         |
| `bb tree node list\|show\|create\|update\|move\|delete`         | Manage the tasks in a tree. `--x`/`--y` on `create` and `move` set a task's place on the canvas; `--handoff summary\|custom\|full` sets what it passes downstream.                                           |
| `bb tree dep add\|remove --parent <task> --child <task>`        | Wire or unwire a dependency. Loops are refused.                                                                                                                                                              |
| `bb tree context <task>`                                        | Print the exact context an agent task will receive.                                                                                                                                                          |
| `bb tree artifact read\|write <task>`                           | Read or replace a task's Markdown file.                                                                                                                                                                      |
| `bb tree start <task>`                                          | Spawn the agent task's thread with its assembled context.                                                                                                                                                    |
| `bb tree resend <task>`                                         | Send the current context into an agent task's existing thread.                                                                                                                                               |
| `bb tree complete <task>`                                       | Save the output, unblock the children, and compact it. Waits for the summary, unlike the panel, which returns at once and summarizes in the background. Only a `summary` handoff is compacted on completion. |
| `bb tree compact <task>`                                        | Regenerate the summary without changing state. Drafts the text under a `custom` handoff; refused under `full`, where no task reads the summary field.                                                        |
| `bb tree summary <task> --text <summary>`                       | Replace the summary with text you write.                                                                                                                                                                     |
| `bb tree reopen <task> [--discard-thread]`                      | Move a completed task back to ready.                                                                                                                                                                         |
| `bb tree working <task>`                                        | Mark a task in progress without spawning a thread.                                                                                                                                                           |
| `bb tree project reveal <tree>`                                 | Open the tree's folder in the server machine's file manager.                                                                                                                                                 |
| `bb tree open <task> --base-branch <branch> [--message <text>]` | Cut a worktree off that branch and open the task's thread with its first message.                                                                                                                            |
| `bb tree ack <task>`                                            | Keep a stale task's output and clear its warning.                                                                                                                                                            |
| `bb tree layout <project>`                                      | Re-lay out the canvas positions.                                                                                                                                                                             |

## Creating a plan as a tree

```sh
bb tree project create --name "Build auth feature" --bb-project proj_your_api
bb tree node create --project "Build auth feature" \
  --title "Write auth requirements" --kind markdown
bb tree node create --project "Build auth feature" \
  --title "Generate API design specs" --kind agent \
  --instruction "Generate the OpenAPI schema for the authentication routes." \
  --depends-on "Write auth requirements"
bb tree node create --project "Build auth feature" \
  --title "Generate Express middleware" --kind agent \
  --instruction "Implement the middleware the schema describes." \
  --depends-on "Generate API design specs" \
  --workspace proj_your_api_project
```

Keep each task atomic: one decision, one document, or one change. A task whose
instruction has several unrelated parts should be several tasks, so downstream
work can start as soon as the part it needs is done.

## Where an agent task runs

By default an agent task runs in a bb-managed scratch workspace: its context
arrives in the prompt and its deliverable is its final message, so it needs no
repository. For work on real code:

- `--workspace <proj_id>` runs the task through that project's own environment,
  so it gets **its own** workspace — a fresh worktree when the project is set up
  for one. Two tasks pointed at the same project do not share a checkout.
- `--workspace <env_id>` runs the task in that exact existing environment, which
  it then **shares** with every other task pointed at it. Use this when a later
  task must continue the earlier task's work in place.
- An absolute path resolves to the bb project that owns that directory; bb
  refuses a directory no project owns.

List candidates with `bb env list` and read a task's current choice from
`bb tree node show <task>`.

## Context modes

- `auto_compact` (default) — the child receives only the parents' summaries.
- `full_parents` — the child receives the parents' complete Markdown output.
  Use it when the exact text matters, such as code generation from a spec.
- `custom` — the child receives a brief you write plus the summaries of the
  specific upstream tasks you list with `--include`.

Set the mode with `bb tree node update <task> --context-mode <mode>`, and check
the result with `bb tree context <task>` before starting the task.

## What a task passes downstream

The context mode above is what a task asks for. What a task gives is its
handoff, set with `bb tree node update <task> --handoff <mode>`:

- `summary` (default) — completing the task compacts its output to under 200
  words, and downstream tasks receive that.
- `custom` — downstream tasks receive exactly the text in the summary field,
  which you set with `bb tree summary <task> --text "…"`. Completion never
  overwrites it.
- `full` — downstream tasks receive the whole Markdown file, however little
  they asked for, and no summary is written at all.

The producer wins: a `full` parent sends its document even to a child on
`auto_compact`. Only `summary` costs a model call on completion.

## Stale tasks

A completed task goes **stale** when the inputs it was completed against change:
an upstream summary or output changed, the task's own instruction changed, or an
upstream task is itself stale. Trees never silently reruns anything. Resolve it
one of two ways:

- `bb tree reopen <task>` to redo the work against the updated context.
- `bb tree ack <task>` to keep the existing output and clear the warning.

Acknowledging is refused while a parent is still stale — resolve upstream first.

## Rules

- Never fabricate a summary for work that did not happen. If a task cannot be
  completed, say so rather than writing a plausible-looking artifact.
- Completing a task overwrites an agent task's Markdown file with the thread's
  final message. Save anything else you want kept as its own task.
- Deleting a task reattaches its children to its parents and leaves its
  Markdown file on disk.
