import { realpath } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, INBOX_CHANNEL } from "../lib/wiki.js";
import { createStore, type Store } from "./store.js";
import { createVault, isFolderSetting, isWikiFolderSetting, resolveRoot, resolveWikiRoot, type Vault } from "./vault.js";

export interface WikiSettings {
  wikiDirectory: string;
  notesDirectory: string;
  ingestTime: string;
  timezone: string;
  ingestEnabled: boolean;
  routingAgent: boolean;
  routingModel: string;
  ingestStartDate: string;
  gitHistory: boolean;
  codeBlockButton: boolean;
}

export type WikiLog = BbPluginApi["log"];

export interface WikiContext {
  bb: BbPluginApi;
  settings: () => Promise<WikiSettings>;
  wikiRoot: () => Promise<string>;
  notesRoot: () => Promise<string>;
  store: Store;
  vault: Vault;
  publishChanged: () => void;
  publishInbox: () => void;
  log: WikiLog;
  dataDir: () => string;
}

export const WIKI_SETTING_DEFAULTS: Readonly<WikiSettings> = {
  wikiDirectory: "~/Wiki",
  notesDirectory: "~/Notes",
  ingestTime: "07:00",
  timezone: "",
  ingestEnabled: true,
  routingAgent: true,
  routingModel: "",
  ingestStartDate: "",
  gitHistory: true,
  codeBlockButton: true,
};

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const folderSchema = z.string().refine(isFolderSetting, 'Use an absolute folder path or one starting with "~/"');
const wikiFolderSchema = z
  .string()
  .refine((value) => isWikiFolderSetting(value), 'Use an absolute folder path or one starting with "~/" that does not hold your home folder, like ~/Wiki');
const timeSchema = z.string().refine(isTimeOfDay, "Use 24-hour HH:MM, like 07:00");
const timezoneSchema = z
  .string()
  .refine((value) => value === "" || isTimeZone(value), "Use an IANA time zone like America/New_York, or leave it empty");
const startDateSchema = z
  .string()
  .refine((value) => value === "" || isCalendarDate(value), "Use a real date as YYYY-MM-DD, or leave it empty");
const textSchema = z.string();
const flagSchema = z.boolean();

const D = WIKI_SETTING_DEFAULTS;

const storedSettingsSchema = z.object({
  wikiDirectory: wikiFolderSchema.catch(D.wikiDirectory),
  notesDirectory: folderSchema.catch(D.notesDirectory),
  ingestTime: timeSchema.catch(D.ingestTime),
  timezone: timezoneSchema.catch(D.timezone),
  ingestEnabled: flagSchema.catch(D.ingestEnabled),
  routingAgent: flagSchema.catch(D.routingAgent),
  routingModel: textSchema.catch(D.routingModel),
  ingestStartDate: startDateSchema.catch(D.ingestStartDate),
  gitHistory: flagSchema.catch(D.gitHistory),
  codeBlockButton: flagSchema.catch(D.codeBlockButton),
});

export function defineWikiSettings(bb: BbPluginApi): () => Promise<WikiSettings> {
  const handle = bb.settings.define({
    wikiDirectory: {
      type: "string",
      label: "Wiki folder",
      description: "Folder that holds the Wiki's Markdown docs. Created on first use; ~/ is expanded.",
      default: D.wikiDirectory,
      experimental_schema: wikiFolderSchema,
    },
    notesDirectory: {
      type: "string",
      label: "Notes folder",
      description: "Folder of daily notes the Wiki reads from. The Wiki never writes there.",
      default: D.notesDirectory,
      experimental_schema: folderSchema,
    },
    ingestTime: {
      type: "string",
      label: "Daily ingest time",
      description: "Local time (24-hour HH:MM) when yesterday's notes are gathered into the inbox.",
      default: D.ingestTime,
      experimental_schema: timeSchema,
    },
    timezone: {
      type: "string",
      label: "Time zone",
      description: "IANA time zone for the ingest time, like America/New_York. Leave empty to use the system time zone.",
      default: D.timezone,
      experimental_schema: timezoneSchema,
    },
    ingestEnabled: {
      type: "boolean",
      label: "Run the daily ingest",
      default: D.ingestEnabled,
      experimental_schema: flagSchema,
    },
    routingAgent: {
      type: "boolean",
      label: "Suggest routes with Claude Code",
      description: "When off, inbox cards are routed by links and tags only.",
      default: D.routingAgent,
      experimental_schema: flagSchema,
    },
    routingModel: {
      type: "string",
      label: "Routing model",
      description: "Model for the routing thread. Leave empty for the provider default.",
      default: D.routingModel,
    },
    ingestStartDate: {
      type: "string",
      label: "Ingest notes from",
      description: "Earliest daily note to ingest, as YYYY-MM-DD. Leave empty to start 7 days before the first run.",
      default: D.ingestStartDate,
      experimental_schema: startDateSchema,
    },
    gitHistory: {
      type: "boolean",
      label: "Keep git history",
      description: "Run git init in the Wiki folder and commit each change.",
      default: D.gitHistory,
      experimental_schema: flagSchema,
    },
    codeBlockButton: {
      type: "boolean",
      label: "Add to Wiki on code blocks",
      description: "Show an Add to Wiki button on code blocks in assistant messages.",
      default: D.codeBlockButton,
      experimental_schema: flagSchema,
    },
  });
  return async () => storedSettingsSchema.parse(await handle.get());
}


export const FOLDER_OVERLAP_MESSAGE = "The Wiki folder can't be the Notes folder or inside it — change wikiDirectory or notesDirectory.";
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function foldersOverlap(a: string, b: string, caseInsensitive: boolean = CASE_INSENSITIVE_PLATFORMS.has(process.platform)): boolean {
  const [left, right] = caseInsensitive ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  return contains(left, right) || contains(right, left);
}

async function canonicalPath(target: string): Promise<string> {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertSeparateFolders(wikiRoot: string, notesRoot: string): Promise<void> {
  if (foldersOverlap(wikiRoot, notesRoot)) throw new Error(FOLDER_OVERLAP_MESSAGE);
  const [wiki, notes] = await Promise.all([canonicalPath(wikiRoot), canonicalPath(notesRoot)]);
  if (foldersOverlap(wiki, notes)) throw new Error(FOLDER_OVERLAP_MESSAGE);
}
const databaseListSchema = z.array(z.object({ name: z.string(), file: z.string().nullable().optional() }));

export function pluginDataDir(storage: BbPluginApi["storage"]): string {
  const rows = databaseListSchema.parse(storage.database().prepare("PRAGMA database_list").all());
  const file = rows.find((row) => row.name === "main")?.file;
  if (file === undefined || file === null || file === "") {
    throw new Error("The Wiki needs a file-backed plugin database to keep uploads.");
  }
  return path.dirname(file);
}

export async function createWikiContext(bb: BbPluginApi): Promise<WikiContext> {
  const settings = defineWikiSettings(bb);
  const store = createStore(bb.storage, bb.log);
  const wikiRoot = async () => {
    const current = await settings();
    const root = resolveWikiRoot(current.wikiDirectory);
    await assertSeparateFolders(root, resolveRoot(current.notesDirectory));
    return root;
  };
  const notesRoot = async () => resolveRoot((await settings()).notesDirectory);
  const vault = createVault({
    getRoot: wikiRoot,
    store,
    gitEnabled: async () => (await settings()).gitHistory,
    log: bb.log,
  });
  let dataDir: string | null = null;
  return {
    bb,
    settings,
    wikiRoot,
    notesRoot,
    store,
    vault,
    publishChanged: () => bb.realtime.publish(CHANGED_CHANNEL, {}),
    publishInbox: () => bb.realtime.publish(INBOX_CHANNEL, {}),
    log: bb.log,
    dataDir: () => (dataDir ??= pluginDataDir(bb.storage)),
  };
}
