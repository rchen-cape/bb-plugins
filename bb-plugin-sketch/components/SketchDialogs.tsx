import { useState, type FormEvent } from "react";
import { titleSchema } from "../contract";
import { LIMITS } from "../lib/sketch.js";
import { ErrorText, errorMessage, Kbd } from "./bits";
import { useLoaded, useSketchRpc } from "./hooks";
import { shortcutGroups } from "./shortcuts";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

function useFolder(): string {
  const rpc = useSketchRpc();
  const status = useLoaded(() => rpc.call("status", {}), [rpc]);
  return status.value?.directory ?? "your sketch folder";
}

function closeOn(onClose: () => void) {
  return (open: boolean) => {
    if (!open) onClose();
  };
}

export function RenameDialog({ title, onRename, onClose }: { title: string; onRename: (title: string) => Promise<void>; onClose: () => void }) {
  const folder = useFolder();
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = titleSchema.safeParse(value);
  const unchanged = parsed.success && parsed.data === title;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.success || unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(parsed.data);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={closeOn(onClose)}>
      <DialogContent className="max-w-md">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename sketch</DialogTitle>
            <DialogDescription>The name is also the file name in {folder}.</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={value} maxLength={LIMITS.title} aria-label="Sketch name" onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
          {error === null ? null : <ErrorText>{error}</ErrorText>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!parsed.success || unchanged || busy}>
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({ title, onDelete, onClose }: { title: string; onDelete: () => Promise<void>; onClose: () => void }) {
  const folder = useFolder();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={closeOn(onClose)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{title}”?</DialogTitle>
          <DialogDescription>
            This deletes {title}.excalidraw from {folder}. You can't undo this.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : <ErrorText>{error}</ErrorText>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={closeOn(onClose)}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys work while the canvas has focus. Click it first if they don't.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {shortcutGroups().map((group) => (
            <section key={group.title} aria-label={group.title} className="grid content-start gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
              <dl className="grid gap-1">
                {group.rows.map(([label, keys]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-sm">
                    <dt className="text-foreground">{label}</dt>
                    <dd>
                      <Kbd className="h-auto min-h-5 px-1.5 py-0.5 text-right">{keys}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
