import { execFileSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import {
  COMMIT_IDLE_MS,
  COMMIT_MAX_WAIT_MS,
  VaultError,
  buildIndexedDoc,
  createVault,
  docRelPath,
  isDocEvent,
  isDocSlug,
  isFolderSetting,
  resolveRoot,
  tagsFilePath,
  tagsJson,
  type VaultDeps,
  type WatchFactory,
} from "./vault";

const PAST = new Date("2020-01-01T00:00:00Z");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

async function walkNames(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true });
  return entries.map(String).sort();
}

interface SetupOptions extends Partial<Omit<VaultDeps, "store" | "log">> {
  git?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const root = await tempDir("wiki-vault-");
  const host = createFakePluginHost({ pluginId: "wiki" });
  const store = createStore(host.bb.storage);
  const warnings: string[] = [];
  const log = { debug: () => undefined, info: () => undefined, warn: (message: string) => warnings.push(message) };
  let currentRoot = root;
  const { git, ...rest } = options;
  const vault = createVault({
    getRoot: async () => currentRoot,
    store,
    gitEnabled: async () => git ?? false,
    log,
    ...rest,
  });
  const file = (rel: string) => path.join(root, rel);
  const put = async (rel: string, content: string | Uint8Array) => {
    await mkdir(path.dirname(file(rel)), { recursive: true });
    await writeFile(file(rel), content);
  };
  const read = (rel: string) => readFile(file(rel), "utf8");
  const switchRoot = (next: string) => {
    currentRoot = next;
  };
  return { root, store, vault, warnings, file, put, read, switchRoot };
}

const FRONTMATTER = "---\ntitle:   Adding config catalog   # keep me\ntype: process\naliases: [cc]\nowner: rachel\n---\n";

describe("resolveRoot", () => {
  it("expands the home folder and normalizes the path", () => {
    expect(resolveRoot("~/Wiki", "/Users/me")).toBe("/Users/me/Wiki");
    expect(resolveRoot("~", "/Users/me")).toBe("/Users/me");
    expect(resolveRoot("  /srv/wiki/  ", "/Users/me")).toBe("/srv/wiki");
    expect(resolveRoot("/srv/a/../wiki//docs", "/Users/me")).toBe("/srv/wiki/docs");
    expect(resolveRoot("/", "/Users/me")).toBe("/");
  });

  it.each(["", "   ", "Wiki", "./Wiki", "~other/Wiki", "/srv/wi\0ki"])("refuses %j", (raw) => {
    expect(() => resolveRoot(raw, "/Users/me")).toThrow(VaultError);
    expect(isFolderSetting(raw)).toBe(false);
  });

  it("accepts the folder settings defaults", () => {
    expect(isFolderSetting("~/Wiki")).toBe(true);
    expect(isFolderSetting("/Users/me/Notes")).toBe(true);
  });
});

describe("slugs and events", () => {
  it("accepts doc slugs at any depth except in assets and node_modules folders", () => {
    expect(isDocSlug("alpha")).toBe(true);
    expect(isDocSlug("projects/beta")).toBe(true);
    expect(isDocSlug("assets")).toBe(true);
    expect(isDocSlug("projects/assets/delta")).toBe(true);
    for (const slug of ["", "../x", "a//b", ".wiki/tags", "a/.hidden", "assets/pic", "x/node_modules/y", "a\\b"]) {
      expect(isDocSlug(slug)).toBe(false);
    }
    expect(docRelPath("projects/beta")).toBe("projects/beta.md");
  });

  it("ignores watcher events for hidden, assets and node_modules paths", () => {
    expect(isDocEvent(null)).toBe(true);
    expect(isDocEvent("alpha.md")).toBe(true);
    expect(isDocEvent("projects")).toBe(true);
    expect(isDocEvent("projects/beta.md")).toBe(true);
    for (const name of [".git/index", ".wiki/tags.json", ".alpha.md.1a2b.tmp", "projects/.beta.md.tmp", "assets/x.png", "node_modules/a/b.md"]) {
      expect(isDocEvent(name)).toBe(false);
    }
  });
});

describe("listDocFiles", () => {
  it("lists Markdown docs recursively and skips hidden, assets, node_modules and symlinks", async () => {
    const { vault, put, file, root } = await setup();
    await put("alpha.md", "# Alpha\n");
    await put("projects/beta.md", "# Beta\n");
    await put("projects/deep/gamma.md", "# Gamma\n");
    await put("projects/assets/delta.md", "# Delta\n");
    await put(".wiki/hidden.md", "x");
    await put(".git/x.md", "x");
    await put(".drafts/draft.md", "x");
    await put("assets/pic.md", "x");
    await put("node_modules/pkg/readme.md", "x");
    await put("notes.txt", "x");
    await put(".dotfile.md", "x");
    await put("UPPER.MD", "x");
    await put(".alpha.md.abc123.tmp", "x");
    const outside = await tempDir("wiki-outside-");
    await writeFile(path.join(outside, "secret.md"), "outside");
    await symlink(file("alpha.md"), file("link.md"));
    await symlink(outside, path.join(root, "linked"));

    const files = await vault.listDocFiles();
    expect(files.map((entry) => entry.slug)).toEqual(["alpha", "projects/assets/delta", "projects/beta", "projects/deep/gamma"]);
    const alpha = files[0]!;
    const stats = await stat(file("alpha.md"));
    expect(alpha).toEqual({ slug: "alpha", path: file("alpha.md"), mtimeMs: stats.mtimeMs, size: stats.size });
  });

  it("creates a missing Wiki folder", async () => {
    const parent = await tempDir("wiki-parent-");
    const missing = path.join(parent, "Wiki");
    const { vault } = await setup({ getRoot: async () => missing });
    expect(await vault.listDocFiles()).toEqual([]);
    expect((await stat(missing)).isDirectory()).toBe(true);
    expect(await vault.ensureRoot()).toBe(missing);
  });

  it("refuses a Wiki folder that holds the home folder", async () => {
    for (const broad of [homedir(), path.dirname(homedir()), "/"]) {
      const { vault } = await setup({ getRoot: async () => broad });
      await expect(vault.listDocFiles()).rejects.toMatchObject({ code: "invalid-root" });
      await expect(vault.writeDoc("doc", "x")).rejects.toMatchObject({ code: "invalid-root" });
      await expect(vault.commit("Wiki: doc")).resolves.toBeUndefined();
    }
  });

  it("skips assets and node_modules folders whatever their case", async () => {
    const { vault, put } = await setup();
    await put("keep.md", "# Keep\n");
    await put("ASSETS/pic.md", "x");
    await put("deep/Node_Modules/pkg.md", "x");
    expect((await vault.listDocFiles()).map((entry) => entry.slug)).toEqual(["keep"]);
    expect(isDocSlug("Assets/pic")).toBe(false);
    expect(isDocSlug("deep/NODE_MODULES/pkg")).toBe(false);
    expect(isDocEvent("Assets/x.png")).toBe(false);
  });

  it("refuses a Wiki folder that is a file", async () => {
    const parent = await tempDir("wiki-parent-");
    const notFolder = path.join(parent, "Wiki");
    await writeFile(notFolder, "file");
    const { vault } = await setup({ getRoot: async () => notFolder });
    await expect(vault.listDocFiles()).rejects.toMatchObject({ code: "invalid-root" });
  });
});

describe("readDoc", () => {
  it("returns the content, its sha256 and the path", async () => {
    const { vault, put, file } = await setup();
    await put("projects/beta.md", "# Beta\n\nCafé ☕\n");
    expect(await vault.readDoc("projects/beta")).toEqual({
      content: "# Beta\n\nCafé ☕\n",
      sha256: sha(Buffer.from("# Beta\n\nCafé ☕\n", "utf8")),
      path: file("projects/beta.md"),
    });
  });

  it("returns null for missing docs and unsafe slugs", async () => {
    const { vault, put } = await setup();
    await put(".wiki/tags.md", "x");
    await put("assets/pic.md", "x");
    for (const slug of ["missing", "", "../escape", ".wiki/tags", "assets/pic", "a//b"]) {
      expect(await vault.readDoc(slug)).toBeNull();
    }
  });

  it("does not follow symlinks out of the Wiki folder", async () => {
    const { vault, root, file } = await setup();
    const outside = await tempDir("wiki-outside-");
    await writeFile(path.join(outside, "secret.md"), "outside");
    await symlink(path.join(outside, "secret.md"), file("leak.md"));
    await symlink(outside, path.join(root, "linked"));
    expect(await vault.readDoc("leak")).toBeNull();
    expect(await vault.readDoc("linked/secret")).toBeNull();
  });
});

describe("writeDoc", () => {
  it("writes unconditionally when no sha256 is given, creating folders", async () => {
    const { vault, read, store } = await setup();
    const first = await vault.writeDoc("projects/new-doc", "# New doc\n");
    expect(first).toEqual({ outcome: "written", sha256: sha("# New doc\n"), changed: true });
    expect(await read("projects/new-doc.md")).toBe("# New doc\n");
    const second = await vault.writeDoc("projects/new-doc", "# Renamed\n", undefined);
    expect(second).toEqual({ outcome: "written", sha256: sha("# Renamed\n"), changed: true });
    expect(store.getDoc("projects/new-doc")).toMatchObject({ title: "Renamed", sha256: sha("# Renamed\n") });
  });

  it("creates only when the sha256 is null", async () => {
    const { vault, put, read } = await setup();
    expect(await vault.writeDoc("fresh", "fresh\n", null)).toEqual({ outcome: "written", sha256: sha("fresh\n"), changed: true });
    await put("taken.md", "original\n");
    expect(await vault.writeDoc("taken", "replacement\n", null)).toEqual({ outcome: "conflict" });
    expect(await read("taken.md")).toBe("original\n");
  });

  it("writes only over the expected content when a sha256 is given", async () => {
    const { vault, put, read, file } = await setup();
    await put("doc.md", "v1\n");
    expect(await vault.writeDoc("doc", "v2\n", sha("stale\n"))).toEqual({ outcome: "conflict" });
    expect(await read("doc.md")).toBe("v1\n");
    expect(await vault.writeDoc("doc", "v2\n", sha("v1\n"))).toEqual({ outcome: "written", sha256: sha("v2\n"), changed: true });
    expect(await read("doc.md")).toBe("v2\n");
    expect(await vault.writeDoc("missing", "x\n", sha("v1\n"))).toEqual({ outcome: "conflict" });
    expect(await exists(file("missing.md"))).toBe(false);
  });

  it("creates no folders when the write is a conflict", async () => {
    const { vault, file } = await setup();
    expect(await vault.writeDoc("new/folder/doc", "x\n", sha("v1\n"))).toEqual({ outcome: "conflict" });
    expect(await exists(file("new"))).toBe(false);
  });

  it("replaces the file atomically and leaves no temp files", async () => {
    const { vault, put, file, root } = await setup();
    await put("doc.md", "old\n");
    await link(file("doc.md"), path.join(root, "..", `${path.basename(root)}-old-link`));
    await vault.writeDoc("doc", "new\n");
    expect(await readFile(path.join(root, "..", `${path.basename(root)}-old-link`), "utf8")).toBe("old\n");
    expect(await readFile(file("doc.md"), "utf8")).toBe("new\n");
    expect((await walkNames(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the file's permissions when it replaces a doc", async () => {
    const { vault, put, file } = await setup();
    await put("private.md", "# Private\n");
    const mode = async () => (await stat(file("private.md"))).mode & 0o7777;
    await chmod(file("private.md"), 0o600);
    await vault.appendBlock("private", "Notes", "- secret fact");
    expect(await mode()).toBe(0o600);
    await vault.addAlias("private", "hush");
    expect(await mode()).toBe(0o600);
    await chmod(file("private.md"), 0o640);
    const current = await vault.readDoc("private");
    await vault.writeDoc("private", "# Private\n\nRewritten.\n", current?.sha256);
    expect(await mode()).toBe(0o640);
  });

  it("does not touch the file when the content is unchanged", async () => {
    const { vault, put, file } = await setup();
    await put("doc.md", "same\n");
    await utimes(file("doc.md"), PAST, PAST);
    await vault.syncAll();
    expect(await vault.writeDoc("doc", "same\n", sha("same\n"))).toEqual({ outcome: "written", sha256: sha("same\n"), changed: false });
    expect((await stat(file("doc.md"))).mtimeMs).toBe(PAST.getTime());
  });

  it("reports a change when unchanged content brings a stale index up to date", async () => {
    const { vault, put, store } = await setup();
    await put("doc.md", "# Old\n");
    await vault.syncAll();
    await put("doc.md", "# New title\n");
    expect(await vault.writeDoc("doc", "# New title\n", sha("# New title\n"))).toEqual({ outcome: "written", sha256: sha("# New title\n"), changed: true });
    expect(store.getDoc("doc")?.title).toBe("New title");
    expect(await vault.writeDoc("doc", "# New title\n", sha("# New title\n"))).toMatchObject({ changed: false });
  });

  it("refuses unsafe slugs and folders that lead outside the Wiki", async () => {
    const { vault, root } = await setup();
    await expect(vault.writeDoc("../escape", "x")).rejects.toMatchObject({ code: "invalid-slug" });
    await expect(vault.writeDoc("assets/x", "x")).rejects.toMatchObject({ code: "invalid-slug" });
    const outside = await tempDir("wiki-outside-");
    await symlink(outside, path.join(root, "linked"));
    await expect(vault.writeDoc("linked/doc", "x")).rejects.toMatchObject({ code: "outside-root" });
    await expect(vault.writeDoc("linked/deeper/doc", "x")).rejects.toMatchObject({ code: "outside-root" });
    expect(await readdir(outside)).toEqual([]);
    await symlink(path.join(outside, "not-yet"), path.join(root, "dangling"));
    await expect(vault.writeDoc("dangling/doc", "x")).rejects.toMatchObject({ code: "outside-root" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("replaces a symlinked doc with a real file instead of writing through it", async () => {
    const { vault, root, file } = await setup();
    const outside = await tempDir("wiki-outside-");
    await writeFile(path.join(outside, "target.md"), "outside\n");
    await symlink(path.join(outside, "target.md"), file("doc.md"));
    expect(await vault.writeDoc("doc", "inside\n", null)).toEqual({ outcome: "conflict" });
    await vault.writeDoc("doc", "inside\n");
    expect(await readFile(path.join(outside, "target.md"), "utf8")).toBe("outside\n");
    expect((await lstat(path.join(root, "doc.md"))).isSymbolicLink()).toBe(false);
  });
});

describe("appendBlock", () => {
  it("keeps the frontmatter bytes and the existing text", async () => {
    const { vault, put, read, store } = await setup();
    const original = `${FRONTMATTER}\n# Adding config catalog\n\nIntro line.\n\n## Steps\n\n1. First\n\n## Later\n\nKeep.\n`;
    await put("adding-config-catalog.md", original);
    const result = await vault.appendBlock("adding-config-catalog", "steps", "2. Second");
    const content = await read("adding-config-catalog.md");
    expect(content.startsWith(FRONTMATTER)).toBe(true);
    expect(content).toBe(`${FRONTMATTER}\n# Adding config catalog\n\nIntro line.\n\n## Steps\n\n1. First\n\n2. Second\n\n## Later\n\nKeep.\n`);
    expect(result).toEqual({ sha256: sha(content) });
    expect(store.getDoc("adding-config-catalog")).toMatchObject({ sha256: sha(content), aliases: ["cc"] });
  });

  it("adds a missing heading at the end and indexes it", async () => {
    const { vault, put, read, store } = await setup();
    await put("doc.md", "# Doc\n\nBody.\n");
    await vault.appendBlock("doc", "Unsorted", "- moved line");
    expect(await read("doc.md")).toBe("# Doc\n\nBody.\n\n---\n\n<!-- wiki:unsorted -->\n\n- moved line\n");
    expect(store.getDoc("doc")?.headings).toEqual(["Doc"]);
  });

  it("applies the block to the latest content on disk", async () => {
    const { vault, put, read } = await setup();
    await put("doc.md", "# Doc\n");
    await vault.syncAll();
    await put("doc.md", "# Doc\n\nEdited outside the Wiki.\n");
    await vault.appendBlock("doc", "Notes", "Appended.");
    expect(await read("doc.md")).toBe("# Doc\n\nEdited outside the Wiki.\n\n## Notes\n\nAppended.\n");
  });

  it("fails for a missing doc", async () => {
    const { vault } = await setup();
    const error = await vault.appendBlock("missing", "Notes", "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: "missing" });
  });

  it("refuses to rewrite a doc that is not valid UTF-8", async () => {
    const { vault, put, file } = await setup();
    const latin1 = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
    await put("latin.md", latin1);
    await expect(vault.appendBlock("latin", "Notes", "- new")).rejects.toMatchObject({ code: "invalid-encoding" });
    await expect(vault.addAlias("latin", "cafe")).rejects.toMatchObject({ code: "invalid-encoding" });
    expect((await readFile(file("latin.md"))).equals(latin1)).toBe(true);
  });

  it("keeps a byte order mark and CRLF line endings", async () => {
    const { vault, put, file } = await setup();
    await put("bom.md", "﻿# Doc\r\n\r\nBody.\r\n");
    await vault.appendBlock("bom", "Notes", "- new");
    expect(await readFile(file("bom.md"), "utf8")).toBe("﻿# Doc\r\n\r\nBody.\r\n\r\n## Notes\r\n\r\n- new\r\n");
  });

  it("reports the append as done when only the index update fails", async () => {
    const { vault, put, read, warnings, store } = await setup();
    await put("doc.md", "# Doc\n");
    await put(".wiki", "not a folder");
    const result = await vault.appendBlock("doc", "Notes", "- kept");
    expect(await read("doc.md")).toBe("# Doc\n\n## Notes\n\n- kept\n");
    expect(result.sha256).toBe(sha("# Doc\n\n## Notes\n\n- kept\n"));
    expect(store.getDoc("doc")?.sha256).toBe(result.sha256);
    expect(warnings.some((line) => line.includes("tags.json"))).toBe(true);
    await expect(vault.syncAll()).resolves.toEqual({ changed: 0 });
  });

  it("serializes concurrent appends so none are lost", async () => {
    const { vault, put, read } = await setup();
    await put("doc.md", "# Doc\n");
    await Promise.all(Array.from({ length: 8 }, (_, index) => vault.appendBlock("doc", "Notes", `- item ${index}`)));
    const content = await read("doc.md");
    for (let index = 0; index < 8; index += 1) expect(content).toContain(`- item ${index}`);
  });
});

describe("createDoc", () => {
  it("creates the template at the root with a unique slug", async () => {
    const { vault, read, store, put } = await setup();
    const first = await vault.createDoc({ title: "Adding config catalog", type: "process", aliases: ["CC", "@config-catalog"] });
    expect(first.slug).toBe("adding-config-catalog");
    const content = await read("adding-config-catalog.md");
    expect(content).toBe("---\ntitle: Adding config catalog\ntype: process\naliases: [cc, config-catalog]\n---\n\n# Adding config catalog\n");
    expect(first.sha256).toBe(sha(content));
    expect(store.getDoc("adding-config-catalog")).toMatchObject({ title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] });

    const second = await vault.createDoc({ title: "Adding config catalog", type: "topic", aliases: [] });
    expect(second.slug).toBe("adding-config-catalog-2");
    await put("Unified-Push.md", "# Not indexed yet\n");
    const third = await vault.createDoc({ title: "Unified push", type: "project", aliases: [] });
    expect(third.slug).toBe("unified-push-2");
    expect(await read("Unified-Push.md")).toBe("# Not indexed yet\n");
  });

  it("appends the first block under its heading", async () => {
    const { vault, read } = await setup();
    const { slug } = await vault.createDoc({ title: "Global token", type: "topic", aliases: [] }, { heading: "Notes", block: "<!-- wiki:source manual added=\"2026-10-15\" -->\nTokens rotate daily." });
    expect(await read(`${slug}.md`)).toBe(
      "---\ntitle: Global token\ntype: topic\naliases: []\n---\n\n# Global token\n\n## Notes\n\n<!-- wiki:source manual added=\"2026-10-15\" -->\nTokens rotate daily.\n",
    );
  });

  it("falls back to an untitled slug for titles without letters or digits", async () => {
    const { vault } = await setup();
    expect((await vault.createDoc({ title: "日本語", type: "topic", aliases: [] })).slug).toBe("untitled");
  });
});

describe("addAlias", () => {
  it("adds the alias and keeps the other keys", async () => {
    const { vault, put, read, store } = await setup();
    await put("doc.md", `${FRONTMATTER}\n# Adding config catalog\n`);
    await vault.addAlias("doc", "@Config Catalog");
    const content = await read("doc.md");
    expect(content).toContain("aliases: [cc, config-catalog]");
    expect(content).toContain("title:   Adding config catalog   # keep me\n");
    expect(content).toContain("owner: rachel\n");
    expect(store.getDoc("doc")?.aliases).toEqual(["cc", "config-catalog"]);
  });

  it("does not rewrite the file when the alias exists", async () => {
    const { vault, put, file } = await setup();
    await put("doc.md", `${FRONTMATTER}\n# Adding config catalog\n`);
    await utimes(file("doc.md"), PAST, PAST);
    const result = await vault.addAlias("doc", "CC");
    expect(result.sha256).toBe(sha(`${FRONTMATTER}\n# Adding config catalog\n`));
    expect((await stat(file("doc.md"))).mtimeMs).toBe(PAST.getTime());
  });

  it("indexes a doc that is not indexed yet even when the alias already exists", async () => {
    const { vault, put, store } = await setup();
    await put("doc.md", `${FRONTMATTER}\n# Adding config catalog\n`);
    expect(store.getDoc("doc")).toBeNull();
    await vault.addAlias("doc", "cc");
    expect(store.getDoc("doc")).toMatchObject({ title: "Adding config catalog", aliases: ["cc"] });
  });
});

describe("copyAsset", () => {
  it("names the copy after the source and its content hash", async () => {
    const { vault, root } = await setup();
    const source = await tempDir("wiki-source-");
    const bytes = randomBytes(2048);
    await writeFile(path.join(source, "Screen Shot 1.PNG"), bytes);
    const { relPath } = await vault.copyAsset(path.join(source, "Screen Shot 1.PNG"));
    expect(relPath).toBe(`assets/screen-shot-1-${sha(bytes).slice(0, 8)}.png`);
    expect((await readFile(path.join(root, relPath))).equals(bytes)).toBe(true);
  });

  it("uses the preferred name for the stem and extension", async () => {
    const { vault } = await setup();
    const source = await tempDir("wiki-source-");
    await writeFile(path.join(source, "upl_1a2b3c4d5e6f"), "video");
    expect((await vault.copyAsset(path.join(source, "upl_1a2b3c4d5e6f"), "Demo Video.MP4")).relPath).toBe(
      `assets/demo-video-${sha("video").slice(0, 8)}.mp4`,
    );
    await writeFile(path.join(source, "clip.webm"), "webm");
    expect((await vault.copyAsset(path.join(source, "clip.webm"), "My clip")).relPath).toBe(`assets/my-clip-${sha("webm").slice(0, 8)}.webm`);
  });

  it("reuses an identical copy and keeps different content apart", async () => {
    const { vault, root } = await setup();
    const source = await tempDir("wiki-source-");
    await writeFile(path.join(source, "a.png"), "same");
    const first = await vault.copyAsset(path.join(source, "a.png"));
    const second = await vault.copyAsset(path.join(source, "a.png"));
    expect(second).toEqual(first);
    await writeFile(path.join(source, "b.png"), "same");
    expect((await vault.copyAsset(path.join(source, "b.png"), "a.png")).relPath).toBe(first.relPath);
    await writeFile(path.join(root, "assets", `a-${sha("other").slice(0, 8)}.png`), "collides by name only");
    await writeFile(path.join(source, "c.png"), "other");
    expect((await vault.copyAsset(path.join(source, "c.png"), "a.png")).relPath).toBe(`assets/a-${sha("other").slice(0, 8)}-2.png`);
    expect((await readdir(path.join(root, "assets"))).sort()).toEqual(
      [`a-${sha("other").slice(0, 8)}-2.png`, `a-${sha("other").slice(0, 8)}.png`, `a-${sha("same").slice(0, 8)}.png`].sort(),
    );
  });

  it("streams large files byte for byte", async () => {
    const { vault, root } = await setup();
    const source = await tempDir("wiki-source-");
    const bytes = randomBytes(9 * 1024 * 1024 + 17);
    await writeFile(path.join(source, "big.mov"), bytes);
    const { relPath } = await vault.copyAsset(path.join(source, "big.mov"));
    const copied = await readFile(path.join(root, relPath));
    expect(copied.length).toBe(bytes.length);
    expect(sha(copied)).toBe(sha(bytes));
    expect((await readdir(path.join(root, "assets"))).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("refuses relative, missing and non-file sources", async () => {
    const { vault } = await setup();
    const source = await tempDir("wiki-source-");
    await expect(vault.copyAsset("relative/a.png")).rejects.toMatchObject({ code: "invalid-path" });
    await expect(vault.copyAsset(path.join(source, "missing.png"))).rejects.toMatchObject({ code: "missing" });
    await expect(vault.copyAsset(source)).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("refuses an assets folder that leads outside the Wiki", async () => {
    const { vault, root } = await setup();
    const outside = await tempDir("wiki-outside-");
    await symlink(outside, path.join(root, "assets"));
    const source = await tempDir("wiki-source-");
    await writeFile(path.join(source, "a.png"), "x");
    await expect(vault.copyAsset(path.join(source, "a.png"))).rejects.toMatchObject({ code: "outside-root" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("resolveInsideRoot", () => {
  it("resolves existing paths inside the Wiki", async () => {
    const { vault, put, file } = await setup();
    await put("assets/x.png", "png");
    expect(await vault.resolveInsideRoot("assets/x.png")).toBe(file("assets/x.png"));
    expect(await vault.resolveInsideRoot("./assets/x.png")).toBe(file("assets/x.png"));
    expect(await vault.resolveInsideRoot("projects/../assets/x.png")).toBe(file("assets/x.png"));
  });

  it("blocks traversal, absolute paths, NUL, hidden folders and missing files", async () => {
    const { vault, put, file } = await setup();
    await put("assets/x.png", "png");
    await put(".git/config", "[core]");
    for (const relPath of ["", "../outside.png", "assets/../../outside.png", "/etc/hosts", file("assets/x.png"), "assets/x\0.png", "assets\\x.png", ".git/config", "missing.png", "C:/x.png"]) {
      expect(await vault.resolveInsideRoot(relPath)).toBeNull();
    }
  });

  it("follows symlinks only while they stay inside the Wiki", async () => {
    const { vault, put, file, root } = await setup();
    await put("assets/real.png", "png");
    const outside = await tempDir("wiki-outside-");
    await writeFile(path.join(outside, "secret.png"), "secret");
    await symlink(path.join(outside, "secret.png"), file("assets/escape.png"));
    await symlink(outside, path.join(root, "linked"));
    await symlink(file("assets/real.png"), file("assets/alias.png"));
    expect(await vault.resolveInsideRoot("assets/escape.png")).toBeNull();
    expect(await vault.resolveInsideRoot("linked/secret.png")).toBeNull();
    expect(await vault.resolveInsideRoot("assets/alias.png")).toBe(file("assets/real.png"));
  });

  it("refuses symlinks into hidden folders and anything that is not a file", async () => {
    const { vault, put, file } = await setup();
    await put(".git/config", "[core]");
    await put(".wiki/tags.json", "{}");
    await put("assets/real.png", "png");
    await symlink(file(".git/config"), file("assets/config.png"));
    await symlink(file(".wiki"), file("assets/meta"));
    for (const relPath of ["assets/config.png", "assets/meta/tags.json", "assets", "assets/meta"]) {
      expect(await vault.resolveInsideRoot(relPath)).toBeNull();
    }
    expect(await vault.resolveInsideRoot("assets/real.png")).toBe(file("assets/real.png"));
  });
});

describe("buildIndexedDoc and tagsJson", () => {
  it("collects sections, headings and links from the linking section", () => {
    const content = [
      "---",
      "title: Unified notification",
      "type: project",
      "aliases: [UN]",
      "---",
      "Intro [[Global token]].",
      "",
      "# Unified notification",
      "",
      "## Setup [[Push]]",
      "",
      "See [[Global token#Rotation|rotation]] and [[Global token#Rotation]].",
      "![[diagram.png]] ![[Embedded doc]]",
      "`[[Not a link]]`",
      "<!-- wiki:source thread=\"thr_1\" title=\"[[Marker]]\" added=\"2026-10-15\" -->",
    ].join("\n");
    const doc = buildIndexedDoc({ slug: "projects/unified-notification", path: "/w/projects/unified-notification.md", mtimeMs: 5, size: 9 }, content, "abc");
    expect(doc).toMatchObject({
      slug: "projects/unified-notification",
      title: "Unified notification",
      type: "project",
      aliases: ["un"],
      tag: "unified-notification",
      mtimeMs: 5,
      size: 9,
      sha256: "abc",
      headings: ["Unified notification", "Setup [[Push]]"],
    });
    expect(doc.sections.map((section) => section.heading)).toEqual(["", "Unified notification", "Setup [[Push]]"]);
    expect(doc.links).toEqual([
      { targetText: "Global token", heading: "" },
      { targetText: "Push", heading: "Setup [[Push]]" },
      { targetText: "Global token#Rotation", heading: "Setup [[Push]]" },
      { targetText: "Embedded doc", heading: "Setup [[Push]]" },
    ]);
  });

  it("formats tags.json sorted by tag without timestamps", () => {
    const text = tagsJson([
      { tag: "zeta", title: "Zeta", type: "topic", aliases: [] },
      { tag: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] },
    ]);
    expect(text).toBe(
      `${JSON.stringify(
        {
          version: 1,
          docs: [
            { tag: "adding-config-catalog", title: "Adding config catalog", type: "process", aliases: ["cc", "config-catalog"] },
            { tag: "zeta", title: "Zeta", type: "topic", aliases: [] },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });
});

describe("syncAll", () => {
  it("indexes docs, links and tags", async () => {
    const { vault, put, store, root } = await setup();
    await put("global-token.md", "---\naliases: [gt, token]\n---\n# Global token\n\n## Rotation\n\nDaily.\n");
    await put("projects/unified-notification.md", "---\ntype: project\n---\n# Unified notification\n\n## Auth\n\nUses [[GT#Rotation]].\n");
    expect(await vault.syncAll()).toEqual({ changed: 2 });
    expect(store.docCount()).toBe(2);
    expect(store.getDoc("projects/unified-notification")).toMatchObject({ title: "Unified notification", type: "project", tag: "unified-notification" });
    expect(store.backlinks("global-token")).toEqual([{ slug: "projects/unified-notification", title: "Unified notification", heading: "Auth" }]);
    expect(store.search({ query: "daily", type: null, limit: 5 }).sections[0]).toMatchObject({ slug: "global-token", heading: "Rotation" });
    const tags = JSON.parse(await readFile(tagsFilePath(root), "utf8"));
    expect(tags).toEqual({
      version: 1,
      docs: [
        { tag: "global-token", title: "Global token", type: "topic", aliases: ["gt", "token"] },
        { tag: "unified-notification", title: "Unified notification", type: "project", aliases: [] },
      ],
    });
  });

  it("reindexes only docs whose size or mtime changed and removes deleted docs", async () => {
    const { vault, put, store, file } = await setup();
    await put("a.md", "# A\n");
    await put("b.md", "# B\n");
    await put("c.md", "# C\n");
    await vault.syncAll();
    expect(await vault.syncAll()).toEqual({ changed: 0 });

    await put("a.md", "# A longer title\n");
    expect(await vault.syncAll()).toEqual({ changed: 1 });
    expect(store.getDoc("a")?.title).toBe("A longer title");

    await writeFile(file("b.md"), "# X\n");
    await utimes(file("b.md"), PAST, PAST);
    expect(await vault.syncAll()).toEqual({ changed: 1 });
    expect(store.getDoc("b")?.title).toBe("X");

    await rm(file("c.md"));
    expect(await vault.syncAll()).toEqual({ changed: 1 });
    expect(store.getDoc("c")).toBeNull();
    expect(store.docCount()).toBe(2);
  });

  it("keeps tags.json byte-stable when tags do not change", async () => {
    const { vault, put, root } = await setup();
    await put("doc.md", "---\naliases: [d]\n---\n# Doc\n");
    await vault.syncAll();
    const tagsFile = tagsFilePath(root);
    const firstBytes = await readFile(tagsFile, "utf8");
    await utimes(tagsFile, PAST, PAST);

    expect(await vault.syncAll()).toEqual({ changed: 0 });
    await put("doc.md", "---\naliases: [d]\n---\n# Doc\n\nA body edit only.\n");
    expect(await vault.syncAll()).toEqual({ changed: 1 });
    expect((await stat(tagsFile)).mtimeMs).toBe(PAST.getTime());
    expect(await readFile(tagsFile, "utf8")).toBe(firstBytes);

    await put("doc.md", "---\naliases: [d, e]\n---\n# Doc\n");
    await vault.syncAll();
    expect((await stat(tagsFile)).mtimeMs).not.toBe(PAST.getTime());
    expect(JSON.parse(await readFile(tagsFile, "utf8")).docs[0].aliases).toEqual(["d", "e"]);
  });

  it("writes an empty tags.json for an empty Wiki", async () => {
    const { vault, root } = await setup();
    expect(await vault.syncAll()).toEqual({ changed: 0 });
    expect(await readFile(tagsFilePath(root), "utf8")).toBe('{\n  "version": 1,\n  "docs": []\n}\n');
    expect(await vault.writeTagsJson()).toBe(false);
  });

  it("follows a change of Wiki folder", async () => {
    const { vault, put, store, switchRoot } = await setup();
    await put("same.md", "# Same\n");
    await put("old-only.md", "# Old\n");
    await vault.syncAll();
    const next = await tempDir("wiki-next-");
    await writeFile(path.join(next, "same.md"), "# Same\n");
    switchRoot(next);
    expect(await vault.syncAll()).toEqual({ changed: 2 });
    expect(store.getDoc("same")?.path).toBe(path.join(next, "same.md"));
    expect(store.getDoc("old-only")).toBeNull();
  });
});

describe("indexDoc", () => {
  it("indexes or removes one doc", async () => {
    const { vault, put, store, file } = await setup();
    await put("solo.md", "# Solo\n");
    expect(await vault.indexDoc("solo")).toBe(true);
    expect(store.getDoc("solo")?.title).toBe("Solo");
    await rm(file("solo.md"));
    expect(await vault.indexDoc("solo")).toBe(false);
    expect(store.getDoc("solo")).toBeNull();
    expect(await vault.indexDoc("../nope")).toBe(false);
  });
});

describe("runExclusive", () => {
  it("runs one task at a time per Wiki folder", async () => {
    const { vault } = await setup();
    const order: string[] = [];
    const task = (name: string, ms: number) =>
      vault.runExclusive(async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name}:end`);
      });
    await Promise.all([task("a", 30), task("b", 0), task("c", 0)]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("runs tasks in call order even when finding the Wiki folder takes longer for the first one", async () => {
    const root = await tempDir("wiki-vault-order-");
    let calls = 0;
    const { vault } = await setup({
      getRoot: async () => {
        calls += 1;
        if (calls === 1) await delay(15);
        return root;
      },
    });
    const order: string[] = [];
    await Promise.all([vault.runExclusive(async () => order.push("a")), vault.runExclusive(async () => order.push("b"))]);
    expect(order).toEqual(["a", "b"]);
  });

  it("lets a task call vault writes without deadlocking and pins its folder", async () => {
    const { vault, read, root, switchRoot } = await setup();
    const result = await vault.runExclusive(async (pinned) => {
      switchRoot(await tempDir("wiki-elsewhere-"));
      const created = await vault.createDoc({ title: "Nested", type: "topic", aliases: [] });
      await vault.appendBlock(created.slug, "Notes", "Inside the task.");
      return { pinned, slug: created.slug, root: await vault.root() };
    });
    expect(result).toEqual({ pinned: root, slug: "nested", root });
    expect(await read("nested.md")).toContain("Inside the task.");
  });

  it("keeps going after a task fails", async () => {
    const { vault } = await setup();
    const failed = vault.runExclusive(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(vault.runExclusive(async () => "next")).resolves.toBe("next");
  });

  it("serializes parallel vault calls made inside one task", async () => {
    const { vault, put, read } = await setup();
    await put("doc.md", "# Doc\n");
    await vault.runExclusive(() =>
      Promise.all(Array.from({ length: 6 }, (_, index) => vault.appendBlock("doc", index % 2 === 0 ? "Notes" : "Steps", `- item ${index}`))),
    );
    const content = await read("doc.md");
    for (let index = 0; index < 6; index += 1) expect(content).toContain(`- item ${index}`);
  });

  it("holds the lock until the calls a task started have finished", async () => {
    const { vault } = await setup();
    const order: string[] = [];
    const first = vault.runExclusive(async () => {
      void vault.runExclusive(async () => {
        await delay(30);
        order.push("child");
      });
    });
    const second = vault.runExclusive(async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["child", "second"]);
  });

  it("queues work that a finished task left behind instead of letting it skip the lock", async () => {
    const { vault } = await setup();
    const order: string[] = [];
    let late: Promise<unknown> = Promise.resolve();
    await vault.runExclusive(async () => {
      late = new Promise((resolve) => {
        setTimeout(() => resolve(vault.runExclusive(async () => order.push("late"))), 5);
      });
    });
    const blocker = vault.runExclusive(async () => {
      order.push("blocker:start");
      await delay(40);
      order.push("blocker:end");
    });
    await Promise.all([late, blocker]);
    expect(order).toEqual(["blocker:start", "blocker:end", "late"]);
  });
});

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("commit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing when git history is off and the folder is not a repo", async () => {
    const { vault, put, root } = await setup({ git: false });
    await put("doc.md", "# Doc\n");
    await expect(vault.commit("Wiki: doc", ["doc.md"])).resolves.toBeUndefined();
    expect(await exists(path.join(root, ".git"))).toBe(false);
  });

  it("logs and carries on when no git binary is found", async () => {
    const { vault, put, warnings, root } = await setup({ git: true, gitBinaries: ["/nonexistent/bin/git"] });
    await put("doc.md", "# Doc\n");
    await expect(vault.commit("Wiki: doc", ["doc.md"])).resolves.toBeUndefined();
    await expect(vault.commit("Wiki: doc", ["doc.md"])).resolves.toBeUndefined();
    expect(warnings.filter((line) => line.includes("no git binary"))).toHaveLength(1);
    expect(await exists(path.join(root, ".git"))).toBe(false);
  });

  describe.skipIf(!gitAvailable)("with git", () => {
    function isolateGit() {
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    }

    function git(root: string, ...args: string[]): string {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: process.env }).trim();
    }

    it("initializes the repo on first use and commits the given paths as Wiki", async () => {
      isolateGit();
      const { vault, put, root } = await setup({ git: true });
      await put("doc.md", "# Doc\n");
      await put("other.md", "# Other\n");
      await vault.commit("Wiki: add doc", ["doc.md"]);
      expect(git(root, "log", "--format=%an <%ae>|%s")).toBe("Wiki <wiki@localhost>|Wiki: add doc");
      expect(git(root, "ls-files")).toBe("doc.md");
      expect(git(root, "status", "--porcelain")).toBe("?? other.md");
    });

    it("skips the commit when nothing changed and accepts absolute paths", async () => {
      isolateGit();
      const { vault, put, root, file } = await setup({ git: true });
      await put("doc.md", "# Doc\n");
      await vault.commit("first", [file("doc.md")]);
      await vault.commit("second", [file("doc.md")]);
      await vault.commit("outside", ["/etc/hosts", "../escape.md"]);
      expect(git(root, "log", "--format=%s")).toBe("first");
      await vault.appendBlock("doc", "Notes", "More.");
      await vault.commit("third", ["doc.md"]);
      expect(git(root, "log", "--format=%s").split("\n")).toEqual(["third", "first"]);
    });

    it("keeps a configured user and fills in only what is missing", async () => {
      isolateGit();
      const { vault, put, root } = await setup({ git: true });
      execFileSync("git", ["-C", root, "init", "-q"], { env: process.env });
      git(root, "config", "user.name", "Rachel");
      await put("doc.md", "# Doc\n");
      await vault.commit("Wiki: doc", []);
      expect(git(root, "log", "--format=%an <%ae>")).toBe("Rachel <wiki@localhost>");
    });

    it("never throws when git itself fails", async () => {
      isolateGit();
      const { vault, put, root, warnings } = await setup({ git: true });
      await put("doc.md", "# Doc\n");
      await writeFile(path.join(root, ".git"), "gitdir: /nonexistent/repo\n");
      await expect(vault.commit("Wiki: doc", ["doc.md"])).resolves.toBeUndefined();
      expect(warnings.some((line) => line.startsWith("Wiki git"))).toBe(true);
    });
  });
});

describe("commitSoon", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const editMessage = (store: { getDoc: (slug: string) => { title: string } | null }, slug: string) => () => `Wiki: edit ${store.getDoc(slug)?.title ?? slug}`;

  it("never schedules a commit when git history is off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { vault, store, root } = await setup({ git: false });
    await vault.writeDoc("doc", "# Doc\n");
    await vault.commitSoon("doc.md", editMessage(store, "doc"));
    expect(vault.pendingCommits()).toEqual([]);
    await vi.advanceTimersByTimeAsync(COMMIT_MAX_WAIT_MS);
    await vault.flushCommits();
    expect(await exists(path.join(root, ".git"))).toBe(false);
  });

  describe.skipIf(!gitAvailable)("with git", () => {
    function isolateGit() {
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    }

    function log(root: string): string[] {
      try {
        return execFileSync("git", ["-C", root, "log", "--format=%s"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] })
          .trim()
          .split("\n")
          .filter((line) => line !== "");
      } catch {
        return [];
      }
    }

    async function editing() {
      isolateGit();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const context = await setup({ git: true });
      const save = async (content: string) => {
        await context.vault.writeDoc("doc", content);
        await context.vault.commitSoon("doc.md", editMessage(context.store, "doc"));
      };
      return { ...context, save };
    }

    it("coalesces saves into one commit after 30 s without saves, titled at commit time", async () => {
      const { vault, root, save } = await editing();
      await save("# Draft\n\nOne.\n");
      await vi.advanceTimersByTimeAsync(20_000);
      await save("# Draft\n\nOne. Two.\n");
      await vi.advanceTimersByTimeAsync(20_000);
      await save("# Final\n\nOne. Two. Three.\n");
      await vi.advanceTimersByTimeAsync(COMMIT_IDLE_MS - 1);
      expect(vault.pendingCommits()).toEqual(["doc.md"]);
      expect(log(root)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(vault.pendingCommits()).toEqual([]);
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Final"]);
      await vi.advanceTimersByTimeAsync(COMMIT_MAX_WAIT_MS);
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Final"]);
    });

    it("commits at most 5 minutes after the first uncommitted save while saves keep coming", async () => {
      const { vault, root, save } = await editing();
      let elapsed = 0;
      for (let step = 0; elapsed < COMMIT_MAX_WAIT_MS; step += 1) {
        await save(`# Doc\n\nStep ${step}.\n`);
        expect(log(root)).toEqual([]);
        await vi.advanceTimersByTimeAsync(20_000);
        elapsed += 20_000;
      }
      expect(vault.pendingCommits()).toEqual([]);
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Doc"]);
    });

    it("commits a pending edit before another commit or write touches the path", async () => {
      const { vault, root, save } = await editing();
      await save("# Doc\n\nTyped.\n");
      await vault.commit("Wiki: save Doc before renaming it", ["doc.md"]);
      expect(log(root)).toEqual(["Wiki: edit Doc"]);
      await save("# Doc\n\nTyped more.\n");
      await vault.appendBlock("doc", "Notes", "- accepted");
      await vault.commit("Wiki: accept → Doc", ["doc.md"]);
      expect(log(root)).toEqual(["Wiki: accept → Doc", "Wiki: edit Doc", "Wiki: edit Doc"]);
      await save("# Doc\n\nTyped again.\n");
      await vault.commit("Wiki: everything", []);
      expect(log(root).slice(0, 2)).toEqual(["Wiki: everything", "Wiki: edit Doc"]);
      expect(vault.pendingCommits()).toEqual([]);
      await vi.advanceTimersByTimeAsync(COMMIT_MAX_WAIT_MS);
      await vault.flushCommits();
      expect(log(root)).toHaveLength(5);
    });

    it("commits pending edits right away on flush and before a delete", async () => {
      const { vault, root, save } = await editing();
      await save("# Doc\n\nTyped.\n");
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Doc"]);
      await save("# Doc\n\nLast words.\n");
      await vault.deleteDoc("doc");
      expect(log(root)).toEqual(["Wiki: edit Doc", "Wiki: edit Doc"]);
      expect(execFileSync("git", ["-C", root, "show", "HEAD:doc.md"], { encoding: "utf8", env: process.env })).toBe("# Doc\n\nLast words.\n");
    });

    it("commits a pending edit in its own Wiki folder after the folder setting changes", async () => {
      const { vault, root, save, switchRoot } = await editing();
      await save("# Doc\n\nTyped in A.\n");
      const next = await tempDir("wiki-next-");
      switchRoot(next);
      await vi.advanceTimersByTimeAsync(COMMIT_IDLE_MS);
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Doc"]);
      switchRoot(root);
      await save("# Doc\n\nTyped in A once more.\n");
      switchRoot(next);
      await save("# Doc\n\nTyped in B.\n");
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Doc", "Wiki: edit Doc"]);
      expect(log(next)).toEqual(["Wiki: edit Doc"]);
      expect(execFileSync("git", ["-C", root, "show", "HEAD:doc.md"], { encoding: "utf8", env: process.env })).toBe("# Doc\n\nTyped in A once more.\n");
    });

    it("commits a save that was still scheduling when the plugin closed and leaves no timers behind", async () => {
      isolateGit();
      let release: () => void = () => undefined;
      let held: Promise<void> | null = null;
      let disposed = false;
      const { vault, root, store, warnings } = await setup({
        gitEnabled: async () => {
          if (held !== null) await held;
          if (disposed) throw new Error("disposed");
          return true;
        },
      });
      await vault.writeDoc("doc", "# Doc\n\nRacing.\n");
      held = new Promise((resolve) => {
        release = resolve;
      });
      const scheduling = vault.commitSoon("doc.md", editMessage(store, "doc"));
      held = null;
      const closing = vault.closeCommits();
      release();
      await Promise.all([scheduling, closing]);
      expect(log(root)).toEqual(["Wiki: edit Doc"]);
      expect(vault.pendingCommits()).toEqual([]);
      await vault.writeDoc("doc", "# Doc\n\nAfter close.\n");
      await vault.commitSoon("doc.md", editMessage(store, "doc"));
      expect(vault.pendingCommits()).toEqual([]);
      await vault.flushCommits();
      expect(log(root)).toEqual(["Wiki: edit Doc", "Wiki: edit Doc"]);
      disposed = true;
      await vault.writeDoc("doc", "# Doc\n\nAfter dispose.\n");
      await vault.commitSoon("doc.md", editMessage(store, "doc"));
      await vault.flushCommits();
      expect(vault.pendingCommits()).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });
});

function fakeWatch() {
  const handles: Array<{ root: string; onEvent: (filename: string | null) => void; onError: (error: unknown) => void; closed: boolean }> = [];
  const factory: WatchFactory = (root, onEvent, onError) => {
    const entry = { root, onEvent, onError, closed: false };
    handles.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  };
  return { handles, factory };
}

async function nativeWatchWorks(): Promise<boolean> {
  const folder = await tempDir("wiki-probe-");
  return new Promise((resolve) => {
    let watcher: FSWatcher;
    try {
      watcher = watch(folder, { recursive: true });
    } catch {
      resolve(false);
      return;
    }
    let count = 0;
    const poke = setInterval(() => void writeFile(path.join(folder, "probe.md"), String((count += 1))), 100);
    const timer = setTimeout(() => finish(false), 2_000);
    function finish(works: boolean) {
      clearInterval(poke);
      clearTimeout(timer);
      watcher.close();
      resolve(works);
    }
    watcher.on("error", () => finish(false));
    watcher.on("change", () => finish(true));
  });
}

describe("watch", () => {
  it("reindexes and reports changes seen by the native watcher", async ({ skip }) => {
    if (!(await nativeWatchWorks())) skip("fs.watch cannot watch folders in this environment");
    const { vault, put, store, warnings } = await setup({ debounceMs: 30, pollMs: 60_000 });
    const controller = new AbortController();
    const onChanged = vi.fn();
    const done = vault.watch(controller.signal, onChanged);
    await vi.waitFor(async () => expect(await exists(tagsFilePath(await vault.root()))).toBe(true));
    expect(onChanged).not.toHaveBeenCalled();
    await put("watched.md", "# Watched\n");
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 5_000, interval: 25 });
    expect(warnings).toEqual([]);
    expect(store.getDoc("watched")?.title).toBe("Watched");
    controller.abort();
    await done;
  });

  it("debounces bursts of events into one sync", async () => {
    const watcher = fakeWatch();
    const { vault, put, store } = await setup({ watchFactory: watcher.factory, debounceMs: 40, pollMs: 60_000 });
    const controller = new AbortController();
    const onChanged = vi.fn();
    const done = vault.watch(controller.signal, onChanged);
    await vi.waitFor(() => expect(watcher.handles).toHaveLength(1));
    await put("a.md", "# A\n");
    await put("b.md", "# B\n");
    const handle = watcher.handles[0]!;
    handle.onEvent(".wiki/tags.json");
    handle.onEvent("a.md");
    handle.onEvent("b.md");
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(store.docCount()).toBe(2);
    handle.onEvent(".git/index");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onChanged).toHaveBeenCalledTimes(1);
    controller.abort();
    await done;
    expect(handle.closed).toBe(true);
  });

  it("falls back to polling when the watcher cannot start", async () => {
    const factory: WatchFactory = () => {
      throw new Error("too many open files");
    };
    const { vault, put, store, warnings } = await setup({ watchFactory: factory, debounceMs: 10, pollMs: 40 });
    const controller = new AbortController();
    const onChanged = vi.fn();
    const done = vault.watch(controller.signal, onChanged);
    await put("polled.md", "# Polled\n");
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 3_000 });
    expect(store.getDoc("polled")).not.toBeNull();
    expect(warnings.filter((line) => line.startsWith("Cannot watch"))).toHaveLength(1);
    controller.abort();
    await done;
  });

  it("closes a failed watcher, polls, and tries to watch again", async () => {
    const watcher = fakeWatch();
    const { vault, put, store, warnings } = await setup({ watchFactory: watcher.factory, debounceMs: 10, pollMs: 40 });
    const controller = new AbortController();
    const onChanged = vi.fn();
    const done = vault.watch(controller.signal, onChanged);
    await vi.waitFor(() => expect(watcher.handles).toHaveLength(1));
    await put("missed.md", "# Missed\n");
    watcher.handles[0]!.onError(new Error("watcher died"));
    expect(watcher.handles[0]!.closed).toBe(true);
    await vi.waitFor(() => expect(store.getDoc("missed")).not.toBeNull());
    expect(onChanged).toHaveBeenCalled();
    expect(warnings.some((line) => line.includes("watcher died"))).toBe(true);
    await vi.waitFor(() => expect(watcher.handles.length).toBeGreaterThan(1));
    controller.abort();
    await done;
    expect(watcher.handles.every((handle) => handle.closed)).toBe(true);
  });

  it("moves to a new Wiki folder when the setting changes", async () => {
    const watcher = fakeWatch();
    const { vault, store, switchRoot } = await setup({ watchFactory: watcher.factory, debounceMs: 10, pollMs: 40 });
    const controller = new AbortController();
    const done = vault.watch(controller.signal, () => undefined);
    await vi.waitFor(() => expect(watcher.handles).toHaveLength(1));
    const next = await tempDir("wiki-next-");
    await writeFile(path.join(next, "moved.md"), "# Moved\n");
    switchRoot(next);
    await vi.waitFor(() => expect(watcher.handles.map((handle) => handle.root)).toContain(next));
    await vi.waitFor(() => expect(store.getDoc("moved")?.path).toBe(path.join(next, "moved.md")));
    expect(watcher.handles[0]!.closed).toBe(true);
    controller.abort();
    await done;
  });

  it("keeps running when the Wiki folder setting is invalid", async () => {
    const watcher = fakeWatch();
    const { vault, warnings } = await setup({ watchFactory: watcher.factory, getRoot: async () => "relative/wiki", pollMs: 20 });
    const controller = new AbortController();
    const done = vault.watch(controller.signal, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(watcher.handles).toHaveLength(0);
    expect(warnings.filter((line) => line.startsWith("Wiki folder unavailable"))).toHaveLength(1);
    controller.abort();
    await done;
  });

  it("returns at once when already aborted", async () => {
    const watcher = fakeWatch();
    const { vault } = await setup({ watchFactory: watcher.factory });
    const controller = new AbortController();
    controller.abort();
    await vault.watch(controller.signal, () => undefined);
    expect(watcher.handles).toHaveLength(0);
  });
});
