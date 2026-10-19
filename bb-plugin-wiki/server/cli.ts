import { PluginCliError, cliCommand, defineCli, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  aliasSchema,
  cardIdSchema,
  headingSchema,
  isoDateSchema,
  titleSchema,
  type Card,
  type DocSummary,
  type DocTarget,
  type IngestResult,
  type WikiStatus,
} from "../contract.js";
import { formatNoteDateShort } from "../lib/daily-notes.js";
import { DEFAULT_DOC_TYPE, DEFAULT_HEADING, DOC_TYPES, LIMITS, NEW_DOC_HEADING, truncate } from "../lib/wiki.js";
import { acceptCard, restoreCard, skipCard } from "./cards.js";
import type { WikiContext } from "./context.js";
import { runImport, runIngest } from "./ingest.js";
import { DESCRIPTION_TOOL, ROUTES_TOOL } from "./routing.js";
import { addDocAlias, addToDoc, createManualDoc, deleteDoc, reindex, renameDoc, statusOf, tidyUnsorted } from "./rpc.js";
import {
  JOB_THREAD_REFUSAL,
  addAgentText,
  docViewText,
  isJobThread,
  missingHeadingText,
  readDocView,
  resolveDocRef,
  searchText,
} from "./tools.js";

export const CLI_NAME = "wiki";
const CLI_RESULTS = 20;
const CLI_TEXT_LIMIT = 500_000;
const FIRST_LINE = 80;
const CARD_STATUSES = ["open", "accepted", "skipped"] as const;

const DOC_HINT = "Run `bb wiki search <words>` or `bb wiki docs` to find doc names.";
const CARD_HINT = "Run `bb wiki inbox` to list card ids.";
const REVIEW_HINT = "Open the Wiki inbox in bb to review agent-written cards.";
const ALIAS_THREAD_REFUSAL = "From a thread, `bb wiki alias` can't change a doc; only the user adds aliases.";
const ALIAS_HINT = "Ask the user to add the alias to the doc's aliases (Edit on the doc page in the Wiki), or to run `bb wiki alias` outside a thread.";
const MANAGE_THREAD_REFUSAL = "From a thread, `bb wiki rename`, `bb wiki delete` and `bb wiki tidy-unsorted` can't change docs; only the user does that.";
const MANAGE_HINT = "Ask the user to right-click the doc in the Wiki, or to run the command outside a thread.";
const STATUS_HINT = "Run `bb wiki status` to check the Wiki folder.";
const JOB_HINT = `Routing threads call ${ROUTES_TOOL}; image-description threads call ${DESCRIPTION_TOOL}.`;

const json = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

function output(asJson: boolean, value: unknown, lines: readonly string[]) {
  return { exitCode: 0, stdout: asJson ? `${JSON.stringify(value)}\n` : lines.map((line) => `${line}\n`).join("") };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, hint: string, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new PluginCliError(`${issue?.path.join(".") || label}: ${issue?.message ?? "invalid"}`, { code: "invalid_value", hint });
}

function failure(error: unknown, hint: string): PluginCliError {
  if (error instanceof PluginCliError) return error;
  return new PluginCliError(error instanceof Error ? error.message : String(error), { code: "command_failed", hint });
}

async function guarded<T>(hint: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw failure(error, hint);
  }
}

function inThread(cli: PluginCliContext): string | null {
  return typeof cli.threadId === "string" && cli.threadId !== "" ? cli.threadId : null;
}

async function refuseJobThread(ctx: WikiContext, cli: PluginCliContext): Promise<void> {
  const threadId = inThread(cli);
  if (threadId === null || !(await isJobThread(ctx, threadId))) return;
  throw new PluginCliError(JOB_THREAD_REFUSAL, { code: "needs_user", hint: JOB_HINT });
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "";
  return truncate(line.trim().replace(/\s+/g, " "), FIRST_LINE);
}

function cardSource(card: Card): string {
  if (card.source.kind === "notes") return card.source.origin === "file" ? card.source.notePath : `${formatNoteDateShort(card.source.noteDate)} notes`;
  return card.source.threadTitle === null ? "agent" : `agent: ${truncate(card.source.threadTitle, 40)}`;
}

function destinationLabel(card: Card): string {
  const included = card.destinations.filter((destination) => destination.include);
  if (included.length === 0) return "no destination";
  return included
    .map((destination) => {
      const doc = destination.target.kind === "existing" ? destination.target.slug : `new "${destination.target.title}"`;
      return `${doc} › ${destination.heading}`;
    })
    .join("; ");
}

export function cardLines(cards: readonly Card[]): string[] {
  if (cards.length === 0) return ["No cards."];
  return cards.map((card) => [card.id, card.status, cardSource(card), firstLine(card.text), destinationLabel(card)].join("\t"));
}

export function docLines(docs: readonly DocSummary[]): string[] {
  if (docs.length === 0) return ["No Wiki docs yet."];
  return docs.map((doc) => [doc.slug, doc.type, doc.title, doc.aliases.join(", ") || "-"].join("\t"));
}

export function statusLines(status: WikiStatus): string[] {
  return [
    `Wiki folder: ${status.wikiDirectory}`,
    `Notes folder: ${status.notesDirectory}`,
    `Docs: ${status.docCount}`,
    `Open inbox cards: ${status.inboxCount}`,
    `Last ingest: ${status.lastIngestDate ?? "never"}`,
    `Claude Code routing: ${status.routingAgent ? "on" : "off"}`,
    `Git history: ${status.gitHistory ? "on" : "off"}`,
    `Tags file: ${status.tagsFile}`,
  ];
}

export function ingestLine(result: IngestResult): string {
  const jobs = result.jobIds.length === 0 ? "" : `; started ${result.jobIds.length} routing job${result.jobIds.length === 1 ? "" : "s"}`;
  return `Scanned ${result.notesScanned} note${result.notesScanned === 1 ? "" : "s"}, found ${result.unitsFound} unit${result.unitsFound === 1 ? "" : "s"}, created ${result.cardsCreated} inbox card${result.cardsCreated === 1 ? "" : "s"}${jobs}.`;
}

function existingDoc(ctx: WikiContext, ref: string): { slug: string; heading: string | null } {
  const resolved = resolveDocRef(ctx.store, ref);
  if (resolved === null) throw new PluginCliError(`No Wiki doc matches "${ref}".`, { code: "not_found", hint: DOC_HINT });
  return resolved;
}

function existingSlug(ctx: WikiContext, ref: string): string {
  return existingDoc(ctx, ref).slug;
}

interface AddOptions {
  doc?: string | undefined;
  new?: string | undefined;
  type?: (typeof DOC_TYPES)[number] | undefined;
}

function addTarget(ctx: WikiContext, options: AddOptions, heading: string | undefined): { target: DocTarget; heading: string } {
  if (options.doc !== undefined) {
    const resolved = existingDoc(ctx, options.doc);
    const fromRef = resolved.heading === null ? null : parseOrThrow(headingSchema, resolved.heading, "Pass a heading like --heading Decisions.", "doc");
    return { target: { kind: "existing", slug: resolved.slug }, heading: heading ?? fromRef ?? DEFAULT_HEADING };
  }
  const title = parseOrThrow(titleSchema, options.new, "Pass the new doc's title with --new <title>.", "new");
  return { target: { kind: "new", title, type: options.type ?? DEFAULT_DOC_TYPE, aliases: [] }, heading: heading ?? NEW_DOC_HEADING };
}

function requireCard(ctx: WikiContext, raw: string): Card {
  const id = parseOrThrow(cardIdSchema, raw, CARD_HINT, "card");
  const card = ctx.store.getCard(id);
  if (card === null) throw new PluginCliError(`No inbox card ${id}.`, { code: "not_found", hint: CARD_HINT });
  return card;
}

function searchCommands(ctx: WikiContext) {
  return {
    search: cliCommand({
      summary: "Search Wiki docs and sections; with no query, list recently updated docs",
      aliases: ["find"],
      positionals: [{ name: "query", description: "Words to match; prefixes match too", variadic: true }],
      options: {
        ...json,
        type: { type: "enum", values: DOC_TYPES, description: "Only docs of this type" },
        limit: { type: "integer", min: 1, max: LIMITS.results, default: CLI_RESULTS, description: `Results to print (max ${LIMITS.results})` },
      },
      async run({ positionals, options }) {
        const query = { query: positionals.query.join(" "), type: options.type ?? null, limit: options.limit };
        const result = await guarded(STATUS_HINT, async () => ctx.store.search(query));
        return output(options.json, result, [searchText(result)]);
      },
    }),
    show: cliCommand({
      summary: "Print a doc, or one heading of it, as Markdown",
      aliases: ["get", "cat"],
      positionals: [{ name: "doc", description: 'Doc slug, title, alias, or "Title#Heading"', required: true, variadic: true }],
      options: { ...json, heading: { type: "string", description: "Only this heading and its subheadings" } },
      async run({ positionals, options }) {
        const ref = positionals.doc.join(" ");
        const result = await guarded(STATUS_HINT, () => readDocView(ctx, ref, options.heading ?? null));
        if (result.kind === "no-doc") throw new PluginCliError(`No Wiki doc matches "${ref}".`, { code: "not_found", hint: DOC_HINT });
        if (result.kind === "no-heading") {
          const hint = `Run \`bb wiki show ${result.doc.slug}\` to read the whole doc.`;
          throw new PluginCliError(missingHeadingText(result.doc, result.heading), { code: "not_found", hint });
        }
        const { view } = result;
        const value = { slug: view.doc.slug, title: view.doc.title, type: view.doc.type, heading: view.heading, markdown: view.markdown };
        return output(options.json, value, [docViewText(view, CLI_TEXT_LIMIT)]);
      },
    }),
    docs: cliCommand({
      summary: "List Wiki docs (slug, type, title, aliases)",
      aliases: ["list", "ls"],
      options: { ...json, type: { type: "enum", values: DOC_TYPES, description: "Only docs of this type" } },
      async run({ options }) {
        const docs = await guarded(STATUS_HINT, async () => ctx.store.listDocs(options.type ?? null));
        return output(options.json, docs, docLines(docs));
      },
    }),
  };
}

function inboxCommands(ctx: WikiContext) {
  return {
    inbox: cliCommand({
      summary: "List inbox cards (id, status, source, first line, destinations)",
      options: { ...json, status: { type: "enum", values: CARD_STATUSES, default: "open", description: "open (default), accepted, or skipped" } },
      async run({ options }) {
        const cards = await guarded(STATUS_HINT, async () => ctx.store.listCards(options.status));
        return output(options.json, cards, cardLines(cards));
      },
    }),
    accept: cliCommand({
      summary: "Accept an inbox card: write it into its included destinations",
      positionals: [{ name: "card", description: "Card id, e.g. card_1a2b3c4d", required: true }],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        const card = requireCard(ctx, positionals.card);
        if (card.source.kind === "agent" && inThread(cli) !== null) {
          throw new PluginCliError(`${card.id} was written by an agent; only the user can accept it.`, { code: "needs_user", hint: REVIEW_HINT });
        }
        const accepted = await guarded(CARD_HINT, () => acceptCard(ctx, card.id));
        return output(options.json, accepted, [`Accepted ${accepted.id} into ${destinationLabel(accepted)}.`]);
      },
    }),
    skip: cliCommand({
      summary: "Skip an inbox card so it never comes back",
      positionals: [{ name: "card", description: "Card id, e.g. card_1a2b3c4d", required: true }],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        const card = requireCard(ctx, positionals.card);
        const skipped = await guarded(CARD_HINT, () => skipCard(ctx, card.id));
        return output(options.json, skipped, [`Skipped ${skipped.id}.`]);
      },
    }),
    restore: cliCommand({
      summary: "Put a skipped card back in the inbox",
      aliases: ["unskip"],
      positionals: [{ name: "card", description: "Card id, e.g. card_1a2b3c4d", required: true }],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        const card = requireCard(ctx, positionals.card);
        const restored = await guarded(CARD_HINT, () => restoreCard(ctx, card.id));
        return output(options.json, restored, [`Restored ${restored.id} to the inbox.`]);
      },
    }),
    ingest: cliCommand({
      summary: "Gather daily notes into the inbox now",
      options: {
        ...json,
        since: { type: "string", description: "Re-read notes dated on or after YYYY-MM-DD, even unchanged ones" },
        "no-agent": { type: "boolean", description: "Route by links and tags only, without Claude Code" },
      },
      async run({ options }, cli) {
        await refuseJobThread(ctx, cli);
        const since = options.since === undefined ? null : parseOrThrow(isoDateSchema, options.since, "Use --since YYYY-MM-DD.", "since");
        const result = await guarded("Run `bb wiki status` to check the folders.", () =>
          runIngest(ctx, { since, useAgent: options["no-agent"] ? false : null }),
        );
        return output(options.json, result, [ingestLine(result)]);
      },
    }),
    import: cliCommand({
      summary: "Chunk reference notes in folders of the notes folder (by heading section) into the inbox",
      positionals: [{ name: "folder", description: 'Folder inside the notes folder, e.g. "Projects"; repeat for more', required: true, variadic: true }],
      options: {
        ...json,
        "no-agent": { type: "boolean", description: "Route by folder tag only, without Claude Code" },
      },
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        const result = await guarded("Name folders inside the notes folder, like Projects or Tools.", () =>
          runImport(ctx, { folders: positionals.folder, useAgent: options["no-agent"] ? false : null }),
        );
        return output(options.json, result, [ingestLine(result).replace(/^Scanned (\d+) notes?/, (_, n: string) => `Scanned ${n} file${n === "1" ? "" : "s"}`)]);
      },
    }),
  };
}

function writeCommands(ctx: WikiContext) {
  return {
    add: cliCommand({
      summary: "Add Markdown under a heading of a doc, or of a new doc",
      description: "From inside a bb thread this files a review card in the Wiki inbox instead of writing.",
      options: {
        ...json,
        doc: { type: "string", description: "Existing doc slug, title, or alias" },
        new: { type: "string", description: "Title of a new doc to create" },
        type: { type: "enum", values: DOC_TYPES, description: `Type of the new doc (default ${DEFAULT_DOC_TYPE})` },
        heading: { type: "string", description: `Heading to add under (default ${DEFAULT_HEADING}; ${NEW_DOC_HEADING} for a new doc)` },
        text: { type: "string", required: true, description: `Markdown to add (max ${LIMITS.text} characters)` },
      },
      constraints: [{ kind: "exactly-one", options: ["doc", "new"] }],
      async run({ options }, cli) {
        await refuseJobThread(ctx, cli);
        if (options.text.trim() === "") throw new PluginCliError("--text is empty.", { code: "invalid_value", hint: "Pass the Markdown with --text." });
        const heading = options.heading === undefined ? undefined : parseOrThrow(headingSchema, options.heading, "Pass a heading like --heading Decisions.", "heading");
        const threadId = inThread(cli);
        if (threadId !== null) {
          const message = await guarded(REVIEW_HINT, () =>
            addAgentText(ctx, threadId, { text: options.text, doc: options.doc, heading, title: options.new }),
          );
          return output(options.json, { queued: true, message }, [message]);
        }
        const { target, heading: chosen } = addTarget(ctx, options, heading);
        const written = await guarded(DOC_HINT, () =>
          addToDoc(ctx, { target, heading: chosen, text: options.text, media: [], source: { kind: "manual" } }),
        );
        return output(options.json, written, [`Added to ${written.title} › ${chosen} (${written.slug}).`]);
      },
    }),
    new: cliCommand({
      summary: "Create a doc",
      options: {
        ...json,
        title: { type: "string", required: true, description: `Doc title (max ${LIMITS.title} characters)` },
        type: { type: "enum", values: DOC_TYPES, default: DEFAULT_DOC_TYPE, description: "topic (default), project, process, or service" },
        alias: { type: "string", repeatable: true, split: ",", aliases: ["aliases"], description: "Alias tag; repeat for more" },
        body: { type: "string", description: "Markdown body" },
      },
      async run({ options }, cli) {
        await refuseJobThread(ctx, cli);
        const title = parseOrThrow(titleSchema, options.title, "Pass a title with --title.", "title");
        const aliases = options.alias.map((alias) => parseOrThrow(aliasSchema, alias, "Aliases are short tags like cc.", "alias"));
        const body = options.body ?? "";
        const threadId = inThread(cli);
        if (threadId !== null) {
          if (body.trim() === "") {
            throw new PluginCliError("From a thread, `bb wiki new` files a review card, so it needs --body.", { code: "invalid_value", hint: REVIEW_HINT });
          }
          const message = await guarded(REVIEW_HINT, () => addAgentText(ctx, threadId, { text: body, title }));
          return output(options.json, { queued: true, message }, [message]);
        }
        const doc = await guarded(DOC_HINT, () => createManualDoc(ctx, { title, type: options.type, aliases, body }));
        return output(options.json, doc, [`Created ${doc.title} (${doc.slug}).`]);
      },
    }),
    alias: cliCommand({
      summary: "Add an alias tag to a doc",
      positionals: [
        { name: "doc", description: "Doc slug, title, or alias", required: true },
        { name: "alias", description: "New alias, e.g. cc", required: true },
      ],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        if (inThread(cli) !== null) throw new PluginCliError(ALIAS_THREAD_REFUSAL, { code: "needs_user", hint: ALIAS_HINT });
        const slug = existingSlug(ctx, positionals.doc);
        const alias = parseOrThrow(aliasSchema, positionals.alias, "Aliases are short tags like cc.", "alias");
        const doc = await guarded(DOC_HINT, () => addDocAlias(ctx, slug, alias));
        return output(options.json, doc, [`${doc.title} aliases: ${doc.aliases.join(", ") || "none"}.`]);
      },
    }),
    rename: cliCommand({
      summary: "Rename a doc; its old name stays as an alias so @tags and [[links]] still find it",
      positionals: [
        { name: "doc", description: "Doc slug, title, or alias", required: true },
        { name: "title", description: "New title", required: true, variadic: true },
      ],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        if (inThread(cli) !== null) throw new PluginCliError(MANAGE_THREAD_REFUSAL, { code: "needs_user", hint: MANAGE_HINT });
        const slug = existingSlug(ctx, positionals.doc);
        const title = parseOrThrow(titleSchema, positionals.title.join(" "), "Give the new title after the doc.", "title");
        const doc = await guarded(DOC_HINT, () => renameDoc(ctx, slug, title));
        return output(options.json, doc, [`Renamed to ${doc.title} (${doc.slug}).`]);
      },
    }),
    delete: cliCommand({
      summary: "Delete a doc (git history keeps a copy)",
      aliases: ["rm", "remove"],
      positionals: [{ name: "doc", description: "Doc slug, title, or alias", required: true }],
      options: json,
      async run({ positionals, options }, cli) {
        await refuseJobThread(ctx, cli);
        if (inThread(cli) !== null) throw new PluginCliError(MANAGE_THREAD_REFUSAL, { code: "needs_user", hint: MANAGE_HINT });
        const slug = existingSlug(ctx, positionals.doc);
        const deleted = await guarded(DOC_HINT, () => deleteDoc(ctx, slug));
        return output(options.json, deleted, [`Deleted ${deleted.title} (${deleted.slug}).`]);
      },
    }),
  };
}

function adminCommands(ctx: WikiContext) {
  return {
    "tidy-unsorted": cliCommand({
      summary: "Move every doc's old '## Unsorted' section below the --- line at the bottom (one git commit)",
      options: json,
      async run({ options }, cli) {
        await refuseJobThread(ctx, cli);
        if (inThread(cli) !== null) throw new PluginCliError(MANAGE_THREAD_REFUSAL, { code: "needs_user", hint: MANAGE_HINT });
        const result = await guarded(STATUS_HINT, () => tidyUnsorted(ctx));
        const count = result.changed.length;
        return output(options.json, result, [count === 0 ? "No docs had an Unsorted heading." : `Moved Unsorted below the line in ${count} doc${count === 1 ? "" : "s"}: ${result.changed.join(", ")}.`]);
      },
    }),
    reindex: cliCommand({
      summary: "Re-read the Wiki folder into the search index",
      options: json,
      async run({ options }) {
        const result = await guarded(STATUS_HINT, () => reindex(ctx));
        return output(options.json, result, [`Indexed ${result.docCount} doc${result.docCount === 1 ? "" : "s"}.`]);
      },
    }),
    status: cliCommand({
      summary: "Show the Wiki folders, counts, and settings",
      options: json,
      async run({ options }) {
        const status = await guarded("Check the Wiki settings with `bb plugin config wiki`.", () => statusOf(ctx));
        return output(options.json, status, statusLines(status));
      },
    }),
  };
}

export function registerCli(ctx: WikiContext): void {
  ctx.bb.cli.register(
    defineCli({
      name: CLI_NAME,
      summary: "Search the Wiki, review its inbox, and add to its docs",
      commands: { ...searchCommands(ctx), ...inboxCommands(ctx), ...writeCommands(ctx), ...adminCommands(ctx) },
    }),
  );
}
