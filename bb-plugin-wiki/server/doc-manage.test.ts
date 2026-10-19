import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Card, DocSummary, IngestResult, SearchResult } from "../contract";
import plugin from "../server";

const GLOBAL_TOKEN = ["---", "title: Global token", "type: topic", "aliases: [gt]", "---", "", "# Global token", "", "## Limits", "", "Each tenant gets a token bucket.", ""].join("\n");
const UNIFIED = ["---", "type: project", "---", "", "# Unified notification", "", "See [[Global token#Limits]] for rate limits.", ""].join("\n");
const NOTE = ["### NOTES", "", "@gt", "- Refill is 10 tokens per second.", ""].join("\n");

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function setup(gitHistory = false) {
  const wiki = await tempDir("wiki-manage-");
  const notes = await tempDir("notes-manage-");
  await writeFile(path.join(wiki, "global-token.md"), GLOBAL_TOKEN);
  await writeFile(path.join(wiki, "unified-notification.md"), UNIFIED);
  await mkdir(path.join(notes, "Time"), { recursive: true });
  await writeFile(path.join(notes, "Time", "01-05-24.md"), NOTE);
  const host = createFakePluginHost({
    pluginId: "wiki",
    agentSkillIds: ["wiki"],
    settings: { wikiDirectory: wiki, notesDirectory: notes, routingAgent: false, gitHistory },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, title: `Chat ${threadId}` }),
        getPluginMetadata: async () => ({}),
      },
      projects: { list: async () => [{ id: "proj_personal" }] },
    },
  });
  await plugin(host.bb);
  const { harness } = host;
  const rpc = harness.behavior.callRpc;
  const ingest = async () => (await rpc("ingestNow", { since: "2020-01-01", useAgent: false })) as IngestResult;
  const openCards = async () => (await rpc("inbox", { status: "open" })) as Card[];
  const files = async () => (await readdir(wiki)).filter((name) => name.endsWith(".md")).sort();
  const git = (...args: string[]) => execFileSync("git", ["-C", wiki, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { wiki, harness, rpc, ingest, openCards, files, git };
}

describe("rename", () => {
  it("moves the file, keeps the old name as an alias, and keeps links and tags resolving", async () => {
    const { wiki, rpc, files } = await setup();
    const renamed = (await rpc("renameDoc", { slug: "global-token", title: "Rate limiting" })) as DocSummary;
    expect(renamed).toMatchObject({ slug: "rate-limiting", title: "Rate limiting", type: "topic" });
    expect(renamed.aliases).toEqual(expect.arrayContaining(["gt", "global-token"]));
    expect(await files()).toEqual(["rate-limiting.md", "unified-notification.md"]);
    const content = await readFile(path.join(wiki, "rate-limiting.md"), "utf8");
    expect(content).toContain("title: Rate limiting");
    expect(content).toContain("\n# Rate limiting\n");
    expect(content).toContain("## Limits\n\nEach tenant gets a token bucket.\n");
    expect(await readFile(path.join(wiki, "unified-notification.md"), "utf8")).toBe(UNIFIED);
    const backlinks = ((await rpc("doc", { slug: "rate-limiting" })) as { backlinks: { slug: string }[] }).backlinks;
    expect(backlinks.map((link) => link.slug)).toEqual(["unified-notification"]);
    const tags = JSON.parse(await readFile(path.join(wiki, ".wiki", "tags.json"), "utf8"));
    expect(tags.docs.find((doc: { tag: string }) => doc.tag === "rate-limiting")?.aliases).toEqual(expect.arrayContaining(["global-token", "gt"]));
    expect(await rpc("doc", { slug: "global-token" })).toBeNull();
  });

  it("points open inbox cards at the renamed doc", async () => {
    const { rpc, ingest, openCards } = await setup();
    await ingest();
    const before = (await openCards())[0];
    expect(before?.destinations.some((dest) => dest.target.kind === "existing" && dest.target.slug === "global-token")).toBe(true);
    await rpc("renameDoc", { slug: "global-token", title: "Rate limiting" });
    const after = (await openCards())[0];
    expect(after?.destinations.some((dest) => dest.target.kind === "existing" && dest.target.slug === "rate-limiting")).toBe(true);
    const accepted = (await rpc("acceptCard", { id: after?.id })) as Card;
    expect(accepted.status).toBe("accepted");
  });

  it("only edits the title when the new title keeps the same file name", async () => {
    const { wiki, rpc, files } = await setup();
    const renamed = (await rpc("renameDoc", { slug: "global-token", title: "Global Token" })) as DocSummary;
    expect(renamed.slug).toBe("global-token");
    expect(await files()).toEqual(["global-token.md", "unified-notification.md"]);
    expect(await readFile(path.join(wiki, "global-token.md"), "utf8")).toContain("title: Global Token");
  });

  it("refuses a missing doc and an empty title", async () => {
    const { rpc } = await setup();
    await expect(rpc("renameDoc", { slug: "nope", title: "X" })).rejects.toThrow('No Wiki doc "nope"');
    await expect(rpc("renameDoc", { slug: "global-token", title: "   " })).rejects.toThrow();
  });
});

describe("delete", () => {
  it("removes the file and index entry and switches off inbox destinations", async () => {
    const { wiki, rpc, ingest, openCards, files } = await setup();
    await ingest();
    expect(await rpc("deleteDoc", { slug: "global-token" })).toEqual({ slug: "global-token", title: "Global token" });
    expect(await files()).toEqual(["unified-notification.md"]);
    expect(await rpc("doc", { slug: "global-token" })).toBeNull();
    const found = (await rpc("search", { query: "bucket", type: null, limit: 10 })) as SearchResult;
    expect(found.sections).toEqual([]);
    const card = (await openCards())[0];
    const dest = card?.destinations.find((entry) => entry.target.kind === "new" && entry.target.title === "Global token");
    expect(dest?.include).toBe(false);
    const tags = JSON.parse(await readFile(path.join(wiki, ".wiki", "tags.json"), "utf8"));
    expect(tags.docs.map((doc: { tag: string }) => doc.tag)).toEqual(["unified-notification"]);
    await expect(rpc("deleteDoc", { slug: "global-token" })).rejects.toThrow('No Wiki doc "global-token"');
  });

  it.runIf(hasGit())("commits the deletion and the rename so both can be undone", async () => {
    const { rpc, git } = await setup(true);
    await rpc("addAlias", { slug: "global-token", alias: "bucket" });
    await rpc("renameDoc", { slug: "global-token", title: "Rate limiting" });
    await rpc("deleteDoc", { slug: "unified-notification" });
    expect(git("status", "--porcelain")).not.toContain("rate-limiting.md");
    const log = git("log", "--format=%s", "--name-status");
    expect(log).toContain("Wiki: delete Unified notification");
    expect(log).toContain("Wiki: rename Global token → Rate limiting");
    expect(log).toMatch(/D\tglobal-token\.md/);
    expect(log).toMatch(/A\trate-limiting\.md/);
    expect(git("ls-files")).not.toContain("global-token.md");
    expect(log).toContain("Wiki: save Unified notification before deleting it");
    expect(git("show", "HEAD~1:unified-notification.md")).toBe(UNIFIED);
  });
});

describe("cli", () => {
  it("renames and deletes as the user, and refuses both from a thread", async () => {
    const { harness, files } = await setup();
    const cli = harness.behavior.runCli;
    const refusedRename = await cli(["rename", "gt", "Agent", "title"], { threadId: "thr_agent" });
    expect(refusedRename.exitCode).not.toBe(0);
    expect(refusedRename.stderr).toContain("only the user does that");
    expect((await cli(["delete", "gt"], { threadId: "thr_agent" })).exitCode).not.toBe(0);
    expect(await files()).toEqual(["global-token.md", "unified-notification.md"]);
    expect((await cli(["rename", "gt", "Rate", "limiting"])).stdout).toBe("Renamed to Rate limiting (rate-limiting).\n");
    expect((await cli(["rm", "rate-limiting"])).stdout).toBe("Deleted Rate limiting (rate-limiting).\n");
    expect(await files()).toEqual(["unified-notification.md"]);
  });
});

describe("restore", () => {
  it("puts a skipped card back in the inbox, and re-ingest still makes no duplicate", async () => {
    const { rpc, ingest, openCards, harness } = await setup();
    await ingest();
    const card = (await openCards())[0];
    await rpc("skipCard", { id: card?.id });
    expect(await openCards()).toEqual([]);
    expect(((await rpc("restoreCard", { id: card?.id })) as Card).status).toBe("pending");
    expect((await openCards()).map((entry) => entry.id)).toEqual([card?.id]);
    expect((await ingest()).cardsCreated).toBe(0);
    await rpc("acceptCard", { id: card?.id });
    await expect(rpc("restoreCard", { id: card?.id })).rejects.toThrow("already accepted");
    const restored = await harness.behavior.runCli(["restore", card?.id ?? ""], { threadId: "thr_agent" });
    expect(restored.exitCode).not.toBe(0);
  });
});
