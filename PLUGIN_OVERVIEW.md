Keep a project as a dependency graph of atomic tasks. A task unlocks only when everything it depends on is done, and each finished task passes its compacted output down to whatever comes next.

## What you get

- A **Trees** panel with a drag-and-drop canvas. Drag a task to move it; drag the handle under a task onto another to make that task depend on it. Loops are refused as you draw them. New tasks are drafted in place, as the card they are about to become: an empty tree shows an empty outline in the middle of the canvas, and each card has a `+` on three sides for a parent, a child, or an independent neighbour.
- Two kinds of task. A **note** is a Markdown file you write, autosaved as you type and frozen as rendered Markdown once complete. An **agent task** is a BB thread that starts with the context its parents produced; its chat is embedded in the task panel, and it appears in your sidebar like any other thread.
- A state dropdown on each task, rather than buttons: move it between ready, in progress, and completed, and the right thing happens — starting an agent's thread, saving and compacting its output, or keeping a stale task's output.
- A **What's ready** list: every task whose dependencies are satisfied, so you never have to read the graph to know what to do next. Across every tree from the tree index, or scoped to one tree from inside it.
- Plain Markdown on disk. Each tree is a folder you choose, and each task owns one file in it, such as `02_tech_spec.md`.
- Compaction, with the choice left to you. Each task picks what it passes downstream, in one box that always holds exactly what will go down: auto-summarized (completing it asks the agent that did the work — or a short throwaway thread, for a note — for a spec under 200 words), text you write yourself, or the whole document. Only the first costs a model call.
- Handing the context down on purpose. One button pushes a task's context to the tasks that depend on it: a child already working receives it as a message in its thread, and one that has not started gets it in its opening message. Also `bb tree handdown`.
- Stale detection. Edit an upstream task after a downstream one finished and Trees flags the downstream task instead of rerunning it. You choose: redo the work against the new context, or keep the output and clear the warning.
- Nothing runs on its own. A finished parent makes its children ready and stops there, with a **Preview what it will see** button so you can read the exact prompt before the agent does.

## For agents

Agents get the `trees` skill and the `bb tree` command: `ready`, `project`, `node`, `dep`, `context`, `artifact`, `start`, `resend`, `complete`, `compact`, `summary`, `reopen`, `ack`, and `layout`. All of them accept `--json`.

An agent task runs in a bb-managed scratch workspace by default, because its context arrives in the prompt and its deliverable is its final message. Point it at a BB project instead and it runs through that project's environment, so it gets a worktree when the project is set up for one.
