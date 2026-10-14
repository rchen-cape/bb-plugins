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
          <li>
            If a check fails, it may fix it with edits that don't change behavior, such as formatting, lint, or import fixes. If a check
            still fails or needs a logic change, it stops without committing or pushing.
          </li>
          <li>
            If they pass, it commits the accepted changes, merges new commits from <span className="font-mono">{branch}</span>, and pushes
            to <span className="font-mono">{branch}</span>.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Its fixes go in a separate commit. Every commit is signed with your git signing key, and it stops before pushing if one is
          not. It does not change code logic or tests, force-push, or merge the pull request.
        </p>
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
