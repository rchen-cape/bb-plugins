# Wiki plugin spec

The Wiki is the organized brain that daily work feeds into. Notes is where daily work happens (time-ordered). The Wiki is organized by subject: projects, topics, and processes. It gathers daily notes, suggests where each piece belongs, and makes everything easy to search.

This file is the build contract. Section 13 lists who owns which file.

## 0. Invariants (never break these)

1. **No AI-written text enters the Wiki without the user approving it.** Automatic ingest only *moves the user's own words* (verbatim lines). The AI chooses destinations and line ranges, never text. Exceptions the user approved:
   - "Add to Wiki" from a thread message, the code block button, drag and drop, and manual docs. The user did these on purpose and confirms the destination in a dialog before anything is written.
   - An image description written by Claude Code. It is shown in an editable field and is only saved when the user saves.
   - Text from the `wiki_add` agent tool. This always becomes a **pending inbox card**, marked as written by an agent, and never writes directly.
2. **Append, don't rewrite.** Writes only ever add a block under a heading, create a heading, create a doc, or add an alias to frontmatter. The plugin never edits or removes existing doc text. The only exception is when the user edits a doc in the Wiki editor.
3. **One home per fact.** When content belongs to a topic or process doc, the project doc gets a *template* link line (`- See [[Doc title]] (from 10-14-26)`), never a copy.
4. **Wiki and Notes stay separate.** The Wiki only ever *reads* the notes folder. The only contract is the file format: the daily note name `MM-DD-YY.md`, the `### NOTES` heading (an optional trailing colon is allowed), and `@tag` lines. In the other direction, Notes reads `<wiki>/.wiki/tags.json` and never imports Wiki code.
5. **Files are the source of truth.** `~/Wiki/*.md` plus `~/Wiki/assets/` hold everything. The plugin's SQLite database is an index (rebuildable) plus inbox and ingest bookkeeping.
6. **Predictable.** Each card shows which rule decided its routing, and why.

## 1. Location, packaging

- Folder: `~/Development/bb-plugins/bb-plugin-wiki`. Package name `bb-plugin-wiki`, so the plugin id is `wiki`. Same layout as `bb-plugin-library`: `server.ts`, `app.tsx`, `contract.ts`, `components/`, `lib/`, `server/`, `skills/wiki/SKILL.md`, `assets/icon.svg`.
- SDK: `"@get-bb/plugin-sdk": "file:vendor/get-bb-plugin-sdk-0.6.43.tgz"`, with the tgz copied from `../bb-plugin-trees/vendor/`. This matches the user's running bb (fork, 0.46.0).
- Scripts: `build: env -u BB_CLI bb plugin build .`, `typecheck: tsc --noEmit`, `test: vitest run`, `check: npm run typecheck && npm test && npm run build`.
- Vitest config, `vitest.global-tmpdir.ts` and `vitest.setup.ts` are copied from Trees, renamed.
- Runtime dependencies (bundled): `zod`, `yaml`, `cron-parser`, `diff`, `@radix-ui/react-slot`.
- Dev dependencies follow Library's list (react, sonner, radix, clsx, tailwind-merge, cva, vaul, better-sqlite3, jsdom, testing-library, vitest, typescript).
- Register it in `../.bb/plugins.json` and in the table in `../README.md`.
- AGENTS.md rule from the bb repo: **no code comments**, except semantic tool directives. Match Library's code style: small functions, zod at boundaries, no `as` casts except at true boundaries.

## 2. Settings (`bb.settings.define`)

| key | type | default | meaning |
|---|---|---|---|
| `wikiDirectory` | string | `~/Wiki` | Wiki folder. Created on first use. `~/` is expanded. |
| `notesDirectory` | string | `~/Notes` | Notes folder, read-only. |
| `ingestTime` | string `HH:MM` | `07:00` | Daily ingest time, local. |
| `timezone` | string | `""` (use system `Intl...resolvedOptions().timeZone`) | IANA zone for `ingestTime`. |
| `ingestEnabled` | boolean | `true` | Run the daily ingest. |
| `routingAgent` | boolean | `true` | Use Claude Code to suggest routes. If false, routing uses rules only. |
| `routingModel` | string | `""` (provider default) | Model for the routing thread. |
| `ingestStartDate` | string `YYYY-MM-DD` | `""` | Earliest daily note to ingest. Empty means 7 days before the first run (stored in kv `firstRunAt`). |
| `gitHistory` | boolean | `true` | `git init` the wiki folder and commit each change. |
| `codeBlockButton` | boolean | `true` | Show "Add to Wiki" on code blocks in assistant messages. |

Settings are read on every use, not cached, like Notes does.

## 3. Wiki folder format

```
~/Wiki/
  adding-config-catalog.md
  unified-notification.md
  assets/<slug>-<8 hex of sha256>.<ext>
  .wiki/tags.json
  .git/
```

- **Docs.** Docs are `*.md` files anywhere under the root, excluding `.wiki/`, `.git/`, `assets/` and dot-folders. A doc's **slug** is its path relative to the root, without `.md`, using `/`. New docs are created at the root as `slugify(title).md`. On a name clash, add `-2`, `-3`, and so on.
- **Frontmatter** (YAML, optional; parse it with `yaml`, and keep the raw block byte-for-byte when appending):
  ```yaml
  ---
  title: Adding config catalog
  type: process            # project | topic | process   (default topic)
  aliases: [config-catalog, cc]
  ---
  ```
- **Title.** The title is frontmatter `title`, else the first `# H1`, else the filename turned into words.
- **Tag.** A doc's tag (used for `@tag` and in `tags.json`) is `slugify(basename(slug))`. Aliases are normalized the same way: lowercase, `[a-z0-9-]`, no leading `@`.
- **Links.** `[[Title]]`, `[[slug]]`, `[[alias]]`, `[[Title#Heading]]` and `[[Title|label]]` are all supported. They resolve case-insensitively: slug first, then title, then alias, then tag. `![[file.png]]` and `![alt](assets/x.png)` embed assets.
- **Source marker.** Each appended block starts with an HTML comment on its own line:
  - `<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->`
  - `<!-- wiki:source thread="thr_abc" title="Thread title" added="2026-10-15" -->`
  - `<!-- wiki:source upload="name.mp4" added="..." -->`, `<!-- wiki:source manual added="..." -->`, `<!-- wiki:source agent thread="thr_x" title="..." added="..." -->`

  `lib/markdown-doc.ts` owns `formatSourceMarker` and `parseSourceMarkers`.
- **Append algorithm** (`insertUnderHeading(content, heading, block)`):
  1. Find a heading whose text equals `heading`, case-insensitive and trimmed, at any level, outside code fences.
  2. Insert `block` at the end of that heading's section: just before the next heading of the same or higher level, or at the end of the file. Put exactly one blank line before and after.
  3. If the heading is missing, append `\n## <heading>\n\n<block>\n` at the end of the file.
  4. The default heading is `Unsorted`.

  Never touch the frontmatter, except `addAlias(content, alias)`, which rewrites only the `aliases` key, keeping the order of other keys. Use the `yaml` Document API, or rebuild minimal frontmatter when there is none.
- **New doc template:**
  ```
  ---
  title: <title>
  type: <type>
  aliases: [<aliases>]
  ---

  # <title>

  ```
  The first block is then appended with `insertUnderHeading`. The default heading for a new doc is `Notes`. For a project doc, link lines go under the `Related` heading.
- **tags.json** (`<root>/.wiki/tags.json`). The Wiki rewrites it atomically after any index change, only when the content differs:
  ```json
  { "version": 1, "docs": [ { "tag": "adding-config-catalog", "title": "Adding config catalog", "type": "process", "aliases": ["cc", "config-catalog"] } ] }
  ```
  Docs are sorted by tag. Do not include a timestamp, so the file stays byte-stable.
- **Writes.** Writes are atomic: write a temp file in the same folder, then rename. Accept and add re-read the file just before writing and apply the append to the latest content. A per-root promise chain serializes all writes.
- **Git.** When `gitHistory` is on, `git init` runs on first write if `.git` is missing, and every write operation makes one commit. Run git with `execFile` (`git -C root add -A -- <paths>` then `git -C root commit -m <msg> --no-verify`) with a 15 s timeout. Try `git` on PATH, then `/usr/bin/git`, `/opt/homebrew/bin/git`, `/usr/local/bin/git`. Set `-c user.name=Wiki -c user.email=wiki@localhost` only if the repo has no user configured. A git failure is logged and never blocks the write.

## 4. Index (SQLite via `bb.storage.database()`, `server/store.ts`)

Migrations go through `bb.storage.migrate`. Only append; never edit a shipped statement.

Tables:
- **`docs`:** `slug PK, title, type, aliases JSON, tag, path, mtime_ms, size, sha256, headings JSON, updated_at`.
- **`sections`:** `seq PK, slug, heading, heading_path, anchor, level, ord, body`. Rows are one per heading section; the text before the first heading is a section with heading `""`.
- **`sections_fts`:** an FTS5 external-content table over `(title, aliases, heading, body)`. `title` and `aliases` are denormalized per section. Use `tokenize='porter unicode61 remove_diacritics 2'`, with insert, delete and update triggers like Library's `store.ts`.
- **`links`:** `from_slug, to_slug (resolved or NULL), target_text, heading`. Used for backlinks.
- **`cards`:** the inbox; see section 6.
- **`units`:** `hash PK, note_path, note_date, status (pending|accepted|skipped), card_id, seen_at`.
- **`notes_seen`:** `path PK, mtime_ms, size`. Lets ingest skip unchanged notes.
- **`jobs`:** `id PK, kind (route|describe), thread_id, status (running|done|failed), payload JSON, created_at, finished_at, error`.

**Sync:**
- At start, a full scan compares `mtime_ms + size` and reindexes only changed docs, then deletes rows for docs that are gone.
- `fs.watch(root, { recursive: true })` with a 300 ms debounce reindexes the changed paths. If the watcher errors, fall back to a 30 s poll, like Docs' `watch-vaults` service. Run it as a `bb.background.service`.
- After a sync that changed anything: rewrite `tags.json` and `bb.realtime.publish("wiki-changed", {})`.

**Search** (`search({ query, type?, limit })`):
1. **Docs group.** Match titles, tags and aliases by prefix and substring, case-insensitive, with exact matches first. At most 8.
2. **Sections group.** FTS5 `MATCH`, using Library's `ftsQuery` (prefix terms, quoted phrases). Rank with `bm25(sections_fts, 10, 8, 4, 1)`. Get the snippet with `snippet(sections_fts, 3, char(2), char(3), '…', 24)`, and strip source markers from the snippet text.
3. An empty query lists recently updated docs.
4. Return `{ docs: DocHit[], sections: SectionHit[], total }`.

## 5. Daily notes parsing (`lib/daily-notes.ts`, pure, heavily tested)

- **Daily note file.** A basename matching `^(\d{1,2})-(\d{2})-(\d{2})\.md$` gives the date `20YY-MM-DD`. Search recursively under `notesDirectory`, skipping dot-folders and `node_modules`.
- **NOTES section.** Starts at a heading line matching `/^(#{1,6})\s+NOTES\s*:?\s*$/i`: trailing spaces and one trailing colon (`### Notes:`) allowed. A daily note with no NOTES section is logged at info level. It ends at the next heading of the same or higher level (outside code fences), or at the end of the file.
- **Blocks.** Lines are grouped into blocks separated by blank lines. Blank lines inside a code fence (or inside a fence nested in a list item) do not split. Also, a blank line followed by a line indented ≥ 2 spaces continues the block, because nested list items can be separated by blank lines.
- **Tag line.** A line whose trimmed text is one or more `@tag` tokens (`@[A-Za-z0-9][A-Za-z0-9-]*`, separated by spaces). When a tag line is the **first line of a block**, its tags apply to every unit in that block; the tag line itself is not part of any unit. A tag line in the middle of a block starts a new tag context for the rest of the block. Tags are normalized the same way as aliases.
- **Units.** Each unit is a top-level item of a block:
  - A list item at indent 0 (`- `, `* `, `+ `, `1. `), plus all following lines indented more, and any indent-0 continuation lines that are not list items (`> quote`, a code fence and its contents, plain lines). Those attach to the previous unit.
  - Indent-0 non-list lines with no previous unit in the block form their own unit (a paragraph).
- **Unit fields:**
  - `lines: string[]`: the raw lines, verbatim, with trailing whitespace trimmed.
  - `text`: the lines joined with `\n`.
  - `blockTags`: from the tag line.
  - `inlineTags`: `@word` tokens inside the unit text that **exactly match a known doc tag or alias**. The parser takes `knownTags: Set<string>`. Others, such as `@George`, are ignored.
  - `explicitLinks`: the `[[...]]` targets in the unit text.
  - `skip`: true if `@skip` is in the block tags or inline tags.
  - `images`: relative or absolute image paths from `![..](path)` in the text.
  - `hash`: `sha256(normalizeWhitespace(text))`, where `normalizeWhitespace` trims each line and collapses runs of blank lines.
- **Today.** Today's note (in the configured timezone) and future-dated notes are never ingested.

## 6. Inbox cards

`cards` table, with `CardSchema` in `contract.ts`:

```ts
Card = {
  id: "card_xxxxxxxx",
  status: "routing" | "pending" | "accepted" | "skipped",
  source:
    | { kind: "notes"; notePath: string; noteDate: string; unitHash: string }
    | { kind: "agent"; threadId: string; threadTitle: string | null },
  text: string,                       // verbatim unit text, or the agent's text
  lines: string[],
  tags: string[],                     // block + inline tags
  rule: "explicit-link" | "tag" | "agent" | "none",
  reason: string,                     // one sentence shown on the card
  destinations: Destination[],
  tagSuggestions: { tag: string; slug: string; title: string; score: number }[], // did-you-mean for unknown tags
  rememberAliases: { tag: string; slug: string }[],                             // user-confirmed did-you-means, applied on accept
  createdAt, updatedAt: ISO strings
}
Destination = {
  id: string,
  include: boolean,
  target: { kind: "existing"; slug: string } | { kind: "new"; title: string; type: DocType; aliases: string[] },
  heading: string,                    // "Unsorted" by default
  lineRanges: { start: number; end: number }[] | "all",   // indexes into card.lines, inclusive; text built server-side
  role: "content" | "link",           // link = template link line into a project doc
  reason: string
}
```

**Routing order:**
1. **`explicit-link`.** The unit has `[[X]]` links. Each link resolves to an existing doc (`existing`), or else to a `new` doc titled X with type `topic`. The heading comes from `X#Heading`, else `Unsorted`. No AI.
2. **`tag`.** The unit has tags, and a tag resolves to a doc by tag or alias. The provisional destination is that doc, under `Unsorted`. When the tags resolve to a project doc and also to a topic or process doc, only the topic and process docs get the text; each project gets the link line from rule 5, never a copy.
3. **`none`.** No tags, or only unknown tags. There is no provisional destination. `tagSuggestions` holds local fuzzy matches (`lib/fuzzy.ts`). Unknown tags also get a provisional `new` doc destination titled from the tag (`unified-push` → "Unified push"), type `project`, **include=false**, so the user can turn it on.
4. **AI.** When `routingAgent` is on, every card that is not `explicit-link` starts as `routing`, and one routing job handles the whole batch (section 7). When the job's results arrive, they replace the destinations, with rule `agent`, and the status becomes `pending`. If the job fails or times out after 15 minutes, the cards keep their provisional rule-based destinations, the reason becomes "Claude Code routing was unavailable; routed by tag only.", and the status becomes `pending`.
5. **Project link rule** (server-side, deterministic). After AI routing, if the unit's tags (block or inline) resolve to a project doc P, and no `content` destination targets P, add a `link` destination to P under heading `Related`. Its text is the template `- See [[<dest title>]] (from <MM-DD-YY>)`, one line per content destination.

**Accept** (`acceptCard(id, edits?)`):
1. Apply `rememberAliases` first.
2. Then, for each included destination, build the text:
   - For `content`, take the selected lines from `card.lines`, de-indented by the minimum indent of the selection.
   - For `link`, use the template.
   - Rewrite image paths: copy each referenced image from the notes folder into `assets/`, and point the link at `assets/<file>`. A relative image path is looked up from the note's folder, then from each parent folder up to the notes root. An image that is not found stays as written, and the card preview lists it as not found.
3. Prepend the source marker, then `insertUnderHeading`. Create the doc if it is `new`.
4. Each destination is recorded on the card as written (`written: true`, turned off, "Already added.") right after its append, so a retry or a crash never writes it twice; a written destination cannot be turned back on. Link lines list every content doc the card was written to, including ones from an earlier, partly failed accept.
5. Reindex, mark the unit `accepted`, set the card to `accepted`, then make one git commit per card: `Wiki: <first 60 chars of text> → <doc titles>`. Publish `wiki-changed` and `wiki-inbox`.

**Skip:** set the card to `skipped` and the unit to `skipped`, so it never comes back.

**Update** (`updateCard`): the user edits destinations (include toggle, doc, heading, line ranges, new-doc title or type) and remembered aliases. The server validates these: slugs must exist and line ranges must be in bounds.

## 7. Routing job (Claude Code, `server/routing.ts`)

- **Spawn:**
  ```ts
  bb.sdk.threads.spawn({
    projectId: "proj_personal",
    environment: { type: "host", workspace: { type: "personal" } },
    providerId: "claude-code",
    model?,
    visibility: "hidden",
    title: "Wiki routing <date>",
    prompt,
    pluginMetadata: { wikiJob: "route", jobId },
  })
  ```
  First check that the personal project exists with `bb.sdk.projects.list({ includePersonal: true })`. If it doesn't, fall back to rules. Copy the spawn, archive and stop patterns from Trees `src/service.ts:686-716`.
- **Tools.** `bb.agents.configure`:
  - Threads with `pluginMetadata.wikiJob === "route"` get `["wiki_search", "wiki_get", "wiki_record_routes"]`.
  - Threads with `"describe"` get `["wiki_record_description"]`.
  - Every other thread gets `["wiki_search", "wiki_get", "wiki_add"]`.
  - `skills: ["wiki"]` for all threads.
- **Prompt.** The prompt holds:
  - The rules: copy-only, choose line ranges, prefer existing docs and headings, the placement rule (if a fact is true outside the project, it goes in a topic or process doc, and the server adds the project link itself), never create near-duplicate docs, give one short reason per destination, and call `wiki_record_routes` once with every unit.
  - A doc catalog: slug, title, type, aliases, headings, and a 160-character excerpt. Cap it at 300 docs and tell the agent to use `wiki_search` for the rest.
  - The units: id, note date, tags, and numbered lines.
- **`wiki_record_routes`:**
  - Parameters: `{ routes: [{ cardId, destinations: [{ target: {slug} | {newDoc:{title,type,aliases}}, heading, lineRanges | "all", reason }], tagMatches: [{ tag, slug }] }] }`.
  - The server validates them: the card must belong to this job's thread (look up `jobs.thread_id`), slugs must exist, and line ranges must be in bounds. An invalid route is reported back as an error string so the agent can retry. Valid routes are applied.
  - `tagMatches` become `tagSuggestions` with score 1, never auto-applied.
  - The tool returns a short summary.
- **Completion.** Listen to `bb.events.on("thread.idle" | "thread.failed")` for job threads. On idle, any card still in `routing` falls back as in section 6, step 4. Then mark the job done or failed, and archive and stop the thread. At startup, re-check `running` jobs with `threads.get`, because events are not replayed. A timer fails a job after 15 minutes.
- **Batching.** At most 60 units per job. Larger batches use multiple jobs run one after another.
- **Describe job** (image description). Spawn the same way, with `input: [{type:"text", text: prompt, mentions: []}, {type:"localImage", path}]`. The agent calls `wiki_record_description({ description })`. The RPC `describeImage` returns a `jobId`, and the UI polls `job(jobId)` until done. The description fills an editable caption field and is never saved automatically.

## 8. Daily ingest (`server/ingest.ts`, `server/schedule.ts`)

**`runIngest({ since?, useAgent? })`:**
1. List daily notes. Skip notes dated before the start date (`since`, else `ingestStartDate`, else firstRunAt − 7 days), today's note, and future notes. Also skip notes whose `notes_seen` mtime and size are unchanged, unless `since` is given.
2. Parse the units. Drop units marked `skip`, and units whose hash is already in `units`.
3. Create cards (section 6), and upsert `units` with status `pending`.
4. Start the routing jobs.
5. Publish `wiki-inbox`.
6. Return `{ notesScanned, unitsFound, cardsCreated, jobIds }`.

Only one ingest runs at a time, through a promise lock.

**Schedule.** Use a `bb.background.service("daily-ingest")` loop that wakes every 60 s, like Automations. Use `cron-parser` with `tz` (or compute from `ingestTime`). When local time is ≥ `ingestTime` and kv `lastIngestDate` < today, run the ingest, then set `lastIngestDate`. This catches up on a missed day. `ingestEnabled=false` skips the run.

## 9. Server surfaces

**RPC** (`contract.ts`, all zod `.strict()`):
- `status`: `{ wikiDirectory, notesDirectory, docCount, inboxCount, lastIngestDate|null, routingAgent, gitHistory, tagsFile }`
- `docs`: `{ type|null }` → `DocSummary[]`, which is `{ slug, title, type, aliases, tag, updatedAt, headings: string[] }`
- `doc`: `{ slug }` → `{ ...DocSummary, content, sha256, backlinks: {slug,title,heading}[] } | null`
- `saveDoc`: `{ slug, content, expectedSha256 }` → `{ outcome: "written", sha256 } | { outcome: "conflict" }`. This is the user's own editor save; the user is allowed to rewrite text.
- `createDoc`: `{ title, type, aliases, body }` → `DocSummary`. This is a manual doc; the body is user-written.
- `search`: `{ query, type|null, limit }` → `{ docs, sections, total }`
- `suggest`: `{ text, title|null }` → `{ suggestions: { slug, title, type, heading|null, score, reason }[] }`. Local only: FTS over the text's distinctive terms, plus title and tag matches. At most 5. Used by the add dialog, the manual doc dialog and the drop dialog.
- `addToDoc`: `{ target: {kind:"existing",slug}|{kind:"new",title,type,aliases}, heading, text, media: { from: {kind:"upload",uploadId}|{kind:"path",path}, caption }[], source: {kind:"thread",threadId,messageId|null}|{kind:"upload",name}|{kind:"manual"} }` → `{ slug, title }`. This is the explicit, user-confirmed write. Each media item is copied into `assets/` and embedded after the text:
  - images: `![caption](assets/x.png)`
  - video: `<video controls src="assets/x.mp4"></video>` plus the caption line
  - text files (`.md`, `.txt`): their content is the `text`
- `inbox`: `{ status: "open"|"accepted"|"skipped" }` → `Card[]`. `"open"` means `routing` plus `pending`, oldest first.
- `card`: `{ id }` → `Card | null`
- `updateCard`: `{ id, destinations, rememberAliases }` → `Card`
- `previewCard`: `{ id }` → `{ previews: { destinationId, slug|null, title, patch: string }[] }`. The patch is a unified diff from `diff.createTwoFilesPatch`, shown with `experimental_Diff`.
- `acceptCard`: `{ id }` → `Card`
- `skipCard`: `{ id }` → `Card`
- `ingestNow`: `{ since: string|null, useAgent: boolean|null }` → ingest result
- `importUpload`: `{ uploadId }` → `{ uploadId, name, kind: "image"|"video"|"markdown"|"text", sizeBytes, text|null }`. Reads text for md and txt.
- `messageMedia`: `{ threadId, messageSeq }` → `{ items: { path, name, kind, sizeBytes }[] }`. Collects message attachments (`bb.sdk.threads.message`) plus absolute file paths in the message text with media extensions that exist on disk.
- `describeImage`: `{ from }` → `{ jobId }`
- `job`: `{ jobId }` → `{ status, result: string|null, error: string|null }`
- `addAlias`: `{ slug, alias }` → `DocSummary`
- `reindex`: `{}` → `{ docCount }`

**HTTP:**
- `GET /asset?path=assets/x.png`, local auth. It serves a file under `<wiki>/assets` (or any doc-relative path inside the root), checks the resolved path stays inside the root, sets the correct content type, and supports `Range` with a 206 response for video.
- `POST /upload?name=<file>`, token auth. It streams the body to `<plugin data dir>/uploads/<id>` (the data dir comes from `PRAGMA database_list`, like Tasks), with a 1 GB cap that returns 413. It accepts `.png .jpg .jpeg .gif .webp .mp4 .mov .webm .md .txt`, and returns `{ uploadId, name, sizeBytes }`. Uploads older than 24 h are deleted at startup.

**Agent tools:**
- `wiki_search`: `{ query, limit? }` → text lines (`slug`, `heading`, snippet).
- `wiki_get`: `{ doc, heading? }` → the doc or section Markdown, with source markers turned into `(source: …)` lines.
- `wiki_add`: `{ doc?, heading?, title?, text }` → creates an `agent` card and returns "Added to the Wiki inbox for review: <card id>".
- `wiki_record_routes`, `wiki_record_description`: job threads only.

  Instructions: when the user asks what they know or wrote about something, search the Wiki first. When the user asks to save something to the Wiki, call `wiki_add`.

**CLI `bb wiki`:**
- `search <query…> [--json] [--limit]`
- `show <doc> [--heading]`
- `docs [--type]`
- `inbox [--status] [--json]`
- `accept <card>`, `skip <card>`
- `ingest [--since YYYY-MM-DD] [--no-agent]`
- `add --doc <doc>|--new <title> [--type] [--heading] --text <md>`
- `new --title [--type] [--alias…] [--body]`
- `alias <doc> <alias>`
- `reindex`
- `status`

Throw `PluginCliError` with hints, like Library.

## 10. UI (`app.tsx`, `components/`)

Copy the UI primitives and patterns from Library (`components/ui/*`, `lib/utils.ts`, `lib/portal-scope.ts`, `hooks/useBrowserDimmingModal.ts`, `components/requests.ts` channel, `hooks.ts` version/realtime pattern, `bits.tsx` Highlighted/EmptyState).

**Registrations:**
- `navPanel` `{ id: "wiki", title: "Wiki", icon: "BookOpen" (check it's a valid bb icon name, else "Book"), path: "wiki", component: WikiPage }`.
- `experimental_appOverlay` `{ id: "wiki-overlay", component: WikiOverlay }`. It hosts AddToWikiDialog and QuickSearch.
- `messageAction` `{ id: "add", title: "Add to Wiki", icon: "BookOpen" }`. It emits `addRequests` with `{ threadId, messageId, messageSeq, text: selectedText ?? message.text, fromSelection }`.
- `experimental_codeFenceRenderer` `{ id: "wiki-code", languages: [common languages: ts tsx js jsx json yaml yml toml bash sh zsh shell console python py go rust rs java kotlin swift c cpp h sql graphql html css scss xml diff dockerfile makefile ruby rb php lua proto text txt mermaid typescript javascript markdown md jsonc ini csv csharp cs r scala hcl terraform powershell ps1], component: CodeFenceWithWikiButton }`. It renders `<props.Original/>` with a small "Add to Wiki" button that appears on hover, top-right. Clicking it emits `addRequests` with the fenced code. When the `codeBlockButton` setting is false, it renders only `Original`. Do not claim `inline-vis`.
- `commands.register`:
  - `{ id: "search", title: "Wiki: search", defaultShortcut: { key: "k", mod: true, shift: true } }` opens QuickSearch.
  - `{ id: "open", title: "Wiki: open" }`
  - `{ id: "inbox", title: "Wiki: review inbox" }`

**WikiPage.** Two panes like Library: an aside of `w-80 xl:w-96` and a main pane. On compact screens, one pane at a time. The route lives in `subPath`:
- `""` home: recently updated docs, plus an inbox banner when there are open cards.
- `doc/<slug>[#anchor]`
- `inbox`, `inbox/<cardId>`
- `search?q=`
- `new`

**Aside:**
- Search input (`/` focuses it; ↑↓ Enter Esc like Library). Results show a Docs group, then Sections (heading path + highlighted snippet).
- With no query, docs are grouped as Projects, Topics, Processes, with counts.
- "Inbox (N)" at the top, and a "New doc" button.
- "Run ingest now" sits in a small menu.

**DocView:**
- Header: title, type badge, aliases chips, "Edit", "Copy link" (copies `[[Title]]`), "Open file" (`navigate.experimental_openFileExternally` if available).
- The body renders with the SDK `<Markdown content=…/>` after preprocessing:
  1. `[[X]]` becomes `[label](#wiki/<slug>)`, and unresolved links render as plain text with a dotted underline style.
  2. Asset paths become `/api/v1/plugins/wiki/http/asset?path=…`, and video embeds become `<video controls>`.
  3. Source markers become `<sub>from 10-14-26 notes</sub>`, or the thread title.
- Intercept clicks on `a[href^="#wiki/"]` with a capture-phase listener on the container and navigate internally.
- Footer: "Linked from" backlinks.

**DocEditor.** A textarea editor (monospace) with ⌘S or ⌘Enter to save and Esc to cancel. It saves with `expectedSha256`. On conflict, show the "Changed on disk" banner with Reload and Overwrite (Docs pattern).

**Inbox and CardView** (the review workflow; fast, keyboard driven):
- **Card list.** The list shows a source chip (note date, or thread), the first line, tag chips, the rule badge, and the status (`routing` gets a spinner).
- **CardView** shows:
  - the verbatim text, rendered as monospace lines with line numbers;
  - `reason` and the rule badge ("Decided by: tag @unified-notification" / "explicit [[link]]" / "Claude Code" / "no rule");
  - **destinations**, one row each, with:
    - an include checkbox;
    - a doc picker (search existing docs, or "New doc…" with title and type);
    - a heading select (the doc's headings, "Unsorted", or "New heading…");
    - a line-range chip ("all lines" or "lines 2–5") that you edit by clicking line numbers in the text, which toggles which lines belong to the selected destination;
    - a role badge for link rows.
  - "Add destination".
  - Did-you-mean block: "`@cc` isn't a Wiki doc yet. Did you mean **Adding config catalog**? [Yes, remember @cc] [No]". "Yes" adds it to `rememberAliases` and switches the destination.
  - "Preview change" (collapsed): `experimental_Diff` per destination from `previewCard`.
  - Buttons: **Accept (A)**, **Skip (S)**, plus **J/K** or ↑/↓ for the next and previous card. After accept or skip, it moves to the next card automatically.
- An empty inbox shows "All caught up", the last ingest date, and "Run ingest now".

**AddToWikiDialog** (overlay; from the message action, the code block button, or a drop):
- Editable text (prefilled, verbatim), or for a drop, the file list.
- Media checkboxes, from `messageMedia` for message actions, or the uploads.
- An image caption field with "Describe with Claude" (calls `describeImage`, polls `job`, fills the field).
- Destination: the top 5 `suggest` results as radio rows ("Best match: Unified notification › Global token"), plus "Pick another doc…" (search) and "New doc…" (title and type).
- A heading select, then **Add to Wiki** (⌘Enter) → `addToDoc`, then a toast with "Open".
- Shows a warning when a file is > 200 MB.

**Drag and drop.** WikiPage accepts dropped files anywhere (an overlay highlight while dragging).
1. Upload each file to `/upload`. Get the token from `useSdk().plugins.token({ pluginId: "wiki" })` or `POST /api/v1/plugins/wiki/token`, following the Tasks client pattern.
2. Call `importUpload`.
3. Open AddToWikiDialog with the files:
   - `.md` and `.txt` files fill the text.
   - Images and videos become media with captions.
   - For a single `.md` file, also offer "New doc from this file" (title from its H1 or filename).

**NewDocDialog** (route `new`). The user fills in title, type, aliases and body. A "Check for existing docs" step calls `suggest` with the title and body. If it finds matches, it shows "This might already belong in …", with the choices "Add to <doc> under <heading>" (`addToDoc`) or "Create new doc anyway" (`createDoc`).

**QuickSearch** (overlay, ⌘⇧K). A command-palette style dialog: an input, results (Docs then Sections), Enter to open in WikiPage, and Esc to close.

## 11. Notes plugin change (bb repo, `~/bb-dir/bb/plugins/notes`)

- **Setting.** `wikiTagsFile: { type: "string", label: "Wiki tags file", description: "Path to the Wiki's .wiki/tags.json; enables @ autocomplete of Wiki doc names. Leave empty to turn it off." }`, with no default. Empty or unset means off.
- **`lib/wiki-tags.ts`** (pure): a zod schema for tags.json version 1, `parseWikiTags(content) → WikiTag[] | null` (tolerant), and path expansion through `expandHomePath`.
- **RPC `wikiTags`.**
  - Input: `{ knownMtimeMs: number|null }`.
  - Output: `{ status: "off" } | { status: "unchanged" } | { status: "ok", mtimeMs, tags } | { status: "missing" } | { status: "invalid" }`.
  - Use `node:fs` `statSync` for the mtime (cheap), and read the file only when it changed. Keep the last parse cached in memory on the server.
- **`lib/wiki-completion.ts`** (app):
  - A module-level cache.
  - `refreshWikiTags(rpc)`.
  - `ensureWikiCompletion(monaco)`, which registers once per page with a module guard: `registerCompletionItemProvider("markdown", { triggerCharacters: ["@"] })`.
  - Pure helpers: `findAtPrefix(lineText, column)` (the `@` must be at line start or after whitespace) and `buildItems(tags, prefix)`.
  - Item fields:
    - `label`: the tag, with `description` = title and `detail` = type.
    - `filterText`: tag + title + aliases.
    - `insertText`: the tag.
    - `range`: from just after `@` to the cursor.
    - `kind`: `CompletionItemKind.Reference`.
  - Matching aliases also find the doc. **Insert the canonical tag**, not the alias.
  - Rank exact prefix matches first, through `sortText`.
- **app.tsx.** Call `ensureWikiCompletion(monaco)` after `monacoRef.current = monaco`. Refresh the cache on mount, on `editor.onDidFocusEditorText`, and at the start of `provideCompletionItems`, at most once per 2 s. The server answers `unchanged` cheaply. The list itself is filtered in memory, so typing stays instant.
- **Tests.** Server `wikiTags` cases: off, missing, invalid, ok, unchanged. Pure tests for `findAtPrefix` and `buildItems`.
- **Docs.** Update the Notes README, PLUGIN_OVERVIEW, `skills/notes/SKILL.md`, and the bb repo's `docs/configuration.md` Notes section. Add a suggest-widget check to `scripts/stage-assets.mjs`.
- **Do not commit.**

## 12. Out of scope (v3, later)

Local embedding search, "Ask the Wiki" with sources, the weekly duplicate check, and undo of an accepted card (git history covers it for now). Video transcripts will never be built.

## 13. File ownership (build phases)

- **Phase A (foundation):** scaffold and config; `lib/wiki.ts`, `lib/slug.ts`, `lib/markdown-doc.ts`, `lib/daily-notes.ts`, `lib/fuzzy.ts` and their tests; `contract.ts`; `server/store.ts`; `server/vault.ts` (fs, index sync, tags.json, git, assets); `server/context.ts` (the shared `WikiContext` type, which bundles bb, settings, store, vault, and `publish` helpers); a minimal `server.ts` that wires settings, store and vault.
- **Phase B1 (ingest and routing):** `server/cards.ts` (create, route rules, project link rule, update validation, preview, accept, skip), `server/ingest.ts`, `server/routing.ts`, `server/schedule.ts`, and their tests.
- **Phase B2 (surfaces):** `server/rpc.ts`, `server/tools.ts`, `server/cli.ts`, `server/http.ts`, `server/media.ts` (uploads, messageMedia, asset copy), and `server.ts` final wiring, with tests.
- **Phase B3 (main UI):** `app.tsx`, `components/WikiPage.tsx`, `components/DocView.tsx`, `components/DocEditor.tsx`, `components/Inbox.tsx`, `components/CardView.tsx`, `components/hooks.ts`, `components/bits.tsx`, `components/requests.ts`, and the app tests.
- **Phase B4 (dialogs):** `components/WikiOverlay.tsx`, `components/AddToWikiDialog.tsx`, `components/QuickSearch.tsx`, `components/NewDocDialog.tsx`, `components/DropZone.tsx` (`useFileDrop`, `uploadFiles`), `components/CodeFence.tsx`, `components/DocPicker.tsx`.
- **Phase B5:** the Notes change (section 11).
- **Phase C:** integration, docs (README, PLUGIN_OVERVIEW, SKILL), `plugins.json`, and the README row.
