import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Card, IngestResult } from "../contract";
import plugin from "../server";

const PROJECT = ["---", "title: Plan", "---", "# Plan", "Goal line.", "", "## How to test", "- run `make test`", "  - check logs", "", "## Risks", "- none yet", ""].join("\n");
const GO = ["# Go", "", "```bash", "# build", "go build ./...", "```", ""].join("\n");

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function setup() {
  const wiki = await tempDir("wiki-import-");
  const notes = await tempDir("notes-import-");
  await writeFile(path.join(wiki, "unified-notification.md"), "---\ntype: project\n---\n\n# Unified notification\n");
  await mkdir(path.join(notes, "Projects", "unified-notification", "pics"), { recursive: true });
  await mkdir(path.join(notes, "Projects", "x", "Saved page_files"), { recursive: true });
  await mkdir(path.join(notes, "Tools"), { recursive: true });
  await writeFile(path.join(notes, "Projects", "unified-notification", "plan.md"), PROJECT);
  await writeFile(path.join(notes, "Projects", "unified-notification", "09-14-26.md"), "### NOTES\n- daily\n");
  await writeFile(path.join(notes, "Projects", "x", "Saved page_files", "junk.md"), "# junk\n");
  await writeFile(path.join(notes, "Projects", "x", "page.html"), "<p>no</p>");
  await writeFile(path.join(notes, "Tools", "go.md"), GO);
  const host = createFakePluginHost({
    pluginId: "wiki",
    agentSkillIds: ["wiki"],
    settings: { wikiDirectory: wiki, notesDirectory: notes, routingAgent: false, gitHistory: false },
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }), getPluginMetadata: async () => ({}) },
      projects: { list: async () => [{ id: "proj_personal" }] },
    },
  });
  await plugin(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const snapshot = async () => (await readdir(notes, { recursive: true })).sort();
  return { wiki, notes, host, rpc, snapshot };
}

describe("importFolders", () => {
  it("chunks reference notes by section with the folder as the tag and the section as the heading", async () => {
    const { rpc, snapshot } = await setup();
    const before = await snapshot();
    const result = (await rpc("importFolders", { folders: ["Projects", "Tools"], useAgent: false })) as IngestResult;
    expect(result).toEqual({ notesScanned: 2, unitsFound: 4, cardsCreated: 4, jobIds: [] });
    const cards = (await rpc("inbox", { status: "open" })) as Card[];
    const byText = new Map(cards.map((card) => [card.text, card]));
    const test = byText.get("- run `make test`\n  - check logs");
    expect(test?.source).toMatchObject({ kind: "notes", origin: "file", notePath: "Projects/unified-notification/plan.md", section: "Plan › How to test" });
    expect(test?.tags).toEqual(["unified-notification"]);
    expect(test?.rule).toBe("tag");
    expect(test?.destinations[0]).toMatchObject({ target: { kind: "existing", slug: "unified-notification" }, heading: "How to test" });
    const go = cards.find((card) => card.source.kind === "notes" && card.source.notePath === "Tools/go.md");
    expect(go?.lines).toEqual(["```bash", "# build", "go build ./...", "```"]);
    expect(go?.tags).toEqual(["go"]);
    expect(cards.some((card) => card.text.includes("daily") || card.text.includes("junk"))).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("is idempotent and labels accepted text with the file it came from", async () => {
    const { wiki, rpc } = await setup();
    await rpc("importFolders", { folders: ["Projects"], useAgent: false });
    expect(((await rpc("importFolders", { folders: ["Projects/"], useAgent: false })) as IngestResult).cardsCreated).toBe(0);
    const cards = (await rpc("inbox", { status: "open" })) as Card[];
    const risks = cards.find((card) => card.text === "- none yet");
    await rpc("acceptCard", { id: risks?.id });
    const doc = await readFile(path.join(wiki, "unified-notification.md"), "utf8");
    expect(doc).toContain('## Risks\n\n<!-- wiki:source notes="Projects/unified-notification/plan.md" date="" added="');
    expect(doc).toContain("-->\n- none yet\n");
  });

  it("refuses folders outside the notes folder", async () => {
    const { rpc } = await setup();
    await expect(rpc("importFolders", { folders: ["../etc"], useAgent: false })).rejects.toThrow("inside the notes folder");
    await expect(rpc("importFolders", { folders: ["Nope"], useAgent: false })).rejects.toThrow('No folder "Nope"');
  });
});
