import { useState, type ReactNode } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Draft, Finding, ReviewThread, Side } from "../contract";
import { cn } from "../lib/utils";
import { Avatar, SeverityBadge, lineLabel, relativeTime } from "./bits";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { errorMessage } from "./cache";

export interface CommentTarget {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
}

export interface Composer extends CommentTarget {
  draftId: string | null;
  initialBody: string;
}

export interface ReviewActions {
  saveDraft(composer: Composer, body: string): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  postComment(target: CommentTarget, body: string): Promise<void>;
  reply(commentId: number, body: string): Promise<void>;
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  dismissFinding(id: string, dismissed: boolean): Promise<void>;
  composeFromFinding(finding: Finding): void;
  editDraft(draft: Draft): void;
  closeComposer(): void;
}

export type AnnotationData =
  | { kind: "finding"; finding: Finding; outdated: boolean }
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "draft"; draft: Draft }
  | { kind: "composer"; composer: Composer; suggestion: string | null };

export function annotationKey(data: AnnotationData): string {
  switch (data.kind) {
    case "finding":
      return `finding:${data.finding.id}`;
    case "thread":
      return `thread:${data.thread.id}`;
    case "draft":
      return `draft:${data.draft.id}`;
    case "composer":
      return `composer:${data.composer.draftId ?? "new"}`;
  }
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("mx-2 my-1.5 whitespace-normal rounded-lg border bg-background p-3 font-sans text-sm text-foreground shadow-xs", className)}>
      {children}
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = (label: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(label);
    action()
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setBusy(null));
  };
  return { busy, run };
}

const SIDE_LABEL: Record<Side, string> = { additions: "new", deletions: "old" };

export function FindingCard({ finding, outdated, actions }: { finding: Finding; outdated: boolean; actions: ReviewActions }) {
  const { busy, run } = useBusy();
  return (
    <Card className="border-amber-500/50 bg-amber-500/5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon name="Bot" className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        <SeverityBadge severity={finding.severity} />
        <span className="min-w-0 flex-1 font-medium">{finding.title}</span>
        {outdated ? (
          <span className="rounded border border-border px-1 text-[10px] text-muted-foreground" title="Recorded on an older head commit">
            outdated
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">{lineLabel(finding.startLine, finding.endLine)}</span>
      </div>
      {finding.body.trim().length === 0 ? null : <Markdown content={finding.body} className="mt-2 text-sm" />}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="outline" className="h-7" onClick={() => actions.composeFromFinding(finding)}>
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-muted-foreground"
          disabled={busy !== null}
          onClick={() => run("dismiss", () => actions.dismissFinding(finding.id, !finding.dismissed))}
        >
          {finding.dismissed ? "Restore" : "Dismiss"}
        </Button>
      </div>
    </Card>
  );
}

export function ThreadCard({ thread, actions }: { thread: ReviewThread; actions: ReviewActions }) {
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState("");
  const { busy, run } = useBusy();
  const first = thread.comments[0];
  if (first === undefined) return null;
  const sendReply = () =>
    run("reply", async () => {
      await actions.reply(first.databaseId, reply);
      setReply("");
    });
  return (
    <Card className={cn(thread.isResolved && "opacity-80")}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
          <Avatar person={first.author} />
          <span className="truncate font-medium">{first.author.login}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
          </span>
          {thread.isResolved ? <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">resolved</span> : null}
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={busy !== null}
          onClick={() => run("resolve", () => actions.resolveThread(thread.id, !thread.isResolved))}
        >
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </Button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          onClick={() => {
            if (!navigate.openUrl(first.url)) window.open(first.url, "_blank", "noopener");
          }}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </button>
      </div>
      {open ? (
        <div className="mt-2 space-y-3">
          {thread.comments.map((comment) => (
            <div key={comment.id} className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Avatar person={comment.author} />
                <span className="font-medium text-foreground">{comment.author.login}</span>
                <span title={new Date(comment.createdAt).toLocaleString()}>{relativeTime(comment.createdAt)}</span>
              </div>
              <Markdown content={comment.body} className="text-sm" />
            </div>
          ))}
          <div className="flex items-end gap-2">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reply.trim().length > 0) sendReply();
              }}
              rows={reply.includes("\n") ? 4 : 1}
              placeholder="Reply…"
              aria-label="Reply"
              className="min-h-8 flex-1 resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button size="sm" className="h-8" disabled={busy !== null || reply.trim().length === 0} onClick={sendReply}>
              {busy === "reply" ? "Sending…" : "Reply"}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function DraftCard({ draft, actions }: { draft: Draft; actions: ReviewActions }) {
  const { busy, run } = useBusy();
  return (
    <Card className="border-violet-500/50 bg-violet-500/5">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-violet-500/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
          Pending
        </span>
        <span className="flex-1 text-xs text-muted-foreground">
          {lineLabel(draft.startLine, draft.endLine)} ({SIDE_LABEL[draft.side]})
        </span>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => actions.editDraft(draft)}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          disabled={busy !== null}
          onClick={() => run("delete", () => actions.deleteDraft(draft.id))}
        >
          Delete
        </Button>
      </div>
      <Markdown content={draft.body} className="mt-2 text-sm" />
    </Card>
  );
}

export function CommentEditor({ composer, suggestion, actions }: { composer: Composer; suggestion: string | null; actions: ReviewActions }) {
  const [body, setBody] = useState(composer.initialBody);
  const { busy, run } = useBusy();
  const empty = body.trim().length === 0;
  const save = () => run("draft", () => actions.saveDraft(composer, body));
  const post = () => run("post", () => actions.postComment(composer, body));
  return (
    <Card className="border-sky-500/50">
      <p className="mb-2 text-xs text-muted-foreground">
        {composer.draftId === null ? "Comment on" : "Edit pending comment on"} {lineLabel(composer.startLine, composer.endLine)} (
        {SIDE_LABEL[composer.side]})
      </p>
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !empty) save();
          if (event.key === "Escape") actions.closeComposer();
        }}
        rows={5}
        placeholder="Leave a comment. Markdown works. ⌘↵ adds it to your review."
        aria-label="Comment"
        className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {suggestion === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            title="Insert a GitHub suggested change for these lines"
            onClick={() => setBody((value) => `${value}${value.length > 0 && !value.endsWith("\n") ? "\n" : ""}\`\`\`suggestion\n${suggestion}\n\`\`\`\n`)}
          >
            <Icon name="FileDiff" className="size-3.5" />
            Suggest change
          </Button>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-7" onClick={actions.closeComposer}>
          Cancel
        </Button>
        {composer.draftId === null ? (
          <Button size="sm" variant="outline" className="h-7" disabled={empty || busy !== null} onClick={post}>
            {busy === "post" ? "Posting…" : "Comment now"}
          </Button>
        ) : null}
        <Button size="sm" className="h-7" disabled={empty || busy !== null} onClick={save}>
          {busy === "draft" ? "Saving…" : composer.draftId === null ? "Add to review" : "Update"}
        </Button>
      </div>
    </Card>
  );
}

export function AnnotationView({ data, actions }: { data: AnnotationData; actions: ReviewActions }) {
  switch (data.kind) {
    case "finding":
      return <FindingCard finding={data.finding} outdated={data.outdated} actions={actions} />;
    case "thread":
      return <ThreadCard thread={data.thread} actions={actions} />;
    case "draft":
      return <DraftCard draft={data.draft} actions={actions} />;
    case "composer":
      return <CommentEditor composer={data.composer} suggestion={data.suggestion} actions={actions} />;
  }
}
