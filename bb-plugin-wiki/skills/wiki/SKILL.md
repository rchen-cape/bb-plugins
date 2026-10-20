---
name: wiki
description: Search and read the user's Wiki of topic, project, process, and service docs, and propose additions to it, with the wiki_search, wiki_get, and wiki_add tools or the bb wiki CLI. Use when the user asks what they know, wrote, or decided about something, mentions the Wiki or a Wiki doc, or asks to save something to the Wiki.
---

# Wiki

The Wiki is the user's organized notes: one Markdown doc per topic, project, process,
or service, in a folder on their machine (`~/Wiki` by default). Daily notes
feed into it through an inbox the user reviews. The user reads and edits it on
the Wiki page in the bb sidebar.

## Finding things

When the user asks what they know, wrote, or decided about something, search
the Wiki before answering from memory:

1. `wiki_search` with a few distinctive words (`query`, optional `limit`,
   default 10, max 50). Prefixes match, so "notif" finds "notification". An
   empty query lists recently updated docs. It returns docs (slug, type,
   title) and sections (slug#anchor, heading, snippet).
2. `wiki_get` with `doc` set to the slug, title, alias, or `@tag`
   (`"Title#Heading"` also works), plus `heading` to read one section and its
   subheadings. Lines like `(source: from 10-14-26 notes)` say where each
   block came from.
3. Answer from what you read and name the doc title.

Without the tools:

```
bb wiki search <words> [--type project|topic|process] [--limit <n>] [--json]
bb wiki show <doc> [--heading <heading>] [--json]
bb wiki docs [--type project|topic|process] [--json]
bb wiki status [--json]
```

## Adding things

Agents never write Wiki docs directly. Do not create, edit, or move files in
the Wiki folder, and do not run git there.

When the user asks to save something to the Wiki, call `wiki_add` with
self-contained Markdown (`text`), in the user's terms. Pass `doc` (slug,
title, alias, or `@tag`) and `heading` (default `Unsorted`, which means under the `---` line at the bottom of the doc) when you know
where it belongs (search first), or `title` for a new doc. The text
becomes a card in the Wiki inbox, marked as written by an agent; nothing is
written until the user accepts it there. Tell the user the card id it returns.

From inside a thread, `bb wiki add` and `bb wiki new --body` also file inbox
cards instead of writing, `bb wiki accept` refuses agent-written cards and
upload cards an agent sent from a thread (like `bb sketch send` there), and
`bb wiki alias`, `bb wiki rename` and `bb wiki delete` are refused there; only the
user adds aliases, renames docs, or deletes them.
In a Wiki routing or image-description thread, record results only with that
job's tool (`wiki_record_routes` or `wiki_record_description`); `wiki_add`
and every `bb wiki` command that changes the Wiki or its inbox are refused
there.

## Inbox and ingest

```
bb wiki inbox [--status open|accepted|skipped] [--json]
bb wiki accept <card_id>
bb wiki skip <card_id>
bb wiki restore <card_id>
bb wiki ingest [--since YYYY-MM-DD] [--no-agent]
bb wiki import <folder…> [--no-agent]
```

Accept or skip a card only when the user asks for that card. Each daily note
unit is copied word for word; routing only picks the doc, heading, and lines.
Cards listed as `upload: <name>` hold images sent from another plugin, such
as Sketch, by the user or by an agent in a thread; accepting copies the images
into the Wiki's `assets/`.

## Other commands

```
bb wiki add --doc <doc> | --new <title> [--type] [--heading] --text <md>
bb wiki new --title <title> [--type] [--alias <tag>…] [--body <md>]
bb wiki alias <doc> <alias>
bb wiki rename <doc> <title>
bb wiki delete <doc>
bb wiki reindex
```

Use only slugs, titles, and card ids that search, docs, or inbox print.
