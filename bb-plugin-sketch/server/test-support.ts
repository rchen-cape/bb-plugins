import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, type FakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { serializeScene, type SketchElement } from "../lib/scene.js";
import plugin from "../server.js";
import { pluginDataDir } from "./context.js";

export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

export function fakePng(width = 4, height = 3): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([header, ihdr, Buffer.from("IEND")]);
}

export function sceneText(elements: readonly SketchElement[]): string {
  return serializeScene({ elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
}

export class FakeHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string, code: string | null = null) {
    super(`HTTP ${status}: ${message}`);
    this.name = "BbHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function unknownMethod(method: string): FakeHttpError {
  const message = `plugin "wiki" has no rpc method "${method}"`;
  return new FakeHttpError(404, { ok: false, error: { code: "unknown_method", message } }, message);
}

export function notRunning(status: string): FakeHttpError {
  const message = `plugin "wiki" is not running (status: ${status})`;
  return new FakeHttpError(503, { ok: false, error: message }, message);
}

export function handlerError(message: string): FakeHttpError {
  return new FakeHttpError(500, { ok: false, error: { code: "handler_error", message } }, message);
}

export function invalidInput(message: string): FakeHttpError {
  return new FakeHttpError(400, { ok: false, error: { code: "invalid_input", message } }, message);
}

const cardInputSchema = z
  .object({
    name: z.string().min(1),
    text: z.string(),
    media: z.array(z.unknown()).min(1),
    target: z.object({ kind: z.literal("existing"), slug: z.string() }).nullable(),
    heading: z.string().nullable(),
    threadId: z.string().min(1).nullable(),
  })
  .strict();

const INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = { addCard: cardInputSchema };

export const WIKI_DOCS = [
  { slug: "architecture", title: "Architecture", type: "project", aliases: ["arch"], tag: "architecture", updatedAt: "2026-10-01T00:00:00.000Z", headings: ["Overview", "Diagrams"] },
  { slug: "notes/billing", title: "Billing", type: "topic", aliases: [], tag: "billing", updatedAt: "2026-10-02T00:00:00.000Z", headings: [] },
  { slug: "notes/billing-v2", title: "Billing v2", type: "topic", aliases: ["billing2"], tag: "billing-v2", updatedAt: "2026-10-03T00:00:00.000Z", headings: [] },
];

export const WIKI_CARD = {
  id: "card_1a2b3c4d",
  status: "pending",
  source: { kind: "upload", name: "Plan.png", pluginId: "sketch" },
  text: "",
  lines: [],
  tags: [],
  rule: "none",
  reason: "",
  destinations: [],
  tagSuggestions: [],
  rememberAliases: [],
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

export interface WikiCall {
  method: string;
  input: unknown;
  mediaPath: string | null;
  mediaBytes: Buffer | null;
}

type Handler = (input: unknown) => unknown;

const mediaInputSchema = z.object({ media: z.array(z.object({ from: z.object({ kind: z.literal("path"), path: z.string() }) })).min(1) });

async function mediaOf(input: unknown): Promise<{ mediaPath: string | null; mediaBytes: Buffer | null }> {
  const parsed = mediaInputSchema.safeParse(input);
  const first = parsed.success ? parsed.data.media[0] : undefined;
  if (first === undefined) return { mediaPath: null, mediaBytes: null };
  return { mediaPath: first.from.path, mediaBytes: await readFile(first.from.path).catch(() => null) };
}

export interface WikiPluginRow {
  id: string;
  status: string;
  enabled: boolean;
  version?: string;
  updatedAt?: string;
}

export interface WikiFakeOptions {
  missing?: readonly string[];
  plugins?: readonly WikiPluginRow[];
}

export function createWikiFake(handlers: Record<string, Handler> = {}, options: WikiFakeOptions = {}) {
  const calls: WikiCall[] = [];
  const rejected: { method: string; input: unknown }[] = [];
  const all: Record<string, Handler> = {
    docs: () => WIKI_DOCS,
    suggest: () => ({
      suggestions: Array.from({ length: 7 }, (_, index) => ({
        slug: `doc-${index}`,
        title: `Doc ${index}`,
        type: "topic",
        heading: index === 0 ? "Diagrams" : null,
        score: 10 - index,
        reason: `reason ${index}`,
      })),
    }),
    addCard: () => WIKI_CARD,
    addToDoc: () => ({ slug: "architecture", title: "Architecture" }),
    ...handlers,
  };
  for (const method of options.missing ?? []) delete all[method];
  const fake = {
    plugins: options.plugins ?? [{ id: "wiki", status: "running", enabled: true, version: "0.1.0" }],
    calls,
    rejected,
    async call(args: { method: string; input?: unknown; outputSchema: z.ZodType<unknown> }): Promise<unknown> {
      const handler = all[args.method];
      if (handler === undefined) throw unknownMethod(args.method);
      const checked = INPUT_SCHEMAS[args.method]?.safeParse(args.input);
      if (checked !== undefined && !checked.success) {
        rejected.push({ method: args.method, input: args.input });
        throw invalidInput("rpc input validation failed");
      }
      calls.push({ method: args.method, input: args.input, ...(await mediaOf(args.input)) });
      return args.outputSchema.parse(await handler(args.input));
    },
  };
  return fake;
}

export type WikiFake = ReturnType<typeof createWikiFake>;

export interface SetupOptions {
  wiki?: WikiFake;
  settings?: Record<string, string>;
  sdk?: FakeSdkOverrides;
}

export interface Setup {
  host: FakePluginHost;
  folder: string;
  wiki: WikiFake;
  rpc: FakePluginHost["harness"]["behavior"]["callRpc"];
  cli: FakePluginHost["harness"]["behavior"]["runCli"];
  dataDir: string;
  signals: () => unknown[];
}

export async function setup(options: SetupOptions = {}): Promise<Setup> {
  const base = await tempDir("sketch-e2e-");
  const folder = path.join(base, "Sketches");
  const wiki = options.wiki ?? createWikiFake();
  const host = createFakePluginHost({
    pluginId: "sketch",
    settings: { sketchDirectory: folder, ...options.settings },
    sdk: {
      ...options.sdk,
      plugins: {
        list: async () => ({ plugins: wiki.plugins }),
        callRpc: (args) => wiki.call(args),
      },
    },
  });
  await plugin(host.bb);
  const { behavior, inspection } = host.harness;
  return {
    host,
    folder,
    wiki,
    rpc: behavior.callRpc,
    cli: behavior.runCli,
    dataDir: pluginDataDir(host.bb.storage),
    signals: () => inspection.realtimeSignals.filter((signal) => signal.channel === "sketch-changed").map((signal) => signal.payload),
  };
}
