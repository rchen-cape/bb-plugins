import { useRef, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import { ErrorText, Kbd, Spinner } from "./bits";
import { Button } from "./ui/button";
import { DialogFooter } from "./ui/dialog";
import { MOD_KEY_LABEL } from "./ui/shortcut";
import { formatBytes, type SendPreview } from "./use-send-preview";
import type { Kind, WikiStatus } from "./wiki-destination";

export type { Kind } from "./wiki-destination";
export type KindVia = "click" | "arrow";

const KIND_OPTIONS: readonly { value: Kind; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "doc", label: "Doc" },
];

export const INBOX_DESCRIPTION = "Review it in the Wiki inbox and pick where it goes there.";

const INBOX_BLOCKED_TEXT ="This Wiki version can't take inbox cards. Update the Wiki plugin, or pick a doc.";

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function KindPicker({ value, inboxBlocked, blockedHintId, onChange }: {
  value: Kind;
  inboxBlocked: boolean;
  blockedHintId: string;
  onChange: (kind: Kind, via: KindVia) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (kind: Kind) => kind !== "inbox" || !inboxBlocked;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!ARROW_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = KIND_OPTIONS.findIndex((option) => option.value !== value && enabled(option.value));
    const option = KIND_OPTIONS[next];
    if (option === undefined) return;
    onChange(option.value, "arrow");
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Where" className="inline-flex rounded-md border border-border p-0.5">
      {KIND_OPTIONS.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-describedby={enabled(option.value) ? undefined : blockedHintId}
          disabled={!enabled(option.value)}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value, "click")}
          onKeyDown={onKeyDown}
          className={cn(
            "h-7 cursor-pointer rounded px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value ? "bg-state-active font-medium text-foreground" : "text-muted-foreground enabled:hover:bg-state-hover enabled:hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PreviewImage({ preview }: { preview: SendPreview }) {
  if (preview.status === "loading") {
    return (
      <div className="flex h-28 items-center justify-center gap-2 rounded-md border border-border bg-muted text-xs text-muted-foreground">
        <Spinner /> Drawing the image…
      </div>
    );
  }
  if (preview.status === "error") return <ErrorText>Couldn't draw the image: {preview.message}</ErrorText>;
  return (
    <figure className="grid gap-1.5">
      <div className="flex max-h-32 justify-center overflow-hidden rounded-md border border-border bg-muted p-2">
        {preview.url === null ? null : (
          <img src={preview.url} alt="The image that will be sent" className="max-h-28 w-auto max-w-full object-contain shadow-xs" />
        )}
      </div>
      <figcaption className="text-xs text-muted-foreground tabular-nums">
        PNG · {preview.image.width} × {preview.image.height} px · {formatBytes(preview.image.blob.size)}
      </figcaption>
    </figure>
  );
}

export function WikiNotice({ status, kind, blockedHintId }: { status: WikiStatus; kind: Kind; blockedHintId: string }) {
  if (status.kind === "loading") return kind === "inbox" ? <p className="text-xs text-muted-foreground">Checking the Wiki…</p> : null;
  if (status.kind === "failed") return <ErrorText>Couldn't reach the Wiki: {status.message}</ErrorText>;
  if (status.kind === "unavailable") {
    return (
      <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
        {status.reason} Sending is turned off until it is.
      </p>
    );
  }
  if (status.inbox) return null;
  return (
    <p id={blockedHintId} className="text-xs text-muted-foreground">
      {INBOX_BLOCKED_TEXT}
    </p>
  );
}

export function SendFooter({ label, canSend, busy, onCancel, onSend }: {
  label: string;
  canSend: boolean;
  busy: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <DialogFooter className="items-center gap-2">
      <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
        <Kbd>{MOD_KEY_LABEL}</Kbd> <Kbd>Enter</Kbd> to send
      </span>
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" disabled={!canSend} onClick={onSend}>
        {label}
      </Button>
    </DialogFooter>
  );
}
