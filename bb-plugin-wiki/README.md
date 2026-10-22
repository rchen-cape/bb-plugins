# Wiki

An organized wiki of your projects, topics, and processes. Your daily notes
feed into it through an inbox you review, and everything is searchable.

The Wiki is a folder of Markdown files (`~/Wiki` by default). Each doc is one
topic, project, process, or service. Nothing is written into it without you: the daily
ingest only moves your own lines, word for word, and you accept each move.

## Install

```sh
npm install
bb plugin install .
```

That adds the **Wiki** page to the sidebar, the `bb wiki` command, the
`wiki_search`, `wiki_get`, and `wiki_add` agent tools, and the `wiki` skill.

## Daily ingest

Once a day the Wiki reads your daily notes and turns new lines into inbox
cards. It reads files named `MM-DD-YY.md` anywhere under the Notes folder, and
only the part under a `### NOTES` heading (any heading level, any case). It
ends at the next heading of the same or a higher level.

Each top-level list item, or a paragraph, becomes one card. These markers decide
where a card goes:

- **`@tag` lines.** A line made only of tags, like `@unified-notification @cc`,
  applies to everything after it in the block, until the next blank line.
- **Inline `@tags`.** A tag inside a line counts only when it matches a doc's
  tag or alias. `@George` is ignored.
- **`[[Doc]]` and `[[Doc#Heading]]`.** An explicit link sends the line to that
  doc, under that heading. A link to a doc that doesn't exist yet proposes a
  new topic doc. No AI is used.
- **`@skip`.** Leaves the line, or the whole block, out of the Wiki.

Each card shows which rule decided it: `explicit [[link]]`, `tag`,
`Claude Code`, or `no rule`, with a one-line reason. Cards from other plugins
show `picked when sent` when the sender chose the doc.

Today's note and future-dated notes are never read, because you are still
writing them. Notes that haven't changed since the last run are skipped, and a
line that was already accepted or skipped never comes back.

The ingest runs at **Daily ingest time** (`07:00` by default) in your time
zone. If bb was off at that time, it runs once bb is back that day, and the
next run picks up any day it missed. To run it right away, open the **⋯** menu on the Wiki page and pick **Run ingest now**,
or run `bb wiki ingest`.

On the first run it reads the last 7 days of notes. Set **Ingest notes from**
to start earlier, or run `bb wiki ingest --since 2026-01-01` once.

## Review the inbox

Open **Inbox** on the Wiki page, or run **Wiki: review inbox**. Each card shows
your lines with line numbers, the rule that routed it, and one row per
destination: a doc, a heading, and the lines that go there.

| Key | Does |
| --- | --- |
| `A` | Accept: write the card into its included destinations |
| `S` | Skip: the lines never come back |
| `J` / `↓` | Next card |
| `K` / `↑` | Previous card |
| `Esc` | Stop choosing lines |

- **Change a destination.** Untick it, pick another doc or heading, or add one.
  **New doc…** creates a doc when you accept.
- **Choose lines.** Click a destination's line chip, then click line numbers.
  Shift-click picks a range. One card can send different lines to different
  docs.
- **Did you mean.** For a tag that isn't a doc yet, the card suggests close
  matches: "`@cc` isn't a Wiki doc yet. Did you mean **Adding config
  catalog**?" **Yes, remember @cc** adds `cc` as that doc's alias when you
  accept, so the tag works from then on.
- **Preview change.** Shows the exact diff each destination will get.

When a topic or process doc gets the content and the block's tag names a
project doc, the project doc gets a link line instead of a copy:
`- See [[Doc title]] (from 10-14-26)`. Each fact has one home.

Accepting copies the selected lines word for word. The only changes are
removing their shared indent and pointing images at the Wiki's `assets/`
folder, where the images are copied.

Cards that another plugin sent, like an image from Sketch, say where they came
from ("From Sketch · Roadmap.png") and show each image as a thumbnail. A card
an agent sent from a thread also shows **Sent by an agent**, and only you can
accept it. They start with the doc and heading picked when they were sent
(`picked when sent`), or with an unticked new doc when none was picked.
**Preview change** shows the `assets/` path each image will get. Skipping
writes nothing and keeps the image, so **Undo** still works. Accepting copies
the image into `assets/` and then deletes the card's own copy.

## Add to Wiki

You can also add things on purpose. A dialog always shows the text and the
destination before anything is written.

- **From a message.** Click **Add to Wiki** in a chat message's action bar.
  Select text first to add only the selection. Images attached to the message
  can come along.
- **From a code block.** Hover a code block in an assistant message that has
  a common language tag (ts, python, bash, json, …) and click **Add to Wiki**.
  Code blocks with no language tag, or whose language another plugin also
  claims, don't get the button; select the text and use the message's
  **Add to Wiki** instead. Turn this off with **Add to Wiki on code blocks**.
- **Drag and drop.** Drop files on the Wiki page: `.png`, `.jpg`, `.gif`,
  `.webp`, `.mp4`, `.mov`, `.webm`, `.md`, `.txt`. Markdown and text files fill
  the text; images and videos are copied to `assets/` with a caption. A single
  `.md` file can become a new doc. **Describe with Claude** drafts an image
  caption you can edit; it is saved only if you save it.
- **New doc.** **New doc** on the Wiki page asks for a title, type, aliases,
  and body. **Check for existing docs** looks for docs that cover the same
  thing. If it finds any, it shows "This might already belong in …" and lets
  you add to that doc instead, or **Create new doc anyway**.

The dialog suggests where the text belongs ("Best match: Unified
notification › Global token"), from a local search of your docs. Press
`⌘Enter` to add.

## From other plugins

Other plugins can add to the Wiki through its RPC methods. `addToDoc` writes
straight into a doc. `addCard` files an image, with optional Markdown text, as
an inbox card for you to review:

```ts
await bb.sdk.plugins.callRpc({
  pluginId: "wiki",
  method: "addCard",
  input: {
    name: "Roadmap.png",
    text: "Q3 plan, first draft",
    media: [{ from: { kind: "path", path: "/abs/path/roadmap.png" }, caption: "Q3 roadmap" }],
    target: { kind: "existing", slug: "unified-notification" },
    heading: null,
    threadId: null,
  },
  outputSchema: z.object({ id: z.string() }),
});
```

- `media` takes images only (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), as an
  absolute path or an upload id. The Wiki copies each one right away, so the
  file can be deleted after the call.
- `target` and `heading` are the proposed destination, or `null`. The heading
  defaults to `Unsorted`, or `Notes` for a new doc.
- The card shows the calling plugin's name, taken from the call itself. A call
  from the app or `bb plugin rpc call` shows as **Upload**.
- `threadId` is the thread a command ran in when an agent sent the card (for
  example `bb sketch send` inside a thread), else `null`. Such a card shows
  **Sent by an agent**, and `bb wiki accept` from a thread refuses it.
- Nothing is written until you accept the card. Accepted blocks carry an
  `upload="<name>"` source marker.

## Find things

- **Search.** Press `⌘⇧K` anywhere in bb, or `/` on the Wiki page. Results show
  docs first, then matching sections with the heading and a snippet. Words
  match as prefixes, so "notif" finds "notification".
- **Browse.** With no query, the Wiki page lists docs grouped as Topics,
  Projects, Processes, and Services. Topics are the catch-all; a service doc
  covers one running system or codebase (how it works, config, APIs).
- **Read and edit in place.** A doc shows its type, tag, aliases, and the docs
  that link to it. Click into the text and type: there is no separate edit
  mode. The text looks rendered, and a Markdown mark (`**`, `#`, `[[…]]`)
  shows only while the cursor is on it. The title shows once, in the header.
  Type `/` on an empty line for headings, lists, to-dos, quotes, code, a
  divider, or a table.
- **Autosave.** Edits save about a second after you stop typing, at least
  every 5 seconds while you keep typing, and when you leave the doc, switch
  windows, or press `⌘S`. Next to "Updated" you see "Saving…", "Saved",
  "Unsaved changes", or "Couldn't save". If the file changed on disk while
  you had unsaved edits, you choose **Reload** or **Overwrite**. If it was
  deleted on disk, **Overwrite** saves it again with your edits and **Discard**
  drops them. Deleting a doc with edits that could not be saved deletes the
  edits too.
- **Highlight.** Select text and click **Highlight**, the first button of the
  formatting toolbar, or press `⌘⇧H`. It writes `==text==`, which shows as a
  yellow marker highlight. The toolbar also has bold, italic, strikethrough,
  code, and link.
- **Markdown.** The **Markdown** button in the header shows the raw file,
  frontmatter and source markers included. Click it again for the rendered
  view.
- **Source labels.** Each added block shows where it came from (for example
  "from 10-14-26 notes") in small, faint grey text above it. Hover it for the
  date it was added.
- **Copy link** copies `[[Doc title]]`.
- **Rename and delete.** Right-click a doc in the list, or use **Rename** and
  **Delete** on the doc page. A rename moves the file to match the new title and
  keeps the old name as an alias, so your `@tags` and `[[links]]` still find it.
  Inbox cards headed to the doc follow it. A delete removes the file after a
  confirmation; git history keeps a copy, and inbox cards headed there are
  switched off.

Agents use the same search:

| Tool | Does |
| --- | --- |
| `wiki_search` | Search docs and sections. An empty query lists recent docs. |
| `wiki_get` | Read a doc, or one heading of it, as Markdown. |
| `wiki_add` | Propose Markdown for the Wiki. It only creates a review card in the inbox, marked as written by an agent. |

Agent cards are never accepted for you, and `bb wiki accept` run from a
thread refuses them. The [skill](skills/wiki/SKILL.md) tells agents when to
search and how to propose additions.

## Settings

Change them in bb's plugin settings, or with
`bb plugin config wiki set <key> <value>`. A stored value that isn't valid
falls back to its default.

| Key | Default | What it does |
| --- | --- | --- |
| `wikiDirectory` | `~/Wiki` | Wiki folder. An absolute path or one starting with `~/`, created on first use. It can't be your home folder or hold it, and it can't overlap the Notes folder. |
| `notesDirectory` | `~/Notes` | Folder of daily notes. The Wiki only reads it. |
| `ingestTime` | `07:00` | Daily ingest time, 24-hour `HH:MM`. |
| `timezone` | empty | IANA time zone for the ingest time, like `America/New_York`. Empty uses the system time zone. |
| `ingestEnabled` | `true` | Run the daily ingest. **Run ingest now** works either way. |
| `routingAgent` | `true` | Ask Claude Code to suggest destinations. When off, cards are routed by links and tags only. |
| `routingModel` | empty | Model for the routing thread. Empty uses the provider default. |
| `ingestStartDate` | empty | Earliest daily note to ingest, a real date as `YYYY-MM-DD`. Empty starts 7 days before the first run. |
| `gitHistory` | `true` | Run `git init` in the Wiki folder and commit each change. Editor saves to one doc share one commit, made 30 s after the last save (at most 5 min after the first). |
| `codeBlockButton` | `true` | Show **Add to Wiki** on code blocks in assistant messages that have a common language tag. |

## CLI

| Command | Does |
| --- | --- |
| `bb wiki search [words…] [--type <type>] [--limit <n>]` | Search docs and sections. No words lists recently updated docs. Alias `find`. |
| `bb wiki show <doc> [--heading <heading>]` | Print a doc, or one heading of it, as Markdown. `<doc>` is a slug, title, alias, or `Title#Heading`. Aliases `get`, `cat`. |
| `bb wiki docs [--type <type>]` | List docs: slug, type, title, aliases. Aliases `list`, `ls`. |
| `bb wiki inbox [--status open\|accepted\|skipped]` | List inbox cards. Default `open`. Cards from other plugins show as `upload: <name>`, with their first text line, or the name when they hold only images. |
| `bb wiki accept <card>` | Accept a card into its included destinations. From a thread, this refuses cards written or sent by an agent. |
| `bb wiki skip <card>` | Skip a card so it never comes back. |
| `bb wiki restore <card>` | Put a skipped card back in the inbox (alias `unskip`). The skip toast in the Wiki page has an **Undo** button that does the same. |
| `bb wiki ingest [--since YYYY-MM-DD] [--no-agent]` | Run the ingest now. `--since` re-reads notes from that date, even unchanged ones. `--no-agent` routes by links and tags only. |
| `bb wiki import <folder…> [--no-agent]` | Chunk reference notes in folders of the notes folder (for example `Projects`, `Tools`) into inbox cards: one card per heading section, long sections split between top-level blocks (never inside a code block or table). The subfolder name (or the file name) is the tag hint, and the section heading is the default heading. Daily-note files and saved web pages (`*_files`) are skipped. |
| `bb wiki add --doc <doc> \| --new <title> [--type <type>] [--heading <heading>] --text <md>` | Add Markdown under a heading (default `Unsorted`, or `Notes` for a new doc). From a thread, this files a review card instead. |
| `bb wiki tidy-unsorted` | Move each doc's old `## Unsorted` section below the `---` line at the bottom of the doc (one git commit). New docs already work this way: text with no heading goes under a horizontal line at the end, and real headings stay above it. |
| `bb wiki new --title <title> [--type <type>] [--alias <tag>]… [--body <md>]` | Create a doc. From a thread, this needs `--body` and files a review card instead. |
| `bb wiki alias <doc> <alias>` | Add an alias tag to a doc. |
| `bb wiki rename <doc> <title>` | Rename a doc; the old name stays as an alias. |
| `bb wiki delete <doc>` | Delete a doc (aliases: `rm`, `remove`); git history keeps a copy. |
| `bb wiki reindex` | Re-read the Wiki folder into the search index. |
| `bb wiki status` | Show the folders, counts, last ingest, and the tags file path. |

`<type>` is `project`, `topic` (the default), or `process`. Every command
takes `--json`.

## Notes autocomplete

The Notes panel can complete Wiki doc names when you type `@`. Point it at the
Wiki's tag list:

```sh
bb plugin config notes set wikiTagsFile ~/Wiki/.wiki/tags.json
```

Notes lists docs by tag, title, or alias, and inserts the doc's tag. It only
reads that file. The Wiki rewrites it whenever a doc's title, type, or
aliases change.

## Where the files live

```
~/Wiki/
├── adding-config-catalog.md      one doc per file; subfolders work too
├── unified-notification.md
├── assets/                       copied images and videos
├── .wiki/tags.json               doc tags for Notes autocomplete
└── .git/                         one commit per change (editor saves grouped), when git history is on
```

A doc is plain Markdown with optional frontmatter (`title`, `type`,
`aliases`). Every added block starts with a hidden comment that says where it
came from, like `<!-- wiki:source notes="10-14-26.md" date="2026-10-14" … -->`.
The Wiki shows it as "from 10-14-26 notes". You can edit the files with any
editor; the Wiki picks up changes as they happen.

The files are the source of truth. The plugin's SQLite database
(`<bb data dir>/plugins/wiki/`) holds only the search index, which
`bb wiki reindex` rebuilds, plus the inbox and ingest bookkeeping. Dropped
files wait in its `uploads/` folder and are deleted after 24 hours. Images on
inbox cards from other plugins live in its `card-media/<card id>/` folder, which
the 24-hour cleanup leaves alone; accepting copies them into `assets/` and then
deletes the folder, and skipped cards keep theirs so they can be restored.

## Privacy and safety

- **Your words only.** Automatic ingest never writes new text. Claude Code
  picks the doc, heading, and line ranges; the lines themselves are copied
  from your note. Text an agent wrote reaches the Wiki only as an inbox card
  that you accept.
- **Append only.** The Wiki adds blocks under headings, creates headings and
  docs, and adds aliases. It never changes or removes existing text, except
  when you edit a doc yourself.
- **Notes stay untouched.** The Wiki never writes to the Notes folder.
- **How routing runs.** Routing uses Claude Code in a hidden thread in your
  personal project, in accept-edits permission mode. Of the Wiki's own tools,
  that thread gets only `wiki_search`, `wiki_get`, and `wiki_record_routes`,
  and its prompt tells it not to run commands or touch files. As in any bb
  thread, Claude Code's built-in tools (such as Bash, Read, and Edit), bb's
  own tools, and other plugins' tools are still there; only the prompt keeps
  the thread off them, and in accept-edits mode edits inside its workspace run
  without asking. It is archived when done. If routing fails or takes more
  than 15 minutes, cards fall back to links and tags. Turn **Suggest routes
  with Claude Code** off to route by links and tags only. **Describe with
  Claude** works the same way; its only Wiki tool is
  `wiki_record_description`.
- **What leaves the machine.** Docs, the index, and git history stay local,
  and the Wiki needs no account or API key. A routing thread sends the card's
  lines and a catalog of doc titles, headings, and short excerpts to Claude
  Code, like any bb thread does. **Describe with Claude** sends the image.

## Not in this version

Local embedding search, "Ask the Wiki" with sources, a weekly duplicate check,
and undo for an accepted card (use git history for now). Video transcripts
will not be built.

## Develop

```sh
npm install
npm run check        # typecheck, tests, build
bb plugin dev        # rebuild and reload on save
```

`@get-bb/plugin-sdk` comes from `vendor/`, the same SDK tarball Project Trees
uses. [SPEC.md](SPEC.md) is the full design.

## Layout

| Path | What it holds |
| --- | --- |
| `server.ts` | Server entry: wires the parts below and syncs the index at start. |
| `contract.ts` | RPC contract and shared zod schemas. |
| `server/context.ts` | Settings, folder checks, and the shared context. |
| `server/vault.ts` | Wiki folder: reads, atomic appends, index sync, `tags.json`, git. |
| `server/store.ts` | SQLite index, full-text search, inbox, and job tables. |
| `server/ingest.ts`, `server/schedule.ts` | The ingest run and its daily schedule. |
| `server/cards.ts` | Card routing rules, preview, accept, and skip. |
| `server/routing.ts` | Claude Code routing and image-description threads. |
| `server/rpc.ts`, `server/http.ts`, `server/media.ts` | RPC handlers, asset, card image, and upload routes, media copying. |
| `server/tools.ts`, `server/cli.ts` | Agent tools and `bb wiki`. |
| `server/suggest.ts`, `server/write.ts`, `server/maintenance.ts` | "Best match" suggestions, write helpers, upload cleanup. |
| `lib/daily-notes.ts` | Daily note parsing: `### NOTES`, blocks, tags, links. |
| `lib/markdown-doc.ts` | Frontmatter, headings, append, and source markers. |
| `lib/fuzzy.ts`, `lib/slug.ts`, `lib/wiki.ts` | Did-you-mean matching, slugs and tags, shared constants. |
| `lib/card-media.ts` | Image lines (with caption escaping), first lines, and source labels of cards from other plugins. |
| `app.tsx` | App entry: sidebar page, message action, code block button, commands. |
| `lib/live-preview/` | The live-preview Markdown editor shared with Notes (CodeMirror 6): rendering, `==highlight==`, toolbar, slash menu, byte-exact load and save. |
| `components/wiki-editor.ts`, `components/use-live-doc.ts`, `components/autosave.ts` | The Wiki's editor extensions (wiki links, embeds, source labels, hidden title), the doc's editor session, and autosave. |
| `components/` | Wiki page, doc view, inbox and card view, dialogs, search. |
| `skills/wiki/SKILL.md` | Agent skill. |
