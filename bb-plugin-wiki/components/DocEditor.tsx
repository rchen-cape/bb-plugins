import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import type { DocDetail } from "../contract";
import { ErrorText, Kbd } from "./bits";
import { errorMessage, useWikiRpc } from "./hooks";

interface Base {
  content: string;
  sha256: string;
}

function isSaveShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return event.key === "Enter" || event.key.toLowerCase() === "s";
}

function ConflictBanner({ busy, onReload, onOverwrite }: { busy: boolean; onReload: () => void; onOverwrite: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-attention px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-foreground">
        Changed on disk. <span className="text-muted-foreground">Reload to see the new version, or overwrite it with your edits.</span>
      </span>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onReload}>
        Reload
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onOverwrite}>
        Overwrite
      </Button>
    </div>
  );
}

export function DocEditor({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const rpc = useWikiRpc();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(doc.content);
  const [base, setBase] = useState<Base>({ content: doc.content, sha256: doc.sha256 });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== base.content;

  useEffect(() => textarea.current?.focus(), []);

  useEffect(() => {
    if (doc.sha256 === base.sha256) return;
    if (dirty) {
      setConflict(true);
      return;
    }
    setDraft(doc.content);
    setBase({ content: doc.content, sha256: doc.sha256 });
  }, [doc.sha256]);

  const write = async (content: string, expectedSha256: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("saveDoc", { slug: doc.slug, content, expectedSha256 });
      if (result.outcome === "conflict") {
        setConflict(true);
        setSaving(false);
        return;
      }
      toast.success(`Saved ${doc.title}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  const save = () => {
    if (saving) return;
    if (!dirty && !conflict) {
      onClose();
      return;
    }
    void write(draft, base.sha256);
  };

  const latest = () => rpc.call("doc", { slug: doc.slug });

  const reload = async () => {
    setSaving(true);
    try {
      const current = await latest();
      if (current === null) {
        setError("This doc was deleted on disk. Overwrite to save your version.");
        return;
      }
      setDraft(current.content);
      setBase({ content: current.content, sha256: current.sha256 });
      setConflict(false);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const overwrite = async () => {
    setSaving(true);
    try {
      const current = await latest();
      await write(draft, current?.sha256 ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm("Discard your changes to this doc?")) return;
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (!isSaveShortcut(event)) return;
    event.preventDefault();
    save();
  };

  return (
    <form
      className="flex flex-col gap-3"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">Editing {doc.title}</h1>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <Kbd>⌘S</Kbd> save <Kbd>Esc</Kbd> cancel
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {conflict ? <ConflictBanner busy={saving} onReload={() => void reload()} onOverwrite={() => void overwrite()} /> : null}
      {error === null ? null : <ErrorText>{error}</ErrorText>}
      <textarea
        ref={textarea}
        value={draft}
        aria-label={`Markdown for ${doc.title}`}
        spellCheck
        rows={28}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-96 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </form>
  );
}
