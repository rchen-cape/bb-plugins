import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { NODE_KINDS, type NodeKind } from "../src/model";
import { KIND_CHIP_CLASS, KIND_LABELS } from "./node-visuals";

export type NodeDraft =
  | { anchor: "canvas" }
  | { anchor: "parent"; nodeId: string }
  | { anchor: "child"; nodeId: string }
  | { anchor: "sibling"; nodeId: string };

export const DRAFT_HEIGHT = 88;

function relationLabel(draft: NodeDraft, anchorTitle: string | null): string {
  const anchor = anchorTitle ?? "that task";
  if (draft.anchor === "parent") return `${anchor} will depend on it`;
  if (draft.anchor === "child") return `Depends on ${anchor}`;
  if (draft.anchor === "sibling") return `Beside ${anchor}`;
  return "Depends on nothing";
}

/*
 * Two mutually exclusive choices, so both are shown. A select would open a
 * native popup over the canvas to say one word, and hide the alternative until
 * it did. Radios rather than buttons, so arrow keys move between them.
 */
function KindChoice({
  kind,
  disabled,
  onChange,
}: {
  kind: NodeKind;
  disabled: boolean;
  onChange: (next: NodeKind) => void;
}) {
  const group = useId();
  return (
    <div
      role="radiogroup"
      aria-label="New task kind"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted/60 p-0.5"
    >
      {NODE_KINDS.map((candidate) => {
        const chosen = candidate === kind;
        return (
          <label
            key={candidate}
            className={cn(
              "cursor-pointer rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide transition-colors duration-150",
              "focus-within:ring-1 focus-within:ring-ring",
              chosen
                ? cn("bg-card shadow-xs", KIND_CHIP_CLASS[candidate])
                : "text-subtle-foreground hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={group}
              className="sr-only"
              value={candidate}
              checked={chosen}
              disabled={disabled}
              onChange={() => onChange(candidate)}
            />
            {KIND_LABELS[candidate]}
          </label>
        );
      })}
    </div>
  );
}

export interface NodeDraftCardProps {
  draft: NodeDraft;
  anchorTitle: string | null;
  disabled: boolean;
  onSubmit: (args: { title: string; kind: NodeKind }) => void;
  onCancel: () => void;
}

export function NodeDraftCard({
  draft,
  anchorTitle,
  disabled,
  onSubmit,
  onCancel,
}: NodeDraftCardProps) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<NodeKind>("markdown");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const named = title.trim().length > 0;

  return (
    <div
      role="dialog"
      aria-label="New task"
      className="rounded-md border border-dashed border-ring bg-card p-2.5 shadow-xs"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!named) return;
          onSubmit({ title: title.trim(), kind });
        }}
      >
        <Input
          ref={inputRef}
          aria-label="New task title"
          placeholder="Name this task"
          className="h-auto w-full rounded-none border-0 bg-transparent px-0 py-0 text-sm font-medium shadow-none placeholder:text-subtle-foreground focus-visible:ring-0 max-md:pointer-coarse:h-auto max-md:pointer-coarse:text-sm"
          value={title}
          disabled={disabled}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <KindChoice kind={kind} disabled={disabled} onChange={setKind} />
          {named ? (
            <button
              type="submit"
              disabled={disabled}
              className="shrink-0 text-2xs font-medium uppercase tracking-wide text-timeline-accent hover:underline focus-visible:underline focus-visible:outline-none"
            >
              Add
            </button>
          ) : (
            <span className="shrink-0 text-2xs text-subtle-foreground">
              esc
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-2xs text-subtle-foreground">
          {relationLabel(draft, anchorTitle)}
        </p>
      </form>
    </div>
  );
}
