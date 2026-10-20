import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Card, CardPreview, DocDetail, DocSummary, IngestResult, JobState, SearchResult, Suggestion, UploadInfo, WikiStatus } from "./contract";
import { CHANGED_CHANNEL, INBOX_CHANNEL } from "./lib/wiki";
import plugin from "./server";
import { DESCRIPTION_TOOL, ROUTES_TOOL } from "./server/routing";
import { statusOf, withoutTitleLine } from "./server/rpc";
import { createWikiContext, pluginDataDir } from "./server/context";
import { tagsJson } from "./server/vault";
import { ADD_TOOL, GET_TOOL, SEARCH_TOOL } from "./server/tools";

const GLOBAL_TOKEN = ["---", "title: Global token", "type: topic", "aliases: [gt]", "---", "", "# Global token", "", "## Limits", "", "Each tenant gets a token bucket.", ""].join("\n");
const UNIFIED = ["---", "type: project", "---", "", "# Unified notification", "", "See [[Global token#Limits]] for rate limits.", ""].join("\n");
const NOTE = [
  "# Friday",
  "",
  "### NOTES",
  "",
  "@global-token",
  "- Refill is 10 tokens per second per tenant.",
  "  - Burst allows 50.",
  "",
  "- Look at [[Retry policy]] next week.",
  "",
  "### TODO",
  "",
  "- not a unit",
  "",
].join("\n");
const NOTE_PATH = "Time/jan2024/01-05-24.md";
const FRESH_JOB_THREAD = "thr_fresh_job";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file)] = await readFile(file, "utf8");
  }
  return files;
}

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
    return result.content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("");
  }
  return "";
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
}

async function setup(settings: Record<string, string | boolean> = {}, message?: unknown) {
  const wiki = await tempDir("wiki-e2e-");
  const notes = await tempDir("notes-e2e-");
  await writeFile(path.join(wiki, "global-token.md"), GLOBAL_TOKEN);
  await writeFile(path.join(wiki, "unified-notification.md"), UNIFIED);
  await mkdir(path.join(notes, "Time", "jan2024"), { recursive: true });
  await writeFile(path.join(notes, ...NOTE_PATH.split("/")), NOTE);
  const host = createFakePluginHost({
    pluginId: "wiki",
    agentSkillIds: ["wiki"],
    settings: { wikiDirectory: wiki, notesDirectory: notes, routingAgent: false, gitHistory: false, ...settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, title: `Chat ${threadId}` }),
        message: async () => message,
        spawn: async () => makeThreadResponse({ id: "thr_job" }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) =>
          threadId === FRESH_JOB_THREAD ? { wikiJob: "route", jobId: "job_aaaaaaaa" } : {},
      },
      projects: { list: async () => [{ id: "proj_personal" }] },
    },
  });
  await plugin(host.bb);
  const { harness } = host;
  const rpc = harness.behavior.callRpc;
  const read = (rel: string) => readFile(path.join(wiki, rel), "utf8");
  const ingest = async () => (await rpc("ingestNow", { since: "2020-01-01", useAgent: false })) as IngestResult;
  const openCards = async () => (await rpc("inbox", { status: "open" })) as Card[];
  const uploadFile = async (name: string, body: string) => {
    const response = await harness.behavior.fetchHttp("POST", `/upload?name=${encodeURIComponent(name)}`, { body });
    const saved: unknown = await response.json();
    return typeof saved === "object" && saved !== null && "uploadId" in saved ? String(saved.uploadId) : "";
  };
  return { wiki, notes, host, harness, rpc, read, ingest, openCards, uploadFile };
}

function tagCard(cards: readonly Card[]): Card {
  const card = cards.find((entry) => entry.rule === "tag");
  if (card === undefined) throw new Error("no tag card");
  return card;
}

describe("ingest to accept", () => {
  it("moves verbatim note lines through the inbox into a doc", async () => {
    const { wiki, harness, rpc, read, ingest, openCards } = await setup();
    expect(await ingest()).toEqual({ notesScanned: 1, unitsFound: 2, cardsCreated: 2, jobIds: [] });
    const cards = await openCards();
    expect(cards.map((card) => card.rule).sort()).toEqual(["explicit-link", "tag"]);
    const card = tagCard(cards);
    expect(card.lines).toEqual(["- Refill is 10 tokens per second per tenant.", "  - Burst allows 50."]);

    const [first] = card.destinations;
    if (first === undefined) throw new Error("no destination");
    const updated = (await rpc("updateCard", {
      id: card.id,
      destinations: [{ ...first, heading: "Limits", lineRanges: [{ start: 0, end: 0 }] }],
      rememberAliases: [],
    })) as Card;
    expect(updated.destinations[0]).toMatchObject({ heading: "Limits", lineRanges: [{ start: 0, end: 0 }] });

    const { previews } = (await rpc("previewCard", { id: card.id })) as { previews: CardPreview[] };
    expect(previews).toHaveLength(1);
    expect(previews[0]?.patch).toContain("+- Refill is 10 tokens per second per tenant.");
    expect(previews[0]?.patch).not.toContain("Burst");
    expect(await read("global-token.md")).toBe(GLOBAL_TOKEN);

    const accepted = (await rpc("acceptCard", { id: card.id })) as Card;
    expect(accepted.status).toBe("accepted");
    const content = await read("global-token.md");
    expect(content).toMatch(/## Limits\n\nEach tenant gets a token bucket\.\n\n<!-- wiki:source notes="Time\/jan2024\/01-05-24\.md" date="2024-01-05" added="\d{4}-\d{2}-\d{2}" -->\n- Refill is 10 tokens per second per tenant\.\n$/);

    const found = (await rpc("search", { query: "refill", type: null, limit: 10 })) as SearchResult;
    expect(found.sections.map((hit) => [hit.slug, hit.heading])).toContainEqual(["global-token", "Limits"]);

    const got = textOf(await harness.behavior.callAgentTool(GET_TOOL, { doc: "gt", heading: "limits" }));
    expect(got).toContain('Wiki doc "Global token" (slug global-token, topic, tag @global-token; aliases: gt), section "Global token > Limits"');
    expect(got).toContain("(source: from 01-05-24 notes)\n- Refill is 10 tokens per second per tenant.");
    expect(got).not.toContain("wiki:source");

    const link = cards.find((entry) => entry.rule === "explicit-link");
    await rpc("acceptCard", { id: link?.id });
    expect(await read("retry-policy.md")).toContain("- Look at [[Retry policy]] next week.");
    const tags = JSON.parse(await read(".wiki/tags.json"));
    expect(tags.docs.map((doc: { tag: string }) => doc.tag)).toEqual(["global-token", "retry-policy", "unified-notification"]);
    expect(await openCards()).toEqual([]);
    expect((await rpc("inbox", { status: "accepted" })) as Card[]).toHaveLength(2);

    const channels = new Set(harness.inspection.realtimeSignals.map((signal) => signal.channel));
    expect(channels).toEqual(new Set([CHANGED_CHANNEL, INBOX_CHANNEL]));
    expect(await snapshot(wiki)).not.toHaveProperty(".git/HEAD");
  });

  it("skips a card so it never comes back", async () => {
    const { rpc, ingest, openCards } = await setup();
    await ingest();
    const card = tagCard(await openCards());
    expect(((await rpc("skipCard", { id: card.id })) as Card).status).toBe("skipped");
    expect((await ingest()).cardsCreated).toBe(0);
    await expect(rpc("acceptCard", { id: card.id })).rejects.toThrow("already skipped");
  });

  it("never writes to the notes folder", async () => {
    const { notes, rpc, ingest, openCards } = await setup();
    const before = await snapshot(notes);
    await ingest();
    for (const card of await openCards()) await rpc("acceptCard", { id: card.id });
    expect(await snapshot(notes)).toEqual(before);
  });
});

describe("agent tools", () => {
  it("files wiki_add text as a pending agent card and writes no file", async () => {
    const { wiki, harness, openCards } = await setup();
    const before = await snapshot(wiki);
    const reply = textOf(await harness.behavior.callAgentTool(ADD_TOOL, { text: "Use jittered backoff.", doc: "Global token" }, { threadId: "thr_agent" }));
    expect(reply).toMatch(/^Added to the Wiki inbox for review: card_[a-z0-9]{8}$/);
    const [card] = await openCards();
    expect(card).toMatchObject({
      id: reply.slice(-13),
      status: "pending",
      source: { kind: "agent", threadId: "thr_agent", threadTitle: "Chat thr_agent" },
      text: "Use jittered backoff.",
    });
    expect(await snapshot(wiki)).toEqual(before);
    await expect(harness.behavior.callAgentTool(ADD_TOOL, { text: "   " })).rejects.toThrow();
  });

  it("searches and reports missing docs and headings", async () => {
    const { harness } = await setup();
    const found = textOf(await harness.behavior.callAgentTool(SEARCH_TOOL, { query: "bucket" }));
    expect(found).toContain("Sections (slug#anchor, heading, snippet):");
    expect(found).toContain("global-token#limits\tGlobal token > Limits\tEach tenant gets a token **bucket**.");
    expect(textOf(await harness.behavior.callAgentTool(SEARCH_TOOL, { query: "zebra" }))).toBe("No Wiki docs match.");
    const missing = await harness.behavior.callAgentTool(GET_TOOL, { doc: "Nope" });
    expect(isError(missing)).toBe(true);
    const noHeading = await harness.behavior.callAgentTool(GET_TOOL, { doc: "global-token", heading: "Budget" });
    expect(isError(noHeading)).toBe(true);
    expect(textOf(noHeading)).toBe('"Global token" has no heading "Budget"; its headings are: Global token, Limits.');
    const linked = textOf(await harness.behavior.callAgentTool(GET_TOOL, { doc: "[[Global token#Limits]]" }));
    expect(linked).toContain("## Limits\n\nEach tenant gets a token bucket.");
  });

  it("offers tools by job kind", async () => {
    const { harness } = await setup();
    const resolve = async (pluginMetadata: Record<string, string>) => {
      const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata }));
      return { tools: config.tools.map((tool) => tool.name), skills: config.skills };
    };
    expect(await resolve({ wikiJob: "route", jobId: "job_aaaaaaaa" })).toEqual({ tools: [SEARCH_TOOL, GET_TOOL, ROUTES_TOOL], skills: ["wiki"] });
    expect(await resolve({ wikiJob: "describe", jobId: "job_aaaaaaaa" })).toEqual({ tools: [DESCRIPTION_TOOL], skills: [] });
    expect(await resolve({})).toEqual({ tools: [SEARCH_TOOL, GET_TOOL, ADD_TOOL], skills: ["wiki"] });
    expect(await resolve({ wikiJob: "other" })).toEqual({ tools: [SEARCH_TOOL, GET_TOOL, ADD_TOOL], skills: ["wiki"] });
  });
});

describe("cli", () => {
  it("searches, shows, lists the inbox, and accepts", async () => {
    const { harness, read } = await setup();
    const cli = harness.behavior.runCli;
    expect((await cli(["ingest", "--since", "2020-01-01", "--no-agent"])).stdout).toBe("Scanned 1 note, found 2 units, created 2 inbox cards.\n");
    const inbox = (await cli(["inbox"])).stdout;
    const cardId = /^(card_[a-z0-9]{8})\tpending\t01-05-24 notes\t- Refill/m.exec(inbox)?.[1] ?? "";
    expect(cardId).not.toBe("");
    expect(inbox).toContain(`${cardId}\tpending\t01-05-24 notes\t- Refill is 10 tokens per second per tenant.\tglobal-token › Unsorted`);
    expect((await cli(["accept", cardId])).stdout).toBe(`Accepted ${cardId} into global-token › Unsorted.\n`);
    expect(await read("global-token.md")).toContain("---\n\n<!-- wiki:unsorted -->\n\n<!-- wiki:source notes=");

    const searched = await cli(["search", "burst", "--json"]);
    expect((JSON.parse(searched.stdout ?? "") as SearchResult).sections[0]).toMatchObject({ slug: "global-token", heading: "Unsorted" });
    const shown = (await cli(["show", "Global", "token", "--heading", "Unsorted"])).stdout;
    expect(shown).toContain("(source: from 01-05-24 notes)\n- Refill is 10 tokens per second per tenant.\n  - Burst allows 50.");
    expect((await cli(["docs", "--type", "project"])).stdout).toBe("unified-notification\tproject\tUnified notification\t-\n");
    expect((await cli(["inbox", "--status", "accepted", "--json"])).stdout).toContain(cardId);
  });

  it("reports unknown cards and docs with hints", async () => {
    const { harness } = await setup();
    const cli = harness.behavior.runCli;
    const bad = await cli(["accept", "nope"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("expected a card id");
    const missing = await cli(["skip", "card_00000000"]);
    expect(missing.stderr).toContain("No inbox card card_00000000.");
    const noDoc = await cli(["show", "nothing"]);
    expect(noDoc.stderr).toContain('No Wiki doc matches "nothing".');
    expect((await cli(["ingest", "--since", "yesterday"])).stderr).toContain("expected YYYY-MM-DD");
  });

  it("adds, creates, and aliases as the user outside a thread", async () => {
    const { harness, read } = await setup();
    const cli = harness.behavior.runCli;
    expect((await cli(["add", "--doc", "gt", "--heading", "Limits", "--text", "Buckets reset hourly."])).stdout).toBe(
      "Added to Global token › Limits (global-token).\n",
    );
    expect(await read("global-token.md")).toMatch(/## Limits\n\nEach tenant gets a token bucket\.\n\n<!-- wiki:source manual added="[\d-]+" -->\nBuckets reset hourly\.\n$/);
    expect((await cli(["add", "--new", "Retry policy", "--type", "process", "--text", "Retry 3 times."])).stdout).toBe(
      "Added to Retry policy › Notes (retry-policy).\n",
    );
    expect(await read("retry-policy.md")).toContain("type: process");
    expect((await cli(["new", "--title", "Deploy", "--alias", "ship,release"])).stdout).toBe("Created Deploy (deploy).\n");
    expect((await cli(["alias", "deploy", "rollout"])).stdout).toBe("Deploy aliases: ship, release, rollout.\n");
    expect((await cli(["add", "--doc", "gt", "--new", "x", "--text", "y"])).exitCode).not.toBe(0);
    expect((await cli(["reindex"])).stdout).toBe("Indexed 4 docs.\n");
    const status = JSON.parse((await cli(["status", "--json"])).stdout ?? "") as WikiStatus;
    expect(status).toMatchObject({ docCount: 4, inboxCount: 0, routingAgent: false, lastIngestDate: null });
  });

  it("turns writes from inside a thread into review cards", async () => {
    const { wiki, harness, openCards, ingest } = await setup();
    const cli = harness.behavior.runCli;
    const before = await snapshot(wiki);
    const added = await cli(["add", "--doc", "gt", "--text", "Agent wrote this."], { threadId: "thr_agent" });
    expect(added.stdout).toMatch(/^Added to the Wiki inbox for review: card_[a-z0-9]{8}\n$/);
    const created = await cli(["new", "--title", "Agent doc", "--body", "Agent body."], { threadId: "thr_agent" });
    expect(created.stdout).toMatch(/^Added to the Wiki inbox for review: card_/);
    const aliased = await cli(["alias", "gt", "agentpicked"], { threadId: "thr_agent" });
    expect(aliased.exitCode).not.toBe(0);
    expect(aliased.stderr).toContain("only the user adds aliases");
    expect(await snapshot(wiki)).toEqual(before);
    const agentCard = (await openCards()).find((card) => card.source.kind === "agent");
    const refused = await cli(["accept", agentCard?.id ?? ""], { threadId: "thr_agent" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("was written by an agent; only the user can accept it.");
    await ingest();
    const notesCard = tagCard(await openCards());
    expect((await cli(["accept", notesCard.id], { threadId: "thr_agent" })).exitCode).toBe(0);
  });
});

describe("rpc", () => {
  it("reports status, docs, and doc detail with backlinks", async () => {
    const { wiki, rpc } = await setup();
    expect((await rpc("status", {})) as WikiStatus).toEqual({
      wikiDirectory: wiki,
      notesDirectory: expect.any(String),
      docCount: 2,
      inboxCount: 0,
      lastIngestDate: null,
      routingAgent: false,
      gitHistory: false,
      tagsFile: path.join(wiki, ".wiki", "tags.json"),
    });
    expect(((await rpc("docs", { type: "project" })) as DocSummary[]).map((doc) => doc.slug)).toEqual(["unified-notification"]);
    const doc = (await rpc("doc", { slug: "global-token" })) as DocDetail;
    expect(doc).toMatchObject({ slug: "global-token", title: "Global token", aliases: ["gt"], content: GLOBAL_TOKEN });
    expect(doc.backlinks).toEqual([{ slug: "unified-notification", title: "Unified notification", heading: "Unified notification" }]);
    expect(doc).not.toHaveProperty("path");
    expect(await rpc("doc", { slug: "missing" })).toBeNull();
    expect(await rpc("doc", { slug: ".git/config" })).toBeNull();
    expect(await rpc("reindex", {})).toEqual({ docCount: 2 });
  });

  it("reads one card and refuses edits that point at missing docs or lines", async () => {
    const { rpc, ingest, openCards } = await setup();
    await ingest();
    const card = tagCard(await openCards());
    expect(await rpc("card", { id: card.id })).toEqual(card);
    expect(await rpc("card", { id: "card_00000000" })).toBeNull();
    const [first] = card.destinations;
    if (first === undefined) throw new Error("no destination");
    const edit = (destination: unknown) => rpc("updateCard", { id: card.id, destinations: [destination], rememberAliases: [] });
    await expect(edit({ ...first, target: { kind: "existing", slug: "missing" } })).rejects.toThrow();
    await expect(edit({ ...first, lineRanges: [{ start: 0, end: 9 }] })).rejects.toThrow();
    expect(await rpc("card", { id: card.id })).toEqual(card);
  });

  it("strips only a leading H1 equal to the title from a manual body", () => {
    expect(withoutTitleLine("\n# Deploy  Process\nSteps", "deploy process")).toBe("Steps");
    expect(withoutTitleLine("# Other\nSteps", "Deploy")).toBe("# Other\nSteps");
    expect(withoutTitleLine("## Deploy\nSteps", "Deploy")).toBe("## Deploy\nSteps");
  });

  it("saves editor changes only against the content the user saw", async () => {
    const { rpc, read } = await setup();
    const doc = (await rpc("doc", { slug: "global-token" })) as DocDetail;
    const edited = `${doc.content}\nEdited by the user.\n`;
    expect(await rpc("saveDoc", { slug: "global-token", content: edited, expectedSha256: "0".repeat(64) })).toEqual({ outcome: "conflict" });
    expect(await read("global-token.md")).toBe(GLOBAL_TOKEN);
    const written = (await rpc("saveDoc", { slug: "global-token", content: edited, expectedSha256: doc.sha256 })) as { outcome: string };
    expect(written.outcome).toBe("written");
    expect(await read("global-token.md")).toBe(edited);
  });

  it("creates manual docs with the body under the title and a manual marker", async () => {
    const { rpc, read } = await setup();
    const doc = (await rpc("createDoc", { title: "Deploy process", type: "process", aliases: ["deploy"], body: "# Deploy process\n\n## Steps\n\n1. Build\n2. Ship\n" })) as DocSummary;
    expect(doc).toMatchObject({ slug: "deploy-process", type: "process", aliases: ["deploy"], headings: ["Deploy process", "Steps"] });
    const content = await read("deploy-process.md");
    expect(content.match(/^# Deploy process$/gm)).toHaveLength(1);
    expect(content).toMatch(/# Deploy process\n\n<!-- wiki:source manual added="[\d-]+" -->\n\n?## Steps\n\n1\. Build\n2\. Ship\n$/);
    await rpc("createDoc", { title: "Empty", type: "topic", aliases: [], body: "" });
    expect(await read("empty.md")).not.toContain("wiki:source");
  });

  it("adds aliases and refuses one that names another doc", async () => {
    const { rpc, read } = await setup();
    expect(((await rpc("addAlias", { slug: "global-token", alias: "@Token" })) as DocSummary).aliases).toEqual(["gt", "token"]);
    expect(await read("global-token.md")).toContain("aliases: [gt, token]");
    await expect(rpc("addAlias", { slug: "unified-notification", alias: "gt" })).rejects.toThrow('@gt already names "Global token".');
    await expect(rpc("addAlias", { slug: "missing", alias: "x" })).rejects.toThrow('No Wiki doc "missing"');
  });

  it("suggests docs with a reason", async () => {
    const { rpc } = await setup();
    const { suggestions } = (await rpc("suggest", { text: "How does the token bucket refill?", title: null })) as { suggestions: Suggestion[] };
    expect(suggestions[0]).toMatchObject({ slug: "global-token", heading: "Limits", reason: "Mentions “token bucket” in Limits" });
    expect(suggestions.length).toBeLessThanOrEqual(5);
    const titled = (await rpc("suggest", { text: "", title: "Global token" })) as { suggestions: Suggestion[] };
    expect(titled.suggestions[0]).toMatchObject({ slug: "global-token", score: 1, reason: "Same title as “Global token”" });
    const tagged = (await rpc("suggest", { text: "@gt is slow", title: null })) as { suggestions: Suggestion[] };
    expect(tagged.suggestions[0]).toMatchObject({ slug: "global-token", reason: "Tagged @gt" });
  });

  it("adds an uploaded image to a doc with one commit", async () => {
    const { wiki, rpc, read, uploadFile, harness } = await setup({ gitHistory: true });
    const uploadId = await uploadFile("Chart.png", "png-bytes");
    expect(((await rpc("importUpload", { uploadId })) as UploadInfo).kind).toBe("image");
    const result = await rpc("addToDoc", {
      target: { kind: "existing", slug: "global-token" },
      heading: "Limits",
      text: "Rate chart:",
      media: [{ from: { kind: "upload", uploadId }, caption: "Tokens over time" }],
      source: { kind: "upload", name: "Chart.png" },
    });
    expect(result).toEqual({ slug: "global-token", title: "Global token" });
    const [asset] = await readdir(path.join(wiki, "assets"));
    expect(asset).toMatch(/^chart-[0-9a-f]{8}\.png$/);
    expect(await readFile(path.join(wiki, "assets", asset ?? ""), "utf8")).toBe("png-bytes");
    expect(await read("global-token.md")).toMatch(
      new RegExp(`<!-- wiki:source upload="Chart\\.png" added="[\\d-]+" -->\\nRate chart:\\n\\n!\\[Tokens over time\\]\\(assets/${asset}\\)\\n$`),
    );
    const log = execFileSync("git", ["-C", wiki, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["Wiki: Rate chart: → Global token"]);
    const served = await harness.behavior.fetchHttp("GET", `/asset?path=${encodeURIComponent(`assets/${asset}`)}`, { headers: { range: "bytes=0-2" } });
    expect(served.status).toBe(206);
    expect(await served.text()).toBe("png");
  });

  it("adds message media to a new doc with the thread title as the source", async () => {
    const files = await tempDir("wiki-message-");
    const clip = path.join(files, "demo.mp4");
    await writeFile(clip, "mp4");
    const message = { message: { text: `Recorded ${clip} and ${path.join(files, "gone.png")}`, attachments: null }, before: [], after: [] };
    const { wiki, rpc, read } = await setup({}, message);
    const { items } = (await rpc("messageMedia", { threadId: "thr_1", messageSeq: 3 })) as { items: Array<{ path: string }> };
    expect(items).toEqual([{ path: clip, name: "demo.mp4", kind: "video", sizeBytes: 3 }]);
    const result = await rpc("addToDoc", {
      target: { kind: "new", title: "Demo videos", type: "topic", aliases: [] },
      heading: "Notes",
      text: "",
      media: [{ from: { kind: "path", path: clip }, caption: "Retry demo" }],
      source: { kind: "thread", threadId: "thr_1", messageId: "msg_1" },
    });
    expect(result).toEqual({ slug: "demo-videos", title: "Demo videos" });
    const [asset] = await readdir(path.join(wiki, "assets"));
    expect(await read("demo-videos.md")).toMatch(
      new RegExp(`<!-- wiki:source thread="thr_1" title="Chat thr_1" added="[\\d-]+" -->\\n<video controls src="assets/${asset}"></video>\\n\\nRetry demo\\n$`),
    );
  });

  it("refuses an empty add and missing media before writing", async () => {
    const { wiki, rpc } = await setup();
    const before = await snapshot(wiki);
    const base = { target: { kind: "existing", slug: "global-token" }, heading: "Limits", source: { kind: "manual" } };
    await expect(rpc("addToDoc", { ...base, text: "  ", media: [] })).rejects.toThrow("Nothing to add");
    await expect(rpc("addToDoc", { ...base, text: "x", media: [{ from: { kind: "path", path: "/nowhere/x.png" }, caption: "" }] })).rejects.toThrow("does not exist");
    await expect(rpc("addToDoc", { ...base, text: "x", media: [{ from: { kind: "upload", uploadId: "upl_000000000000" }, caption: "" }] })).rejects.toThrow("is gone");
    expect(await snapshot(wiki)).toEqual(before);
  });

  it("starts a describe job for images only and reports its state", async () => {
    const { rpc, uploadFile, harness } = await setup();
    const uploadId = await uploadFile("shot.png", "png");
    const { jobId } = (await rpc("describeImage", { from: { kind: "upload", uploadId } })) as { jobId: string };
    expect((await rpc("job", { jobId })) as JobState).toEqual({ status: "running", result: null, error: null });
    const spawn = harness.sdk.callsTo("threads.spawn")[0]?.[0];
    expect(spawn).toMatchObject({ visibility: "hidden", pluginMetadata: { wikiJob: "describe", jobId } });
    await harness.behavior.callAgentTool(DESCRIPTION_TOOL, { description: "A bar chart." }, { threadId: "thr_job" });
    expect(await rpc("job", { jobId })).toEqual({ status: "done", result: "A bar chart.", error: null });
    const videoId = await uploadFile("clip.mp4", "mp4");
    await expect(rpc("describeImage", { from: { kind: "upload", uploadId: videoId } })).rejects.toThrow("clip.mp4 is not an image");
    await expect(rpc("job", { jobId: "job_00000000" })).rejects.toThrow("No Wiki job job_00000000.");
  });
});

describe("inbox cards from other plugins", () => {
  const SKETCH = { experimental_caller: { kind: "plugin", pluginId: "sketch" } } as const;

  it("files a plugin's image as a pending card that outlives its upload, then accepts it into assets", async () => {
    const { wiki, host, harness, rpc, read, uploadFile } = await setup({ gitHistory: true });
    const before = await snapshot(wiki);
    const uploadId = await uploadFile("Roadmap.png", "png-bytes");
    const input = {
      name: "Roadmap.png",
      text: "Q3 roadmap",
      media: [{ from: { kind: "upload", uploadId }, caption: "Roadmap" }],
      target: { kind: "existing", slug: "global-token" },
      heading: "Limits",
      threadId: null,
    };
    const card = (await rpc("addCard", input, SKETCH)) as Card;
    expect(card).toMatchObject({
      status: "pending",
      source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch" },
      text: `Q3 roadmap\n\n![Roadmap](card-media/${card.id}/roadmap.png)`,
      reason: "Sent from Sketch; review before adding.",
    });
    expect(await snapshot(wiki)).toEqual(before);
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain(INBOX_CHANNEL);

    const dataDir = pluginDataDir(host.bb.storage);
    await rm(path.join(dataDir, "uploads"), { recursive: true, force: true });
    const thumbnail = await harness.behavior.fetchHttp("GET", `/card-media?path=${encodeURIComponent(`card-media/${card.id}/roadmap.png`)}`);
    expect(thumbnail.headers.get("content-type")).toBe("image/png");
    expect(await thumbnail.text()).toBe("png-bytes");
    expect((await harness.behavior.runCli(["inbox"])).stdout).toContain(`${card.id}\tpending\tupload: Roadmap.png\tQ3 roadmap\tglobal-token › Limits`);

    await rpc("acceptCard", { id: card.id });
    const [asset] = await readdir(path.join(wiki, "assets"));
    expect(asset).toMatch(/^roadmap-[0-9a-f]{8}\.png$/);
    expect(await read("global-token.md")).toMatch(
      new RegExp(`<!-- wiki:source upload="Roadmap\\.png" added="[\\d-]+" -->\\nQ3 roadmap\\n\\n!\\[Roadmap\\]\\(assets/${asset}\\)\\n$`),
    );
    const log = execFileSync("git", ["-C", wiki, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["Wiki: Q3 roadmap → Global token"]);
    const gone = await harness.behavior.fetchHttp("GET", `/card-media?path=${encodeURIComponent(`card-media/${card.id}/roadmap.png`)}`);
    expect(gone.status).toBe(404);
  });

  it("marks cards from the app or CLI as plain uploads and checks the input", async () => {
    const { wiki, harness, rpc, openCards } = await setup();
    const files = await tempDir("wiki-add-card-");
    await writeFile(path.join(files, "board.png"), "png");
    await writeFile(path.join(files, "demo.mp4"), "mp4");
    const image = (file: string) => [{ from: { kind: "path", path: path.join(files, file) }, caption: "" }];
    const base = { name: "board.png", text: "", media: image("board.png"), target: null, heading: null, threadId: null };
    const card = (await rpc("addCard", base)) as Card;
    expect(card.source).toEqual({ kind: "upload", name: "board.png", pluginId: null, threadId: null });
    expect(card.destinations[0]).toMatchObject({ include: false, target: { kind: "new", title: "board" } });
    expect((await harness.behavior.runCli(["inbox"])).stdout).toBe(`${card.id}\tpending\tupload: board.png\tboard.png\tno destination\n`);
    const before = await snapshot(wiki);
    await expect(rpc("addCard", { name: "board.png", text: "", media: image("board.png"), target: null, heading: null })).rejects.toThrow();
    await expect(rpc("addCard", { ...base, threadId: "" })).rejects.toThrow();
    await expect(rpc("addCard", { ...base, source: { kind: "upload", name: "x", pluginId: "spoof" } }, SKETCH)).rejects.toThrow();
    await expect(rpc("addCard", { ...base, media: [] })).rejects.toThrow("Nothing to add");
    await expect(rpc("addCard", { ...base, media: image("demo.mp4") })).rejects.toThrow("demo.mp4 is a video");
    await expect(rpc("addCard", { ...base, target: { kind: "existing", slug: "missing" } })).rejects.toThrow('there is no Wiki doc with slug "missing"');
    expect(await openCards()).toEqual([card]);
    expect(await snapshot(wiki)).toEqual(before);
  });

  it("lets only the user accept a card an agent sent from a thread", async () => {
    const { wiki, harness, rpc, read } = await setup();
    const files = await tempDir("wiki-thread-card-");
    await writeFile(path.join(files, "board.png"), "png");
    const media = [{ from: { kind: "path", path: path.join(files, "board.png") }, caption: "Board" }];
    const base = { name: "board.png", text: "Agent note.", media, target: { kind: "existing", slug: "global-token" }, heading: "Limits" };
    const sent = (await rpc("addCard", { ...base, threadId: "thr_agent" }, SKETCH)) as Card;
    expect(sent.source).toEqual({ kind: "upload", name: "board.png", pluginId: "sketch", threadId: "thr_agent" });
    const before = await snapshot(wiki);
    const refused = await harness.behavior.runCli(["accept", sent.id], { threadId: "thr_agent" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`${sent.id} was sent by an agent; only the user can accept it.`);
    expect(await snapshot(wiki)).toEqual(before);
    expect((await harness.behavior.runCli(["accept", sent.id])).exitCode).toBe(0);
    expect(await read("global-token.md")).toContain("Agent note.");
    const mine = (await rpc("addCard", { ...base, threadId: null }, SKETCH)) as Card;
    expect((await harness.behavior.runCli(["accept", mine.id], { threadId: "thr_agent" })).exitCode).toBe(0);
  });
});

describe("job threads", () => {
  it("refuses every Wiki write from routing threads, by CLI or wiki_add", async () => {
    const { wiki, harness, rpc, openCards } = await setup();
    const result = (await rpc("ingestNow", { since: "2020-01-01", useAgent: true })) as IngestResult;
    expect(result.jobIds).toHaveLength(1);
    const cards = await openCards();
    const routing = cards.find((card) => card.status === "routing");
    const pending = cards.find((card) => card.status === "pending");
    if (routing === undefined || pending === undefined) throw new Error("expected a routing and a pending card");
    const before = await snapshot(wiki);
    const cli = harness.behavior.runCli;
    const attempts = [
      ["accept", pending.id],
      ["skip", routing.id],
      ["ingest", "--since", "2020-01-01"],
      ["add", "--doc", "gt", "--text", "Routing agent text."],
      ["new", "--title", "Agent doc", "--body", "Agent body."],
      ["alias", "gt", "tok"],
    ];
    for (const threadId of ["thr_job", FRESH_JOB_THREAD]) {
      for (const argv of attempts) {
        const refused = await cli(argv, { threadId });
        expect(refused.exitCode, argv.join(" ")).not.toBe(0);
        expect(refused.stderr).toContain("cannot change the Wiki or its inbox");
      }
      const added = await harness.behavior.callAgentTool(ADD_TOOL, { text: "Routing agent text." }, { threadId });
      expect(isError(added)).toBe(true);
    }
    expect(await snapshot(wiki)).toEqual(before);
    expect(await openCards()).toEqual(cards);
    expect((await cli(["search", "token"], { threadId: "thr_job" })).exitCode).toBe(0);
  });
});

describe("races", () => {
  it("accepts a card only once when two accepts arrive together", async () => {
    const { rpc, read, ingest, openCards } = await setup();
    await ingest();
    const card = tagCard(await openCards());
    const outcomes = await Promise.allSettled([rpc("acceptCard", { id: card.id }), rpc("acceptCard", { id: card.id })]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await read("global-token.md")).match(/Refill is 10 tokens/g)).toHaveLength(1);
  });

  it("refuses an edit that lands while the card is being accepted", async () => {
    const { rpc, read, ingest, openCards } = await setup();
    await ingest();
    const card = tagCard(await openCards());
    const [first] = card.destinations;
    if (first === undefined) throw new Error("no destination");
    const accepting = rpc("acceptCard", { id: card.id });
    const editing = rpc("updateCard", { id: card.id, destinations: [{ ...first, heading: "Limits" }], rememberAliases: [] });
    const [accepted, edited] = await Promise.allSettled([accepting, editing]);
    expect(accepted.status).toBe("fulfilled");
    expect(edited.status).toBe("rejected");
    const stored = (await rpc("card", { id: card.id })) as Card;
    expect(stored).toMatchObject({ status: "accepted", destinations: card.destinations });
    expect(await read("global-token.md")).toContain("---\n\n<!-- wiki:unsorted -->\n\n<!-- wiki:source notes=");
  });
});

describe("partial writes", () => {
  it("checks every file and the target before copying any asset", async () => {
    const { wiki, rpc, uploadFile } = await setup();
    const before = await snapshot(wiki);
    const imageId = await uploadFile("chart.png", "png");
    const longId = await uploadFile("long.txt", "a".repeat(500_001));
    const base = { heading: "Limits", text: "x", source: { kind: "manual" } };
    const image = { from: { kind: "upload", uploadId: imageId }, caption: "" };
    const long = { from: { kind: "upload", uploadId: longId }, caption: "" };
    await expect(rpc("addToDoc", { ...base, target: { kind: "existing", slug: "global-token" }, media: [image, long] })).rejects.toThrow("too long");
    await expect(rpc("addToDoc", { ...base, target: { kind: "existing", slug: "gone" }, media: [image] })).rejects.toThrow('No Wiki doc "gone"');
    expect(await snapshot(wiki)).toEqual(before);
  });

  it("refuses new docs whose aliases already name another doc", async () => {
    const { wiki, rpc } = await setup();
    const before = await snapshot(wiki);
    await expect(rpc("createDoc", { title: "Tokens", type: "topic", aliases: ["GT"], body: "" })).rejects.toThrow('@gt already names "Global token".');
    const target = { kind: "new", title: "Tokens", type: "topic", aliases: ["global-token"] };
    await expect(rpc("addToDoc", { target, heading: "Notes", text: "x", media: [], source: { kind: "manual" } })).rejects.toThrow("already names");
    expect(await snapshot(wiki)).toEqual(before);
  });
});

describe("cli details", () => {
  it("adds under the heading named in --doc Title#Heading", async () => {
    const { harness, read } = await setup();
    const added = await harness.behavior.runCli(["add", "--doc", "Global token#Limits", "--text", "Buckets reset hourly."]);
    expect(added.stdout).toBe("Added to Global token › Limits (global-token).\n");
    expect(await read("global-token.md")).toMatch(/## Limits\n\nEach tenant gets a token bucket\.\n\n<!-- wiki:source manual added="[\d-]+" -->\nBuckets reset hourly\.\n$/);
  });

  it("reports an unusable Wiki folder with a hint instead of crashing", async () => {
    const { wiki, harness } = await setup();
    await rm(wiki, { recursive: true });
    await writeFile(wiki, "not a folder");
    const shown = await harness.behavior.runCli(["show", "gt"]);
    expect(shown.exitCode).not.toBe(0);
    expect(shown.stderr).toContain("bb wiki status");
    expect(shown.stderr).not.toContain("bb wiki failed");
  });
});

describe("long input", () => {
  it("leaves a very long first line alone when stripping the title", () => {
    const line = `# Spaced${" ".repeat(150_000)}x`;
    const started = performance.now();
    expect(withoutTitleLine(`${line}\nBody.`, "Spaced x")).toBe(`${line}\nBody.`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("ui contract", () => {
  it("accepts destination ids made in the browser, previews the last edit, and returns the created doc's slug", async () => {
    const { rpc, read, ingest, openCards } = await setup();
    await ingest();
    const card = tagCard(await openCards());
    const [first] = card.destinations;
    if (first === undefined) throw new Error("no destination");
    const browser = { ...first, id: "dest_2", target: { kind: "new", title: "Token refill", type: "topic", aliases: [] }, heading: "Notes", lineRanges: [{ start: 1, end: 1 }] };
    const saved = (await rpc("updateCard", { id: card.id, destinations: [{ ...first, include: false }, browser], rememberAliases: [] })) as Card;
    expect(saved.destinations.map((entry) => entry.id)).toEqual([first.id, "dest_2"]);
    const before = (await rpc("previewCard", { id: card.id })) as { previews: CardPreview[] };
    expect(before.previews.map((preview) => [preview.destinationId, preview.slug, preview.title])).toEqual([["dest_2", null, "Token refill"]]);
    expect(before.previews[0]?.patch).toContain("+## Notes");

    await rpc("updateCard", { id: card.id, destinations: [{ ...first, include: false }, { ...browser, heading: "Burst" }], rememberAliases: [] });
    const after = (await rpc("previewCard", { id: card.id })) as { previews: CardPreview[] };
    expect(after.previews[0]?.patch).toContain("+## Burst");
    expect(after.previews[0]?.patch).not.toContain("+## Notes");

    const accepted = (await rpc("acceptCard", { id: card.id })) as Card;
    expect(accepted.destinations.find((entry) => entry.id === "dest_2")?.target).toEqual({ kind: "existing", slug: "token-refill" });
    expect(await read("token-refill.md")).toContain("## Burst");
  });

  it("reports the Wiki and notes folders as absolute paths with ~ expanded", async () => {
    const home = await tempDir("wiki-home-");
    await mkdir(path.join(home, "Wiki"));
    await mkdir(path.join(home, "Notes"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const host = createFakePluginHost({
        pluginId: "wiki",
        settings: { wikiDirectory: "~/Wiki/", notesDirectory: "~/Notes", routingAgent: false, gitHistory: false },
      });
      const status = await statusOf(await createWikiContext(host.bb));
      expect(status).toMatchObject({
        wikiDirectory: path.join(home, "Wiki"),
        notesDirectory: path.join(home, "Notes"),
        tagsFile: path.join(home, "Wiki", ".wiki", "tags.json"),
      });
      expect([status.wikiDirectory, status.notesDirectory].every((folder) => path.isAbsolute(folder))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  const notesTagsFileSchema = z.object({ version: z.literal(1), docs: z.array(z.unknown()) });
  const notesTagsFileDocSchema = z.object({
    tag: z.string(),
    title: z.string().catch(""),
    type: z.string().catch(""),
    aliases: z.array(z.string().catch("")).catch([]),
  });
  const notesTag = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function notesRead(content: string) {
    const file = notesTagsFileSchema.parse(JSON.parse(content));
    return file.docs.map((entry) => {
      const strict = notesTagsFileDocSchema.strict().safeParse(entry);
      expect(strict.success).toBe(true);
      return notesTagsFileDocSchema.parse(entry);
    });
  }

  it("writes a tags.json that the Notes plugin's schema reads field for field", async () => {
    const built = tagsJson([
      { tag: "zeta", title: "Zeta", type: "topic", aliases: [] },
      { tag: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] },
    ]);
    expect(notesRead(built)).toEqual([
      { tag: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] },
      { tag: "zeta", title: "Zeta", type: "topic", aliases: [] },
    ]);

    const { rpc, read } = await setup();
    await rpc("addAlias", { slug: "unified-notification", alias: "@Unified Push" });
    const written = await read(".wiki/tags.json");
    const docs = notesRead(written);
    expect(docs).toEqual([
      { tag: "global-token", title: "Global token", type: "topic", aliases: ["gt"] },
      { tag: "unified-notification", title: "Unified notification", type: "project", aliases: ["unified-push"] },
    ]);
    for (const doc of docs) {
      expect([doc.tag, ...doc.aliases].every((tag) => notesTag.test(tag) && tag.length <= 80)).toBe(true);
      expect(doc.aliases).not.toContain(doc.tag);
    }
  });
});
