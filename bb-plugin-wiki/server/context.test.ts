import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { WATCH_SERVICE } from "../server";
import { MAINTENANCE_SERVICE } from "./maintenance";
import { SCHEDULE_SERVICE } from "./schedule";
import { CHANGED_CHANNEL, INBOX_CHANNEL } from "../lib/wiki";
import {
  FOLDER_OVERLAP_MESSAGE,
  WIKI_SETTING_DEFAULTS,
  assertSeparateFolders,
  createWikiContext,
  foldersOverlap,
  isCalendarDate,
  isTimeOfDay,
  isTimeZone,
  pluginDataDir,
} from "./context";
import { createStore } from "./store";
import { tagsFilePath } from "./vault";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-context-");
  const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: wiki, ...settings } });
  const ctx = await createWikiContext(host.bb);
  return { wiki, ctx, harness: host.harness, bb: host.bb };
}

describe("setting checks", () => {
  it("accepts 24-hour times only", () => {
    for (const value of ["00:00", "07:00", "23:59"]) expect(isTimeOfDay(value)).toBe(true);
    for (const value of ["7:00", "24:00", "07:60", "07:00 ", "", "0700"]) expect(isTimeOfDay(value)).toBe(false);
  });

  it("accepts real calendar dates only", () => {
    for (const value of ["2026-10-14", "2024-02-29"]) expect(isCalendarDate(value)).toBe(true);
    for (const value of ["2026-02-30", "2025-02-29", "2026-13-01", "10-14-26", "2026-1-01", ""]) expect(isCalendarDate(value)).toBe(false);
  });

  it("accepts IANA time zones", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("createWikiContext settings", () => {
  it("fills in the defaults", async () => {
    const host = createFakePluginHost({ pluginId: "wiki" });
    const ctx = await createWikiContext(host.bb);
    expect(await ctx.settings()).toEqual(WIKI_SETTING_DEFAULTS);
    expect(await ctx.wikiRoot()).toBe(path.join(homedir(), "Wiki"));
    expect(await ctx.notesRoot()).toBe(path.join(homedir(), "Notes"));
    expect(Object.keys(host.harness.inspection.registrations.settingsDescriptors).sort()).toEqual(Object.keys(WIKI_SETTING_DEFAULTS).sort());
  });

  it("reads settings on every call", async () => {
    const { ctx, harness } = await setup();
    const notes = await tempDir("wiki-notes-");
    await harness.behavior.setSettings({ notesDirectory: notes, ingestTime: "06:30", routingAgent: false, timezone: "Europe/Paris" });
    expect(await ctx.settings()).toMatchObject({ notesDirectory: notes, ingestTime: "06:30", routingAgent: false, timezone: "Europe/Paris" });
    expect(await ctx.notesRoot()).toBe(notes);
    await harness.behavior.setSettings({ ingestTime: null });
    expect((await ctx.settings()).ingestTime).toBe("07:00");
  });

  it.each([
    ["ingestTime", "7am"],
    ["ingestTime", "24:00"],
    ["ingestStartDate", "2026-02-30"],
    ["ingestStartDate", "10-14-26"],
    ["timezone", "Mars/Olympus_Mons"],
    ["wikiDirectory", "Wiki"],
    ["wikiDirectory", "~"],
    ["wikiDirectory", "/"],
    ["wikiDirectory", homedir()],
    ["notesDirectory", "./Notes"],
  ])("rejects %s = %j", async (key, value) => {
    const { harness } = await setup();
    await expect(harness.behavior.setSettings({ [key]: value })).rejects.toThrow();
  });

  it("accepts empty optional values and home-relative folders", async () => {
    const { ctx, harness } = await setup();
    await harness.behavior.setSettings({ ingestStartDate: "2026-10-01", timezone: "" });
    await harness.behavior.setSettings({ ingestStartDate: "", wikiDirectory: "~/Documents/Wiki" });
    expect(await ctx.settings()).toMatchObject({ ingestStartDate: "", timezone: "", wikiDirectory: "~/Documents/Wiki" });
    expect(await ctx.wikiRoot()).toBe(path.join(homedir(), "Documents", "Wiki"));
  });

  it("falls back to defaults for stored values that no longer pass the checks", async () => {
    const { ctx } = await setup({ ingestTime: "7am", ingestStartDate: "yesterday", timezone: "Nowhere/Land", notesDirectory: "relative" });
    expect(await ctx.settings()).toMatchObject({ ingestTime: "07:00", ingestStartDate: "", timezone: "", notesDirectory: "~/Notes" });
  });

  it("never uses the home folder itself as the Wiki folder", async () => {
    const { ctx } = await setup({ wikiDirectory: "~" });
    expect((await ctx.settings()).wikiDirectory).toBe("~/Wiki");
    expect(await ctx.wikiRoot()).toBe(path.join(homedir(), "Wiki"));
  });
});

describe("createWikiContext helpers", () => {
  it("finds the plugin data folder from the database file", async () => {
    const { ctx, bb } = await setup();
    const rows: unknown = bb.storage.database().prepare("PRAGMA database_list").all();
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: "main" })]));
    expect(ctx.dataDir()).toBe(await realpath(path.dirname(bb.storage.database().name)));
    expect(pluginDataDir(bb.storage)).toBe(ctx.dataDir());
  });

  it("publishes the changed and inbox channels", async () => {
    const { ctx, harness } = await setup();
    ctx.publishChanged();
    ctx.publishInbox();
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([CHANGED_CHANNEL, INBOX_CHANNEL]);
  });

  it("wires the vault to the Wiki folder and the git history setting", async () => {
    const { ctx, wiki } = await setup({ gitHistory: false });
    const { slug } = await ctx.vault.createDoc({ title: "Global token", type: "topic", aliases: [] });
    expect(await readFile(path.join(wiki, `${slug}.md`), "utf8")).toContain("# Global token");
    expect(ctx.store.getDoc(slug)?.path).toBe(path.join(wiki, `${slug}.md`));
    await ctx.vault.commit("Wiki: Global token", [`${slug}.md`]);
    expect(await exists(path.join(wiki, ".git"))).toBe(false);
  });
});

describe("Wiki and Notes folder overlap", () => {
  async function folders() {
    const parent = await tempDir("wiki-overlap-");
    const notes = path.join(parent, "Notes");
    await mkdir(notes);
    await writeFile(path.join(notes, "10-14-26.md"), "# Day\n\n## NOTES\n\n- keep me\n");
    return { parent, notes };
  }

  async function contextFor(wikiDirectory: string, notesDirectory: string) {
    const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory, notesDirectory, gitHistory: false } });
    return createWikiContext(host.bb);
  }

  it("refuses when the Wiki folder is the Notes folder", async () => {
    const { notes } = await folders();
    const ctx = await contextFor(notes, notes);
    await expect(ctx.wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
  });

  it("refuses when the Wiki folder is inside the Notes folder, and writes nothing there", async () => {
    const { notes } = await folders();
    const ctx = await contextFor(path.join(notes, "Wiki"), notes);
    await expect(ctx.wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    await expect(ctx.vault.createDoc({ title: "Global token", type: "topic", aliases: [] })).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    await expect(ctx.vault.syncAll()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    expect(await readdir(notes)).toEqual(["10-14-26.md"]);
  });

  it("refuses when the Notes folder is inside the Wiki folder", async () => {
    const { parent } = await folders();
    const ctx = await contextFor(parent, path.join(parent, "Notes"));
    await expect(ctx.wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
  });

  it("refuses a symlinked alias of the Notes folder", async () => {
    const { parent, notes } = await folders();
    const alias = path.join(parent, "NotesAlias");
    await symlink(notes, alias);
    await expect((await contextFor(alias, notes)).wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    await expect((await contextFor(path.join(alias, "Wiki"), notes)).wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    await expect((await contextFor(notes, alias)).wikiRoot()).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
  });

  it("allows sibling folders, including ones that share a name prefix", async () => {
    const { parent, notes } = await folders();
    expect(await (await contextFor(path.join(parent, "Wiki"), notes)).wikiRoot()).toBe(path.join(parent, "Wiki"));
    expect(await (await contextFor(`${notes}-wiki`, notes)).wikiRoot()).toBe(`${notes}-wiki`);
    await expect(assertSeparateFolders(path.join(parent, "Notes2"), notes)).resolves.toBeUndefined();
  });

  it("compares paths case-insensitively when asked", () => {
    expect(foldersOverlap("/Users/me/Notes/Wiki", "/Users/me/notes", true)).toBe(true);
    expect(foldersOverlap("/Users/me/Notes/Wiki", "/Users/me/notes", false)).toBe(false);
    expect(foldersOverlap("/Users/me/Wiki", "/Users/me/Notes", true)).toBe(false);
  });

  it("still loads, and the status rpc reports the problem", async () => {
    const { notes } = await folders();
    const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: path.join(notes, "Wiki"), notesDirectory: notes, gitHistory: false } });
    await expect(plugin(host.bb)).resolves.toBeUndefined();
    await expect(host.harness.behavior.callRpc("status", {})).rejects.toThrow(FOLDER_OVERLAP_MESSAGE);
    expect(host.harness.inspection.logEntries.some((entry) => entry.level === "warn" && entry.message.includes(FOLDER_OVERLAP_MESSAGE))).toBe(true);
    expect(await readdir(notes)).toEqual(["10-14-26.md"]);
  });
});

describe("plugin wiring", () => {
  it("indexes the Wiki at startup and registers the watcher", async () => {
    const wiki = await tempDir("wiki-plugin-");
    await writeFile(path.join(wiki, "global-token.md"), "# Global token\n");
    const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: wiki } });
    await plugin(host.bb);
    const store = createStore(host.bb.storage);
    expect(store.getDoc("global-token")?.title).toBe("Global token");
    expect(JSON.parse(await readFile(tagsFilePath(wiki), "utf8")).docs).toEqual([
      { tag: "global-token", title: "Global token", type: "topic", aliases: [] },
    ]);
    expect(host.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([CHANGED_CHANNEL]);
    expect(host.harness.inspection.registrations.services.map((service) => service.name)).toEqual([WATCH_SERVICE, SCHEDULE_SERVICE, MAINTENANCE_SERVICE]);
    const service = host.harness.behavior.runService(WATCH_SERVICE);
    service.controller.abort();
    await service.done;
  });

  it("loads and logs when the Wiki folder is unusable", async () => {
    const parent = await tempDir("wiki-plugin-");
    const notFolder = path.join(parent, "Wiki");
    await writeFile(notFolder, "a file");
    const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: notFolder } });
    await expect(plugin(host.bb)).resolves.toBeUndefined();
    expect(host.harness.inspection.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("not a folder"))).toBe(true);
  });
});
