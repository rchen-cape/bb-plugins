# PR Board

A kanban board of open GitHub pull requests, with one agent review thread per
PR and a review page for reading the diff and commenting on it.

## Install

```sh
npm install --include=dev
bb plugin install . --yes
```

Requires `gh` signed in to GitHub on the bb server machine. `gopls` is
optional; with it, ⌘-click on Go code resolves definitions exactly.

## Board

The **PR Board** sidebar entry lists open PRs that involve you, across every
repository `gh` can see:

- PRs you opened;
- PRs that @-mention you;
- PRs where someone requested your review directly (team requests do not count);
- PRs you commented on or reviewed where your comment is still the latest, in
  an unresolved review thread or the conversation, so it waits for a reply.

The optional **Repositories** setting (comma-separated `owner/repo`) limits the
board to those repositories. The PRs are grouped in four columns:

| Column | PRs |
| --- | --- |
| Draft | Draft PRs. |
| Open | Ready for review, with no comment or review from a person other than the author. |
| Reviewing | Commented on or reviewed by someone other than the author. Comments from bots, GitHub Actions, and Copilot do not count. |
| Ready | Approved: GitHub's review decision is approved, or, in repositories without required reviews, a person approved and nobody requested changes. |

Each card shows the repository name (unless the board is limited to one
repository), number, title, author, age, size, CI status, reviewers
(ring color: green approved, red changes requested, blue commented, grey
requested), comment count, unresolved threads, comments waiting for your
reply (red warning sign), and the review thread's state. A comment waits for
your reply when it is an unresolved code comment whose latest reply is not
yours, or a conversation comment or review with text posted after your latest
comment, review with text, approval, change request, or dismissed review.
Approvals and dismissed reviews do not wait for a reply. On PRs you did not open, only code comments you replied in and
conversations you posted in count. Comments from bots, GitHub Actions, and
Copilot do not count.
Filter by text, or by **Mine**, **Requested**, **Mentioned**, and **Awaiting reply**.

**Columns** lays the groups out side by side; **Rows** stacks them, each a grid
of cards that wraps to the page width, so the page scrolls down. Rows is the
default when the window is taller than it is wide. Click a group's header to
collapse it.

Hover a card for its actions: **Shrink** reduces it to one line (**Expand**
restores it), **Hide** removes it from the board, and the external-link icon
opens it on GitHub. **N hidden** in the toolbar shows hidden cards, faded, with
**Unhide**. Layout, scope, collapsed groups, and shrunk and hidden PRs are kept
in this client's local storage.

The last board loads at once, including after a restart, and updates in the
background: the toolbar shows **Updating…** while it fetches and **Updated
<time>** after, where the time is when the server last read GitHub. The board
refreshes every minute and when a review thread changes; the server caches
GitHub for 30 seconds and **Refresh** skips that cache. It returns to where you
scrolled.

## Review page

Click a card to open `/plugins/pr-board/board/pr/<owner>/<repo>/<n>`. Opening
a PR starts no agent. **Run review** starts a review thread when the PR has no
live one:

- in the project whose git remote matches the repository, or the **Review
  project** setting;
- in a `git-worktree` environment on `origin/<head branch>` (the default branch
  for PRs from forks), where `gh pr checkout <n>` runs once the worktree is
  ready;
- with a first message that asks for a short, plain summary of the PR;
- followed by `/thermo-nuclear-code-quality-review review pr <n>`, sent after
  the checkout and queued behind the summary. The message asks the agent to
  record its findings with the `pr_board_record_findings` tool.

The review thread's chat is the page's **Review thread** panel tab, and the
address thread's chat is the **Address thread** tab beside it. The
**Review diff** button in a review thread's header opens the page from the
thread.

A PR's page also opens from the cache when you come back to it, on the file
you last viewed, and refreshes in the background.

The page has:

- **Files**: every changed file with its status, finding, unresolved-thread,
  and pending-comment counts. The circle marks a file viewed on GitHub. `j` and
  `k` move between files.
- **Findings**: the recorded findings, blockers first. Click one to jump to
  its lines. Dismissed findings are hidden until **Show dismissed**.
- **Comments**: unresolved code comments plus conversation comments from
  others; comments from bots, GitHub Actions, and Copilot (and code comments
  they started) are listed but not counted. The tab lists every code comment and conversation comment (and
  review with text); click one to scroll to it in the main pane, which shows
  each comment with its replies, a reply box, and the address thread's
  suggestions.
- **The diff**: split or unified, wrapped or not, collapsed or the full file.
  Lines a finding covers are shaded amber, darker for blockers and majors;
  lines with a pending comment are shaded violet. Findings, GitHub review
  threads, and pending comments render under their last line. Findings on
  lines outside the shown hunks, and outdated GitHub comments, are listed
  above the diff.
- **Description**: the PR body.
- **Run review**: starts the review thread, or sends the review command to it again.
- **Address comments** (under Run review) and **Submit Address** (under Submit
  review): see below.

### Addressing comments

**Address comments** starts a separate address thread for the PR, in its own
`git-worktree` environment on the PR's head (checked out with `gh pr checkout`
like the review thread). It lists the unresolved code comments and the
conversation, asks for a short summary, and then, once the checkout is done,
asks for a suggestion per comment that still needs a response. Clicking it
again reloads the PR, moves the thread's worktree to the PR's latest commit
with `git pull --ff-only` (keeping accepted changes), and sends the current
comments to the same thread; its new suggestions replace the old ones. If the
worktree cannot fast-forward, for example because an accepted change conflicts
with the new commits, nothing is sent and git's error is shown.

The thread does not edit files. It records suggestions with the
`pr_board_record_suggestions` tool, and each suggestion can hold:

- **A change**: edits that each replace one exact piece of a file (or create a
  new file). The tool checks every edit against the worktree and refuses any
  whose text is missing or appears more than once. A change that touches more
  than one file or more than 10 lines starts collapsed: click a file name, which
  shows its `+` and `−` counts, to see its diff. **Accept change** writes the
  edits into the address thread's worktree, uncommitted; commit and push from
  the thread or a terminal. A change that no longer matches the files is refused.
- **A reply**: **Use reply** puts the text in the comment's reply box, where
  you can edit it before **Reply** (code comments) or **Comment** (conversation
  comments, posted as a new PR comment).

Each change and reply can be dismissed, and **Show dismissed** brings them back.

**Submit Address** asks you to confirm, then sends the address thread one
message. The thread does not edit files. It runs the check, lint, typecheck,
build, and test steps of the repository's pull-request GitHub Actions workflows
on its worktree and lists what it had to skip. If a check fails, it stops
without committing or pushing. If they pass, it commits the accepted changes,
merges new commits from the PR branch (aborting on a conflict), pushes to the
PR's head branch without force, and watches `gh pr checks`. It never merges the
pull request. The button needs an address thread, and the server refuses when
that thread's worktree has no changes.

The diff layout is **Auto** by default: split when the diff area is at least
860 pixels wide, unified when it is narrower. **Split** and **Unified** fix it.
The ↑ and ↓ buttons step through the files.

On a page narrower than 900 pixels, such as a vertical monitor with the thread
panel open, the file list and findings move into a collapsible panel above the
diff (the list button toggles it), the header's actions move to their own row,
and toolbar buttons show icons only.

### Commenting

Hover a line number and click **+**, or drag across line numbers first for a
range. The editor offers:

- **Add to review**: saves a pending comment in the plugin's database (⌘↵).
- **Comment now**: posts a single review comment immediately.
- **Suggest change**: inserts a GitHub suggestion block with the selected new
  lines.

A finding's **Comment** button opens the editor on the finding's lines with its
title and explanation. **Submit review** posts every pending comment in one
review with a summary and **Comment**, **Approve**, or **Request changes**.
Authors can only comment. GitHub threads can be replied to, resolved, and
unresolved in place.

GitHub only accepts review comments on lines inside a diff hunk, so the editor
refuses ranges outside one, and a range must stay inside one hunk.

### Go to definition

⌘-click (Ctrl-click off macOS) an identifier in the diff. The lookup runs in the
review thread's worktree:

- Go code on the PR's head uses `gopls definition`, including definitions in
  the standard library and module cache, which open read-only.
- Everything else, and the old side of the diff, searches the commit with
  `git grep` for definition patterns in Go, TypeScript/JavaScript, Python,
  Rust, C/C++, JVM languages, Swift, C#, and protobuf, ranked same file, then
  same directory, then other non-test code.

One match jumps to it: into the diff when the file changed in the PR,
otherwise into a read-only file view where ⌘-click keeps working. Several
matches open a picker. The back button, ⌥←, or Ctrl+- return to where you
were.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Repositories | empty | Optional comma-separated `owner/repo` list that limits the board. |
| Review project | none | Project that review threads start in when no project's remote matches. |
| Review model | `claude-opus-5-5` | Claude Code model of new review threads. Empty uses the project's default. |
| Review reasoning effort | `high` | `low`, `medium`, `high`, `xhigh`, or `max`. |
| Review permission mode | `auto` | `auto` is Approve for me, `accept-edits` is Accept Edits, `full` is Full Access. |

Review threads always run on Claude Code, because the review is the
`/thermo-nuclear-code-quality-review` skill. The model, effort, and mode are set
when a thread starts, so changing them affects new review threads only; change
an existing thread from its composer.

## CLI

```
bb pr-board board [--refresh] [--json]
bb pr-board open <n | owner/repo#n | PR URL> [--json]
bb pr-board review <n | owner/repo#n | PR URL> [--json]
bb pr-board findings <n | owner/repo#n | PR URL> [--json]
bb pr-board address <n | owner/repo#n | PR URL> [--json]
bb pr-board submit-address <n | owner/repo#n | PR URL> [--json]
bb pr-board suggestions <n | owner/repo#n | PR URL> [--json]
```

See `skills/pr-board/SKILL.md` for the output formats.

## Storage

The plugin database keeps the PR of each review and address thread, the
findings, the comment suggestions, and pending comments. Accepted changes go
only to the address thread's worktree. Nothing reaches GitHub until you post a comment, reply,
resolve a thread, mark a file viewed, or submit a review.

## Limits

- The review worktree and every `gh`, `git`, and `gopls` call run on the bb
  server machine.
- File contents come from GitHub's contents API at the merge base and the head;
  files over 2 MB show the patch only.
- Findings keep the head commit they were recorded on. After new commits they
  show **outdated**, and their lines may have moved.
- Go to definition needs the review worktree. On the head side it uses the
  checked-out files, so local edits in the worktree can shift gopls results.
- The board reads the 100 most recently updated open PRs per repository and up
  to 100 review threads per PR. The Comments tab shows the last 100
  conversation comments and reviews.
- Suggestion previews read the address thread's worktree, so they need that
  thread to exist and its environment to be on the bb server machine.

## Development

```sh
npm run check   # typecheck, tests, build
bb plugin dev   # rebuild and reload on save
```
