An organized wiki of your projects, topics, and processes, fed by your daily notes.

## What you get

- A **Wiki** page in the sidebar: one Markdown doc per topic, project, process,
  or service, grouped by type, with fast search and a Markdown editor.
- A **daily ingest** that reads your past daily notes and turns new lines into
  inbox cards. Tag a block with a line like `@unified-notification`, link a
  line with `[[Doc]]` or `[[Doc#Heading]]`, or leave it out with `@skip`.
- An **inbox** to review where each note belongs. Every card shows the rule
  that routed it, the doc and heading for each destination, and a preview of
  the change. Press `A` to accept, `S` to skip, and `J`/`K` to move between
  cards. Click line numbers to send different lines to different docs.
- **Did you mean** suggestions for tags that aren't docs yet. Confirm one and
  the tag becomes that doc's alias.
- **Add to Wiki** on every chat message and on code blocks tagged with a common
  language (ts, python, bash, json, …), and drag and drop for
  images, videos, Markdown, and text files. A dialog suggests the best doc and
  heading before anything is written.
- **New doc** checks for existing docs first, so the same thing doesn't end up
  in two places.
- Search from anywhere with `⌘⇧K`, and agent tools so agents can look up what
  you wrote and propose additions.
- `@` completion of Wiki doc names in the Notes panel.

## Your words, your files

Nothing an AI wrote enters the Wiki unless you accept it. The daily ingest
copies your own lines word for word. Claude Code only suggests which doc,
heading, and lines they go to, and you can turn that off to route by tags and
links alone. When an agent saves something, it lands in your inbox as a card
marked as written by an agent.

The Wiki only adds to docs. It never rewrites or removes what is there, and it
never writes to your notes folder. When a fact belongs in a topic doc, the
project doc gets a link to it instead of a copy.

## How it works

The Wiki is a folder of plain Markdown files, `~/Wiki` by default, with copied
images in `assets/`. Edit the files with any editor and the Wiki picks up the
changes. Each change is also a git commit in that folder, unless you turn it off. The
plugin's database holds only a search index, which it can rebuild, plus the
inbox. Routing runs Claude Code in a hidden thread in your personal project,
whose only Wiki tools are search, get, and record-routes; its prompt tells it
not to run commands or edit files, though Claude Code's own tools are still there.
