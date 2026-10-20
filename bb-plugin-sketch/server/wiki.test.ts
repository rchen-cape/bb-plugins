import { mkdir, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sendResultSchema, statusSchema } from "../contract";
import { sweepOutbox } from "./outbox";
import { createInboxCheck, INBOX_RECHECK_MS, probeVerdict } from "./wiki-inbox";
import {
  createWikiFake,
  fakePng,
  FakeHttpError,
  handlerError,
  invalidInput,
  notRunning,
  setup,
  unknownMethod,
  WIKI_CARD,
  WIKI_DOCS,
  type Setup,
} from "./test-support";
import {
  WIKI_NO_INBOX,
  WIKI_NO_INBOX_THREAD,
  WIKI_NOT_INSTALLED,
  WIKI_NOT_RUNNING,
  WIKI_SEND_TIMEOUT,
  WIKI_TIMEOUT,
  WIKI_TURNED_OFF,
  wikiFailure,
} from "./wiki-errors";

const PNG = fakePng(6, 4);

function sendInput(destination: unknown, name = "Plan") {
  return { name, png: PNG.toString("base64"), caption: "Billing flow", note: "From the planning call.", destination };
}

async function outboxEntries(dataDir: string): Promise<string[]> {
  return readdir(path.join(dataDir, "outbox")).catch(() => []);
}

const probeSchema = z.tuple([z.object({ method: z.literal("addCard"), input: z.object({}).strict() })]);

function probes(s: Setup): number {
  return s.host.harness.inspection.sdk.callsTo("plugins.callRpc").filter((args) => probeSchema.safeParse(args).success).length;
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

describe("Wiki availability", () => {
  it("comes from the plugin list", async () => {
    const cases: [{ id: string; status: string; enabled: boolean }[], string][] = [
      [[], WIKI_NOT_INSTALLED],
      [[{ id: "library", status: "running", enabled: true }], WIKI_NOT_INSTALLED],
      [[{ id: "wiki", status: "disabled", enabled: false }], WIKI_TURNED_OFF],
      [[{ id: "wiki", status: "running", enabled: false }], WIKI_TURNED_OFF],
      [[{ id: "wiki", status: "error", enabled: true }], WIKI_NOT_RUNNING],
      [[{ id: "wiki", status: "needs-configuration", enabled: true }], WIKI_NOT_RUNNING],
    ];
    for (const [plugins, reason] of cases) {
      const { rpc, wiki } = await setup({ wiki: createWikiFake({}, { plugins }) });
      expect(statusSchema.parse(await rpc("status", {})).wiki).toEqual({ available: false, reason });
      expect(await rpc("wikiDocs", {})).toEqual({ wiki: { available: false, reason }, docs: [] });
      expect(wiki.calls).toEqual([]);
    }
    const degraded = await setup({ wiki: createWikiFake({}, { plugins: [{ id: "wiki", status: "degraded", enabled: true }] }) });
    expect(statusSchema.parse(await degraded.rpc("status", {})).wiki).toEqual({ available: true, inbox: true });
  });

  it("says so when the plugin list can't be read", async () => {
    const { rpc, host } = await setup();
    host.harness.inspection.sdk.stub("plugins.list", async () => {
      throw new Error("server busy");
    });
    expect(statusSchema.parse(await rpc("status", {})).wiki).toEqual({ available: false, reason: "Couldn't check the Wiki plugin: server busy" });
  });

  it("lists Wiki docs with their headings", async () => {
    const { rpc, wiki } = await setup();
    expect(await rpc("wikiDocs", {})).toEqual({
      wiki: { available: true, inbox: true },
      docs: WIKI_DOCS.map(({ slug, title, type, aliases, tag, headings }) => ({ slug, title, type, aliases, tag, headings })),
    });
    expect(wiki.calls).toEqual([{ method: "docs", input: { type: null }, mediaPath: null, mediaBytes: null }]);
  });

  it("probes addCard with an empty input to tell whether the Wiki takes inbox cards", async () => {
    const current = await setup();
    expect(statusSchema.parse(await current.rpc("status", {})).wiki).toEqual({ available: true, inbox: true });
    expect(current.wiki.rejected).toEqual([{ method: "addCard", input: {} }]);
    expect(current.wiki.calls).toEqual([]);

    const old = await setup({ wiki: createWikiFake({}, { missing: ["addCard"] }) });
    expect(statusSchema.parse(await old.rpc("status", {})).wiki).toEqual({ available: true, inbox: false });
    expect(await old.rpc("wikiDocs", {})).toMatchObject({ wiki: { available: true, inbox: false } });
    expect(old.wiki.calls.map((call) => call.method)).toEqual(["docs"]);
  });

  it("remembers inbox support until the Wiki plugin changes", async () => {
    const s = await setup();
    await s.rpc("status", {});
    await s.rpc("wikiDocs", {});
    expect(probes(s)).toBe(1);
    s.wiki.plugins = [{ id: "wiki", status: "running", enabled: true, version: "0.2.0" }];
    await s.rpc("status", {});
    expect(probes(s)).toBe(2);
  });

  it("assumes inbox cards work when the probe fails for another reason, and asks again next time", async () => {
    const s = await setup();
    s.host.harness.inspection.sdk.stub("plugins.callRpc", async () => {
      throw handlerError("busy");
    });
    expect(statusSchema.parse(await s.rpc("status", {})).wiki).toEqual({ available: true, inbox: true });
    await s.rpc("status", {});
    expect(probes(s)).toBe(2);
  });

  it("learns that inbox cards stopped working from a real send", async () => {
    let card = true;
    const { rpc } = await setup({
      wiki: createWikiFake({
        addCard: () => {
          if (card) return WIKI_CARD;
          throw unknownMethod("addCard");
        },
      }),
    });
    expect(statusSchema.parse(await rpc("status", {})).wiki).toEqual({ available: true, inbox: true });
    card = false;
    await expect(rpc("sendToWiki", sendInput({ kind: "inbox" }))).rejects.toThrow(WIKI_NO_INBOX);
    expect(statusSchema.parse(await rpc("status", {})).wiki).toEqual({ available: true, inbox: false });
  });

  it("reports a Wiki that fails to list its docs as unavailable", async () => {
    const { rpc } = await setup({
      wiki: createWikiFake({
        docs: () => {
          throw notRunning("starting");
        },
      }),
    });
    expect(await rpc("wikiDocs", {})).toEqual({ wiki: { available: false, reason: WIKI_NOT_RUNNING }, docs: [] });
  });

  it("maps the top five suggestions and stays quiet when the Wiki fails", async () => {
    const { rpc, wiki } = await setup();
    const result = await rpc("wikiSuggest", { text: "billing flow", title: "Plan" });
    expect(result).toEqual({
      suggestions: Array.from({ length: 5 }, (_, index) => ({
        slug: `doc-${index}`,
        title: `Doc ${index}`,
        heading: index === 0 ? "Diagrams" : null,
        reason: `reason ${index}`,
      })),
    });
    expect(wiki.calls[0]?.input).toEqual({ text: "billing flow", title: "Plan" });

    const broken = await setup({
      wiki: createWikiFake({
        suggest: () => {
          throw handlerError("index is rebuilding");
        },
      }),
    });
    expect(await broken.rpc("wikiSuggest", { text: "x", title: null })).toEqual({ suggestions: [] });
  });
});

describe("sending to the Wiki", () => {
  it("files an inbox card with a temporary PNG and removes it afterwards", async () => {
    const { rpc, wiki, dataDir } = await setup();
    const result = sendResultSchema.parse(await rpc("sendToWiki", sendInput({ kind: "inbox" })));
    expect(result).toEqual({ kind: "inbox", cardId: "card_1a2b3c4d" });

    const [call] = wiki.calls;
    expect(call?.method).toBe("addCard");
    expect(call?.input).toEqual({
      name: "Plan.png",
      text: "From the planning call.",
      media: [{ from: { kind: "path", path: call?.mediaPath }, caption: "Billing flow" }],
      target: null,
      heading: null,
      threadId: null,
    });
    expect(call?.mediaPath).toMatch(new RegExp(`^${dataDir}/outbox/[a-f0-9]{16}/Plan\\.png$`));
    expect(call?.mediaBytes).toEqual(PNG);
    expect(await outboxEntries(dataDir)).toEqual([]);
  });

  it("adds straight to a doc under a heading", async () => {
    const { rpc, wiki, dataDir } = await setup();
    const result = await rpc("sendToWiki", sendInput({ kind: "doc", slug: "architecture", heading: "Diagrams" }));
    expect(result).toEqual({ kind: "doc", slug: "architecture", title: "Architecture" });
    const [call] = wiki.calls;
    expect(call?.method).toBe("addToDoc");
    expect(call?.input).toEqual({
      target: { kind: "existing", slug: "architecture" },
      heading: "Diagrams",
      text: "From the planning call.",
      media: [{ from: { kind: "path", path: call?.mediaPath }, caption: "Billing flow" }],
      source: { kind: "upload", name: "Plan.png" },
    });
    expect(call?.mediaBytes).toEqual(PNG);
    expect(await outboxEntries(dataDir)).toEqual([]);
  });

  it("keeps the temporary file name safe whatever the sketch is called", async () => {
    const { rpc, wiki, dataDir } = await setup();
    await rpc("sendToWiki", sendInput({ kind: "inbox" }, "../a/b: c.png"));
    const [call] = wiki.calls;
    expect(path.dirname(path.dirname(call?.mediaPath ?? ""))).toBe(path.join(dataDir, "outbox"));
    expect(path.basename(call?.mediaPath ?? "")).toBe("-a-b- c.png");
    expect(call?.input).toMatchObject({ name: "../a/b: c.png" });
  });

  it("removes the temporary file when the Wiki fails, and shows the Wiki's message", async () => {
    const { rpc, wiki, dataDir } = await setup({
      wiki: createWikiFake({
        addToDoc: () => {
          throw handlerError("Heading “Diagrams” is too deep.");
        },
      }),
    });
    await expect(rpc("sendToWiki", sendInput({ kind: "doc", slug: "architecture", heading: "Diagrams" }))).rejects.toThrow(
      "Heading “Diagrams” is too deep.",
    );
    expect(wiki.calls[0]?.mediaBytes).toEqual(PNG);
    expect(await outboxEntries(dataDir)).toEqual([]);
  });

  it("keeps the temporary file when the Wiki doesn't answer in time, since it may still read it", async () => {
    const { rpc, wiki, dataDir } = await setup({
      wiki: createWikiFake({
        addToDoc: () => {
          throw timeoutError();
        },
      }),
    });
    await expect(rpc("sendToWiki", sendInput({ kind: "doc", slug: "architecture", heading: "Diagrams" }))).rejects.toThrow(WIKI_SEND_TIMEOUT);
    expect(await outboxEntries(dataDir)).toHaveLength(1);
    expect(wiki.calls[0]?.mediaPath).toContain(path.join(dataDir, "outbox"));
  });

  it("clears outbox leftovers older than an hour before each send", async () => {
    const { rpc, dataDir } = await setup();
    await mkdir(path.join(dataDir, "outbox", "old"), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(dataDir, "outbox", "old"), old, old);
    await rpc("sendToWiki", sendInput({ kind: "inbox" }));
    expect(await outboxEntries(dataDir)).toEqual([]);
  });

  it("explains an old Wiki that can't take inbox cards", async () => {
    const { rpc, dataDir } = await setup({ wiki: createWikiFake({}, { missing: ["addCard"] }) });
    await expect(rpc("sendToWiki", sendInput({ kind: "inbox" }))).rejects.toThrow(WIKI_NO_INBOX);
    expect(await outboxEntries(dataDir)).toEqual([]);
    expect(await rpc("sendToWiki", sendInput({ kind: "doc", slug: "architecture", heading: "Unsorted" }))).toMatchObject({ kind: "doc" });
  });

  it("explains a Wiki that isn't there", async () => {
    const missing = new FakeHttpError(404, { ok: false, error: 'unknown plugin "wiki"' }, 'unknown plugin "wiki"');
    const failing = (error: Error) =>
      createWikiFake({
        addCard: () => {
          throw error;
        },
      });
    const cases: [Error, string][] = [
      [missing, WIKI_NOT_INSTALLED],
      [notRunning("disabled — turned off by the user"), WIKI_TURNED_OFF],
      [notRunning("error — failed to load"), WIKI_NOT_RUNNING],
    ];
    for (const [error, message] of cases) {
      const { rpc } = await setup({ wiki: failing(error) });
      await expect(rpc("sendToWiki", sendInput({ kind: "inbox" }))).rejects.toThrow(message);
    }
  });

  it("refuses an image that isn't a PNG without calling the Wiki", async () => {
    const { rpc, wiki } = await setup();
    await expect(rpc("sendToWiki", { ...sendInput({ kind: "inbox" }), png: Buffer.from("not a png at all").toString("base64") })).rejects.toThrow(
      "That image isn't a PNG.",
    );
    expect(wiki.calls).toEqual([]);
  });
});

describe("Wiki error mapping", () => {
  it("turns transport errors into readable messages", () => {
    expect(wikiFailure(timeoutError(), "docs").message).toBe(WIKI_TIMEOUT);
    expect(wikiFailure(timeoutError(), "addCard").message).toBe(WIKI_SEND_TIMEOUT);
    expect(wikiFailure(new FakeHttpError(504, null, "Gateway Timeout"), "addToDoc").message).toBe(WIKI_SEND_TIMEOUT);
    expect(wikiFailure(unknownMethod("addCard"), "addCard").message).toBe(WIKI_NO_INBOX);
    expect(wikiFailure(unknownMethod("addCard"), "addCard", true).message).toBe(WIKI_NO_INBOX_THREAD);
    expect(WIKI_NO_INBOX_THREAD).not.toContain("pick a doc");
    expect(wikiFailure(new FakeHttpError(400, { ok: false, error: { code: "invalid_input", message: "heading: Too big" } }, "heading: Too big"), "addToDoc").message).toBe(
      "heading: Too big",
    );
    expect(wikiFailure(new FakeHttpError(500, null, "Internal Server Error"), "docs").message).toBe("Internal Server Error");
    expect(wikiFailure(new Error("socket hang up"), "docs").message).toBe("socket hang up");
    expect(wikiFailure(new FakeHttpError(404, { ok: false, error: { code: "unknown_method", message: "x" } }, "x"), "suggest").message).toBe(
      "This Wiki version has no “suggest” call. Update the Wiki plugin.",
    );
  });
});

describe("outbox sweep", () => {
  it("removes leftovers older than an hour", async () => {
    const { dataDir } = await setup();
    await mkdir(path.join(dataDir, "outbox", "old"), { recursive: true });
    await mkdir(path.join(dataDir, "outbox", "fresh"), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(dataDir, "outbox", "old"), old, old);
    expect(await sweepOutbox(dataDir)).toBe(1);
    expect(await outboxEntries(dataDir)).toEqual(["fresh"]);
  });
});

describe("inbox support check", () => {
  it("asks again a minute after a no, but keeps a yes for the same Wiki build", async () => {
    let now = 0;
    let answer: Error = unknownMethod("addCard");
    let asked = 0;
    const check = createInboxCheck(async () => {
      asked += 1;
      throw answer;
    }, () => now);
    const build = { version: "0.1.0", status: "running" };
    expect(await check.supported(build)).toBe(false);
    expect(await check.supported(build)).toBe(false);
    expect(asked).toBe(1);
    now += INBOX_RECHECK_MS + 1;
    answer = invalidInput("name: Required");
    expect(await check.supported(build)).toBe(true);
    now += 10 * INBOX_RECHECK_MS;
    expect(await check.supported(build)).toBe(true);
    expect(asked).toBe(2);
    expect(await check.supported({ ...build, updatedAt: "2026-10-19T12:00:00.000Z" })).toBe(true);
    expect(asked).toBe(3);
  });

  it("reads the probe's answer from the host's error", () => {
    expect(probeVerdict(unknownMethod("addCard"))).toBe(false);
    expect(probeVerdict(invalidInput("name: Required"))).toBe(true);
    expect(probeVerdict(notRunning("starting"))).toBeNull();
    expect(probeVerdict(timeoutError())).toBeNull();
  });
});
