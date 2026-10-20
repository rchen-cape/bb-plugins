import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LIMITS } from "../lib/sketch.js";
import { errorMessage, isMissing } from "./errors.js";
import { writeFileAtomic } from "./files.js";
import { displayFolder } from "./folder.js";

export type CliMachine = { kind: "server" } | { kind: "remote"; hostId: string };

export interface CliPath {
  machine: CliMachine;
  path: string;
  display: string;
}

const SERVER: CliMachine = { kind: "server" };
const MAX_READ_BYTES = LIMITS.contentChars * 4;
const PATH_HINT = "Use an absolute path, or one starting with ~/.";
const BOM = String.fromCharCode(0xfeff);

const threadSchema = z.object({ environmentId: z.string().nullable().optional() });
const environmentSchema = z.object({ hostId: z.string() });
const configSchema = z.object({ primaryHostId: z.string().nullable().optional() });
const remoteReadSchema = z.object({ content: z.string(), contentEncoding: z.enum(["utf8", "base64"]).catch("utf8") });

function pathError(message: string, code: string = "invalid_value", hint: string = PATH_HINT): PluginCliError {
  return new PluginCliError(message, { code, hint });
}

export async function invokingMachine(bb: BbPluginApi, cli: PluginCliContext): Promise<CliMachine> {
  if (cli.threadId === undefined || cli.threadId === "") return SERVER;
  try {
    const thread = threadSchema.parse(await bb.sdk.threads.get({ threadId: cli.threadId }));
    if (thread.environmentId === undefined || thread.environmentId === null) return SERVER;
    const environment = environmentSchema.parse(await bb.sdk.environments.get({ environmentId: thread.environmentId }));
    const config = configSchema.parse(await bb.sdk.system.config());
    return config.primaryHostId === environment.hostId ? SERVER : { kind: "remote", hostId: environment.hostId };
  } catch (error) {
    throw pathError(`Couldn't tell which machine this thread runs on: ${errorMessage(error)}`, "command_failed", "Try again, or run the command outside the thread.");
  }
}

function pathApiFor(machine: CliMachine, sample: string): typeof path.posix {
  if (machine.kind === "server") return path;
  return path.win32.isAbsolute(sample) && !path.posix.isAbsolute(sample) ? path.win32 : path.posix;
}

export function resolveCliPath(raw: string, cwd: string | undefined, machine: CliMachine, home: string = homedir()): string {
  const value = raw.trim();
  if (value === "") throw pathError("The path is empty.");
  if (value === "~" || value.startsWith("~/")) {
    if (machine.kind === "remote") throw pathError("~/ can't be expanded on this thread's machine.", "invalid_value", "Use an absolute path on that machine.");
    return path.join(home, value.slice(2));
  }
  const own = pathApiFor(machine, value);
  if (own.isAbsolute(value)) return own.normalize(value);
  const api = pathApiFor(machine, cwd ?? "");
  if (cwd === undefined || cwd === "") throw pathError(`${JSON.stringify(raw)} is relative, and this command doesn't know the current folder.`);
  return api.resolve(cwd, value);
}

async function cliPath(bb: BbPluginApi, cli: PluginCliContext, raw: string): Promise<CliPath> {
  const machine = await invokingMachine(bb, cli);
  const resolved = resolveCliPath(raw, cli.cwd, machine);
  return { machine, path: resolved, display: machine.kind === "server" ? displayFolder(resolved) : resolved };
}

async function readLocal(target: CliPath): Promise<string> {
  const stats = await stat(target.path).catch((error: unknown) => {
    if (isMissing(error)) throw pathError(`There's no file at ${target.display}.`, "not_found", "Check the path.");
    throw error;
  });
  if (!stats.isFile()) throw pathError(`${target.display} isn't a file.`, "invalid_value", "Pass the path of an .excalidraw file.");
  if (stats.size > MAX_READ_BYTES) throw pathError(`${target.display} is too big for a sketch.`, "invalid_value", "Sketches are at most 10 MB of JSON.");
  return readFile(target.path, "utf8");
}

async function readRemote(bb: BbPluginApi, target: CliPath, hostId: string): Promise<string> {
  const file = remoteReadSchema.parse(await bb.sdk.files.read({ hostId, path: target.path }));
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}

export async function readCliFile(bb: BbPluginApi, cli: PluginCliContext, raw: string): Promise<CliPath & { text: string }> {
  const target = await cliPath(bb, cli, raw);
  const { machine } = target;
  const loaded = machine.kind === "server" ? await readLocal(target) : await readRemote(bb, target, machine.hostId);
  const text = loaded.startsWith(BOM) ? loaded.slice(BOM.length) : loaded;
  if (text.length > LIMITS.contentChars) throw pathError(`${target.display} is too big for a sketch.`, "invalid_value", "Sketches are at most 10 MB of JSON.");
  return { ...target, text };
}

async function localTarget(target: CliPath, defaultName: string): Promise<CliPath> {
  const stats = await stat(target.path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (stats?.isDirectory() !== true) return target;
  const inside = path.join(target.path, defaultName);
  return { ...target, path: inside, display: displayFolder(inside) };
}

async function writeLocal(target: CliPath, bytes: Uint8Array): Promise<void> {
  const folder = path.dirname(target.path);
  const stats = await stat(folder).catch(() => null);
  if (stats?.isDirectory() !== true) throw pathError(`The folder ${displayFolder(folder)} doesn't exist.`, "not_found", "Create the folder first, or pick another path.");
  await writeFileAtomic(target.path, bytes);
}

async function writeRemote(bb: BbPluginApi, target: CliPath, hostId: string, bytes: Uint8Array): Promise<void> {
  await bb.sdk.files.write({ hostId, path: target.path, content: Buffer.from(bytes).toString("base64"), contentEncoding: "base64", createParents: false });
}

export async function writeCliFile(bb: BbPluginApi, cli: PluginCliContext, raw: string, bytes: Uint8Array, defaultName: string): Promise<CliPath> {
  const named = /[\\/]$/.test(raw.trim()) ? `${raw.trim()}${defaultName}` : raw;
  const target = await cliPath(bb, cli, named);
  const { machine } = target;
  if (machine.kind === "remote") {
    await writeRemote(bb, target, machine.hostId, bytes);
    return target;
  }
  const local = await localTarget(target, defaultName);
  await writeLocal(local, bytes);
  return local;
}
