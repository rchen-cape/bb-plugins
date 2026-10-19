import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod/mini";
import type { UploadInfo } from "../contract";
import { LIMITS, MEDIA_EXTENSIONS, WIKI_PANEL, mediaKindOf } from "../lib/wiki";
import { errorMessage, useWikiRpc } from "./hooks";
import { addRequests } from "./requests";

const tokenResponseSchema = z.object({ token: z.string().check(z.minLength(1)) });
const uploadResponseSchema = z.object({ uploadId: z.string(), name: z.string(), sizeBytes: z.number() });
const errorResponseSchema = z.object({ error: z.string() });

export interface UploadDeps {
  importUpload: (uploadId: string) => Promise<UploadInfo>;
  pluginId?: string;
  fetch?: typeof fetch;
  getToken?: () => Promise<string>;
}

const sharedTokens = new Map<string, Promise<string>>();

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const latest = useRef(onFiles);
  useEffect(() => {
    latest.current = onFiles;
  });

  const bind = useMemo(
    () => ({
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) latest.current(files);
      },
    }),
    [],
  );

  return { dragging, bind };
}

export function DropOverlay({ dragging }: { dragging: boolean }) {
  if (!dragging) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-background/85"
    >
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Drop to add to the Wiki</p>
        <p className="mt-1 text-xs text-muted-foreground">Images, videos, and .md or .txt files</p>
      </div>
    </div>
  );
}

function nameList(files: readonly File[]): string {
  return files.map((file) => file.name || "unnamed file").join(", ");
}

export function checkUploadable(files: readonly File[]): void {
  const unsupported = files.filter((file) => mediaKindOf(file.name) === null);
  if (unsupported.length > 0) {
    throw new Error(`The Wiki can't add ${nameList(unsupported)}. It accepts ${MEDIA_EXTENSIONS.join(" ")} files.`);
  }
  const tooLarge = files.filter((file) => file.size > LIMITS.uploadBytes);
  if (tooLarge.length > 0) throw new Error(`${nameList(tooLarge)} is over the 1 GB upload limit.`);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function requestToken(fetchFn: typeof fetch, pluginId: string): Promise<string> {
  const response = await fetchFn(`/api/v1/plugins/${pluginId}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const parsed = tokenResponseSchema.safeParse(await readJson(response));
  if (!response.ok || !parsed.success) throw new Error(`Could not get an upload token (HTTP ${response.status}).`);
  return parsed.data.token;
}

function sharedToken(pluginId: string): Promise<string> {
  const cached = sharedTokens.get(pluginId);
  if (cached !== undefined) return cached;
  const pending = requestToken((input, init) => fetch(input, init), pluginId);
  sharedTokens.set(pluginId, pending);
  pending.catch(() => sharedTokens.delete(pluginId));
  return pending;
}

async function sendFile(file: File, pluginId: string, fetchFn: typeof fetch, token: string): Promise<string> {
  const response = await fetchFn(`/api/v1/plugins/${pluginId}/http/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "x-bb-plugin-token": token, "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const json = await readJson(response);
  if (!response.ok) {
    if (response.status === 401) sharedTokens.delete(pluginId);
    const failure = errorResponseSchema.safeParse(json);
    throw new Error(failure.success ? `Could not upload ${file.name}: ${failure.data.error}` : `Could not upload ${file.name} (HTTP ${response.status}).`);
  }
  const parsed = uploadResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error(`The Wiki sent an unexpected reply for ${file.name}.`);
  return parsed.data.uploadId;
}

export async function uploadFiles(files: File[], deps: UploadDeps): Promise<UploadInfo[]> {
  checkUploadable(files);
  const pluginId = deps.pluginId ?? WIKI_PANEL;
  const customFetch = deps.fetch;
  const fetchFn: typeof fetch = customFetch ?? ((input, init) => fetch(input, init));
  const getToken = deps.getToken ?? (customFetch === undefined ? () => sharedToken(pluginId) : () => requestToken(customFetch, pluginId));
  const uploads: UploadInfo[] = [];
  for (const file of files) {
    const uploadId = await sendFile(file, pluginId, fetchFn, await getToken());
    uploads.push(await deps.importUpload(uploadId));
  }
  return uploads;
}

function uploadingLabel(files: readonly File[]): string {
  const [first] = files;
  return files.length === 1 && first !== undefined ? `Uploading ${first.name}…` : `Uploading ${files.length} files…`;
}

export function useDropToWiki(): (files: File[]) => Promise<void> {
  const rpc = useWikiRpc();
  const pluginId = experimental_usePluginId();
  return useCallback(
    async (files: File[]) => {
      let toastId: string | number | undefined;
      try {
        checkUploadable(files);
        toastId = toast.loading(uploadingLabel(files));
        const uploads = await uploadFiles(files, { pluginId, importUpload: (uploadId) => rpc.call("importUpload", { uploadId }) });
        toast.dismiss(toastId);
        if (!addRequests.emit({ kind: "uploads", uploads })) toast.error("The Wiki is still loading. Try again in a moment.");
      } catch (cause) {
        toast.error(errorMessage(cause), toastId === undefined ? undefined : { id: toastId });
      }
    },
    [rpc, pluginId],
  );
}
