import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, DEFAULT_SKETCH_DIRECTORY } from "../lib/sketch.js";
import { createEchoFilter, type EchoFilter } from "./echo.js";
import { FOLDER_HINT, isSketchFolderSetting, resolveSketchRoot } from "./folder.js";
import { createPreviewStore, type PreviewStore } from "./previews.js";
import { createSketchStore, type SketchStore } from "./store.js";
import { createWikiClient, type WikiClient } from "./wiki.js";

export interface SketchSettings {
  sketchDirectory: string;
}

export type SketchLog = BbPluginApi["log"];

export interface SketchContext {
  bb: BbPluginApi;
  settings: () => Promise<SketchSettings>;
  root: () => Promise<string>;
  store: SketchStore;
  previews: PreviewStore;
  wiki: WikiClient;
  echo: EchoFilter;
  publishChanged: (id: string | null, renamedTo?: string) => void;
  log: SketchLog;
  dataDir: () => string;
}

export const SKETCH_SETTING_DEFAULTS: Readonly<SketchSettings> = {
  sketchDirectory: DEFAULT_SKETCH_DIRECTORY,
};

const folderSchema = z.string().refine((value) => isSketchFolderSetting(value), FOLDER_HINT);

const storedSettingsSchema = z.object({
  sketchDirectory: folderSchema.catch(SKETCH_SETTING_DEFAULTS.sketchDirectory),
});

export function defineSketchSettings(bb: BbPluginApi, onChange: () => void = () => undefined): () => Promise<SketchSettings> {
  const handle = bb.settings.define({
    sketchDirectory: {
      type: "string",
      label: "Sketch folder",
      description: "Folder that holds your .excalidraw files. Created on first save; ~/ is expanded.",
      default: SKETCH_SETTING_DEFAULTS.sketchDirectory,
      experimental_schema: folderSchema,
    },
  });
  handle.onChange(onChange);
  return async () => storedSettingsSchema.parse(await handle.get());
}

const databaseListSchema = z.array(z.object({ name: z.string(), file: z.string().nullable().optional() }));

export function pluginDataDir(storage: BbPluginApi["storage"]): string {
  const rows = databaseListSchema.parse(storage.database().prepare("PRAGMA database_list").all());
  const file = rows.find((row) => row.name === "main")?.file;
  if (file === undefined || file === null || file === "") {
    throw new Error("Sketch needs a file-backed plugin database to send images to the Wiki.");
  }
  return path.dirname(file);
}

export function createSketchContext(bb: BbPluginApi): SketchContext {
  const publishChanged = (id: string | null, renamedTo?: string) =>
    bb.realtime.publish(CHANGED_CHANNEL, renamedTo === undefined ? { id } : { id, renamedTo });
  const settings = defineSketchSettings(bb, () => publishChanged(null));
  const root = async () => resolveSketchRoot((await settings()).sketchDirectory);
  const previews = createPreviewStore(bb.storage);
  const echo = createEchoFilter();
  let dataDir: string | null = null;
  const resolveDataDir = () => (dataDir ??= pluginDataDir(bb.storage));
  return {
    bb,
    settings,
    root,
    store: createSketchStore({ root, previews, echo, publish: publishChanged }),
    previews,
    wiki: createWikiClient({ bb, dataDir: resolveDataDir, log: bb.log }),
    echo,
    publishChanged,
    log: bb.log,
    dataDir: resolveDataDir,
  };
}
