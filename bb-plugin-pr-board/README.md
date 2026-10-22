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
- PRs that involve you without you having commented on or reviewed them, such
  as ones that @-mention you;
- PRs where someone requested your review directly (team requests do not count);
- PRs you commented on or reviewed where your comment is still the latest, in
  an unresolved review thread or the conversation, so it waits for a reply.

It finds them with two GitHub searches, `involves:@me` and
`user-review-requested:@me`, each the 30 most recently updated open PRs.

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
reply (red warning sign), the review thread's state, and, for PRs with an
address thread, its worktree's changes: **N uncommitted** (amber, changed
files), **N to push** (commits not pushed yet), or **Pushed** (green, when
everything from Address comments is pushed). A comment waits for
your reply when it is an unresolved code comment whose latest reply is not
yours, or a conversation comment or review with text posted after your latest
comment, review with text, approval, change request, or dismissed review.
Approvals and dismissed reviews do not wait for a reply. On PRs you did not open, only code comments you replied in and
conversations you posted in count. Comments from bots, GitHub Actions, and
Copilot do not count.
Filter by text with the search box.

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
<time>** after, where the time is when the server last read GitHub. It returns to
where you scrolled.

To stay within GitHub's API limit (5,000 GraphQL points an hour, shared with
everything else that uses your `gh` login), the board refreshes cheaply:

- While the board is on screen it checks every minute, and once when it
  becomes visible again; it does not check while hidden. The server reuses a
  check for 50 seconds, so going in and out of the board costs nothing, and
  live updates from review threads also wait until the board is visible.
- A check runs the two searches for only each PR's id, last update time, and
  CI status (about 1 point each). CI status updates the cards directly.
- Full details (comments, reviews, and the newest 30 review threads) are
  fetched only for PRs that are new, changed since the last check, or that you
  acted on from PR Board, and for every PR at least every 15 minutes.
- **Refresh** checks right away and fetches every PR's details again.

## Review page

Click a card to open `/plugins/pr-board/board/pr/<owner>/<repo>/<n>`. Opening
a PR starts only its explain thread (see [Explaining](#explaining)), not a
review. **Run review** starts a review thread when the PR has no live one:

- in the project whose git remote matches the repository, or the **Review
  project** setting;
- in a `git-worktree` environment on `origin/<head branch>` (the default branch
  for PRs from forks), where `gh pr checkout <n>` runs once the worktree is
  ready;
- with a first message that asks for a short, plain summary of the PR;
- followed by `/thermo-nuclear-code-quality-review review pr <n>`, sent after
  the checkout and queued behind the summary. The message asks the agent to
  record its findings with the `pr_board_record_findings` tool. Each finding
  becomes a PR comment when you click **Comment**, so the message also asks
  the agent to write titles and explanations by the Document rules of the
  `simple-english` skill, and to lint them with its `ste_lint.py --type
  descriptive --gate` before it records them.

The review thread's chat is the page's **Review thread** panel tab, the
address thread's chat is the **Address thread** tab beside it, and the explain
thread's chat is the **Explain thread** tab. The
**Review diff** button in a review thread's header opens the page from the
thread.

A PR's page also opens from the cache when you come back to it, on the file
you last viewed, and refreshes in the background. The server keeps each PR it
has loaded in the plugin database, so this survives restarts, and only fetches
it again when it changed:

- Within 50 seconds of the last look it reuses the saved PR with no GitHub
  call.
- After that it runs one tiny query (last update time, head commit, and which
  review threads are resolved) and reuses the saved PR when nothing changed. If
  the board checked the PR in the last 50 seconds and it has not been updated,
  it skips even that.
- Only a change, a PR Board action on the PR, or the page's refresh fetches the
  PR, its files, viewed states, and merge base again. Marking a file viewed in
  PR Board updates the saved PR; marking it on GitHub's website is not noticed
  until the PR changes.

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
- **Changes** (once the PR has an address thread): see
  [Tracking fixes](#tracking-fixes).
- **Description**: the PR body.
- **Run review**: starts the review thread, or sends the review command to it again.
- **Address comments** (under Run review): see below.

### Explaining

Each PR has an explain thread. It starts by itself the first time you open the
PR's page or its **Explain thread** tab, so there is no button. It runs on
Claude Code in the project's default environment (it reads the PR with `gh`,
not from a checkout of the PR head), with no PR Board tools, and its first
message loads the `/simple-english` skill. Every answer follows that skill's
Reply rules: plain prose with the answer first, terms defined at first use, and
no headers, bullets, bold, or em-dashes. Before each answer, the thread runs
the skill's linter (`ste_lint.py --type reply --gate`) on its draft and fixes
what it finds. The thread only reads. It does not edit files, check out
branches, or post to GitHub.

To ask about part of the PR:

1. Select text anywhere on the page: code in the diff, the description, a
   comment, a review comment, or a finding.
2. A bar at the bottom of the diff shows where the selection came from and a
   preview of it. Type a question, or leave it empty to ask what it means.
3. Press **Explain**. The selection, its source, and your question go to the
   explain thread, and the **Explain thread** tab opens.

`Esc`, the close button, or a click elsewhere closes the bar.

The skill must be installed in Claude Code at `~/.claude/skills/simple-english`,
with the linter beside it in `scripts/`. From a copy of
<https://github.com/AminBlg/SimpleEnglish>, copy `skills/simple-english/` to
that folder, then copy `evals/ste_lint.py` and `evals/slop.tsv` to its
`scripts/` folder. The repository's Claude Code plugin also works, but its
session hook loads the rules into every Claude Code session, not only the
explain thread.

### Addressing comments

**Address comments** starts a separate address thread for the PR, in its own
`git-worktree` environment on the PR's head (checked out with `gh pr checkout`
like the review thread). It lists only the comments waiting for your reply, by
the same rule as the board's red count: unresolved code comments where someone
else replied last, and conversation comments or reviews with text from others
posted after your last conversation reply (bots skipped). It asks for a short
summary, and then, once the checkout is done, a suggestion per listed comment.
When no comment is waiting for your reply, it says so and starts nothing.

If the PR is part of a stack (open PRs in the same repository whose branches build
on each other), the thread is told the whole stack, bottom first, found with one
query of the repository's open PRs (about 1 API point per click). Before suggesting
a change, it checks the PRs above with `git` (no API calls): if one already makes
the change, it suggests only a reply such as "Addressed in #123". If the code a
comment is about comes from a PR below, it says the fix belongs there and suggests
only a reply.

Clicking it
again reloads the PR, moves the thread's worktree to the PR's latest commit
with `git pull --ff-only` (keeping accepted changes), and sends the current
comments to the same thread; its new suggestions replace the old ones. If the
worktree cannot fast-forward, for example because an accepted change conflicts
with the new commits, nothing is sent and git's error is shown.

By default the thread does not edit files. If you ask it in the thread to fix
a specific comment itself, it edits the worktree and links the change to that
comment with the `pr_board_record_fix` tool (see
[Tracking fixes](#tracking-fixes)). It records suggestions with the
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

### Tracking fixes

PR Board links each change in the address thread's worktree to the comment it
addresses, in two ways:

- **Accept change** records the suggestion's files for its comment.
- When you ask the address thread to fix a comment, it calls
  `pr_board_record_fix` with the comment id and the files it changed. The tool
  refuses comment ids that are not on the PR and files that have no change in
  the worktree or in a commit made there since the thread started, so the
  agent fixes the call and tries again.

The **Changes** tab, beside Comments, works like VS Code's Source Control view
for the address thread's worktree:

- **Uncommitted**: changed files with a status letter (`M` modified, `A`
  added, `D` deleted, `R` renamed, `U` untracked).
- **Committed, not pushed**: commits made in the worktree that are not on the
  PR branch's upstream yet. Click one to list its files.
- **Pushed**: commits made in the worktree that are on the upstream.

Commits made elsewhere, such as a teammate's commits pulled into the worktree,
are left out: only commits the worktree's reflog shows were made there count.
Each file or commit shows the comments it addresses; click one to jump to that
comment. Click a file to see its diff. The tab updates when PR Board or the
address thread changes something, when the thread finishes a turn, every 10
seconds while it works, and from its refresh button.

Each comment with a linked fix shows **Uncommitted fix**, **Committed abc1234 ·
not pushed**, or **Pushed abc1234**. Hover it for the files and whether the fix
came from an accepted suggestion or from asking in the address thread. A fix
counts as committed in the first commit after it that touches its files, and
shows nothing once its files have neither a change nor such a commit (for
example after you discard it).

`bb pr-board submit-address` sends the address thread one
message. It runs the check, lint, typecheck, build, and test steps of the
repository's pull-request GitHub Actions workflows on its worktree and lists
what it had to skip. When a check fails, it may fix it only with edits that do
not change behavior: formatter output, lint and style fixes, import order,
unused imports, type annotations, comments, and regenerated files or lockfiles.
It never changes logic, tests, or test expectations, and never disables rules
or skips checks. If a check still fails, or needs a logic change, it undoes its
own fixes and stops without committing or pushing. If they pass, it commits
the accepted changes, commits its fixes separately and lists them, merges new
commits from the PR branch (aborting on a conflict), and checks that every
commit it made is signed with your git signing key (`git commit -S`, never
`--no-gpg-sign`; it stops before pushing if one is not) and attributed to you
alone, with no `Co-Authored-By: Claude` trailer or other AI attribution in the
message (it rewords any unpushed commit that has one). Then it pushes to the
PR's head branch without force, and watches `gh pr checks`. It never merges the
pull request. It needs an address thread, and the server refuses when
that thread's worktree has no changes.

The diff layout is **Auto** by default: split when the diff area is at least
860 pixels wide, unified when it is narrower. **Split** and **Unified** fix it.
The ↑ and ↓ buttons step through the files.

On a page narrower than 900 pixels, such as a vertical monitor with the thread
panel open, the file list and findings move into a collapsible panel above the
diff (the list button toggles it), the header's actions move to their own row,
and toolbar buttons show icons only.

### Commenting

Click a line number (or hover it and click **+**), or drag across line numbers for a
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
review thread's worktree, or, when the PR has none, in the checkout of the bb
project whose git remote is the PR's repository, so no agent is needed:

- Go code on the PR's head uses gopls, kept running per worktree like an
  editor's language server, so lookups after the first answer at once. It stops
  after ten idle minutes. Definitions in the standard library and module cache
  open read-only.
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
bb pr-board changes <n | owner/repo#n | PR URL> [--json]
```

See `skills/pr-board/SKILL.md` for the output formats.

## Storage

The plugin database keeps the PR of each review, address, and explain thread (with the
commit the address thread started from), the findings, the comment
suggestions, the fixes linked to comments, and pending comments. Commit and
push state is read from the worktree with `git`, not stored. Accepted changes go
only to the address thread's worktree. Nothing reaches GitHub until you post a comment, reply,
resolve a thread, mark a file viewed, or submit a review.

## Limits

- The review worktree and every `gh`, `git`, and `gopls` call run on the bb
  server machine.
- File contents come from GitHub's contents API at the merge base and the head;
  files over 2 MB show the patch only.
- Findings keep the head commit they were recorded on. After new commits they
  show **outdated**, and their lines may have moved.
- Go to definition needs the review worktree or a local checkout. On the head
  side it uses the checked-out files, so local edits in the worktree can shift gopls
  results.
- The board reads the 30 most recently updated open PRs from each of its two
  searches and the newest 30 review threads per PR, so counts on PRs with more
  threads leave out the oldest ones. The review page still reads up to 100
  review threads, and the Comments tab shows the last 100 conversation comments
  and reviews.
- A change GitHub does not count as an update to the PR, such as someone
  resolving a thread on GitHub, can take up to 15 minutes to show on the board
  unless you press **Refresh**.
- Suggestion previews read the address thread's worktree, so they need that
  thread to exist and its environment to be on the bb server machine.

## Development

```sh
npm run check   # typecheck, tests, build
bb plugin dev   # rebuild and reload on save
```
