import { useId, type Ref } from "react";
import type { WikiSuggestion } from "../contract";
import { INBOX_DESCRIPTION, KindPicker, WikiNotice, type KindVia } from "./SendParts";
import type { WikiDestinationState } from "./use-wiki-destination";
import { inboxBlocked, type Kind, type WikiStatus } from "./wiki-destination";
import { DocSearch, HeadingPicker } from "./WikiDocField";

function DocFields({ status, destination, suggestions, focusSearch, searchRef }: {
  status: WikiStatus;
  destination: WikiDestinationState;
  suggestions: readonly WikiSuggestion[];
  focusSearch: boolean;
  searchRef: Ref<HTMLInputElement>;
}) {
  if (status.kind !== "ready" && status.kind !== "loading") return null;
  return (
    <div className="grid gap-3">
      <DocSearch
        docs={status.kind === "ready" ? status.docs : undefined}
        suggestions={suggestions}
        value={destination.choice}
        autoFocus={focusSearch}
        inputRef={searchRef}
        onChange={destination.pick}
      />
      {status.kind === "ready" ? (
        <HeadingPicker doc={destination.doc} preferred={destination.choice?.heading ?? null} value={destination.heading} onChange={destination.setHeading} />
      ) : null}
    </div>
  );
}

export function WhereSection({ kind, status, destination, suggestions, focusSearch, searchRef, onKind }: {
  kind: Kind;
  status: WikiStatus;
  destination: WikiDestinationState;
  suggestions: readonly WikiSuggestion[];
  focusSearch: boolean;
  searchRef: Ref<HTMLInputElement>;
  onKind: (kind: Kind, via: KindVia) => void;
}) {
  const hintId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-muted-foreground">Where</span>
        <KindPicker value={kind} inboxBlocked={inboxBlocked(status)} blockedHintId={hintId} onChange={onKind} />
      </div>
      <WikiNotice status={status} kind={kind} blockedHintId={hintId} />
      {kind === "inbox" ? (
        <p className="text-xs text-muted-foreground">{INBOX_DESCRIPTION}</p>
      ) : (
        <DocFields status={status} destination={destination} suggestions={suggestions} focusSearch={focusSearch} searchRef={searchRef} />
      )}
    </div>
  );
}
