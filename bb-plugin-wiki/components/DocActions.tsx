import { createContext, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { usePortalScopeProps } from "../lib/portal-scope";
import { LIMITS, WIKI_PANEL } from "../lib/wiki";
import type { DocSummary } from "../contract";
import { errorMessage, useWikiRpc } from "./hooks";
import { docSubPath } from "./nav";

type DocRef = Pick<DocSummary, "slug" | "title">;

export interface OpenDoc {
  flush(): Promise<boolean>;
  discard(): void;
}

type FlushDoc = () => Promise<boolean>;

interface DocActions {
  rename(doc: DocRef): void;
  remove(doc: DocRef): void;
  registerDoc(slug: string, doc: OpenDoc): () => void;
}

type Pending = { kind: "rename"; doc: DocRef } | { kind: "delete"; doc: DocRef } | null;

const DocActionsContext = createContext<DocActions | null>(null);

export function useDocActions(): DocActions | null {
  return useContext(DocActionsContext);
}

async function saveFirst(doc: DocRef, flush: FlushDoc): Promise<boolean> {
  if (await flush()) return true;
  toast.error(`Couldn't save ${doc.title}, so it wasn't renamed. Resolve the save problem first.`);
  return false;
}

function RenameDialog({ doc, flush, onClose, onRenamed }: { doc: DocRef; flush: FlushDoc; onClose: () => void; onRenamed: (slug: string) => void }) {
  const rpc = useWikiRpc();
  const [title, setTitle] = useState(doc.title);
  const [saving, setSaving] = useState(false);
  const clean = title.trim();
  const canSave = clean !== "" && clean !== doc.title && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      if (!(await saveFirst(doc, flush))) {
        setSaving(false);
        return;
      }
      const renamed = await rpc.call("renameDoc", { slug: doc.slug, title: clean });
      toast.success(`Renamed to ${renamed.title}`);
      onRenamed(renamed.slug);
      onClose();
    } catch (cause) {
      toast.error(errorMessage(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename doc</DialogTitle>
            <DialogDescription>The old name stays as an alias, so your @tags and [[links]] still find this doc.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="New title"
            className="my-4"
            maxLength={LIMITS.title}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ doc, flush, discard, onClose, onDeleted }: { doc: DocRef; flush: FlushDoc; discard: () => void; onClose: () => void; onDeleted: () => void }) {
  const rpc = useWikiRpc();
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      const saved = await flush();
      const deleted = await rpc.call("deleteDoc", { slug: doc.slug });
      if (!saved) discard();
      toast.success(saved ? `Deleted ${deleted.title}` : `Deleted ${deleted.title} and its unsaved edits`);
      onDeleted();
      onClose();
    } catch (cause) {
      toast.error(errorMessage(cause));
      setDeleting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{doc.title}”?</DialogTitle>
          <DialogDescription>
            The file is removed from your Wiki folder. Git history keeps a copy, and inbox cards headed here are switched off.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4 gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={() => void confirm()}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocActionsProvider({ currentSlug, children }: { currentSlug: string | null; children: ReactNode }) {
  const navigate = useBbNavigate();
  const [pending, setPending] = useState<Pending>(null);
  const open = useRef(new Map<string, OpenDoc>());
  const flushFor = (slug: string): FlushDoc => () => open.current.get(slug)?.flush() ?? Promise.resolve(true);
  const discardFor = (slug: string) => () => open.current.get(slug)?.discard();
  const actions = useMemo<DocActions>(
    () => ({
      rename: (doc) => setPending({ kind: "rename", doc }),
      remove: (doc) => setPending({ kind: "delete", doc }),
      registerDoc: (slug, doc) => {
        open.current.set(slug, doc);
        return () => {
          if (open.current.get(slug) === doc) open.current.delete(slug);
        };
      },
    }),
    [],
  );
  const close = () => setPending(null);

  return (
    <DocActionsContext.Provider value={actions}>
      {children}
      {pending?.kind === "rename" ? (
        <RenameDialog
          doc={pending.doc}
          flush={flushFor(pending.doc.slug)}
          onClose={close}
          onRenamed={(slug) => {
            if (currentSlug === pending.doc.slug && slug !== pending.doc.slug) {
              navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(slug), replace: true });
            }
          }}
        />
      ) : null}
      {pending?.kind === "delete" ? (
        <DeleteDialog
          doc={pending.doc}
          flush={flushFor(pending.doc.slug)}
          discard={discardFor(pending.doc.slug)}
          onClose={close}
          onDeleted={() => {
            if (currentSlug === pending.doc.slug) navigate.toPluginPanel(WIKI_PANEL, { subPath: "", replace: true });
          }}
        />
      ) : null}
    </DocActionsContext.Provider>
  );
}

const MENU_ITEM =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";

export function DocContextMenu({ doc, children }: { doc: DocRef | null; children: ReactNode }) {
  const actions = useDocActions();
  const portalProps = usePortalScopeProps();
  if (doc === null || actions === null) return <>{children}</>;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content {...portalProps} className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => actions.rename(doc)}>
            <Icon name="Edit" className="size-4" />
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item className={`${MENU_ITEM} text-destructive`} onSelect={() => actions.remove(doc)}>
            <Icon name="Trash" className="size-4" />
            Delete…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
