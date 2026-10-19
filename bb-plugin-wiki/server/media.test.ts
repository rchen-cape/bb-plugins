import { mkdir, mkdtemp, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createWikiContext } from "./context";
import {
  MediaError,
  cleanUploadName,
  cleanupUploads,
  embedFor,
  extractMediaPaths,
  formatBytes,
  importUpload,
  messageMedia,
  resolveMediaSource,
  saveUpload,
  uploadPath,
  uploadsDir,
} from "./media";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new Blob(chunks).stream();
}

async function setup(message?: unknown) {
  const wiki = await tempDir("wiki-media-");
  const host = createFakePluginHost({
    pluginId: "wiki",
    settings: { wikiDirectory: wiki },
    sdk: { threads: { message: async () => message } },
  });
  const ctx = await createWikiContext(host.bb);
  return { ctx, harness: host.harness, wiki };
}

async function rejection(work: Promise<unknown>): Promise<MediaError> {
  const error: unknown = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof MediaError)) throw new Error(`expected a MediaError, got ${String(error)}`);
  return error;
}

describe("uploads", () => {
  it("streams an upload to the data folder and imports it", async () => {
    const { ctx } = await setup();
    const saved = await saveUpload(ctx, "Design notes.md", stream("# Design\n", "Token bucket per tenant.\n"), null);
    expect(saved).toMatchObject({ name: "Design notes.md", sizeBytes: 34 });
    expect(saved.uploadId).toMatch(/^upl_[a-z0-9]{12}$/);
    const file = await uploadPath(ctx, saved.uploadId);
    expect(file).toBe(path.join(uploadsDir(ctx), `${saved.uploadId}.md`));
    expect(await importUpload(ctx, saved.uploadId)).toEqual({
      uploadId: saved.uploadId,
      name: "Design notes.md",
      kind: "markdown",
      sizeBytes: 34,
      text: "# Design\nToken bucket per tenant.\n",
    });
  });

  it("keeps only the base name and returns no text for media", async () => {
    const { ctx } = await setup();
    const saved = await saveUpload(ctx, "../../etc/shot.PNG", stream("png-bytes"), 9);
    expect(saved.name).toBe("shot.PNG");
    expect(await importUpload(ctx, saved.uploadId)).toMatchObject({ kind: "image", text: null, sizeBytes: 9 });
    expect(await uploadPath(ctx, saved.uploadId)).toMatch(/\.png$/);
  });

  it("accepts an empty body", async () => {
    const { ctx } = await setup();
    const saved = await saveUpload(ctx, "empty.txt", null, 0);
    expect(await importUpload(ctx, saved.uploadId)).toMatchObject({ kind: "text", text: "", sizeBytes: 0 });
  });

  it("rejects unsupported and nameless files before writing", async () => {
    const { ctx } = await setup();
    expect((await rejection(saveUpload(ctx, "run.sh", stream("echo"), 4))).code).toBe("unsupported");
    expect((await rejection(saveUpload(ctx, "  ", stream("x"), 1))).code).toBe("invalid-name");
    expect((await rejection(saveUpload(ctx, "folder/", stream("x"), 1))).code).toBe("invalid-name");
    expect(await readdir(uploadsDir(ctx)).catch(() => [])).toEqual([]);
  });

  it("refuses a declared length over the cap without reading the body", async () => {
    const { ctx } = await setup();
    const body = stream("x".repeat(2048));
    const error = await rejection(saveUpload(ctx, "big.mp4", body, 2048, { limitBytes: 1024 }));
    expect(error.code).toBe("too-large");
    expect(error.message).toBe("big.mp4 is larger than the 1 KB upload limit.");
    expect(body.locked).toBe(false);
    expect(await readdir(uploadsDir(ctx)).catch(() => [])).toEqual([]);
  });

  it("stops a stream that grows past the cap and leaves nothing behind", async () => {
    const { ctx } = await setup();
    const error = await rejection(saveUpload(ctx, "clip.mov", stream("0123456789", "0123456789"), null, { limitBytes: 15 }));
    expect(error.code).toBe("too-large");
    expect(await readdir(uploadsDir(ctx))).toEqual([]);
  });

  it("treats unknown, malformed, and half-written uploads as gone", async () => {
    const { ctx } = await setup();
    expect((await rejection(importUpload(ctx, "upl_000000000000"))).code).toBe("missing");
    expect(await uploadPath(ctx, "../secrets")).toBeNull();
    await mkdir(uploadsDir(ctx), { recursive: true });
    await writeFile(path.join(uploadsDir(ctx), "upl_aaaaaaaaaaaa.png"), "orphan");
    expect(await uploadPath(ctx, "upl_aaaaaaaaaaaa")).toBeNull();
    await writeFile(path.join(uploadsDir(ctx), "upl_bbbbbbbbbbbb.json"), "{not json");
    expect(await uploadPath(ctx, "upl_bbbbbbbbbbbb")).toBeNull();
  });

  it("refuses text files too long to add as text", async () => {
    const { ctx } = await setup();
    const saved = await saveUpload(ctx, "huge.txt", stream("x".repeat(500_001)), null);
    expect((await rejection(importUpload(ctx, saved.uploadId))).code).toBe("too-large");
  });

  it("removes uploads older than a day and leaves other files", async () => {
    const { ctx } = await setup();
    const old = await saveUpload(ctx, "old.png", stream("old"), 3);
    const fresh = await saveUpload(ctx, "new.png", stream("new"), 3);
    const folder = uploadsDir(ctx);
    await writeFile(path.join(folder, "keep-me.txt"), "not an upload");
    const past = new Date(Date.now() - 25 * 60 * 60_000);
    for (const name of await readdir(folder)) {
      if (name.startsWith(old.uploadId) || name === "keep-me.txt") await utimes(path.join(folder, name), past, past);
    }
    expect(await cleanupUploads(ctx)).toBe(1);
    expect(await uploadPath(ctx, old.uploadId)).toBeNull();
    expect(await uploadPath(ctx, fresh.uploadId)).not.toBeNull();
    expect((await readdir(folder)).sort()).toEqual([`${fresh.uploadId}.json`, `${fresh.uploadId}.png`, "keep-me.txt"].sort());
  });

  it("cleans up nothing when there is no uploads folder", async () => {
    const { ctx } = await setup();
    expect(await cleanupUploads(ctx)).toBe(0);
  });
});

describe("names and sizes", () => {
  it("strips folders and control characters from names", () => {
    expect(cleanUploadName("C:\\Users\\me\\a\u0007b.png")).toBe("ab.png");
    expect(cleanUploadName("  spaced   out.mp4 ")).toBe("spaced out.mp4");
  });

  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("extractMediaPaths", () => {
  it("finds absolute media paths, quoted or bare", () => {
    const text = [
      "Screenshot at /Users/me/Desktop/shot.png, and the clip:",
      "![demo](/tmp/demo.MP4)",
      'Quoted: "/Users/me/My Files/plan.md".',
      "`/var/folders/x/notes.txt`",
    ].join("\n");
    expect(extractMediaPaths(text).sort()).toEqual(
      ["/Users/me/Desktop/shot.png", "/tmp/demo.MP4", "/Users/me/My Files/plan.md", "/var/folders/x/notes.txt"].sort(),
    );
  });

  it("ignores URLs, relative and home paths, and other extensions", () => {
    const text = "https://example.test/a.png file:///tmp/b.png ~/c.png ./d.png e/f.png /tmp/g.pdf /tmp/h.md5 /tmp/i.png.bak";
    expect(extractMediaPaths(text)).toEqual([]);
  });
});

describe("messageMedia", () => {
  it("returns only referenced media files that exist", async () => {
    const files = await tempDir("wiki-message-");
    const image = path.join(files, "shot.png");
    const video = path.join(files, "demo.mp4");
    const doc = path.join(files, "notes.md");
    await writeFile(image, "png");
    await writeFile(video, "mp4-bytes");
    await writeFile(doc, "# Notes");
    await mkdir(path.join(files, "folder.png"));
    await writeFile(path.join(files, "unreferenced.png"), "secret");
    const message = {
      message: {
        text: `See ${video} and ${image} plus ${path.join(files, "missing.png")} and ${path.join(files, "folder.png")}.`,
        attachments: {
          localImagePaths: [image, "relative/shot.png"],
          localFilePaths: [doc, path.join(files, "script.sh")],
          localFileDetails: [{ path: doc, name: "Meeting notes.md", sizeBytes: 7 }],
        },
      },
      before: [],
      after: [],
    };
    const { ctx, harness } = await setup(message);
    const items = await messageMedia(ctx, "thr_1", 4);
    expect(items).toEqual([
      { path: image, name: "shot.png", kind: "image", sizeBytes: 3 },
      { path: doc, name: "Meeting notes.md", kind: "markdown", sizeBytes: 7 },
      { path: video, name: "demo.mp4", kind: "video", sizeBytes: 9 },
    ]);
    expect(harness.sdk.callsTo("threads.message")).toEqual([[{ threadId: "thr_1", seq: 4 }]]);
  });

  it("handles messages without attachments", async () => {
    const { ctx } = await setup({ message: { text: "nothing here", attachments: null }, before: [], after: [] });
    expect(await messageMedia(ctx, "thr_1", 1)).toEqual([]);
  });

  it("reports an unreadable message", async () => {
    const { ctx } = await setup({ unexpected: true });
    await expect(messageMedia(ctx, "thr_1", 1)).rejects.toThrow("Could not read message 1 in thread thr_1.");
  });
});

describe("resolveMediaSource", () => {
  it("resolves uploads to their file and original name", async () => {
    const { ctx } = await setup();
    const saved = await saveUpload(ctx, "Whiteboard.jpg", stream("jpg"), 3);
    expect(await resolveMediaSource(ctx, { kind: "upload", uploadId: saved.uploadId })).toEqual({
      path: await uploadPath(ctx, saved.uploadId),
      name: "Whiteboard.jpg",
      kind: "image",
      sizeBytes: 3,
    });
  });

  it("checks paths: absolute, a media type, existing, a file", async () => {
    const { ctx } = await setup();
    const files = await tempDir("wiki-resolve-");
    await writeFile(path.join(files, "a.webm"), "webm");
    await writeFile(path.join(files, "a.exe"), "exe");
    await mkdir(path.join(files, "dir.png"));
    expect(await resolveMediaSource(ctx, { kind: "path", path: path.join(files, "a.webm") })).toMatchObject({ kind: "video", name: "a.webm" });
    expect((await rejection(resolveMediaSource(ctx, { kind: "path", path: "a.webm" }))).code).toBe("invalid-path");
    expect((await rejection(resolveMediaSource(ctx, { kind: "path", path: path.join(files, "a.exe") }))).code).toBe("unsupported");
    expect((await rejection(resolveMediaSource(ctx, { kind: "path", path: path.join(files, "b.png") }))).code).toBe("missing");
    expect((await rejection(resolveMediaSource(ctx, { kind: "path", path: path.join(files, "dir.png") }))).code).toBe("invalid-path");
    expect((await rejection(resolveMediaSource(ctx, { kind: "upload", uploadId: "upl_000000000000" }))).code).toBe("missing");
  });
});

describe("embedFor", () => {
  it("embeds images with the caption as alt text", () => {
    expect(embedFor("assets/shot-1a2b3c4d.png", "image", " Rate [limit]\n chart ")).toBe("![Rate \\[limit\\] chart](assets/shot-1a2b3c4d.png)");
    expect(embedFor("assets/shot.png", "image", "")).toBe("![](assets/shot.png)");
  });

  it("embeds videos with the caption on its own line", () => {
    expect(embedFor("assets/demo.mp4", "video", "")).toBe('<video controls src="assets/demo.mp4"></video>');
    expect(embedFor("assets/demo.mp4", "video", "Demo of the retry flow")).toBe(
      '<video controls src="assets/demo.mp4"></video>\n\nDemo of the retry flow',
    );
  });
});
