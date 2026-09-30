# Trees

Trees is a to-do list shaped like a dependency graph. A project is a directed
acyclic graph of atomic tasks: each task waits for the tasks it depends on, and
each finished task passes its compacted output down to the tasks that depend on
it.

A task is either a **note** — a Markdown file you write — or an **agent task**,
a BB thread that starts with the context its parents produced.

## Install

```sh
bb plugin install trees
```

That adds the Trees panel, the `bb tree` command, and the `trees` agent skill.

## Where the files live

Set **Trees folder** in the plugin's settings (default `~/Trees`). Each tree
becomes a subdirectory of it, and each task owns one Markdown file inside that
subdirectory:

```
~/Trees/build_auth_feature/
├── 01_write_auth_requirements.md
├── 02_generate_api_design_specs.md
└── 03_generate_express_middleware.md
```

The graph itself — tasks, dependencies, states, and summaries — lives in the
plugin's own database, not in that folder. Deleting a project from Trees leaves
its Markdown files untouched.

Tree folders resolve on the primary machine, so `~` expands to the home
directory of the account running the BB server.

**A tree belongs to no project.** Its Markdown lives in the Trees folder, and
which repository gets changed is each agent task's own business: every agent
task names the project it works in and the branch to cut its worktree from. One
tree can therefore change several codebases — a schema in one repository, the
client that consumes it in another, the release notes in a third — while the
plan for all of it stays in one graph.

Each tree on the index has a folder button that opens its directory in your
file manager, or `bb tree project reveal <tree>`. It runs on the machine hosting
the bb server, so it does nothing useful when you are connected to bb remotely.

## Quick start

```sh
bb tree project create --name "Build auth feature"

bb tree node create --project "Build auth feature" \
  --title "Write auth requirements" --kind markdown

bb tree node create --project "Build auth feature" \
  --title "Generate API design specs" --kind agent \
  --instruction "Generate the OpenAPI schema for the authentication routes." \
  --depends-on "Write auth requirements"

bb tree ready
```

Write the requirements in `01_write_auth_requirements.md` (in the panel or in
your editor), then:

```sh
bb tree complete "Write auth requirements"
bb tree context "Generate API design specs"   # read the prompt first
bb tree start "Generate API design specs"
```

## The task panel

Trees keeps one header line: `Trees > <tree name>` with the task counts, and
the tree's actions — Tidy layout, Delete tree — at the far right. Click
**Trees** to go back to every tree.

The counts are the navigation. Clicking **N ready** opens that tree's ready
list, so there is no separate button for it; the count stays visible on a narrow
window even when the task count does not, so the list is always reachable.

The trail nests, so each segment is the way back to what it names. A tree's
ready list reads `Trees > <tree name> > What's ready` and lists only that tree's
ready tasks; the tree name returns to its canvas, and Trees returns to every
tree. The **What's ready** button on the tree index is the one that spans every
tree, which is what `bb tree ready` prints — add `--project <tree>` for one
tree's.

Click a task on the canvas to open it. The panel is deliberately plain: the
title and the writing area have no borders, so a note reads like a document,
and the panel shares the chat's background so an agent task reads as one
surface. The task's state, kind, last change, and _Open full thread_ all sit on
the title line.

- The **state** is a picker, not a set of buttons. Choosing a state performs
  it: _In progress_ starts an agent's thread the first time, _Completed_ saves
  the output and compacts it, and on a stale task _Completed_ keeps the output
  while _Ready_ redoes the work. `blocked` and `stale` show as the current state
  but are never on offer — they follow from the graph. The menu always opens
  downward from the pill and takes arrow keys, Enter, and Escape.
- A note **autosaves** as you type, so there is no save button. Typing is never
  interrupted by it: a save goes out once you pause, or every few seconds if you
  do not pause at all, and leaving the task writes whatever is pending rather
  than dropping it. Saves are chained, never overlapped, so two of them cannot
  race over the file's digest. Nothing the panel does elsewhere reaches into the
  editor while you are in it. Once the task is completed the document is frozen
  and shown as rendered Markdown; set the task back to _Ready_ to edit it again.
- An agent task's **chat is embedded** in the panel once it has a thread, so you
  can talk to it without leaving the canvas — including the model, environment,
  and permission controls the normal composer has. _Open full thread_ goes to
  the full thread view, which behaves exactly as it always did.
- Everything you configure — dependencies, context, where it runs, thread
  operations, and deleting the task — lives in one collapsed **Setup** section,
  with **What it passes downstream** below it.
- An agent task has no instruction field. Opening one that has no thread yet
  asks two things: what the task should do, and which branch to work from.
  Starting it cuts a fresh worktree from that branch, opens the thread with
  your text as its first message — wrapped in the upstream context — and drops
  you into it. From then on the panel is that thread's chat.

  bb cannot create a thread with no messages, so the first message is asked for
  up front rather than typed into an empty thread.

- **Drag the panel's left edge** to resize it, up to 80% of the width between
  the sidebars. The width is remembered per device, and the divider takes arrow
  keys.
- Each task shows when it last changed, on its card and in the panel.

## Adding tasks on the canvas

A task is drafted where it will live. There is no button in the title bar,
because there is no one place a new task belongs — the canvas decides. An empty
tree shows an empty card outline in the middle; clicking it turns that outline
into the draft.

The draft is the card it is about to become, not a form on top of one: the title
is a bare line of text where the card's title goes, and the only other thing on
it is the dependency it will create. Note and Agent both sit on the card as a
small pair of segments, in the colours a finished card uses for them, so
choosing one never opens anything over the canvas. **Add** appears once the task
has a name — there is nothing to press until then — and Escape drops the draft.

Every card carries a `+` on three of its sides, so the next task grows out of
the one it belongs to:

| Handle | What it adds                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Top    | A task the card depends on.                                                                              |
| Bottom | A task that depends on the card. Drag it onto another card instead to depend on one that already exists. |
| Right  | A task beside the card, depending on nothing.                                                            |

The draft card shows the dependency it is about to create, and a dashed line to
the task it grew from.

Adding a task tidies the layout, so the canvas always shows the graph's own
shape: a task has a row once the graph says which row, not wherever its draft
happened to sit. The draft's place is there to show the relationship being
drawn. Tidy layout in the title bar does the same thing on demand, and
`bb tree node create --x <px> --y <px>` or
`bb tree node move <task> --x <px> --y <px>` place a task deliberately from the
command line.

## Task states

| State         | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `blocked`     | At least one task it depends on is not finished.           |
| `ready`       | Everything it depends on is finished.                      |
| `in_progress` | Its thread is running, or you marked it in progress.       |
| `completed`   | Its output is saved and its summary is passing downstream. |
| `stale`       | It finished, but its inputs changed afterwards.            |

`blocked` and `ready` are derived from the graph, never stored, so they cannot
drift from it.

## Context passed to a task

Two choices meet here: **which** upstream tasks a task hears from, and **how
much** each of those tasks says. The first belongs to the reader, the second to
the writer alone.

Only an **agent task** receives anything: the context is the prompt its thread
opens with. A note is a file you write, so it has no context to receive and its
panel offers no such choice — but it still chooses what it passes downstream,
which is often the whole point of writing it.

Each agent task chooses which upstream tasks it hears from:

- **Every task it depends on** (default) — all of its parents.
- **The upstream tasks I choose** — a brief you write, plus the upstream tasks
  you tick, which may be any ancestor rather than only a parent.

Either way, each of those tasks contributes exactly what its own handoff says
it contributes. A reader cannot ask a parent for more than the parent passes
down, so the box a parent shows under **What it passes downstream** is what its
children actually read.

With several parents, the sections are labelled per parent
(`### Context from Write auth requirements (summary)`), so an agent can tell
the sources apart.

And each task chooses how much of itself it passes downstream, in its **What it
passes downstream** section or with
`bb tree node update <task> --handoff summary|custom|full`. The box in that
section always holds what will actually go down, and the choice above it
decides what fills the box:

- **Auto-summarized** (default) — a model compacts the output to under 200
  words and writes it into the box, which is then yours to edit. Choosing it
  on a finished task compacts right then rather than waiting for the next
  completion.
- **What I write** — the box is empty and yours to fill. Completing the task
  leaves it alone, so nothing overwrites what you wrote. _Draft with AI_ fills
  it from the document when you want a starting point to edit.
- **Whole document** — nothing is shown, because what goes down is the document
  above, which you have just read or written. Right for a note whose exact
  wording matters, where a summary would lose the thing that mattered: a
  specification, a schema, a set of copy strings. This is also the only mode
  that carries the note's **images**: they travel with the document they
  belong to.

Staleness follows what a parent actually sends — a child reading a parent's
document is warned when that document changes, and is not disturbed by a
rewrite of a summary it never sees.

Only **Auto-summarized** calls a model on completion. The other two skip that
step, which is the slowest part of completing a task. `bb tree compact <task>`
still drafts text on demand under **What I write**, and is refused under
**Whole document**, where no task is ever shown the summary field.

Read the assembled prompt with `bb tree context <task>`, or **Preview what it
will see** in the panel. Nothing starts on its own: a finished parent makes its
children ready and stops there.

## Images in a note

**Drop an image anywhere on a note** and it is stored beside the note, then
referenced from the document at your cursor:

```
~/Trees/build_auth_feature/
├── 01_write_auth_requirements.md      ![the login screen](assets/6f1c….png)
└── assets/
    └── 6f1c4b2a91d83e07.png
```

The note stays one Markdown file. Nothing is hidden in the plugin's database,
so the same file opened in any editor still shows its images, and the folder
can be copied or committed whole. Files are named by their content, so dropping
the same screenshot twice stores it once.

PNG, JPEG, GIF, WebP, AVIF, HEIC, BMP, and TIFF, up to 10MB each. SVG is
refused: it is a document that can carry script, and these are rendered in the
app and handed to agents.

A note's images are listed under its editor, and a completed note renders them
inline. `bb tree image add <task> --file <path>` does the same from the command
line, and `bb tree image list <task>` prints what a note carries with the paths
on disk.

**They are sent downstream only under Whole document**, and on every path that
sends it: a thread starting, `bb tree resend`, and **Send down the context** to
a child already working. An agent task receives the pictures themselves, as
attachments of its own message, not paths to go and read — an image is copied
into the thread's project as bb does for anything you attach in the composer,
because a path into the Trees folder is something the agent's runtime may have
no way to open.

In the document that travels, each reference becomes a numbered marker —
`_[Image 1: the login screen]_` — where the image sat, and a line after it
names them. The Markdown reference itself would be a broken image in a chat
message, since it is relative to the tree's folder.

A summary cannot carry images: it is text about the document, and nothing in it
points at one.

## Handing the context down

Children normally pull: each one assembles its context when it starts. **Send
down the context**, at the bottom of the same section, pushes instead — to the
immediate children, not the whole subtree — and says what became of each one:

- A child **with a running thread** receives it as a message in that thread,
  framed as additional context that replaces what it was given before. This is
  what to use when a parent changed after its children were already working.
- A child **not started yet** needs nothing: its first message is assembled
  from this task when it starts, so it is reported as already accounted for.
- A **note** child has no thread, and reads its parents in the panel.

One child that cannot be reached does not stop the others; each reports its own
outcome. Handing down never changes a child's state — that stays the state
picker's job, so nothing starts, reopens, or completes behind your back.
`bb tree handdown <task>` does the same from the command line.

## Completing and compacting

Completing a task does three things:

1. Saves the output. For an agent task that is the thread's final message,
   written verbatim to the task's Markdown file. For a note it is the file you
   already wrote.
2. Recomputes state, so the tasks that depend on it become ready.
3. Queues a summary, and compacts it in the background. An agent task is asked
   for a summary spec in its own thread; a note is summarized by a short hidden
   thread that is archived and stopped afterwards. Only an auto-summarized task
   does this; the other two handoffs skip the step entirely.

Only the first two are synchronous. Marking a task done in the panel takes
effect immediately and the summary lands a moment later — the downstream
section reads _summarizing…_ until it does. Summarizing asks a model, which is
far slower than anything else completion does, and nothing downstream needs it
to become ready.

`bb tree complete <task>` waits for the summary instead, so the summary is
ready for whatever the caller does next.

If compaction fails, the task still completes and the downstream section says
so — write the summary yourself with `bb tree summary <task> --text "…"`, or
retry with `bb tree compact <task>`. Downstream tasks see
`_No summary was recorded for this task._` until one exists.

## Stale tasks

A completed task goes stale when what it was completed against changes: an
upstream summary or output changed, an upstream task is itself stale, or the
task's own instruction changed. Trees flags it and never reruns anything by
itself:

- `bb tree reopen <task>` moves it back to ready so you can redo it against the
  updated context. Add `--discard-thread` to start from a fresh thread instead
  of continuing the existing one.
- `bb tree working <task>` marks it in progress without spawning a thread.
- `bb tree ack <task>` keeps the output and clears the warning. It is refused
  while a parent is still stale, so you resolve upstream first.

A background sweep re-reads completed tasks' files every minute, so an edit made
outside BB is noticed too.

## Where an agent task runs

Two choices, both the task's own: **which project** it changes, and **which
branch** its worktree is cut from.

| Choice                          | Behavior                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A scratch workspace (default)   | A bb-managed personal workspace. The agent gets its context in the prompt and returns the deliverable as its final message, so it needs no repository. |
| A bb project                    | Its own fresh worktree in that project, cut from the branch below. Two tasks in one project cannot tread on each other.                                |
| An existing workspace           | The task runs in that exact environment, sharing it with every other task pointed at it — right when a later task continues earlier work in place.     |
| A directory you name (CLI only) | Resolved to the bb project that owns that directory.                                                                                                   |

| Branch         | Behavior                                                             |
| -------------- | -------------------------------------------------------------------- |
| One you pick   | The worktree is cut from that branch.                                |
| None (default) | The project's own default environment decides, as it does elsewhere. |

Set both in the panel under **Where it runs**, or with
`bb tree node update <task> --workspace scratch|<proj_id>|<env_id>|<absolute path> --branch <name>`.
`--branch=` with nothing after it clears the branch again.

An agent task with no project yet asks for one before anything else, since
there is nothing to branch from until it has one. Starting a task from the panel
remembers the branch it was started on.

Changing the branch of a task that already has a thread does not move that
worktree — it applies the next time the task is started, after detaching the
thread.

The panel lists ready environments only, grouped as _Its own new workspace_
(projects) and _Share an existing workspace_ (environments), labelled by project
and branch.

bb only runs a thread in a directory a project owns, so a named directory that
no bb project has as a source is refused with that explanation. Add the
directory as a bb project first, then point the task at the project.

## CLI reference

Run `bb tree help`. Every command accepts `--json`. Projects are named by id or
exact name; tasks by id, file name, or exact title. `--project` narrows a task
lookup when two trees use the same title.

For `bb tree artifact write`, `--content-file` resolves on the invoking
machine — inside an agent thread that is the thread's machine, otherwise the
server's. Pass `--machine <id-or-name>` to target another enrolled machine.

## Limits

- 200 projects, and 300 tasks per project.
- A task file is at most 2,000,000 characters; a summary at most 4,000.
- Compaction gives a turn three minutes to finish.

## Known limitations

- Tree folders live on the primary machine only.
- An agent task cannot be pointed straight at an arbitrary directory: bb runs
  threads in project-owned or bb-managed workspaces, so a named directory has
  to belong to a bb project.
- Changing a task's branch after its thread exists does not move the worktree
  it already has.
- The Markdown editor in the panel is a plain text area. Open the file with the
  Docs plugin or your editor for a richer one.
- Renaming a task does not rename its Markdown file; the file name is fixed when
  the task is created.
