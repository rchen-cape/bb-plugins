import { useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { errorMessage } from "./cache";

export function SubmitAddressDialog({
  open,
  onOpenChange,
  branch,
  acceptedChanges,
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  branch: string;
  acceptedChanges: number;
  onSubmit(): Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const submit = () => {
    setSubmitting(true);
    onSubmit()
      .then(() => onOpenChange(false))
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setSubmitting(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Submit the addressed comments</DialogTitle>
          <DialogDescription>
            {acceptedChanges} accepted change{acceptedChanges === 1 ? "" : "s"} in the address thread's worktree.
          </DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>The address thread runs the PR's GitHub Actions checks on its worktree.</li>
          <li>If any check fails, it stops without committing or pushing.</li>
          <li>
            If they pass, it commits the accepted changes, merges new commits from <span className="font-mono">{branch}</span>, and pushes
            to <span className="font-mono">{branch}</span>.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">It does not edit files, force-push, or merge the pull request.</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={submit}>
            {submitting ? "Sending…" : "Submit Address"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
