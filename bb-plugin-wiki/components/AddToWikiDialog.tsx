import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { AddSource, DocSummary, DocTarget, MediaSource, Suggestion, UploadInfo } from "../contract";
import { parseDoc } from "../lib/markdown-doc";
import { normalizeTag, wordsFromName } from "../lib/slug";
import { DEFAULT_DOC_TYPE, DEFAULT_HEADING, LIMITS, NEW_DOC_HEADING, WIKI_PANEL, truncate, type DocType, type MediaKind } from "../lib/wiki";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { MOD_KEY_LABEL, isModEnter } from "./ui/shortcut";
import { Textarea } from "./ui/textarea";
import { Kbd, Spinner, TypeBadge } from "./bits";
import { DocPicker, NewDocFields } from "./DocPicker";
import { errorMessage, useDocs, useWikiRpc } from "./hooks";
import { docSubPath } from "./nav";
import type { AddRequest } from "./requests";

const SUGGEST_DEBOUNCE_MS = 300;
export const DESCRIBE_POLL_MS = 1500;
const DESCRIBE_MAX_POLLS = 640;
const NEW_HEADING = "\u0000new-heading";

type VisualKind = "image" | "video";

interface MediaEntry {
  key: string;
  from: MediaSource;
  name: string;
  kind: VisualKind;
  sizeBytes: number;
  selected: boolean;
  caption: string;
  describing: boolean;
  error: string | null;
}

type Choice =
  | { kind: "suggestion"; suggestion: Suggestion }
  | { kind: "picked"; target: DocTarget | null }
  | { kind: "new"; title: string; type: DocType }
  | { kind: "file"; title: string; type: DocType };

const KIND_LABELS: Record<MediaKind, string> = { image: "Image", video: "Video", markdown: "Markdown", text: "Text" };

export function fencedCode(code: string, language: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}`;
}

export function initialText(request: AddRequest): string {
  switch (request.kind) {
    case "message":
      return request.text;
    case "code":
      return fencedCode(request.code, request.language);
    case "uploads":
      return request.uploads.flatMap((upload) => (upload.text === null ? [] : [upload.text.trimEnd()])).join("\n\n");
  }
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null ? { frontmatter: "", body: text } : { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

function isInlineSpace(char: string): boolean {
  return char === " " || char === "\t";
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'";
}

function leadingEnd(text: string, from: number, skip: (char: string) => boolean): number {
  let index = from;
  while (index < text.length && skip(text.charAt(index))) index += 1;
  return index;
}

function trailingStart(text: string, skip: (char: string) => boolean): number {
  let index = text.length;
  while (index > 0 && skip(text.charAt(index - 1))) index -= 1;
  return index;
}

function frontmatterTitleLine(line: string): string | undefined {
  if (!line.startsWith("title:")) return undefined;
  const rest = line.slice("title:".length);
  const start = leadingEnd(rest, 0, isInlineSpace);
  const end = trailingStart(rest, isInlineSpace);
  if (end === 0) return start === 0 ? undefined : rest.charAt(start - 1);
  const from = isQuote(rest.charAt(start)) && start + 1 < rest.length ? start + 1 : start;
  if (isQuote(rest.charAt(end - 1)) && end - 1 > from) return rest.slice(from, end - 1);
  return end > from ? rest.slice(from, end) : rest.charAt(from);
}

function headingTitleLine(line: string): string | undefined {
  if (!line.startsWith("#") || !isInlineSpace(line.charAt(1))) return undefined;
  const start = leadingEnd(line, 1, isInlineSpace);
  if (start === line.length) return start > 2 ? line.charAt(start - 1) : undefined;
  const end = trailingStart(line, (char) => isInlineSpace(char) || char === "#");
  return line.slice(start, Math.max(end, start + 1));
}

function firstLineTitle(text: string, read: (line: string) => string | undefined): string | undefined {
  for (const line of text.split(/[\n\r\u2028\u2029]/)) {
    const title = read(line);
    if (title !== undefined) return title;
  }
  return undefined;
}

export function fileTitle(upload: Pick<UploadInfo, "name" | "text">): string {
  const { frontmatter, body } = splitFrontmatter(upload.text ?? "");
  const fromFrontmatter = firstLineTitle(frontmatter, frontmatterTitleLine);
  const fromHeading = firstLineTitle(body, headingTitleLine);
  const fromName = wordsFromName(upload.name.replace(/\.[^.]+$/, ""));
  return truncate((fromFrontmatter ?? fromHeading ?? fromName).trim(), LIMITS.title);
}

export function fileDocBody(text: string): string {
  return tidy(splitFrontmatter(text).body);
}

export function fileAliases(text: string, docs: readonly DocSummary[]): string[] {
  const taken = new Set(docs.flatMap((doc) => [doc.tag, ...doc.aliases].map(normalizeTag)));
  return parseDoc(text, "file.md")
    .meta.aliases.filter((alias) => alias.length <= LIMITS.alias && !taken.has(alias))
    .slice(0, LIMITS.aliases);
}

export function titleGuess(text: string): string {
  const heading = firstLineTitle(splitFrontmatter(text).body, (line) => {
    const hashes = leadingEnd(line, 0, (char) => char === "#");
    return hashes > 6 ? undefined : headingTitleLine(line.slice(Math.max(hashes - 1, 0)));
  });
  return heading === undefined ? "" : truncate(heading.trim(), LIMITS.title);
}

function tidy(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function isVisual(kind: MediaKind): kind is VisualKind {
  return kind === "image" || kind === "video";
}

function mediaEntry(key: string, from: MediaSource, name: string, kind: VisualKind, sizeBytes: number, selected: boolean): MediaEntry {
  return { key, from, name, kind, sizeBytes, selected, caption: "", describing: false, error: null };
}

function uploadMedia(request: AddRequest): MediaEntry[] {
  if (request.kind !== "uploads") return [];
  return request.uploads.flatMap((upload) => {
    const kind = upload.kind;
    return isVisual(kind) ? [mediaEntry(`upload:${upload.uploadId}`, { kind: "upload", uploadId: upload.uploadId }, upload.name, kind, upload.sizeBytes, true)] : [];
  });
}

function sourceOf(request: AddRequest): AddSource {
  if (request.kind !== "uploads") return { kind: "thread", threadId: request.threadId, messageId: request.messageId };
  const names = request.uploads.map((upload) => upload.name).join(", ");
  return { kind: "upload", name: truncate(names === "" ? "upload" : names, LIMITS.title) };
}

function describeRequest(request: AddRequest): string {
  if (request.kind === "message") return request.fromSelection ? "From the text you selected." : "From this message.";
  if (request.kind === "code") return `From a ${request.language} code block.`;
  const [first] = request.uploads;
  return request.uploads.length === 1 && first !== undefined ? `From ${first.name}.` : `From ${request.uploads.length} dropped files.`;
}

function singleMarkdownUpload(request: AddRequest): UploadInfo | null {
  if (request.kind !== "uploads" || request.uploads.length !== 1) return null;
  const [upload] = request.uploads;
  return upload !== undefined && upload.kind === "markdown" ? upload : null;
}

function suggestTitle(request: AddRequest): string | null {
  if (request.kind !== "uploads") return null;
  const [first] = request.uploads;
  return first === undefined ? null : truncate(wordsFromName(first.name.replace(/\.[^.]+$/, "")), LIMITS.title);
}

function targetOf(choice: Choice | null): DocTarget | null {
  if (choice === null) return null;
  if (choice.kind === "suggestion") return { kind: "existing", slug: choice.suggestion.slug };
  if (choice.kind === "picked") return choice.target;
  const title = choice.title.trim();
  return title === "" ? null : { kind: "new", title, type: choice.type, aliases: [] };
}

function defaultHeading(choice: Choice | null): string {
  if (choice?.kind === "suggestion") return choice.suggestion.heading ?? DEFAULT_HEADING;
  if (choice?.kind === "picked" && choice.target?.kind !== "new") return DEFAULT_HEADING;
  return choice === null ? DEFAULT_HEADING : NEW_DOC_HEADING;
}

function uniqueHeadings(headings: readonly string[]): string[] {
  const seen = new Set<string>();
  return headings.filter((heading) => {
    const key = heading.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function headingOptions(target: DocTarget | null, docs: readonly DocSummary[] | undefined, preferred: string): string[] {
  if (target?.kind === "new") return uniqueHeadings([preferred, NEW_DOC_HEADING]);
  const doc = target === null ? undefined : docs?.find((candidate) => candidate.slug === target.slug);
  return uniqueHeadings([...(doc?.headings ?? []), preferred, DEFAULT_HEADING]);
}

function headingKey(target: DocTarget | null): string {
  if (target === null) return "none";
  return target.kind === "existing" ? `existing:${target.slug}` : "new";
}

function useSuggestions(text: string, title: string | null) {
  const rpc = useWikiRpc();
  const [state, setState] = useState<{ suggestions: Suggestion[]; loaded: boolean; error: string | null }>({
    suggestions: [],
    loaded: false,
    error: null,
  });
  const first = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const delay = first.current ? 0 : SUGGEST_DEBOUNCE_MS;
    first.current = false;
    const timer = setTimeout(() => {
      rpc.call("suggest", { text: text.slice(0, LIMITS.text), title }).then(
        ({ suggestions }) => {
          if (!cancelled) setState({ suggestions, loaded: true, error: null });
        },
        (cause: unknown) => {
          if (!cancelled) setState((current) => ({ ...current, loaded: true, error: errorMessage(cause) }));
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, text, title]);

  return state;
}

function useMediaEntries(request: AddRequest) {
  const rpc = useWikiRpc();
  const [media, setMedia] = useState<MediaEntry[]>(() => uploadMedia(request));
  const wantsMessageMedia = request.kind === "message" && request.messageSeq !== null;
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: wantsMessageMedia, error: null });

  useEffect(() => {
    if (request.kind !== "message" || request.messageSeq === null) return;
    let cancelled = false;
    rpc.call("messageMedia", { threadId: request.threadId, messageSeq: request.messageSeq }).then(
      ({ items }) => {
        if (cancelled) return;
        const entries = items.flatMap((item) => {
          const kind = item.kind;
          return isVisual(kind) ? [mediaEntry(`path:${item.path}`, { kind: "path", path: item.path }, item.name, kind, item.sizeBytes, false)] : [];
        });
        setMedia((current) => [...current, ...entries.filter((entry) => !current.some((existing) => existing.key === entry.key))]);
        setStatus({ loading: false, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) setStatus({ loading: false, error: errorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, request]);

  const update = useCallback((key: string, patch: Partial<MediaEntry>) => {
    setMedia((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }, []);

  return { media, update, ...status };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useImageDescriber() {
  const rpc = useWikiRpc();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return useCallback(
    async (from: MediaSource): Promise<string | null> => {
      const { jobId } = await rpc.call("describeImage", { from });
      for (let attempt = 0; attempt < DESCRIBE_MAX_POLLS; attempt += 1) {
        await wait(DESCRIBE_POLL_MS);
        if (!alive.current) return null;
        const job = await rpc.call("job", { jobId });
        if (job.status === "done") return job.result ?? "";
        if (job.status === "failed") throw new Error(job.error ?? "Claude Code could not describe this image.");
      }
      throw new Error("Claude Code took too long to describe this image.");
    },
    [rpc],
  );
}

function LargeFileNote({ sizeBytes }: { sizeBytes: number }) {
  if (sizeBytes <= LIMITS.uploadWarnBytes) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-warning-text">
      <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
      This file is {formatBytes(sizeBytes)}. It will be copied into the Wiki's assets folder.
    </p>
  );
}

function FileList({ uploads }: { uploads: readonly UploadInfo[] }) {
  return (
    <div role="group" aria-label="Files" className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Files</span>
      <ul className="divide-y divide-border rounded-md border border-border">
        {uploads.map((upload) => (
          <li key={upload.uploadId} className="grid gap-1 px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <Icon name={isVisual(upload.kind) ? "FileAttachment" : "FileText"} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{upload.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {KIND_LABELS[upload.kind]} · {formatBytes(upload.sizeBytes)}
              </span>
            </div>
            <LargeFileNote sizeBytes={upload.sizeBytes} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaptionField({
  entry,
  onCaption,
  onDescribe,
}: {
  entry: MediaEntry;
  onCaption: (caption: string) => void;
  onDescribe: () => void;
}) {
  return (
    <div className="grid gap-1.5 pl-5.5">
      <div className="flex flex-wrap gap-2">
        <Input
          value={entry.caption}
          maxLength={LIMITS.caption}
          placeholder="Caption (optional)"
          aria-label={`Caption for ${entry.name}`}
          className="h-8 min-w-48 flex-1 text-sm"
          onChange={(event) => onCaption(event.target.value)}
        />
        {entry.kind === "image" ? (
          <Button type="button" variant="outline" size="sm" disabled={entry.describing} onClick={onDescribe}>
            {entry.describing ? <Spinner className="text-current" /> : <Icon name="AiContentGenerator01" />}
            {entry.describing ? "Describing…" : "Describe with Claude"}
          </Button>
        ) : null}
      </div>
      {entry.describing ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Claude Code is looking at the image. You can edit the caption before adding it.
        </p>
      ) : null}
      {entry.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {entry.error}
        </p>
      )}
    </div>
  );
}

function MediaList({
  media,
  loading,
  error,
  onUpdate,
  onDescribe,
}: {
  media: readonly MediaEntry[];
  loading: boolean;
  error: string | null;
  onUpdate: (key: string, patch: Partial<MediaEntry>) => void;
  onDescribe: (entry: MediaEntry) => void;
}) {
  if (media.length === 0 && !loading && error === null) return null;
  return (
    <div role="group" aria-label="Images and videos" className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Images and videos</span>
      {loading ? <p className="text-xs text-muted-foreground">Looking for images in this message…</p> : null}
      {error === null ? null : <p className="text-xs text-muted-foreground">Could not read this message's images: {error}</p>}
      {media.length === 0 ? null : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {media.map((entry) => (
            <li key={entry.key} className="grid gap-2 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={entry.selected}
                  onChange={(event) => onUpdate(entry.key, { selected: event.target.checked })}
                  className="size-3.5 shrink-0 cursor-pointer accent-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {KIND_LABELS[entry.kind]} · {formatBytes(entry.sizeBytes)}
                </span>
              </label>
              <LargeFileNote sizeBytes={entry.sizeBytes} />
              {entry.selected ? (
                <CaptionField entry={entry} onCaption={(caption) => onUpdate(entry.key, { caption })} onDescribe={() => onDescribe(entry)} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChoiceRow({
  name,
  checked,
  onSelect,
  label,
  accessibleName,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  accessibleName?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("rounded-md border px-3 py-2 transition-colors", checked ? "border-ring bg-state-active" : "border-border hover:bg-state-hover")}>
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="radio"
          name={name}
          checked={checked}
          aria-label={accessibleName}
          onChange={onSelect}
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-foreground" />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
          {label}
        </label>
      </div>
      {checked && children !== undefined ? <div className="mt-2 pl-6">{children}</div> : null}
    </div>
  );
}

function suggestionName(suggestion: Suggestion, best: boolean): string {
  const heading = suggestion.heading === null ? "" : ` › ${suggestion.heading}`;
  return `${best ? "Best match: " : ""}${suggestion.title}${heading}`;
}

function SuggestionLabel({ suggestion, best }: { suggestion: Suggestion; best: boolean }) {
  return (
    <span className="grid gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">
          {best ? <span className="text-muted-foreground">Best match: </span> : null}
          <span className="font-medium text-foreground">{suggestion.title}</span>
          {suggestion.heading === null ? null : <span className="text-muted-foreground"> › {suggestion.heading}</span>}
        </span>
        <TypeBadge type={suggestion.type} />
      </span>
      {suggestion.reason === "" ? null : <span className="text-xs text-muted-foreground">{suggestion.reason}</span>}
    </span>
  );
}

function HeadingPicker({
  options,
  value,
  custom,
  disabled,
  onChange,
}: {
  options: readonly string[];
  value: string;
  custom: string;
  disabled: boolean;
  onChange: (next: { value: string; custom: string }) => void;
}) {
  return (
    <div className="grid gap-2">
      <Field label="Heading">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange({ value: event.target.value, custom })}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {options.map((heading) => (
            <option key={heading} value={heading}>
              {heading}
            </option>
          ))}
          <option value={NEW_HEADING}>New heading…</option>
        </select>
      </Field>
      {value === NEW_HEADING ? (
        <Input
          autoFocus
          value={custom}
          maxLength={LIMITS.heading}
          placeholder="New heading name"
          aria-label="New heading name"
          onChange={(event) => onChange({ value, custom: event.target.value })}
        />
      ) : null}
    </div>
  );
}

export function AddToWikiDialog({ request, onClose }: { request: AddRequest; onClose: () => void }) {
  const rpc = useWikiRpc();
  const navigate = useBbNavigate();
  const radioName = useId();
  const { docs } = useDocs();
  const [text, setText] = useState(() => initialText(request));
  const { media, update, loading: mediaLoading, error: mediaError } = useMediaEntries(request);
  const describeImage = useImageDescriber();
  const fileUpload = singleMarkdownUpload(request);
  const [hintTitle] = useState(() => suggestTitle(request));
  const { suggestions, loaded, error: suggestError } = useSuggestions(text, hintTitle);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [headingPick, setHeadingPick] = useState<{ key: string; value: string; custom: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [top] = suggestions;
  const automatic: Choice | null =
    !loaded ? null : top !== undefined ? { kind: "suggestion", suggestion: top } : fileUpload === null ? null : { kind: "file", title: fileTitle(fileUpload), type: DEFAULT_DOC_TYPE };
  const choice = picked ?? automatic;
  const target = targetOf(choice);
  const key = headingKey(target);
  const preferredHeading = defaultHeading(choice);
  const heading = headingPick?.key === key ? headingPick : { key, value: preferredHeading, custom: "" };
  const headingText = heading.value === NEW_HEADING ? heading.custom.trim() : heading.value;
  const selectedMedia = media.filter((entry) => entry.selected);
  const fileMode = choice?.kind === "file";
  const hasContent = text.trim() !== "" || selectedMedia.length > 0;
  const canSubmit = !busy && target !== null && (fileMode || (hasContent && headingText !== ""));
  const rows =
    choice?.kind === "suggestion" && !suggestions.some((suggestion) => suggestion.slug === choice.suggestion.slug)
      ? [...suggestions, choice.suggestion]
      : suggestions;

  const describe = async (entry: MediaEntry) => {
    update(entry.key, { describing: true, error: null });
    try {
      const description = await describeImage(entry.from);
      if (description !== null) update(entry.key, { describing: false, caption: truncate(description.trim(), LIMITS.caption) });
    } catch (cause) {
      update(entry.key, { describing: false, error: errorMessage(cause) });
    }
  };

  const save = async (): Promise<{ slug: string; title: string }> => {
    if (choice?.kind === "file") {
      return rpc.call("createDoc", { title: choice.title.trim(), type: choice.type, aliases: fileAliases(text, docs ?? []), body: fileDocBody(text) });
    }
    if (target === null) throw new Error("Pick a doc first.");
    return rpc.call("addToDoc", {
      target,
      heading: headingText,
      text: tidy(text),
      media: selectedMedia.map((entry) => ({ from: entry.from, caption: entry.caption.trim() })),
      source: sourceOf(request),
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await save();
      toast.success(fileMode ? `Created ${result.title}` : `Added to ${result.title}`, {
        action: { label: "Open", onClick: () => navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(result.slug) }) },
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isModEnter(event)) return;
    event.preventDefault();
    void submit();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Add to Wiki</DialogTitle>
          <DialogDescription>{describeRequest(request)} It is added exactly as written, under the heading you pick.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {request.kind === "uploads" ? <FileList uploads={request.uploads} /> : null}
          <Field label={selectedMedia.length > 0 ? "Text (optional)" : "Text"}>
            <Textarea
              value={text}
              maxLength={LIMITS.text}
              spellCheck={false}
              className="max-h-72 min-h-32 resize-y font-mono text-xs leading-5"
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <MediaList media={media} loading={mediaLoading} error={mediaError} onUpdate={update} onDescribe={(entry) => void describe(entry)} />
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Destination</legend>
            {!loaded ? <p className="text-xs text-muted-foreground">Finding where this belongs…</p> : null}
            {loaded && rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">{suggestError === null ? "No similar docs found. Pick a doc or start a new one." : `Suggestions are unavailable: ${suggestError}`}</p>
            ) : null}
            {rows.map((suggestion, index) => (
              <ChoiceRow
                key={suggestion.slug}
                name={radioName}
                checked={choice?.kind === "suggestion" && choice.suggestion.slug === suggestion.slug}
                onSelect={() => setPicked({ kind: "suggestion", suggestion })}
                label={<SuggestionLabel suggestion={suggestion} best={index === 0} />}
                accessibleName={suggestionName(suggestion, index === 0)}
              />
            ))}
            <ChoiceRow
              name={radioName}
              checked={choice?.kind === "picked"}
              onSelect={() => setPicked({ kind: "picked", target: null })}
              label="Pick another doc…"
            >
              {choice?.kind === "picked" ? (
                <DocPicker value={choice.target} autoFocus={choice.target === null} onChange={(next) => setPicked({ kind: "picked", target: next })} />
              ) : null}
            </ChoiceRow>
            <ChoiceRow
              name={radioName}
              checked={choice?.kind === "new"}
              onSelect={() => setPicked({ kind: "new", title: titleGuess(text), type: DEFAULT_DOC_TYPE })}
              label="New doc…"
            >
              {choice?.kind === "new" ? (
                <NewDocFields title={choice.title} type={choice.type} autoFocus onChange={(next) => setPicked({ kind: "new", ...next })} />
              ) : null}
            </ChoiceRow>
            {fileUpload === null ? null : (
              <ChoiceRow
                name={radioName}
                checked={choice?.kind === "file"}
                onSelect={() => setPicked({ kind: "file", title: fileTitle(fileUpload), type: DEFAULT_DOC_TYPE })}
                label="New doc from this file"
              >
                {choice?.kind === "file" ? (
                  <div className="grid gap-1.5">
                    <NewDocFields title={choice.title} type={choice.type} onChange={(next) => setPicked({ kind: "file", ...next })} />
                    <p className="text-xs text-muted-foreground">
                      The file becomes the doc, without its frontmatter; its aliases are kept unless another doc uses them. A first # heading that matches the title is dropped.
                    </p>
                  </div>
                ) : null}
              </ChoiceRow>
            )}
          </fieldset>
          {fileMode ? null : (
            <HeadingPicker
              options={headingOptions(target, docs, preferredHeading)}
              value={heading.value}
              custom={heading.custom}
              disabled={target === null}
              onChange={(next) => setHeadingPick({ key, ...next })}
            />
          )}
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="items-center gap-2">
            <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
              <Kbd>{MOD_KEY_LABEL}</Kbd> <Kbd>Enter</Kbd> to add
            </span>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? "Adding…" : fileMode ? "Create doc" : "Add to Wiki"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
