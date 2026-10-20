import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createWikiContext } from "./context";
import { ASSET_PATH, CARD_MEDIA_PATH, UPLOAD_PATH, declaredLength, isServablePath, parseRange, registerHttp } from "./http";
import { cardMediaDir, importUpload, uploadsDir } from "./media";

const VIDEO = "0123456789abcdefghij";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function setup(uploadLimitBytes?: number) {
  const wiki = await tempDir("wiki-http-");
  await mkdir(path.join(wiki, "assets"), { recursive: true });
  await mkdir(path.join(wiki, ".git"), { recursive: true });
  await mkdir(path.join(wiki, "media"), { recursive: true });
  await writeFile(path.join(wiki, "assets", "demo.mp4"), VIDEO);
  await writeFile(path.join(wiki, "assets", "shot.png"), "png");
  await writeFile(path.join(wiki, "assets", "page.html"), "<script>alert(1)</script>");
  await writeFile(path.join(wiki, "assets", "readme.md"), "# not an asset");
  await writeFile(path.join(wiki, "media", "chart.webp"), "webp");
  await writeFile(path.join(wiki, "global-token.md"), "# Global token\n");
  await writeFile(path.join(wiki, "notes.txt"), "plain");
  await writeFile(path.join(wiki, ".git", "config"), "[core]");
  const outside = await tempDir("wiki-outside-");
  await writeFile(path.join(outside, "secret.png"), "secret");
  await symlink(path.join(outside, "secret.png"), path.join(wiki, "assets", "escape.png"));
  await symlink(path.join(wiki, "global-token.md"), path.join(wiki, "assets", "doc.png"));
  const host = createFakePluginHost({ pluginId: "wiki", settings: { wikiDirectory: wiki } });
  const ctx = await createWikiContext(host.bb);
  registerHttp(ctx, uploadLimitBytes === undefined ? {} : { uploadLimitBytes });
  const asset = (relPath: string, headers: Record<string, string> = {}) =>
    host.harness.behavior.fetchHttp("GET", `${ASSET_PATH}?path=${encodeURIComponent(relPath)}`, { headers });
  const upload = (name: string, body: BodyInit | null, headers: Record<string, string> = {}) => {
    const init = { body, headers, duplex: "half" };
    return host.harness.behavior.fetchHttp("POST", `${UPLOAD_PATH}?name=${encodeURIComponent(name)}`, init);
  };
  return { ctx, host, wiki, asset, upload };
}

describe("parseRange", () => {
  it.each([
    ["bytes=0-4", { kind: "partial", start: 0, end: 4 }],
    ["bytes=5-", { kind: "partial", start: 5, end: 19 }],
    ["bytes=-5", { kind: "partial", start: 15, end: 19 }],
    ["bytes=-50", { kind: "partial", start: 0, end: 19 }],
    ["bytes=10-500", { kind: "partial", start: 10, end: 19 }],
    ["BYTES=1-1", { kind: "partial", start: 1, end: 1 }],
  ])("reads %s", (header, expected) => {
    expect(parseRange(header, 20)).toEqual(expected);
  });

  it.each(["bytes=20-", "bytes=25-30", "bytes=-0"])("refuses %s on a 20-byte file", (header) => {
    expect(parseRange(header, 20)).toEqual({ kind: "unsatisfiable" });
  });

  it.each([undefined, null, "", "bytes=", "bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=5-2", "bytes=a-b", "bytes=99999999999999999999-"])(
    "serves the whole file for %j",
    (header) => {
      expect(parseRange(header, 20)).toEqual({ kind: "full" });
    },
  );

  it("cannot satisfy any range of an empty file", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("isServablePath", () => {
  it("serves assets and media files, never docs or hidden files", () => {
    expect(isServablePath("assets/shot.png")).toBe(true);
    expect(isServablePath("assets/sub/page.html")).toBe(true);
    expect(isServablePath("media/chart.webp")).toBe(true);
    expect(isServablePath("assets/readme.md")).toBe(false);
    expect(isServablePath("global-token.md")).toBe(false);
    expect(isServablePath("notes.txt")).toBe(false);
    expect(isServablePath(".git/config")).toBe(false);
    expect(isServablePath(".wiki/tags.json")).toBe(false);
    expect(isServablePath("../x.png")).toBe(false);
    expect(isServablePath("/etc/x.png")).toBe(false);
    expect(isServablePath("assets")).toBe(false);
  });
});

describe("declaredLength", () => {
  it("reads only plain non-negative integers", () => {
    expect(declaredLength("42")).toBe(42);
    expect(declaredLength(undefined)).toBeNull();
    expect(declaredLength("-1")).toBeNull();
    expect(declaredLength("1e3")).toBeNull();
  });
});

describe("GET /asset", () => {
  it("serves a whole asset with safe headers", async () => {
    const { asset } = await setup();
    const response = await asset("assets/shot.png");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="shot.png"/);
  });

  it("answers a byte range with 206", async () => {
    const { asset } = await setup();
    const response = await asset("assets/demo.mp4", { range: "bytes=5-9" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 5-9/20");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("56789");
    const tail = await asset("assets/demo.mp4", { range: "bytes=-3" });
    expect(await tail.text()).toBe("hij");
  });

  it("streams files larger than one chunk", async () => {
    const { asset, wiki } = await setup();
    const big = Buffer.alloc(1024 * 1024 * 2 + 17, 7);
    big[big.length - 1] = 9;
    await writeFile(path.join(wiki, "assets", "big.webm"), big);
    const whole = Buffer.from(await (await asset("assets/big.webm")).arrayBuffer());
    expect(whole.equals(big)).toBe(true);
    const tail = await asset("assets/big.webm", { range: `bytes=${big.length - 2}-` });
    expect([...Buffer.from(await tail.arrayBuffer())]).toEqual([7, 9]);
  });

  it("serves an empty asset", async () => {
    const { asset, wiki } = await setup();
    await writeFile(path.join(wiki, "assets", "empty.png"), "");
    const response = await asset("assets/empty.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });

  it("answers 404 when the Wiki folder is gone", async () => {
    const { asset, host, wiki } = await setup();
    await host.harness.behavior.setSettings({ wikiDirectory: path.join(wiki, "missing") });
    expect((await asset("assets/shot.png")).status).toBe(404);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const { asset } = await setup();
    const response = await asset("assets/demo.mp4", { range: "bytes=40-" });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */20");
  });

  it("serves media outside assets and unknown asset types as downloads", async () => {
    const { asset } = await setup();
    expect((await asset("media/chart.webp")).headers.get("content-type")).toBe("image/webp");
    const html = await asset("assets/page.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
  });

  it.each(["../x.png", "assets/../../x.png", ".git/config", "global-token.md", "assets/readme.md", "notes.txt", ".wiki/tags.json", "assets/missing.png", "assets", "assets/escape.png", "assets/doc.png"])(
    "returns 404 for %s",
    async (relPath) => {
      const { asset } = await setup();
      const response = await asset(relPath);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Asset not found." });
    },
  );

  it("asks for a path when none is given", async () => {
    const { host } = await setup();
    expect((await host.harness.behavior.fetchHttp("GET", ASSET_PATH)).status).toBe(400);
  });
});

describe("POST /upload", () => {
  it("stores the body and returns the upload", async () => {
    const { ctx, upload } = await setup();
    const response = await upload("Plan.md", "# Plan\nShip it.\n", { "content-type": "text/markdown" });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ name: "Plan.md", sizeBytes: 16 });
    const uploadId = typeof body === "object" && body !== null && "uploadId" in body ? String(body.uploadId) : "";
    expect(await importUpload(ctx, uploadId)).toMatchObject({ kind: "markdown", text: "# Plan\nShip it.\n" });
  });

  it("refuses a declared size over the cap with 413", async () => {
    const { ctx, upload } = await setup(10);
    const response = await upload("clip.mp4", "tiny", { "content-length": "4096" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "clip.mp4 is larger than the 10 bytes upload limit." });
    expect(await readdir(uploadsDir(ctx)).catch(() => [])).toEqual([]);
  });

  it("stops a body that streams past the cap with 413", async () => {
    const { ctx, upload } = await setup(10);
    const chunks = ["01234", "56789", "abcde"];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const response = await upload("clip.mp4", body);
    expect(response.status).toBe(413);
    expect(await readdir(uploadsDir(ctx))).toEqual([]);
  });

  it("refuses unsupported types and missing names", async () => {
    const { host, upload } = await setup();
    expect((await upload("tool.exe", "MZ")).status).toBe(415);
    const nameless = await host.harness.behavior.fetchHttp("POST", UPLOAD_PATH, { body: "x" });
    expect(nameless.status).toBe(400);
  });
});

describe("GET /card-media", () => {
  const CARD = "card_1a2b3c4d";

  async function cardMediaSetup() {
    const base = await setup();
    const folder = path.join(cardMediaDir(base.ctx), CARD);
    await mkdir(path.join(folder, "sub"), { recursive: true });
    await writeFile(path.join(folder, "roadmap.png"), "PNGDATA");
    await writeFile(path.join(folder, "notes.md"), "# notes");
    await writeFile(path.join(folder, ".hidden.png"), "hidden");
    await writeFile(path.join(folder, "sub", "deep.png"), "deep");
    const outside = await tempDir("wiki-card-outside-");
    await writeFile(path.join(outside, "secret.png"), "secret");
    await symlink(path.join(outside, "secret.png"), path.join(folder, "escape.png"));
    await mkdir(uploadsDir(base.ctx), { recursive: true });
    await writeFile(path.join(uploadsDir(base.ctx), "upl_aaaaaaaaaaaa.png"), "upload");
    const image = (relPath: string, headers: Record<string, string> = {}) =>
      base.host.harness.behavior.fetchHttp("GET", `${CARD_MEDIA_PATH}?path=${encodeURIComponent(relPath)}`, { headers });
    return { ...base, folder, outside, image };
  }

  it("serves a card's image inline with its image type", async () => {
    const { image } = await cardMediaSetup();
    const response = await image(`card-media/${CARD}/roadmap.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain('inline; filename="roadmap.png"');
    expect(await response.text()).toBe("PNGDATA");
    const partial = await image(`card-media/${CARD}/roadmap.png`, { range: "bytes=0-2" });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("PNG");
  });

  it.each([
    "../x.png",
    "card-media/../uploads/upl_aaaaaaaaaaaa.png",
    `card-media/${CARD}/../../uploads/upl_aaaaaaaaaaaa.png`,
    "uploads/upl_aaaaaaaaaaaa.png",
    "assets/shot.png",
    `card-media/${CARD}/notes.md`,
    `card-media/${CARD}/.hidden.png`,
    `card-media/${CARD}/sub/deep.png`,
    `card-media/${CARD}/escape.png`,
    `card-media/${CARD}/missing.png`,
    `card-media/${CARD}`,
    "card-media/not-a-card/roadmap.png",
    `/card-media/${CARD}/roadmap.png`,
  ])("returns 404 for %s", async (relPath) => {
    const { image } = await cardMediaSetup();
    const response = await image(relPath);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Image not found." });
  });

  it("refuses an absolute path to a real image, and asks for a path when none is given", async () => {
    const { host, image, outside } = await cardMediaSetup();
    expect((await image(path.join(outside, "secret.png"))).status).toBe(404);
    expect((await host.harness.behavior.fetchHttp("GET", CARD_MEDIA_PATH)).status).toBe(400);
  });
});
