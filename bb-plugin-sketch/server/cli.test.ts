import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sketchDetailSchema, sketchSummarySchema, statusSchema } from "../contract";
import { rect, text } from "../lib/test-fixtures";
import { formatFor } from "./cli-export";
import { titleFromPath } from "./cli";
import { CONTENT_HINT, shellArg } from "./cli-output";
import { createWikiFake, fakePng, sceneText, setup, tempDir, type Setup } from "./test-support";

const PLAN = sceneText([rect(0, 0, 100, 60, { id: "box" }), text({ x: 10, y: 10 }, "Billing   flow", { id: "label" }), text({ x: 10, y: 40 }, "v2", { id: "v2" })]);
const errorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }) });

async function seed(s: Setup, title: string, content: string = PLAN) {
  return sketchDetailSchema.parse(await s.rpc("create", { title, content }));
}

async function withPreview(s: Setup, title: string, png: Buffer = fakePng(10, 6)) {
  const sketch = await seed(s, title);
  expect(await s.rpc("savePreview", { id: sketch.id, sha256: sketch.sha256, png: png.toString("base64") })).toEqual({ stored: true });
  return sketch;
}

function json(stdout: string): unknown {
  return JSON.parse(stdout);
}

describe("bb sketch list, show and status", () => {
  it("lists sketches, or says there are none", async () => {
    const s = await setup();
    expect((await s.cli(["list"])).stdout).toBe("No sketches yet. Create one with `bb sketch new`.\n");
    await seed(s, "Plan");
    const listed = await s.cli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toMatch(/^Plan\t3 elements\t\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
    expect(z.array(sketchSummarySchema).parse(json((await s.cli(["ls", "--json"])).stdout))).toHaveLength(1);
  });

  it("prints the file by exact name, any case, or a unique prefix", async () => {
    const s = await setup();
    await seed(s, "Billing plan");
    await seed(s, "Billing review");
    await seed(s, "billing");
    for (const ref of [["billing"], ["BILLING", "PLAN"], ["Billing", "p"], ["billing", "r"]]) {
      expect((await s.cli(["show", ...ref])).stdout).toBe(PLAN);
    }
    expect(sketchDetailSchema.parse(json((await s.cli(["show", "billing plan", "--json"])).stdout)).id).toBe("Billing plan");
  });

  it("explains a missing or ambiguous name", async () => {
    const s = await setup();
    await seed(s, "Plan A");
    await seed(s, "Plan B");
    const ambiguous = await s.cli(["show", "Plan"]);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain("“Plan” matches 2 sketches: “Plan A”, “Plan B”.");
    const missing = await s.cli(["show", "Nope", "--json"]);
    expect(errorEnvelope.parse(json(missing.stdout)).error).toEqual({
      code: "not_found",
      message: "No sketch matches “Nope”.",
      hint: "Run `bb sketch list` to see sketch names.",
    });
  });

  it("shows the status", async () => {
    const s = await setup({ wiki: createWikiFake({}, { plugins: [] }) });
    await seed(s, "Plan");
    expect((await s.cli(["status"])).stdout).toBe(`Sketch folder: ${s.folder}\nSketches: 1\nWiki: The Wiki plugin isn't installed.\n`);
    expect(statusSchema.parse(json((await s.cli(["status", "--json"])).stdout)).sketchCount).toBe(1);
    expect((await (await setup()).cli(["status"])).stdout).toContain("Wiki: ready for images\n");
    const old = await setup({ wiki: createWikiFake({}, { missing: ["addCard"] }) });
    expect((await old.cli(["status"])).stdout).toContain("Wiki: ready (doc only — update the Wiki plugin for inbox cards)\n");
    expect(statusSchema.parse(json((await old.cli(["status", "--json"])).stdout)).wiki).toEqual({ available: true, inbox: false });
  });

  it("refuses output bigger than a bb command can print", async () => {
    const s = await setup();
    await seed(s, "Huge", sceneText([text({ x: 0, y: 0 }, "x".repeat(1_200_000), { id: "huge" })]));
    const shown = await s.cli(["show", "Huge"]);
    expect(shown.exitCode).not.toBe(0);
    expect(shown.stdout).toBe("");
    expect(shown.stderr).toContain("a bb command can print");
    expect(shown.stderr).toContain("bb sketch export");
  });
});

describe("bb sketch new, rename, duplicate and delete", () => {
  it("creates empty sketches with numbered names", async () => {
    const s = await setup();
    expect((await s.cli(["new"])).stdout).toBe(`Created “Untitled” (0 elements) in ${s.folder}.\n`);
    expect(sketchSummarySchema.parse(json((await s.cli(["new", "--json"])).stdout)).id).toBe("Untitled 2");
    expect((await s.cli(["new", "Billing", "flow"])).stdout).toContain("Created “Billing flow”");
    expect((await readdir(s.folder)).sort()).toEqual(["Billing flow.excalidraw", "Untitled 2.excalidraw", "Untitled.excalidraw"]);
  });

  it("creates a sketch from an .excalidraw file, named after it", async () => {
    const s = await setup();
    const work = await tempDir("sketch-cli-");
    await writeFile(path.join(work, "System map.excalidraw"), PLAN);
    expect((await s.cli(["new", "--file", path.join(work, "System map.excalidraw")])).stdout).toContain("Created “System map” (3 elements)");
    expect((await s.cli(["new", "Copy", "of", "map", "--file", "System map.excalidraw"], { cwd: work })).stdout).toContain("Created “Copy of map”");
    expect(await readFile(path.join(s.folder, "Copy of map.excalidraw"), "utf8")).toBe(PLAN);
  });

  it("creates a sketch from JSON passed inline", async () => {
    const s = await setup();
    expect((await s.cli(["new", "Inline", "--content", PLAN])).stdout).toContain("Created “Inline” (3 elements)");
    expect(json((await s.cli(["new", "Inline", "--content", PLAN, "--json"])).stdout)).toMatchObject({ id: "Inline 2", skipped: 0, placeholders: 0 });
  });

  it("says which elements it couldn't read", async () => {
    const s = await setup();
    const content = JSON.stringify({
      type: "excalidraw",
      elements: [rect(0, 0, 10, 10, { id: "a" }), { type: "rectangle", x: 1, y: 1 }, { id: "bad-arrow", type: "arrow", x: 0, y: 0, points: [[0, 0]] }],
    });
    const created = await s.cli(["new", "Rough", "--content", content]);
    expect(created.stdout).toBe(
      [
        `Created “Rough” (2 elements) in ${s.folder}.`,
        "Skipped 1 element Sketch can't read. Each element needs a unique id and numbers for x and y.",
        "Kept 1 element with fields Sketch can't read as a placeholder.",
        "",
      ].join("\n"),
    );
    expect(json((await s.cli(["new", "Rough", "--content", content, "--json"])).stdout)).toMatchObject({ skipped: 1, placeholders: 1 });
  });

  it("reads files saved with a byte order mark", async () => {
    const s = await setup();
    const work = await tempDir("sketch-cli-");
    await writeFile(path.join(work, "bom.excalidraw"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PLAN)]));
    expect((await s.cli(["new", "--file", path.join(work, "bom.excalidraw")])).stdout).toContain("Created “bom” (3 elements)");
    expect(await readFile(path.join(s.folder, "bom.excalidraw"), "utf8")).toBe(PLAN);
  });

  it("explains bad input files and writes nothing", async () => {
    const s = await setup();
    const work = await tempDir("sketch-cli-");
    await writeFile(path.join(work, "bad.excalidraw"), "{ not json");
    const bad = await s.cli(["new", "--file", path.join(work, "bad.excalidraw"), "--json"]);
    expect(errorEnvelope.parse(json(bad.stdout)).error).toEqual({ code: "invalid_content", message: "This isn't valid JSON.", hint: CONTENT_HINT });
    const inline = await s.cli(["new", "x", "--content", "nope", "--json"]);
    expect(errorEnvelope.parse(json(inline.stdout)).error).toEqual({ code: "invalid_content", message: "This isn't valid JSON.", hint: CONTENT_HINT });
    const missing = await s.cli(["new", "--file", path.join(work, "missing.excalidraw")]);
    expect(missing.stderr).toContain(`There's no file at ${path.join(work, "missing.excalidraw")}.`);
    const relative = await s.cli(["new", "--file", "bad.excalidraw"]);
    expect(relative.stderr).toContain("is relative, and this command doesn't know the current folder");
    const both = await s.cli(["new", "--file", "x", "--content", PLAN]);
    expect(both.exitCode).not.toBe(0);
    expect(await readdir(s.folder).catch(() => [])).toEqual([]);
  });

  it("renames, duplicates and deletes", async () => {
    const s = await setup();
    await seed(s, "Plan");
    await seed(s, "Other");
    expect((await s.cli(["rename", "plan", "Billing", "flow"])).stdout).toBe("Renamed “Plan” to “Billing flow”.\n");
    expect((await s.cli(["rename", "Billing flow", "OTHER"])).stderr).toContain("A sketch named “Other” already exists.");
    expect((await s.cli(["duplicate", "Billing"])).stdout).toBe("Copied “Billing flow” to “Billing flow copy”.\n");
    expect(sketchSummarySchema.parse(json((await s.cli(["cp", "Billing flow", "--json"])).stdout)).id).toBe("Billing flow copy 2");
    expect((await s.cli(["rm", "Billing flow copy 2"])).stdout).toBe("Deleted “Billing flow copy 2”.\n");
    expect((await s.cli(["delete", "Other", "--json"])).stdout).toBe('{"id":"Other"}\n');
    expect((await readdir(s.folder)).sort()).toEqual(["Billing flow copy.excalidraw", "Billing flow.excalidraw"]);
  });
});

describe("bb sketch export", () => {
  it("prints .excalidraw JSON and SVG", async () => {
    const s = await setup();
    await seed(s, "Plan");
    expect((await s.cli(["export", "Plan"])).stdout).toBe(PLAN);
    const svg = (await s.cli(["export", "Plan", "--format", "svg"])).stdout;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("@font-face");
    expect(svg).toContain("Billing");
    const asJson = z.object({ id: z.string(), format: z.literal("svg"), width: z.number(), height: z.number(), content: z.string() }).parse(
      json((await s.cli(["export", "Plan", "--format", "svg", "--json"])).stdout),
    );
    expect(asJson.content).toContain("<svg");
  });

  it("writes files, picking the format from the extension", async () => {
    const s = await setup();
    const work = await tempDir("sketch-out-");
    await withPreview(s, "Plan", fakePng(12, 8));
    expect((await s.cli(["export", "Plan", "--out", path.join(work, "plan.svg")])).stdout).toBe(`Wrote “Plan” as SVG to ${path.join(work, "plan.svg")}.\n`);
    expect(await readFile(path.join(work, "plan.svg"), "utf8")).toContain("<svg");
    const png = await s.cli(["export", "Plan", "--out", "plan.png", "--json"], { cwd: work });
    expect(json(png.stdout)).toEqual({ id: "Plan", format: "png", path: path.join(work, "plan.png"), sizeBytes: fakePng(12, 8).length, width: 12, height: 8 });
    expect(await readFile(path.join(work, "plan.png"))).toEqual(fakePng(12, 8));
    await mkdir(path.join(work, "exports"));
    await s.cli(["export", "Plan", "--format", "excalidraw", "--out", path.join(work, "exports")]);
    expect(await readFile(path.join(work, "exports", "Plan.excalidraw"), "utf8")).toBe(PLAN);
    const noFolder = await s.cli(["export", "Plan", "--out", path.join(work, "missing", "x.svg")]);
    expect(noFolder.stderr).toContain("doesn't exist");
    expect((await readdir(work)).sort()).toEqual(["exports", "plan.png", "plan.svg"]);
  });

  it("needs --out and an up-to-date image for PNG", async () => {
    const s = await setup();
    const work = await tempDir("sketch-out-");
    const sketch = await seed(s, "Plan");
    expect((await s.cli(["export", "Plan", "--format", "png"])).stderr).toContain("PNG export needs --out <path>");
    const missing = await s.cli(["export", "Plan", "--out", path.join(work, "a.png"), "--json"]);
    expect(errorEnvelope.parse(json(missing.stdout)).error).toMatchObject({ code: "no_image", message: "Open “Plan” in bb once so Sketch can draw its image." });
    await s.rpc("savePreview", { id: "Plan", sha256: sketch.sha256, png: fakePng().toString("base64") });
    await s.rpc("save", { id: "Plan", content: sceneText([]), expectedSha256: sketch.sha256 });
    expect((await s.cli(["export", "Plan", "--out", path.join(work, "a.png")])).stderr).toContain("Open “Plan” in bb once so Sketch can draw its image.");
    expect(await readdir(work)).toEqual([]);
  });

  it("quotes names with spaces in the commands it suggests", async () => {
    const s = await setup();
    await seed(s, "QA flow");
    await seed(s, "Plan");
    const png = errorEnvelope.parse(json((await s.cli(["export", "QA flow", "--format", "png", "--json"])).stdout)).error;
    expect(png.hint).toBe("Add --out with a file path, like --out '~/Desktop/QA flow.png'.");
    const plain = errorEnvelope.parse(json((await s.cli(["export", "Plan", "--format", "png", "--json"])).stdout)).error;
    expect(plain.hint).toBe("Add --out with a file path, like --out ~/Desktop/Plan.png.");
    expect(shellArg("it's")).toBe("'it'\\''s'");
  });

  it("infers the format from --out", () => {
    expect(formatFor(undefined, undefined)).toBe("excalidraw");
    expect(formatFor(undefined, "~/a.PNG")).toBe("png");
    expect(formatFor(undefined, "a.svg")).toBe("svg");
    expect(formatFor(undefined, "a.json")).toBe("excalidraw");
    expect(formatFor("svg", "a.png")).toBe("svg");
    expect(titleFromPath("/x/System map.excalidraw")).toBe("System map");
    expect(titleFromPath("C:\\x\\flow.excalidraw.json")).toBe("flow");
    expect(titleFromPath("/x/.excalidraw")).toBeNull();
  });
});

describe("bb sketch send", () => {
  it("sends the whole sketch to the inbox with its text as the caption", async () => {
    const s = await setup();
    await withPreview(s, "Plan");
    const sent = await s.cli(["send", "plan", "--inbox", "--note", "From the call"]);
    expect(sent.stdout).toBe("Sent “Plan” to the Wiki inbox as card_1a2b3c4d. Review it there to pick where it goes.\n");
    expect(s.wiki.calls.at(-1)).toMatchObject({
      method: "addCard",
      input: { name: "Plan.png", text: "From the call", media: [{ caption: "Billing flow · v2" }], target: null, heading: null, threadId: null },
      mediaBytes: fakePng(10, 6),
    });
    expect(json((await s.cli(["send", "Plan", "--inbox", "--caption", "Custom", "--json"])).stdout)).toEqual({
      sketch: "Plan",
      kind: "inbox",
      cardId: "card_1a2b3c4d",
      heading: null,
    });
    expect(s.wiki.calls.at(-1)?.input).toMatchObject({ media: [{ caption: "Custom" }] });
  });

  it("adds to a doc matched by slug, title, alias, or Title#Heading", async () => {
    const s = await setup();
    await withPreview(s, "Plan");
    expect((await s.cli(["send", "Plan", "--doc", "architecture"])).stdout).toBe("Added “Plan” to Architecture › Unsorted (architecture).\n");
    expect(s.wiki.calls.at(-1)).toMatchObject({ method: "addToDoc", input: { target: { kind: "existing", slug: "architecture" }, heading: "Unsorted" } });
    await s.cli(["send", "Plan", "--doc", "ARCH", "--heading", "Diagrams"]);
    expect(s.wiki.calls.at(-1)?.input).toMatchObject({ heading: "Diagrams", source: { kind: "upload", name: "Plan.png" } });
    await s.cli(["send", "Plan", "--doc", "Architecture#Overview"]);
    expect(s.wiki.calls.at(-1)?.input).toMatchObject({ heading: "Overview" });
    await s.cli(["send", "Plan", "--doc", "billing2"]);
    expect(s.wiki.calls.at(-1)?.input).toMatchObject({ target: { slug: "notes/billing-v2" } });
  });

  it("files a card that proposes the doc when run from a thread", async () => {
    const s = await setup();
    await withPreview(s, "Plan");
    const sent = await s.cli(["send", "Plan", "--doc", "Architecture", "--heading", "Diagrams"], { threadId: "thr_agent" });
    expect(sent.stdout).toBe("Sent “Plan” to the Wiki inbox as card_1a2b3c4d, proposed for Architecture › Diagrams. The user reviews it there.\n");
    expect(s.wiki.calls.at(-1)).toMatchObject({
      method: "addCard",
      input: { target: { kind: "existing", slug: "architecture" }, heading: "Diagrams", threadId: "thr_agent" },
    });
    expect(s.wiki.calls.some((call) => call.method === "addToDoc")).toBe(false);
    await s.cli(["send", "Plan", "--inbox"], { threadId: "thr_agent" });
    expect(s.wiki.calls.at(-1)?.input).toMatchObject({ target: null, threadId: "thr_agent" });
  });

  it("explains a doc that doesn't match, a missing image, and a missing Wiki", async () => {
    const s = await setup();
    await seed(s, "Draft");
    await withPreview(s, "Plan");
    expect((await s.cli(["send", "Plan", "--doc", "Nothing"])).stderr).toContain("No Wiki doc matches “Nothing”.");
    expect((await s.cli(["send", "Plan", "--doc", "notes/billing", "--heading", " "])).stderr).toContain("heading");
    expect((await s.cli(["send", "Draft", "--inbox"])).stderr).toContain("Open “Draft” in bb once so Sketch can draw its image.");
    expect((await s.cli(["send", "Plan"])).exitCode).not.toBe(0);
    expect((await s.cli(["send", "Plan", "--inbox", "--heading", "X"])).exitCode).not.toBe(0);

    const off = await setup({ wiki: createWikiFake({}, { plugins: [{ id: "wiki", status: "disabled", enabled: false }] }) });
    await withPreview(off, "Plan");
    const failed = await off.cli(["send", "Plan", "--doc", "architecture", "--json"]);
    expect(errorEnvelope.parse(json(failed.stdout)).error).toMatchObject({ code: "wiki_unavailable", message: "The Wiki plugin is turned off." });
  });

  it("stops early when the Wiki can't take inbox cards", async () => {
    const s = await setup({ wiki: createWikiFake({}, { missing: ["addCard"] }) });
    await seed(s, "Draft");
    await withPreview(s, "Plan");
    const failed = await s.cli(["send", "Plan", "--inbox", "--json"]);
    expect(errorEnvelope.parse(json(failed.stdout)).error).toEqual({
      code: "wiki_no_inbox",
      message: "This Wiki version can't take inbox cards yet. Update the Wiki plugin, or pick a doc.",
      hint: "Pass --doc <doc> to add it to a Wiki doc instead.",
    });
    expect((await s.cli(["send", "Draft", "--inbox"])).stderr).toContain("can't take inbox cards yet");
    const threaded = await s.cli(["send", "Plan", "--doc", "architecture", "--json"], { threadId: "thr_agent" });
    expect(errorEnvelope.parse(json(threaded.stdout)).error).toEqual({
      code: "wiki_no_inbox",
      message: "This Wiki version can't take inbox cards yet, and from a thread --doc files an inbox card too. Update the Wiki plugin.",
      hint: "Ask the user to update the Wiki plugin.",
    });
    expect((await s.cli(["send", "Plan", "--doc", "architecture"])).stdout).toContain("Added “Plan” to Architecture");
    expect(s.wiki.calls.map((call) => call.method)).toEqual(["docs", "addToDoc"]);
    expect(await readdir(path.join(s.dataDir, "outbox")).catch(() => [])).toEqual([]);
  });
});

describe("files on the thread's machine", () => {
  const remoteSdk = (primaryHostId: string, writes: unknown[]) => ({
    threads: { get: async () => ({ id: "thr_remote", environmentId: "env_1" }) },
    environments: { get: async () => ({ id: "env_1", hostId: "host_remote" }) },
    system: { config: async () => ({ primaryHostId }) },
    files: {
      write: async (args: unknown) => {
        writes.push(args);
        return { outcome: "written", sha256: "0".repeat(64), sizeBytes: 1 };
      },
      read: async () => ({ content: Buffer.from(PLAN).toString("base64"), contentEncoding: "base64", path: "/remote/plan.excalidraw", sha256: "0".repeat(64), sizeBytes: 1 }),
    },
  });

  it("reads and writes through the host when the thread runs on another machine", async () => {
    const writes: unknown[] = [];
    const s = await setup({ sdk: remoteSdk("host_server", writes) });
    await seed(s, "Plan");
    const exported = await s.cli(["export", "Plan", "--out", "out/plan.svg"], { threadId: "thr_remote", cwd: "/home/dev/repo" });
    expect(exported.stdout).toBe("Wrote “Plan” as SVG to /home/dev/repo/out/plan.svg.\n");
    const write = z
      .object({ hostId: z.string(), path: z.string(), content: z.string(), contentEncoding: z.literal("base64"), createParents: z.literal(false) })
      .parse(writes[0]);
    expect(write).toMatchObject({ hostId: "host_remote", path: "/home/dev/repo/out/plan.svg" });
    expect(Buffer.from(write.content, "base64").toString("utf8")).toContain("<svg");
    expect((await s.cli(["export", "Plan", "--out", "~/plan.svg"], { threadId: "thr_remote" })).stderr).toContain("~/ can't be expanded");
    expect((await s.cli(["new", "Remote", "--file", "/remote/plan.excalidraw"], { threadId: "thr_remote" })).stdout).toContain("Created “Remote” (3 elements)");
  });

  it("uses this machine's disk when the thread runs here", async () => {
    const writes: unknown[] = [];
    const s = await setup({ sdk: remoteSdk("host_remote", writes) });
    await seed(s, "Plan");
    const work = await tempDir("sketch-local-");
    await s.cli(["export", "Plan", "--out", "plan.svg"], { threadId: "thr_local", cwd: work });
    expect(writes).toEqual([]);
    expect(await readFile(path.join(work, "plan.svg"), "utf8")).toContain("<svg");
  });
});
