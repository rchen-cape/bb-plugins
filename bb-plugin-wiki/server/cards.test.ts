import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Destination } from "../contract";
import { parseNoteUnits } from "../lib/daily-notes";
import { INBOX_CHANNEL } from "../lib/wiki";
import {
  FALLBACK_REASON,
  acceptCard,
  applyRoutes,
  createAgentCard,
  createNotesCards,
  createUploadCard,
  fallbackToRules,
  missingCardImages,
  previewCard,
  restoreCard,
  skipCard,
  updateCardDestinations,
} from "./cards";
import { createWikiContext, type WikiContext } from "./context";

const NOW = new Date("2026-10-15T15:00:00Z");
const NOTE_PATH = "Time/oct2026/10-14-26.md";
const MARKER = '<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->';

const PROJECT_DOC = `---
title: Unified notification
type: project
aliases: [un]
---

# Unified notification

Intro paragraph.

## Related

---

<!-- wiki:unsorted -->
`;

const TOPIC_DOC = `---
title: Global token
type: topic
---

# Global token

## Setup

Rotate with the CLI.

---

<!-- wiki:unsorted -->
`;

const PROCESS_DOC = `---
title: Adding config catalog
type: process
aliases: [config-catalog]
---

# Adding config catalog

Steps here.
`;

const DOCS: Record<string, string> = {
  "unified-notification.md": PROJECT_DOC,
  "global-token.md": TOPIC_DOC,
  "adding-config-catalog.md": PROCESS_DOC,
};

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function put(root: string, rel: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

function noteContent(body: string): string {
  return `# Wednesday\n\n## TODO\n- [ ] call @george\n\n### NOTES\n\n${body}\n\n### Later\n- not part of the notes\n`;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = (await readdir(root, { recursive: true })).map(String).sort();
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const full = path.join(root, entry);
    const stats = await stat(full);
    result[entry] = stats.isFile()
      ? `${createHash("sha256").update(await readFile(full)).digest("hex")}:${stats.size}:${stats.mtimeMs}`
      : "dir";
  }
  return result;
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const wiki = await tempDir("wiki-cards-wiki-");
  const notes = await tempDir("wiki-cards-notes-");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki, notesDirectory: notes, gitHistory: false, routingAgent: false, timezone: "America/New_York", ...settings },
  });
  const ctx = await createWikiContext(host.bb);
  for (const [rel, content] of Object.entries(DOCS)) await put(wiki, rel, content);
  await ctx.vault.syncAll();
  const read = (rel: string) => readFile(path.join(wiki, rel), "utf8");
  return { wiki, notes, ctx, harness: host.harness, read };
}

function knownTags(ctx: WikiContext): Set<string> {
  return new Set(ctx.store.allTags().flatMap((entry) => [entry.tag, ...entry.aliases]));
}

async function noteCards(ctx: WikiContext, notes: string, body: string, useAgent = false): Promise<Card[]> {
  const content = noteContent(body);
  await put(notes, NOTE_PATH, content);
  const units = parseNoteUnits(content, { knownTags: knownTags(ctx) });
  return createNotesCards(
    ctx,
    units.map((unit) => ({ unit, notePath: NOTE_PATH, noteDate: "2026-10-14" })),
    { useAgent },
  );
}

async function oneCard(ctx: WikiContext, notes: string, body: string, useAgent = false): Promise<Card> {
  const [card, ...rest] = await noteCards(ctx, notes, body, useAgent);
  expect(rest).toEqual([]);
  if (card === undefined) throw new Error("expected one card");
  return card;
}

function targets(card: Card): Array<Pick<Destination, "include" | "target" | "heading" | "role">> {
  return card.destinations.map(({ include, target, heading, role }) => ({ include, target, heading, role }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createNotesCards routing rules", () => {
  it("routes [[links]] to existing docs and new topic docs, with the heading from #", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "- Rotation lives in [[Global token#Setup]] and [[Brand new idea]]", true);
    expect(card.rule).toBe("explicit-link");
    expect(card.status).toBe("pending");
    expect(card.reason).toBe("The note links to [[Global token]] and [[Brand new idea]].");
    expect(targets(card)).toEqual([
      { include: true, target: { kind: "existing", slug: "global-token" }, heading: "Setup", role: "content" },
      { include: true, target: { kind: "new", title: "Brand new idea", type: "topic", aliases: [] }, heading: "Unsorted", role: "content" },
    ]);
  });

  it("routes by a known tag, and starts as routing when the agent is on", async () => {
    const { ctx, notes } = await setup();
    const [ruled, routed] = [
      await oneCard(ctx, notes, "@global-token\n- Rotates weekly"),
      await oneCard(ctx, notes, "@global-token\n- Stored in the vault", true),
    ];
    expect(ruled?.rule).toBe("tag");
    expect(ruled?.status).toBe("pending");
    expect(ruled?.reason).toBe("Tagged @global-token.");
    expect(ruled && targets(ruled)).toEqual([
      { include: true, target: { kind: "existing", slug: "global-token" }, heading: "Unsorted", role: "content" },
    ]);
    expect(routed?.status).toBe("routing");
    expect(routed?.rule).toBe("tag");
  });

  it("resolves inline tags through aliases", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "- Talked to @george about @un rollout");
    expect(card.tags).toEqual(["un"]);
    expect(card.rule).toBe("tag");
    expect(card.destinations[0]?.target).toEqual({ kind: "existing", slug: "unified-notification" });
  });

  it("offers did-you-mean suggestions and an off-by-default new project doc for unknown tags", async () => {
    const { ctx, notes } = await setup();
    const unknown = await oneCard(ctx, notes, "@unified-push\n- Push service notes");
    expect(unknown.rule).toBe("none");
    expect(unknown.reason).toBe("@unified-push isn't a Wiki doc yet.");
    expect(targets(unknown)).toEqual([
      { include: false, target: { kind: "new", title: "Unified push", type: "project", aliases: [] }, heading: "Notes", role: "content" },
    ]);
    const abbreviated = await oneCard(ctx, notes, "@cc\n- Add the schema first");
    expect(abbreviated.tagSuggestions[0]).toMatchObject({ tag: "cc", slug: "adding-config-catalog", title: "Adding config catalog" });
    expect(abbreviated.tagSuggestions.every((entry) => entry.tag === "cc" && entry.score > 0)).toBe(true);
  });

  it("leaves untagged text without a destination", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "Just a thought about lunch", true);
    expect(card.status).toBe("routing");
    expect(card.rule).toBe("none");
    expect(card.destinations).toEqual([]);
    expect(card.reason).toBe("No [[link]] or known @tag; choose where this belongs.");
  });

  it("adds a Related link to the project doc when the content lives elsewhere", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Token format is in [[Global token]]");
    expect(targets(card)).toEqual([
      { include: true, target: { kind: "existing", slug: "global-token" }, heading: "Unsorted", role: "content" },
      { include: true, target: { kind: "existing", slug: "unified-notification" }, heading: "Related", role: "link" },
    ]);
    expect(card.destinations.map((destination) => destination.id)).toEqual(["dst_1", "dst_2"]);
  });

  it("adds no link when the content already goes to the project", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Launch is next week");
    expect(card.destinations.map((destination) => destination.role)).toEqual(["content"]);
  });

  it.each([
    ["two block tags", "@unified-notification @global-token\n- Token rotates weekly"],
    ["a project block tag and an inline topic tag", "@unified-notification\n- Token rotates per @global-token policy"],
    ["a topic block tag and an inline project tag", "@global-token\n- Token rollout for @unified-notification is next week"],
  ])("sends the text to the topic and only a link line to the project for %s", async (_label, body) => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, body);
    expect(card.rule).toBe("tag");
    expect(targets(card)).toEqual([
      { include: true, target: { kind: "existing", slug: "global-token" }, heading: "Unsorted", role: "content" },
      { include: true, target: { kind: "existing", slug: "unified-notification" }, heading: "Related", role: "link" },
    ]);
    await acceptCard(ctx, card.id);
    expect(await read("unified-notification.md")).toBe(
      PROJECT_DOC.replace("## Related\n\n", `## Related\n\n${MARKER}\n- See [[Global token]] (from 10-14-26)\n\n`),
    );
    expect(await read("global-token.md")).toContain(`${MARKER}\n${body.split("\n")[1] ?? ""}\n`);
  });

  it("keeps the one-home rule when Claude Code routing falls back to the tags", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification @global-token\n- Token rotates weekly", true);
    expect(card.status).toBe("routing");
    const fallen = fallbackToRules(ctx, card, FALLBACK_REASON);
    expect(targets(fallen)).toEqual([
      { include: true, target: { kind: "existing", slug: "global-token" }, heading: "Unsorted", role: "content" },
      { include: true, target: { kind: "existing", slug: "unified-notification" }, heading: "Related", role: "link" },
    ]);
  });

  it("still copies into project docs when every known tag is a project", async () => {
    const { ctx, notes, wiki } = await setup();
    await put(wiki, "spam.md", "---\ntitle: Spam\ntype: project\n---\n\n# Spam\n");
    await ctx.vault.syncAll();
    const card = await oneCard(ctx, notes, "@unified-notification @spam\n- Shared launch date");
    expect(card.destinations.map((destination) => [destination.role, destination.target])).toEqual([
      ["content", { kind: "existing", slug: "unified-notification" }],
      ["content", { kind: "existing", slug: "spam" }],
    ]);
  });

  it("records units as pending, publishes once, and never duplicates a known unit", async () => {
    const { ctx, notes, harness } = await setup();
    const body = "@global-token\n- One\n- Two\n\n@skip\n- Private";
    const cards = await noteCards(ctx, notes, body);
    expect(cards.map((card) => card.text)).toEqual(["- One", "- Two", "- Private"]);
    for (const card of cards) {
      if (card.source.kind !== "notes") throw new Error("expected a notes card");
      expect(ctx.store.getUnit(card.source.unitHash)).toMatchObject({ status: "pending", cardId: card.id, notePath: NOTE_PATH });
    }
    expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === INBOX_CHANNEL)).toHaveLength(1);
    expect(await noteCards(ctx, notes, body)).toEqual([]);
    expect(ctx.store.listCards("open")).toHaveLength(3);
  });
});

describe("acceptCard", () => {
  it("appends the verbatim lines with a source marker and leaves the rest byte-identical", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Push tokens rotate weekly\n  - rotation job runs at 3am");
    const accepted = await acceptCard(ctx, card.id);
    expect(accepted.status).toBe("accepted");
    expect(await read("global-token.md")).toBe(`${TOPIC_DOC}\n${MARKER}\n- Push tokens rotate weekly\n  - rotation job runs at 3am\n`);
    expect(await read("unified-notification.md")).toBe(PROJECT_DOC);
    if (card.source.kind !== "notes") throw new Error("expected a notes card");
    expect(ctx.store.getUnit(card.source.unitHash)?.status).toBe("accepted");
    expect(ctx.store.getDoc("global-token")?.sha256).toBe(createHash("sha256").update(await read("global-token.md")).digest("hex"));
  });

  it("appends to the latest file content and writes once when accepted twice at the same time", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Fresh fact");
    const edited = TOPIC_DOC.replace("Rotate with the CLI.", "Rotate with the CLI, edited by hand.");
    await writeFile(path.join(wiki, "global-token.md"), edited);
    const results = await Promise.allSettled([acceptCard(ctx, card.id), acceptCard(ctx, card.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await read("global-token.md")).toBe(`${edited}\n${MARKER}\n- Fresh fact\n`);
  });

  it("writes the template link line under Related in the project doc", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Token format is in [[Global token#Setup]]");
    await acceptCard(ctx, card.id);
    expect(await read("unified-notification.md")).toBe(
      PROJECT_DOC.replace("## Related\n\n", `## Related\n\n${MARKER}\n- See [[Global token]] (from 10-14-26)\n\n`),
    );
    expect(await read("global-token.md")).toBe(
      TOPIC_DOC.replace("Rotate with the CLI.\n", `Rotate with the CLI.\n\n${MARKER}\n- Token format is in [[Global token#Setup]]\n`),
    );
  });

  it("creates a new doc for a new destination", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "- Idea: [[Brand new idea]]");
    await acceptCard(ctx, card.id);
    expect(await read("brand-new-idea.md")).toBe(
      `---\ntitle: Brand new idea\ntype: topic\naliases: []\n---\n\n# Brand new idea\n\n---\n\n<!-- wiki:unsorted -->\n\n${MARKER}\n- Idea: [[Brand new idea]]\n`,
    );
    expect(ctx.store.getDoc("brand-new-idea")?.title).toBe("Brand new idea");
  });

  it("points accepted destinations at the docs the accept created", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Idea for [[Brand new idea]] and [[Global token]]");
    const accepted = await acceptCard(ctx, card.id);
    expect(accepted.destinations.map((entry) => [entry.id, entry.target])).toEqual([
      ["dst_1", { kind: "existing", slug: "brand-new-idea" }],
      ["dst_2", { kind: "existing", slug: "global-token" }],
      ["dst_3", { kind: "existing", slug: "unified-notification" }],
    ]);
    expect(ctx.store.getCard(card.id)).toEqual(accepted);
  });

  it("copies images from the notes folder into assets and rewrites only those links", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const outside = await tempDir("wiki-cards-outside-");
    await put(outside, "secret.png", "OUTSIDE");
    await put(notes, "Time/oct2026/img/diagram.png", "PNGDATA");
    const line = `- Diagram ![diagram](img/diagram.png), ![gone](img/missing.png), ![far](${outside}/secret.png)`;
    const card = await oneCard(ctx, notes, `@global-token\n${line}`);
    const before = await snapshot(notes);
    const asset = `diagram-${createHash("sha256").update("PNGDATA").digest("hex").slice(0, 8)}.png`;
    expect(await missingCardImages(ctx, card.id)).toEqual(["img/missing.png", `${outside}/secret.png`]);
    await acceptCard(ctx, card.id);
    expect(await readFile(path.join(wiki, "assets", asset), "utf8")).toBe("PNGDATA");
    expect(await readdir(path.join(wiki, "assets"))).toEqual([asset]);
    expect(await read("global-token.md")).toContain(
      `- Diagram ![diagram](assets/${asset}), ![gone](img/missing.png), ![far](${outside}/secret.png)`,
    );
    expect(await snapshot(notes)).toEqual(before);
  });

  it("finds images linked relative to a parent folder of the note, and reports the rest as missing", async () => {
    const { ctx, notes, read } = await setup();
    await put(notes, "Time/photos/x.png", "PHOTO");
    await put(notes, "Projects/unified-notification/y.png", "SHOT");
    const line = "- proof ![a](./photos/x.png) ![b](../Projects/unified-notification/y.png) ![c](../photos/missing.png)";
    const card = await oneCard(ctx, notes, `@global-token\n${line}`);
    expect(await missingCardImages(ctx, card.id)).toEqual(["../photos/missing.png"]);
    await acceptCard(ctx, card.id);
    const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
    expect(await read("global-token.md")).toContain(
      `- proof ![a](assets/x-${hash("PHOTO")}.png) ![b](assets/y-${hash("SHOT")}.png) ![c](../photos/missing.png)`,
    );
  });

  it("dedents the selected lines of a destination", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Parent item\n  - child one\n  - child two");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    updateCardDestinations(ctx, card.id, [{ ...destination, lineRanges: [{ start: 1, end: 2 }] }], []);
    await acceptCard(ctx, card.id);
    expect(await read("global-token.md")).toBe(`${TOPIC_DOC}\n${MARKER}\n- child one\n- child two\n`);
  });

  it("applies remembered aliases before writing", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@cc\n- Add the schema first");
    const destination: Destination = {
      id: "dst_9",
      include: true,
      target: { kind: "existing", slug: "adding-config-catalog" },
      heading: "Steps",
      lineRanges: "all",
      role: "content",
      reason: "Did you mean",
    };
    updateCardDestinations(ctx, card.id, [destination], [{ tag: "@CC", slug: "adding-config-catalog" }]);
    await acceptCard(ctx, card.id);
    const content = await read("adding-config-catalog.md");
    expect(content).toContain("aliases: [config-catalog, cc]");
    expect(content).toContain(`## Steps\n\n${MARKER}\n- Add the schema first\n`);
    expect(ctx.store.resolveTag("cc")).toBe("adding-config-catalog");
  });

  it("makes one git commit per card", async () => {
    const { ctx, notes, wiki } = await setup({ gitHistory: true });
    const card = await oneCard(ctx, notes, "@unified-notification\n- Push tokens rotate weekly per [[Global token]]");
    await acceptCard(ctx, card.id);
    const log = execFileSync("git", ["-C", wiki, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["Wiki: - Push tokens rotate weekly per [[Global token]] → Global token"]);
    const files = execFileSync("git", ["-C", wiki, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort();
    expect(files).toEqual(["global-token.md", "unified-notification.md"]);
  });

  it("refuses cards that have nothing to write or were already handled", async () => {
    const { ctx, notes } = await setup();
    const empty = await oneCard(ctx, notes, "Loose thought");
    await expect(acceptCard(ctx, empty.id)).rejects.toThrow("Turn on at least one destination with content");
    const card = await oneCard(ctx, notes, "@global-token\n- Real fact");
    await acceptCard(ctx, card.id);
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("already accepted");
    await expect(skipCard(ctx, card.id)).rejects.toThrow("already accepted");
    await expect(acceptCard(ctx, "card_00000000")).rejects.toThrow("No Wiki inbox card card_00000000");
  });

  it("refuses to write when a target doc disappeared, without partial writes", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Format in [[Global token]]");
    await writeFile(path.join(wiki, "unified-notification.md"), PROJECT_DOC);
    ctx.store.removeDoc("unified-notification");
    await expect(acceptCard(ctx, card.id)).rejects.toThrow('there is no Wiki doc with slug "unified-notification"');
    expect(await read("global-token.md")).toBe(TOPIC_DOC);
  });

  it("writes agent cards with an agent source marker", async () => {
    const { ctx, read } = await setup();
    const card = await createAgentCard(ctx, {
      threadId: "thr_agent",
      threadTitle: "Deploy chat",
      text: "Use `bb deploy --dry-run` first.",
      doc: "Global token",
      heading: "Setup",
      title: null,
    });
    await acceptCard(ctx, card.id);
    expect(await read("global-token.md")).toContain(
      `Rotate with the CLI.\n\n<!-- wiki:source agent thread="thr_agent" title="Deploy chat" added="2026-10-15" -->\nUse \`bb deploy --dry-run\` first.\n`,
    );
  });
});

describe("skipCard", () => {
  it("marks the card and the unit skipped, and stays skipped", async () => {
    const { ctx, notes, harness } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Not worth keeping");
    const signals = harness.inspection.realtimeSignals.length;
    expect((await skipCard(ctx, card.id)).status).toBe("skipped");
    expect((await skipCard(ctx, card.id)).status).toBe("skipped");
    expect(harness.inspection.realtimeSignals).toHaveLength(signals + 1);
    if (card.source.kind !== "notes") throw new Error("expected a notes card");
    expect(ctx.store.getUnit(card.source.unitHash)?.status).toBe("skipped");
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("already skipped");
  });
});

describe("updateCardDestinations", () => {
  async function pendingCard() {
    const env = await setup();
    const card = await oneCard(env.ctx, env.notes, "@global-token\n- First line\n  - nested line");
    expect(card.lines).toHaveLength(2);
    return { ...env, card };
  }

  function destination(overrides: Partial<Destination> = {}): Destination {
    return {
      id: "dst_1",
      include: true,
      target: { kind: "existing", slug: "global-token" },
      heading: "Setup",
      lineRanges: "all",
      role: "content",
      reason: "",
      ...overrides,
    };
  }

  it("saves valid edits and marks the card pending", async () => {
    const { ctx, notes } = await setup();
    const routing = await oneCard(ctx, notes, "@global-token\n- In flight", true);
    const updated = updateCardDestinations(ctx, routing.id, [destination({ heading: "Setup" })], []);
    expect(updated.status).toBe("pending");
    expect(updated.destinations).toEqual([destination({ heading: "Setup" })]);
    expect(ctx.store.getCard(routing.id)?.destinations[0]?.heading).toBe("Setup");
  });

  it.each([
    ["an unknown slug", [destination({ target: { kind: "existing", slug: "nope" } })], [], 'there is no Wiki doc with slug "nope"'],
    ["lines out of bounds", [destination({ lineRanges: [{ start: 1, end: 2 }] })], [], "lines 1-2 are outside this card's 2 lines (0-1)"],
    ["duplicate ids", [destination(), destination()], [], 'Destination id "dst_1" is used twice'],
    ["an alias owned by another doc", [destination()], [{ tag: "un", slug: "global-token" }], "@un already belongs to “Unified notification”"],
    ["an alias for a missing doc", [destination()], [{ tag: "gt", slug: "missing" }], 'there is no Wiki doc with slug "missing"'],
  ])("rejects %s", async (_label, destinations, aliases, message) => {
    const { ctx, card } = await pendingCard();
    expect(() => updateCardDestinations(ctx, card.id, destinations, aliases)).toThrow(message);
    expect(ctx.store.getCard(card.id)?.destinations).toEqual(card.destinations);
  });

  it("keeps destination ids made in the browser, and previews always show the last saved edit", async () => {
    const { ctx, card } = await pendingCard();
    const browser = destination({ id: "dest_7", target: { kind: "new", title: "Rotation runbook", type: "process", aliases: [] }, heading: "Notes", lineRanges: [{ start: 1, end: 1 }] });
    const updated = updateCardDestinations(ctx, card.id, [destination(), browser], []);
    expect(updated.destinations.map((entry) => entry.id)).toEqual(["dst_1", "dest_7"]);
    const first = await previewCard(ctx, card.id);
    expect(first.map((preview) => [preview.destinationId, preview.slug, preview.title])).toEqual([
      ["dst_1", "global-token", "Global token"],
      ["dest_7", null, "Rotation runbook"],
    ]);
    expect(first[1]?.patch).toContain(`+## Notes\n+\n+${MARKER}\n+- nested line`);

    updateCardDestinations(ctx, card.id, [{ ...browser, heading: "Steps", lineRanges: "all" }], []);
    const second = await previewCard(ctx, card.id);
    expect(second.map((preview) => preview.destinationId)).toEqual(["dest_7"]);
    expect(second[0]?.patch).toContain(`+## Steps\n+\n+${MARKER}\n+- First line\n+  - nested line`);
    expect(second[0]?.patch).not.toContain("+## Notes");
  });

  it("refuses edits to accepted cards", async () => {
    const { ctx, card } = await pendingCard();
    await acceptCard(ctx, card.id);
    expect(() => updateCardDestinations(ctx, card.id, [destination()], [])).toThrow("already accepted");
  });
});

describe("applyRoutes and fallbackToRules", () => {
  async function routingCard(body = "@unified-notification\n- Global token rotates weekly\n  - see the runbook") {
    const env = await setup();
    const card = await oneCard(env.ctx, env.notes, body, true);
    expect(card.status).toBe("routing");
    return { ...env, card };
  }

  it("replaces destinations with the agent's routes and adds the project link", async () => {
    const { ctx, card } = await routingCard();
    const routed = applyRoutes(ctx, card, {
      destinations: [
        { target: { kind: "existing", slug: "global-token" }, heading: "Setup", lineRanges: [{ start: 0, end: 1 }], reason: "How tokens work." },
      ],
      tagMatches: [],
    });
    expect(routed.rule).toBe("agent");
    expect(routed.status).toBe("pending");
    expect(routed.destinations).toEqual([
      { id: "dst_1", include: true, target: { kind: "existing", slug: "global-token" }, heading: "Setup", lineRanges: [{ start: 0, end: 1 }], role: "content", reason: "How tokens work." },
      expect.objectContaining({ id: "dst_2", target: { kind: "existing", slug: "unified-notification" }, heading: "Related", role: "link" }),
    ]);
  });

  it("turns a new doc that matches an existing title into that doc", async () => {
    const { ctx, card } = await routingCard();
    const routed = applyRoutes(ctx, card, {
      destinations: [{ target: { kind: "new", title: "global token", type: "topic", aliases: [] }, heading: "Unsorted", lineRanges: "all", reason: "" }],
      tagMatches: [],
    });
    expect(routed.destinations[0]?.target).toEqual({ kind: "existing", slug: "global-token" });
  });

  it("keeps agent tag matches as suggestions with score 1", async () => {
    const { ctx, card } = await routingCard("@cc\n- Add the schema first");
    const routed = applyRoutes(ctx, card, { destinations: [], tagMatches: [{ tag: "cc", slug: "adding-config-catalog" }] });
    expect(routed.tagSuggestions).toContainEqual({ tag: "cc", slug: "adding-config-catalog", title: "Adding config catalog", score: 1 });
    expect(routed.rememberAliases).toEqual([]);
    expect(ctx.store.resolveTag("cc")).toBeNull();
  });

  it.each([
    [{ target: { kind: "existing" as const, slug: "nope" }, lineRanges: "all" as const }, 'Destination 1: there is no Wiki doc with slug "nope"'],
    [{ target: { kind: "existing" as const, slug: "global-token" }, lineRanges: [{ start: 1, end: 4 }] }, "Destination 1: lines 1-4 are outside this card's 2 lines (0-1)"],
  ])("rejects invalid routes without changing the card", async (route, message) => {
    const { ctx, card } = await routingCard();
    expect(() => applyRoutes(ctx, card, { destinations: [{ ...route, heading: "Unsorted", reason: "" }], tagMatches: [] })).toThrow(message);
    expect(ctx.store.getCard(card.id)).toEqual(card);
  });

  it("rejects tag matches for tags the card does not have", async () => {
    const { ctx, card } = await routingCard();
    expect(() => applyRoutes(ctx, card, { destinations: [], tagMatches: [{ tag: "zzz", slug: "global-token" }] })).toThrow(
      "@zzz: that is not one of this card's tags",
    );
  });

  it("falls back to the provisional rule-based destinations", async () => {
    const { ctx, card } = await routingCard();
    const fallen = fallbackToRules(ctx, card, FALLBACK_REASON);
    expect(fallen.status).toBe("pending");
    expect(fallen.reason).toBe(FALLBACK_REASON);
    expect(fallen.rule).toBe("tag");
    expect(fallen.destinations).toEqual(card.destinations);
    expect(fallbackToRules(ctx, fallen, "other")).toEqual(fallen);
  });

  it("never sends explicit-link cards to the agent", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- See [[Global token]] for the format", true);
    expect(card.status).toBe("pending");
    expect(card.destinations.map((destination) => destination.role)).toEqual(["content", "link"]);
  });
});

describe("previewCard", () => {
  it("shows a unified diff per destination without writing anything", async () => {
    const { ctx, notes, wiki } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Idea for [[Brand new idea]] and [[Global token]]");
    const before = await snapshot(wiki);
    const previews = await previewCard(ctx, card.id);
    expect(previews.map((preview) => [preview.destinationId, preview.slug, preview.title])).toEqual([
      ["dst_1", null, "Brand new idea"],
      ["dst_2", "global-token", "Global token"],
      ["dst_3", "unified-notification", "Unified notification"],
    ]);
    const [created, existing, link] = previews;
    expect(created?.patch).toContain("--- brand-new-idea.md");
    expect(created?.patch).toContain("+title: Brand new idea");
    expect(existing?.patch).toContain(`+${MARKER}\n+- Idea for [[Brand new idea]] and [[Global token]]`);
    expect(link?.patch).toContain("+- See [[Brand new idea]] (from 10-14-26)\n+- See [[Global token]] (from 10-14-26)");
    expect(await snapshot(wiki)).toEqual(before);
    expect(await exists(path.join(wiki, "brand-new-idea.md"))).toBe(false);
  });

  it("returns nothing when no content destination is on", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@unified-push\n- Not yet a doc");
    expect(await previewCard(ctx, card.id)).toEqual([]);
  });
});

describe("createAgentCard", () => {
  const base = { threadId: "thr_agent", threadTitle: "Deploy chat", text: "Use dry runs.\nThen deploy.", heading: null };

  it("targets a doc the agent named", async () => {
    const { ctx, harness } = await setup();
    const card = await createAgentCard(ctx, { ...base, doc: "global-token#Setup", title: null });
    expect(card).toMatchObject({
      status: "pending",
      rule: "explicit-link",
      source: { kind: "agent", threadId: "thr_agent", threadTitle: "Deploy chat" },
      lines: ["Use dry runs.", "Then deploy."],
      reason: "Written by an agent in “Deploy chat”; review before adding.",
    });
    expect(targets(card)).toEqual([{ include: true, target: { kind: "existing", slug: "global-token" }, heading: "Setup", role: "content" }]);
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain(INBOX_CHANNEL);
  });

  it("proposes a new doc, turned on only when the agent gave a title", async () => {
    const { ctx } = await setup();
    const titled = await createAgentCard(ctx, { ...base, doc: null, title: "Deploy checklist" });
    expect(titled.rule).toBe("none");
    expect(targets(titled)).toEqual([
      { include: true, target: { kind: "new", title: "Deploy checklist", type: "topic", aliases: [] }, heading: "Notes", role: "content" },
    ]);
    const unknownDoc = await createAgentCard(ctx, { ...base, threadTitle: null, doc: "Nowhere", title: null });
    expect(targets(unknownDoc)[0]).toMatchObject({ include: false, target: { kind: "new", title: "Nowhere" } });
    expect(unknownDoc.reason).toBe("Written by an agent in thread thr_agent; review before adding.");
    const bare = await createAgentCard(ctx, { ...base, doc: null, title: null });
    expect(targets(bare)[0]).toMatchObject({ include: false, target: { kind: "new", title: "Use dry runs." } });
  });

  it("rejects empty text", async () => {
    const { ctx } = await setup();
    await expect(createAgentCard(ctx, { ...base, text: "  \n ", doc: null, title: null })).rejects.toThrow("Give the text");
  });
});

describe("accept safety", () => {
  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it("files a second card's [[New doc]] link into the doc the first card created", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const [first, second] = await noteCards(ctx, notes, "- One about [[Brand new idea]]\n\n- Two about [[Brand new idea]]");
    if (first === undefined || second === undefined) throw new Error("expected two cards");
    await acceptCard(ctx, first.id);
    const [preview] = await previewCard(ctx, second.id);
    expect(preview).toMatchObject({ slug: "brand-new-idea", title: "Brand new idea" });
    expect(preview?.patch).not.toContain("+title:");
    await acceptCard(ctx, second.id);
    expect((await readdir(wiki)).filter((name) => name.startsWith("brand-new-idea"))).toEqual(["brand-new-idea.md"]);
    const content = await read("brand-new-idea.md");
    expect(count(content, "<!-- wiki:unsorted -->")).toBe(1);
    expect(content).toContain("- One about [[Brand new idea]]");
    expect(content).toContain("- Two about [[Brand new idea]]");
  });

  it("creates one doc when two destinations of one card name the same new doc", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const card = await oneCard(ctx, notes, "- Parent about [[Fresh topic]]\n  - child line");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    updateCardDestinations(
      ctx,
      card.id,
      [
        { ...destination, lineRanges: [{ start: 0, end: 0 }] },
        { ...destination, id: "dst_2", heading: "Details", lineRanges: [{ start: 1, end: 1 }] },
      ],
      [],
    );
    await acceptCard(ctx, card.id);
    expect((await readdir(wiki)).filter((name) => name.startsWith("fresh-topic"))).toEqual(["fresh-topic.md"]);
    expect(await read("fresh-topic.md")).toContain(`## Details\n\n${MARKER}\n- child line\n`);
  });

  it("checks every target doc before writing, so a bad doc leaves the others untouched", async () => {
    const { ctx, notes, wiki, read } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Shared fact");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const second = { ...destination, id: "dst_2", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    updateCardDestinations(ctx, card.id, [destination, second], []);
    await writeFile(path.join(wiki, "adding-config-catalog.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("adding-config-catalog");
    expect(await read("global-token.md")).toBe(TOPIC_DOC);
    expect(ctx.store.getCard(card.id)?.status).toBe("pending");
  });

  it("never writes a destination twice when a later write fails and the user accepts again", async () => {
    const { ctx, notes, read, harness } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Shared fact");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const second = { ...destination, id: "dst_2", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    updateCardDestinations(ctx, card.id, [destination, second], []);
    const append = ctx.vault.appendBlock;
    const spy = vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      if (slug === "adding-config-catalog") throw new Error("disk full");
      return append(slug, heading, block);
    });
    const signals = harness.inspection.realtimeSignals.length;
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("disk full");
    expect(harness.inspection.realtimeSignals.length).toBeGreaterThan(signals);
    const kept = ctx.store.getCard(card.id);
    expect(kept?.status).toBe("pending");
    expect(kept?.destinations.map((entry) => [entry.id, entry.include])).toEqual([
      ["dst_1", false],
      ["dst_2", true],
    ]);
    spy.mockRestore();
    await acceptCard(ctx, card.id);
    expect(count(await read("global-token.md"), "- Shared fact")).toBe(1);
    expect(count(await read("adding-config-catalog.md"), "- Shared fact")).toBe(1);
  });

  it("points a destination at the doc it created when a later write fails", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "- Fact about [[Fresh topic]]");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const second = { ...destination, id: "dest_2", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    updateCardDestinations(ctx, card.id, [destination, second], []);
    const append = ctx.vault.appendBlock;
    vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      if (slug === "adding-config-catalog") throw new Error("disk full");
      return append(slug, heading, block);
    });
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("disk full");
    expect(ctx.store.getCard(card.id)?.destinations.map((entry) => [entry.id, entry.include, entry.target])).toEqual([
      [destination.id, false, { kind: "existing", slug: "fresh-topic" }],
      ["dest_2", true, { kind: "existing", slug: "adding-config-catalog" }],
    ]);
  });

  it("commits what was written when a later write fails", async () => {
    const { ctx, notes, wiki } = await setup({ gitHistory: true });
    const card = await oneCard(ctx, notes, "@global-token\n- Shared fact");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const second = { ...destination, id: "dst_2", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    updateCardDestinations(ctx, card.id, [destination, second], []);
    const append = ctx.vault.appendBlock;
    vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      if (slug === "adding-config-catalog") throw new Error("disk full");
      return append(slug, heading, block);
    });
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("disk full");
    const status = execFileSync("git", ["-C", wiki, "status", "--porcelain", "--", "global-token.md"], { encoding: "utf8" });
    expect(status).toBe("");
  });

  it("takes a routing card away from the routing agent once the user accepts it", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- In flight", true);
    expect(card.status).toBe("routing");
    const append = ctx.vault.appendBlock;
    const seen: Array<string | undefined> = [];
    vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      seen.push(ctx.store.getCard(card.id)?.status);
      return append(slug, heading, block);
    });
    await acceptCard(ctx, card.id);
    expect(seen).toEqual(["pending"]);
    expect(ctx.store.getCard(card.id)?.status).toBe("accepted");
  });

  function failAppendsTo(ctx: WikiContext, failing: string) {
    const append = ctx.vault.appendBlock;
    return vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      if (slug === failing) throw new Error("disk full");
      return append(slug, heading, block);
    });
  }

  async function twoDestinationCard(ctx: WikiContext, notes: string, body: string): Promise<Card> {
    const card = await oneCard(ctx, notes, body);
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const second = { ...destination, id: "dst_2", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    return updateCardDestinations(ctx, card.id, [destination, second], []);
  }

  it("records each written destination before the next write, so a crash cannot lead to a second copy", async () => {
    const { ctx, notes, read } = await setup();
    const card = await twoDestinationCard(ctx, notes, "@global-token\n- Crash fact");
    const append = ctx.vault.appendBlock;
    let duringSecond: Destination[] = [];
    const spy = vi.spyOn(ctx.vault, "appendBlock").mockImplementation(async (slug, heading, block) => {
      if (slug !== "adding-config-catalog") return append(slug, heading, block);
      duringSecond = ctx.store.getCard(card.id)?.destinations ?? [];
      throw new Error("process killed");
    });
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("process killed");
    expect(duringSecond.map((entry) => [entry.id, entry.include, entry.written === true])).toEqual([
      ["dst_1", false, true],
      ["dst_2", true, false],
    ]);
    spy.mockRestore();
    const stored = ctx.store.getCard(card.id)?.destinations ?? [];
    expect(() => updateCardDestinations(ctx, card.id, stored.map((entry) => ({ ...entry, include: true })), [])).toThrow(
      "can't be turned on again",
    );
    expect(() => updateCardDestinations(ctx, card.id, stored.slice(1), [])).toThrow("already added to the Wiki");
    await acceptCard(ctx, card.id);
    expect(count(await read("global-token.md"), "- Crash fact")).toBe(1);
    expect(count(await read("adding-config-catalog.md"), "- Crash fact")).toBe(1);
  });

  it("marks the card accepted before the git commit, so a crash during the commit cannot lead to a second copy", async () => {
    const { ctx, notes, read } = await setup({ gitHistory: true });
    const card = await oneCard(ctx, notes, "@global-token\n- Commit fact");
    const statuses: Array<string | undefined> = [];
    const spy = vi.spyOn(ctx.vault, "commit").mockImplementation(async () => {
      statuses.push(ctx.store.getCard(card.id)?.status);
      throw new Error("process killed");
    });
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("process killed");
    expect(statuses).toEqual(["accepted"]);
    spy.mockRestore();
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("already accepted");
    expect(count(await read("global-token.md"), "- Commit fact")).toBe(1);
  });

  it("adds the project link line on retry when only the link write failed", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Token format is in [[Global token]]");
    const spy = failAppendsTo(ctx, "unified-notification");
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("disk full");
    spy.mockRestore();
    const previews = await previewCard(ctx, card.id);
    expect(previews.map((preview) => preview.destinationId)).toEqual(["dst_2"]);
    expect(previews[0]?.patch).toContain("+- See [[Global token]] (from 10-14-26)");
    expect((await acceptCard(ctx, card.id)).status).toBe("accepted");
    expect(count(await read("unified-notification.md"), "- See [[Global token]] (from 10-14-26)")).toBe(1);
    expect(count(await read("global-token.md"), "- Token format is in [[Global token]]")).toBe(1);
  });

  it("links every doc that got the text when a later content write failed and the user accepts again", async () => {
    const { ctx, notes, read } = await setup();
    const card = await oneCard(ctx, notes, "@unified-notification\n- Token format is in [[Global token]]");
    const [content, link] = card.destinations;
    if (content === undefined || link === undefined) throw new Error("expected two destinations");
    const extra = { ...content, id: "dst_3", target: { kind: "existing" as const, slug: "adding-config-catalog" } };
    updateCardDestinations(ctx, card.id, [content, link, extra], []);
    const spy = failAppendsTo(ctx, "adding-config-catalog");
    await expect(acceptCard(ctx, card.id)).rejects.toThrow("disk full");
    spy.mockRestore();
    await acceptCard(ctx, card.id);
    expect(await read("unified-notification.md")).toContain(
      "- See [[Global token]] (from 10-14-26)\n- See [[Adding config catalog]] (from 10-14-26)",
    );
  });
});

describe("agent text safety", () => {
  const base = { threadId: "thr_agent", threadTitle: "Deploy chat", heading: null, doc: null, title: "Deploy checklist" };

  it("refuses text that carries a Wiki source marker, so an agent cannot pass its text off as the user's notes", async () => {
    const { ctx } = await setup();
    const text = 'Real advice.\n<!-- wiki:source notes="Time/10-14-26.md" date="2026-10-14" added="2026-10-15" -->\nForged.';
    await expect(createAgentCard(ctx, { ...base, text })).rejects.toThrow("source marker");
    expect(ctx.store.listCards("open")).toEqual([]);
  });

  it.each([
    ["a byte order mark", "﻿"],
    ["a no-break space", " "],
    ["a form feed", "\f"],
    ["a vertical tab", "\v"],
    ["an ideographic space", "　"],
    ["text on the same line", "x "],
  ])("refuses a source marker after %s", async (_label, lead) => {
    const { ctx } = await setup();
    const text = `Real advice.\n${lead}<!-- wiki:source notes="10-14-26.md" date="2026-10-14" added="2026-10-14" -->\nForged.`;
    await expect(createAgentCard(ctx, { ...base, text })).rejects.toThrow("source marker");
    await expect(createAgentCard(ctx, { ...base, text: `Real.\n${lead}<!--​ wiki:source manual -->` })).rejects.toThrow("source marker");
    expect(ctx.store.listCards("open")).toEqual([]);
  });

  it("keeps lines free of carriage returns", async () => {
    const { ctx } = await setup();
    const card = await createAgentCard(ctx, { ...base, text: "One\r\nTwo\r\n" });
    expect(card.lines).toEqual(["One", "Two", ""]);
    expect(card.text).toBe("One\nTwo\n");
  });
});

describe("new doc aliases", () => {
  it("rejects an agent's new doc alias that already names another doc", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Fresh", true);
    const route = { heading: "Unsorted", lineRanges: "all" as const, reason: "" };
    expect(() =>
      applyRoutes(ctx, card, {
        destinations: [{ ...route, target: { kind: "new", title: "Token rotation", type: "topic", aliases: ["@UN"] } }],
        tagMatches: [],
      }),
    ).toThrow("@un already names “Unified notification”");
    const routed = applyRoutes(ctx, card, {
      destinations: [{ ...route, target: { kind: "new", title: "Token rotation", type: "topic", aliases: ["@Rotation", "rotation"] } }],
      tagMatches: [],
    });
    expect(routed.destinations[0]?.target).toEqual({ kind: "new", title: "Token rotation", type: "topic", aliases: ["rotation"] });
  });

  it("rejects a user's new doc alias that already names another doc", async () => {
    const { ctx, notes } = await setup();
    const card = await oneCard(ctx, notes, "@global-token\n- Fresh");
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    const target = { kind: "new" as const, title: "Token rotation", type: "topic" as const, aliases: ["config-catalog"] };
    expect(() => updateCardDestinations(ctx, card.id, [{ ...destination, target }], [])).toThrow(
      "@config-catalog already names “Adding config catalog”",
    );
  });
});

describe("createUploadCard", () => {
  async function uploadSetup(settings: Record<string, string | boolean> = {}) {
    const env = await setup(settings);
    const files = await tempDir("wiki-cards-upload-");
    await put(files, "Roadmap.png", "PNGDATA");
    const media = [{ from: { kind: "path" as const, path: path.join(files, "Roadmap.png") }, caption: "Q3 plan" }];
    const base = { name: "Roadmap.png", text: "  \nRoadmap for Q3\n\n", media, target: null, heading: null, pluginId: "sketch", threadId: null };
    const asset = `roadmap-${createHash("sha256").update("PNGDATA").digest("hex").slice(0, 8)}.png`;
    const cardMedia = (card: Card) => path.join(env.ctx.dataDir(), "card-media", card.id);
    return { ...env, files, media, base, asset, cardMedia };
  }

  function content(card: Card): Destination {
    const [destination] = card.destinations;
    if (destination === undefined) throw new Error("expected a destination");
    return destination;
  }

  it("files an image with a note as a pending card holding its own copy of the image", async () => {
    const { ctx, wiki, harness, base, cardMedia } = await uploadSetup();
    const before = await snapshot(wiki);
    const card = await createUploadCard(ctx, { ...base, target: { kind: "existing", slug: "global-token" } });
    expect(card).toMatchObject({
      status: "pending",
      source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId: null },
      text: `Roadmap for Q3\n\n![Q3 plan](card-media/${card.id}/roadmap.png)`,
      lines: ["Roadmap for Q3", "", `![Q3 plan](card-media/${card.id}/roadmap.png)`],
      tags: [],
      rule: "picked",
      reason: "Sent from Sketch; review before adding.",
    });
    expect(targets(card)).toEqual([{ include: true, target: { kind: "existing", slug: "global-token" }, heading: "Unsorted", role: "content" }]);
    expect(content(card).reason).toBe("Chosen in Sketch when it was sent.");
    expect(await readFile(path.join(cardMedia(card), "roadmap.png"), "utf8")).toBe("PNGDATA");
    expect(ctx.store.getCard(card.id)).toEqual(card);
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain(INBOX_CHANNEL);
    expect(await snapshot(wiki)).toEqual(before);
  });

  it("proposes the chosen heading or a new doc, and an off new doc when nothing was chosen", async () => {
    const { ctx, base } = await uploadSetup();
    const headed = await createUploadCard(ctx, { ...base, target: { kind: "existing", slug: "global-token" }, heading: "Setup" });
    expect(targets(headed)[0]).toMatchObject({ include: true, heading: "Setup" });
    const fresh = await createUploadCard(ctx, { ...base, target: { kind: "new", title: "Roadmaps", type: "project", aliases: [] } });
    expect(fresh.rule).toBe("picked");
    expect(targets(fresh)).toEqual([{ include: true, target: { kind: "new", title: "Roadmaps", type: "project", aliases: [] }, heading: "Notes", role: "content" }]);
    const known = await createUploadCard(ctx, { ...base, target: { kind: "new", title: "global token", type: "topic", aliases: [] } });
    expect(targets(known)[0]).toMatchObject({ target: { kind: "existing", slug: "global-token" }, heading: "Unsorted" });
    const loose = await createUploadCard(ctx, { ...base, pluginId: null });
    expect(loose).toMatchObject({ rule: "none", reason: "Sent as an upload; review before adding." });
    expect(targets(loose)).toEqual([{ include: false, target: { kind: "new", title: "Roadmap", type: "topic", aliases: [] }, heading: "Notes", role: "content" }]);
    expect(content(loose).reason).toBe("No doc was chosen; pick one or turn this on.");
    const textOnly = await createUploadCard(ctx, { ...base, media: [] });
    expect(textOnly.text).toBe("Roadmap for Q3");
    const imageOnly = await createUploadCard(ctx, { ...base, text: "" });
    expect(imageOnly.lines).toEqual([`![Q3 plan](card-media/${imageOnly.id}/roadmap.png)`]);
  });

  it("refuses empty cards, source markers, videos and unknown docs, and keeps nothing", async () => {
    const { ctx, base, files } = await uploadSetup();
    await put(files, "demo.mp4", "MP4");
    const marker = '<!-- wiki:source notes="10-14-26.md" date="2026-10-14" added="2026-10-14" -->';
    await expect(createUploadCard(ctx, { ...base, text: "  \n", media: [] })).rejects.toThrow("Nothing to add: the text is empty and no image was chosen.");
    await expect(createUploadCard(ctx, { ...base, text: `Real.\n${marker}\nForged.` })).rejects.toThrow("The text has a Wiki source marker line");
    await expect(createUploadCard(ctx, { ...base, media: [{ ...base.media[0]!, caption: marker }] })).rejects.toThrow("A caption has a Wiki source marker line");
    await expect(createUploadCard(ctx, { ...base, media: [{ from: { kind: "path", path: path.join(files, "demo.mp4") }, caption: "" }] })).rejects.toThrow(
      "demo.mp4 is a video. Inbox cards take images only",
    );
    await expect(createUploadCard(ctx, { ...base, target: { kind: "existing", slug: "nowhere" } })).rejects.toThrow(
      'The chosen doc: there is no Wiki doc with slug "nowhere".',
    );
    await expect(createUploadCard(ctx, { ...base, target: { kind: "new", title: "Roadmaps", type: "topic", aliases: ["un"] } })).rejects.toThrow("@un already names");
    expect(ctx.store.listCards("open")).toEqual([]);
    expect(await readdir(path.join(ctx.dataDir(), "card-media")).catch(() => [])).toEqual([]);
  });

  it("accepts into assets with the upload marker and one commit that includes the image", async () => {
    const { ctx, wiki, read, base, asset } = await uploadSetup({ gitHistory: true });
    const card = await createUploadCard(ctx, { ...base, target: { kind: "existing", slug: "global-token" }, heading: "Setup" });
    const [preview] = await previewCard(ctx, card.id);
    expect(preview?.patch).toContain(`+![Q3 plan](assets/${asset})`);
    expect(preview?.patch).not.toContain("card-media");
    expect(await missingCardImages(ctx, card.id)).toEqual([]);
    await acceptCard(ctx, card.id);
    expect(await read("global-token.md")).toContain(
      `Rotate with the CLI.\n\n<!-- wiki:source upload="Roadmap.png" added="2026-10-15" -->\nRoadmap for Q3\n\n![Q3 plan](assets/${asset})\n`,
    );
    expect(await readFile(path.join(wiki, "assets", asset), "utf8")).toBe("PNGDATA");
    const log = execFileSync("git", ["-C", wiki, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["Wiki: Roadmap for Q3 → Global token"]);
    const files = execFileSync("git", ["-C", wiki, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").sort();
    expect(files).toEqual([`assets/${asset}`, "global-token.md"]);
  });

  it("names the commit after the image when the card has no text", async () => {
    const { ctx, wiki, base } = await uploadSetup({ gitHistory: true });
    const card = await createUploadCard(ctx, { ...base, text: "", target: { kind: "existing", slug: "global-token" } });
    await acceptCard(ctx, card.id);
    const log = execFileSync("git", ["-C", wiki, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual(["Wiki: Roadmap.png → Global token"]);
  });

  it("keeps the image through skip so restore and accept still work, then drops it once accepted", async () => {
    const { ctx, read, base, asset, cardMedia } = await uploadSetup();
    const card = await createUploadCard(ctx, { ...base, target: { kind: "existing", slug: "global-token" } });
    expect((await skipCard(ctx, card.id)).status).toBe("skipped");
    expect(await read("global-token.md")).toBe(TOPIC_DOC);
    expect(await readdir(cardMedia(card))).toEqual(["roadmap.png"]);
    expect((await restoreCard(ctx, card.id)).status).toBe("pending");
    await acceptCard(ctx, card.id);
    expect(await read("global-token.md")).toContain(`![Q3 plan](assets/${asset})`);
    expect(await exists(cardMedia(card))).toBe(false);
  });

  it("refuses to accept when the card's image is gone, and leaves other image links alone", async () => {
    const { ctx, read, base, cardMedia } = await uploadSetup();
    const card = await createUploadCard(ctx, { ...base, text: "See ![old](assets/old.png)", target: { kind: "existing", slug: "global-token" } });
    await rm(cardMedia(card), { recursive: true });
    expect(await missingCardImages(ctx, card.id)).toEqual([`card-media/${card.id}/roadmap.png`]);
    await expect(acceptCard(ctx, card.id)).rejects.toThrow(
      `The image card-media/${card.id}/roadmap.png is gone from the Wiki's data folder, so nothing was added. Skip this card and send it again.`,
    );
    expect(await read("global-token.md")).toBe(TOPIC_DOC);
    expect(ctx.store.getCard(card.id)?.status).toBe("pending");
  });
});
