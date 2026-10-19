import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createWikiContext } from "./context";
import { appendToTarget, sourceBlock, todayIso } from "./write";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-write-");
  const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: wiki, gitHistory: true, ...settings } });
  const ctx = await createWikiContext(host.bb);
  return { wiki, ctx };
}

describe("sourceBlock", () => {
  it("puts the source marker on its own line above the text", () => {
    expect(sourceBlock({ kind: "manual", added: "2026-10-15" }, "- one\n- two")).toBe("<!-- wiki:source manual added=\"2026-10-15\" -->\n- one\n- two");
  });
});

describe("todayIso", () => {
  it("uses the configured time zone", async () => {
    const instant = new Date("2026-10-15T02:30:00Z");
    expect(await todayIso((await setup({ timezone: "America/Los_Angeles" })).ctx, instant)).toBe("2026-10-14");
    expect(await todayIso((await setup({ timezone: "Asia/Tokyo" })).ctx, instant)).toBe("2026-10-15");
  });
});

describe("appendToTarget", () => {
  it("appends under a heading of an existing doc and reports its title", async () => {
    const { wiki, ctx } = await setup();
    await writeFile(path.join(wiki, "global-token.md"), "# Global token\n\n## Setup\n\nOld text.\n\n## Other\n\nKeep.\n");
    await ctx.vault.syncAll();
    const result = await appendToTarget(ctx, { target: { kind: "existing", slug: "global-token" }, heading: "setup", block: "- New line" });
    expect(result).toEqual({ slug: "global-token", title: "Global token", created: false });
    expect(await readFile(path.join(wiki, "global-token.md"), "utf8")).toBe(
      "# Global token\n\n## Setup\n\nOld text.\n\n- New line\n\n## Other\n\nKeep.\n",
    );
  });

  it("creates a new doc from the template with a unique slug", async () => {
    const { wiki, ctx } = await setup();
    await writeFile(path.join(wiki, "deploy-checklist.md"), "# Something else\n");
    await ctx.vault.syncAll();
    const result = await appendToTarget(ctx, {
      target: { kind: "new", title: "Deploy checklist", type: "process", aliases: ["dc"] },
      heading: "Steps",
      block: "1. Build",
    });
    expect(result).toEqual({ slug: "deploy-checklist-2", title: "Deploy checklist", created: true });
    expect(await readFile(path.join(wiki, "deploy-checklist-2.md"), "utf8")).toBe(
      "---\ntitle: Deploy checklist\ntype: process\naliases: [dc]\n---\n\n# Deploy checklist\n\n## Steps\n\n1. Build\n",
    );
    expect(ctx.store.resolveTag("dc")).toBe("deploy-checklist-2");
  });

  it("does not commit; callers commit once per operation", async () => {
    const { wiki, ctx } = await setup();
    await appendToTarget(ctx, { target: { kind: "new", title: "Loose", type: "topic", aliases: [] }, heading: "Notes", block: "text" });
    expect(await lstat(path.join(wiki, ".git")).then(() => true, () => false)).toBe(false);
  });

  it("fails for a missing existing doc", async () => {
    const { ctx } = await setup();
    await expect(appendToTarget(ctx, { target: { kind: "existing", slug: "nope" }, heading: "Notes", block: "x" })).rejects.toThrow("does not exist");
  });
});
