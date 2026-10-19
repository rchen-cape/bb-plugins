import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Suggestion } from "../contract";
import { normalizeTag } from "../lib/slug";
import { DEFAULT_DOC_TYPE, DEFAULT_HEADING, LIMITS, WIKI_PANEL, type DocType } from "../lib/wiki";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { MOD_KEY_LABEL, isModEnter } from "./ui/shortcut";
import { Textarea } from "./ui/textarea";
import { Kbd, TypeBadge } from "./bits";
import { TypePicker } from "./DocPicker";
import { errorMessage, useWikiRpc } from "./hooks";
import { docSubPath } from "./nav";

interface Draft {
  title: string;
  type: DocType;
  aliases: string[];
  body: string;
}

type Busy = "checking" | "creating" | "adding" | null;

const EMPTY_DRAFT: Draft = { title: "", type: DEFAULT_DOC_TYPE, aliases: [], body: "" };

function addAliases(current: readonly string[], raw: string): string[] {
  const next = [...current];
  for (const part of raw.split(",")) {
    const alias = normalizeTag(part);
    if (alias !== "" && !next.includes(alias) && next.length < LIMITS.aliases) next.push(alias);
  }
  return next;
}

export function AliasInput({ aliases, onChange }: { aliases: readonly string[]; onChange: (aliases: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (draft.trim() === "") return;
    onChange(addAliases(aliases, draft));
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isModEnter(event)) {
      commit();
    } else if ((event.key === "Enter" || event.key === ",") && !event.metaKey && !event.ctrlKey) {
      if (draft.trim() === "") return;
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && aliases.length > 0) {
      onChange(aliases.slice(0, -1));
    }
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
      {aliases.map((alias) => (
        <span key={alias} className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-foreground">
          @{alias}
          <button
            type="button"
            aria-label={`Remove alias ${alias}`}
            className="-mr-1 cursor-pointer rounded-full p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onChange(aliases.filter((candidate) => candidate !== alias))}
          >
            <Icon name="X" className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={aliases.length === 0 ? "Other names, e.g. cc, config-catalog" : "Add alias"}
        aria-label="Add alias"
        className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function MatchRow({
  suggestion,
  canAdd,
  busy,
  autoFocus,
  onAdd,
  onOpen,
}: {
  suggestion: Suggestion;
  canAdd: boolean;
  busy: boolean;
  autoFocus: boolean;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const heading = suggestion.heading ?? DEFAULT_HEADING;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium text-foreground">{suggestion.title}</span>
          <TypeBadge type={suggestion.type} />
        </p>
        {suggestion.reason === "" ? null : <p className="mt-0.5 text-xs text-muted-foreground">{suggestion.reason}</p>}
      </div>
      {canAdd ? (
        <Button ref={ref} type="button" size="sm" disabled={busy} onClick={onAdd}>
          Add to {suggestion.title} under {heading}
        </Button>
      ) : (
        <Button ref={ref} type="button" size="sm" variant="outline" onClick={onOpen}>
          Open {suggestion.title}
        </Button>
      )}
    </li>
  );
}

function Matches({
  suggestions,
  canAdd,
  busy,
  onAdd,
  onOpen,
  onCreate,
  onBack,
}: {
  suggestions: readonly Suggestion[];
  canAdd: boolean;
  busy: Busy;
  onAdd: (suggestion: Suggestion) => void;
  onOpen: (suggestion: Suggestion) => void;
  onCreate: () => void;
  onBack: () => void;
}) {
  return (
    <section aria-label="Similar docs" className="rounded-lg border border-border bg-surface-raised p-3">
      <p className="text-sm font-medium text-foreground">This might already belong in …</p>
      <ul className="mt-1 divide-y divide-border">
        {suggestions.map((suggestion, index) => (
          <MatchRow
            key={suggestion.slug}
            suggestion={suggestion}
            canAdd={canAdd}
            busy={busy !== null}
            autoFocus={index === 0}
            onAdd={() => onAdd(suggestion)}
            onOpen={() => onOpen(suggestion)}
          />
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Keep editing
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onCreate}>
          {busy === "creating" ? "Creating…" : "Create new doc anyway"}
        </Button>
      </div>
    </section>
  );
}

export function NewDocView({ onDone, onCancel }: { onDone: (slug: string) => void; onCancel: () => void }) {
  const rpc = useWikiRpc();
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const latest = useRef(draft);
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const title = draft.title.trim();
  const canCheck = title !== "" && busy === null;

  const edit = (patch: Partial<Draft>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setDraft(next);
    setMatches(null);
  };

  const run = async (kind: Exclude<Busy, null>, task: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const createDoc = async () => {
    const { type, aliases, body } = latest.current;
    const doc = await rpc.call("createDoc", { title: latest.current.title.trim(), type, aliases, body });
    toast.success(`Created ${doc.title}`);
    onDone(doc.slug);
  };

  const create = () => run("creating", createDoc);

  const addTo = (suggestion: Suggestion) =>
    run("adding", async () => {
      const result = await rpc.call("addToDoc", {
        target: { kind: "existing", slug: suggestion.slug },
        heading: suggestion.heading ?? DEFAULT_HEADING,
        text: latest.current.body,
        media: [],
        source: { kind: "manual" },
      });
      toast.success(`Added to ${result.title}`);
      onDone(result.slug);
    });

  const check = () => {
    if (!canCheck) return;
    void run("checking", async () => {
      const { suggestions } = await rpc.call("suggest", { text: latest.current.body, title: latest.current.title.trim() });
      if (suggestions.length > 0) setMatches(suggestions);
      else await createDoc();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isModEnter(event) || matches !== null) return;
    event.preventDefault();
    check();
  };

  return (
    <div className="w-full">
      <h1 className="text-lg font-semibold text-foreground">New doc</h1>
      <p className="mt-1 text-sm text-muted-foreground">Write it in your own words. The Wiki checks for a doc that already covers it before creating one.</p>
      <div className="mt-4 grid gap-4" onKeyDown={onKeyDown}>
        <Field label="Title">
          <Input value={draft.title} maxLength={LIMITS.title} autoFocus placeholder="e.g. Adding config catalog" onChange={(event) => edit({ title: event.target.value })} />
        </Field>
        <Field label="Type" group>
          <TypePicker value={draft.type} onChange={(type) => edit({ type })} />
        </Field>
        <Field label="Aliases" group hint="Other names you use for it. @alias in your daily notes routes here.">
          <AliasInput aliases={draft.aliases} onChange={(aliases) => edit({ aliases })} />
        </Field>
        <Field label="Body">
          <Textarea
            value={draft.body}
            maxLength={LIMITS.text}
            spellCheck={false}
            placeholder="Markdown"
            className="min-h-48 resize-y font-mono text-xs leading-5"
            onChange={(event) => edit({ body: event.target.value })}
          />
        </Field>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {matches === null ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              <Kbd>{MOD_KEY_LABEL}</Kbd> <Kbd>Enter</Kbd> to check
            </span>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" disabled={!canCheck} onClick={check}>
              {busy === "checking" || busy === "creating" ? "Checking…" : "Check for existing docs"}
            </Button>
          </div>
        ) : (
          <Matches
            suggestions={matches}
            canAdd={draft.body.trim() !== ""}
            busy={busy}
            onAdd={(suggestion) => void addTo(suggestion)}
            onOpen={(suggestion) => navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(suggestion.slug) })}
            onCreate={() => void create()}
            onBack={() => setMatches(null)}
          />
        )}
      </div>
    </div>
  );
}
