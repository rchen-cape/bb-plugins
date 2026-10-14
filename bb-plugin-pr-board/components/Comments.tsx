import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { Markdown, experimental_useCodeTheme, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ConversationComment, PullDetail, ReviewState, ReviewThread, Suggestion, SuggestionEdit, rpcContract } from "../contract";
import { cn } from "../lib/utils";
import { Avatar, relativeTime } from "./bits";
import { errorMessage } from "./cache";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

const COLLAPSE_LINES = 10;

export interface CommentActions {
  reply(commentId: number, body: string): Promise<void>;
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  postConversation(body: string): Promise<void>;
  applySuggestion(id: string): Promise<void>;
  setReplyState(id: string, state: Suggestion["replyState"]): Promise<void>;
  setChangeState(id: string, state: "open" | "dismissed"): Promise<void>;
  viewInDiff(thread: ReviewThread): void;
  openThread(threadId: string): void;
}

export interface CommentFocus {
  commentId: string;
  seq: number;
}

type Preview = { files: Array<{ path: string; before: string | null; after: string }>; error: string | null };

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

function openExternal(navigate: ReturnType<typeof useBbNavigate>, url: string) {
  if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
}

function countLines(diff: FileDiffMetadata): { additions: number; deletions: number } {
  return diff.hunks.reduce(
    (total, hunk) => ({ additions: total.additions + hunk.additionLines, deletions: total.deletions + hunk.deletionLines }),
    { additions: 0, deletions: 0 },
  );
}

function diffOf(path: string, before: string, after: string): FileDiffMetadata {
  return parseDiffFromFile({ name: path, contents: before }, { name: path, contents: after });
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function editDiff(edit: SuggestionEdit): FileDiffMetadata {
  return edit.find === "" ? diffOf(edit.path, "", edit.replace) : diffOf(edit.path, withNewline(edit.find), withNewline(edit.replace));
}

function editStats(edits: readonly SuggestionEdit[]): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const edit of edits) {
    const counted = countLines(editDiff(edit));
    const total = stats.get(edit.path) ?? { additions: 0, deletions: 0 };
    stats.set(edit.path, { additions: total.additions + counted.additions, deletions: total.deletions + counted.deletions });
  }
  return stats;
}

export function suggestionsByComment(suggestions: readonly Suggestion[]): Map<string, Suggestion[]> {
  const grouped = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions) grouped.set(suggestion.commentId, [...(grouped.get(suggestion.commentId) ?? []), suggestion]);
  return grouped;
}

export function openSuggestionParts(suggestion: Suggestion): number {
  return Number(suggestion.edits.length > 0 && suggestion.changeState === "open") + Number(suggestion.reply !== null && suggestion.replyState === "open");
}

function Stats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

function SuggestedDiff({ diff }: { diff: FileDiffMetadata }) {
  const codeTheme = experimental_useCodeTheme();
  const options = useMemo(
    (): NonNullable<FileDiffProps<undefined>["options"]> => ({
      theme: codeTheme.name,
      themeType: codeTheme.mode,
      diffStyle: "unified",
      overflow: "wrap",
      disableFileHeader: true,
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
    }),
    [codeTheme.mode, codeTheme.name],
  );
  return <FileDiff fileDiff={diff} options={options} disableWorkerPool />;
}

function ChangeFiles({ suggestion, version }: { suggestion: Suggestion; version: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const stats = useMemo(() => editStats(suggestion.edits), [suggestion.edits]);
  const paths = [...stats.keys()];
  const changed = [...stats.values()].reduce((total, file) => total + file.additions + file.deletions, 0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => (paths.length > 1 || changed > COLLAPSE_LINES ? new Set() : new Set(paths)));
  const [loaded, setLoaded] = useState<{ version: number; preview: Preview } | null>(null);
  const preview = loaded?.version === version ? loaded.preview : null;
  const wanted = open.size > 0;
  const diffs = useMemo(
    () => new Map((preview?.files ?? []).map((file) => [file.path, diffOf(file.path, file.before ?? "", file.after)])),
    [preview],
  );
  useEffect(() => {
    if (!wanted || preview !== null) return;
    let live = true;
    rpc.call("suggestionFiles", { id: suggestion.id }).then(
      (result) => live && setLoaded({ version, preview: result }),
      (error: unknown) => live && setLoaded({ version, preview: { files: [], error: errorMessage(error) } }),
    );
    return () => {
      live = false;
    };
  }, [preview, rpc, suggestion.id, version, wanted]);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {paths.map((path) => {
        const expanded = open.has(path);
        const diff = diffs.get(path);
        const counted = diff === undefined ? (stats.get(path) ?? { additions: 0, deletions: 0 }) : countLines(diff);
        return (
          <div key={path} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(path)) next.add(path);
                  return next;
                })
              }
              className="flex w-full items-center gap-1.5 bg-muted/40 px-2 py-1 text-left font-mono text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{path}</span>
              <Stats {...counted} />
            </button>
            {!expanded ? null : preview === null ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Loading the diff…</p>
            ) : diff !== undefined ? (
              <SuggestedDiff diff={diff} />
            ) : (
              <div>
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {preview.error ?? "This file is missing from the preview."} Showing only the changed text, with line numbers counted from the change.
                </p>
                {suggestion.edits
                  .filter((edit) => edit.path === path)
                  .map((edit, index) => (
                    <SuggestedDiff key={index} diff={editDiff(edit)} />
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SuggestionBlock({
  suggestion,
  version,
  showDismissed,
  actions,
  onUseReply,
}: {
  suggestion: Suggestion;
  version: number;
  showDismissed: boolean;
  actions: CommentActions;
  onUseReply(id: string, text: string): void;
}) {
  const { busy, run } = useBusy();
  const hasChange = suggestion.edits.length > 0 && (suggestion.changeState !== "dismissed" || showDismissed);
  const hasReply = suggestion.reply !== null && (suggestion.replyState !== "dismissed" || showDismissed);
  if (!hasChange && !hasReply) return null;
  return (
    <div className="space-y-2 rounded-md border border-sky-500/40 bg-sky-500/5 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Icon name="Bot" className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
        <span className="min-w-0">{suggestion.summary}</span>
      </p>
      {hasChange ? (
        <div className={cn("space-y-1.5", suggestion.changeState === "dismissed" && "opacity-60")}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Suggested change</p>
          {suggestion.changeState === "applied" ? (
            <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Icon name="CircleCheck" className="size-3.5" aria-hidden />
              Applied to the address thread's worktree. Submit Address commits and pushes it.
            </p>
          ) : (
            <ChangeFiles suggestion={suggestion} version={version} />
          )}
          {suggestion.changeState === "open" ? (
            <div className="flex gap-1.5">
              <Button size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => run("apply", () => actions.applySuggestion(suggestion.id))}>
                <Icon name="Check" className="size-3.5" />
                {busy === "apply" ? "Applying…" : "Accept change"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground"
                disabled={busy !== null}
                onClick={() => run("dismiss-change", () => actions.setChangeState(suggestion.id, "dismissed"))}
              >
                Dismiss
              </Button>
            </div>
          ) : suggestion.changeState === "dismissed" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy !== null}
              onClick={() => run("restore-change", () => actions.setChangeState(suggestion.id, "open"))}
            >
              Restore
            </Button>
          ) : null}
        </div>
      ) : null}
      {hasReply && suggestion.reply !== null ? (
        <div className={cn("space-y-1.5", suggestion.replyState !== "open" && "opacity-60")}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Suggested reply{suggestion.replyState === "used" ? " · used" : ""}
          </p>
          <div className="rounded border-l-2 border-sky-500/50 bg-background px-2.5 py-1.5">
            <Markdown content={suggestion.reply} className="text-sm" />
          </div>
          <div className="flex gap-1.5">
            {suggestion.replyState === "dismissed" ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={busy !== null}
                onClick={() => run("restore-reply", () => actions.setReplyState(suggestion.id, "open"))}
              >
                Restore
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={busy !== null}
                  onClick={() => {
                    if (suggestion.reply !== null) onUseReply(suggestion.id, suggestion.reply);
                  }}
                >
                  <Icon name="CornerDownLeft" className="size-3.5" />
                  {suggestion.replyState === "used" ? "Use again" : "Use reply"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  disabled={busy !== null}
                  onClick={() => run("dismiss-reply", () => actions.setReplyState(suggestion.id, "dismissed"))}
                >
                  Dismiss
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReplyBox({
  value,
  onChange,
  onSubmit,
  busy,
  label,
  inputRef,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  busy: boolean;
  label: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const empty = value.trim().length === 0;
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !empty) onSubmit();
        }}
        rows={value.includes("\n") || value.length > 80 ? 4 : 1}
        placeholder={`${label}…`}
        aria-label={label}
        className="min-h-8 flex-1 resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button size="sm" className="h-8" disabled={busy || empty} onClick={onSubmit}>
        {busy ? "Sending…" : label}
      </Button>
    </div>
  );
}

function useReplyDraft(actions: CommentActions) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  return {
    text,
    setText,
    input,
    use(id: string, reply: string) {
      setText(reply);
      setSource(id);
      input.current?.focus();
    },
    async send(post: (body: string) => Promise<void>) {
      await post(text);
      setText("");
      setSource(null);
      if (source !== null) await actions.setReplyState(source, "used");
    },
  };
}

function useFocusScroll(focused: CommentFocus | null) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused !== null) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focused?.seq]);
  return ref;
}

function CommentBody({ author, createdAt, body, note }: { author: ConversationComment["author"]; createdAt: string; body: string; note?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Avatar person={author} />
        <span className="font-medium text-foreground">{author.login}</span>
        {note === undefined ? null : <span>{note}</span>}
        <span title={new Date(createdAt).toLocaleString()}>{relativeTime(createdAt)}</span>
      </div>
      <Markdown content={body} className="text-sm" />
    </div>
  );
}

function CardShell({ focused, children }: { focused: CommentFocus | null; children: ReactNode }) {
  const ref = useFocusScroll(focused);
  return (
    <article
      ref={ref}
      className={cn("scroll-mt-3 space-y-2.5 rounded-lg border border-border bg-background p-3 text-sm shadow-xs", focused !== null && "ring-2 ring-sky-500/60")}
    >
      {children}
    </article>
  );
}

function CodeCommentCard({
  thread,
  suggestions,
  version,
  focused,
  showDismissed,
  actions,
}: {
  thread: ReviewThread;
  suggestions: readonly Suggestion[];
  version: number;
  focused: CommentFocus | null;
  showDismissed: boolean;
  actions: CommentActions;
}) {
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(!thread.isResolved || focused !== null);
  const draft = useReplyDraft(actions);
  const { busy, run } = useBusy();
  const first = thread.comments[0];
  useEffect(() => {
    if (focused !== null) setOpen(true);
  }, [focused?.seq]);
  if (first === undefined) return null;
  const range = thread.line === null ? "" : thread.startLine !== null && thread.startLine !== thread.line ? `:${thread.startLine}–${thread.line}` : `:${thread.line}`;
  return (
    <CardShell focused={focused}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs" title={thread.path}>
            {thread.path}
            {range}
          </span>
          {thread.isOutdated ? <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">outdated</span> : null}
          {thread.isResolved ? <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">resolved</span> : null}
        </button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => actions.viewInDiff(thread)}>
          View in diff
        </Button>
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
          onClick={() => openExternal(navigate, first.url)}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </button>
      </div>
      {open ? (
        <>
          {thread.comments.map((comment) => (
            <CommentBody key={comment.id} author={comment.author} createdAt={comment.createdAt} body={comment.body} />
          ))}
          {suggestions.map((suggestion) => (
            <SuggestionBlock
              key={suggestion.id}
              suggestion={suggestion}
              version={version}
              showDismissed={showDismissed}
              actions={actions}
              onUseReply={draft.use}
            />
          ))}
          <ReplyBox
            value={draft.text}
            onChange={draft.setText}
            busy={busy === "reply"}
            label="Reply"
            inputRef={draft.input}
            onSubmit={() => run("reply", () => draft.send((body) => actions.reply(first.databaseId, body)))}
          />
        </>
      ) : null}
    </CardShell>
  );
}

function ConversationCard({
  comment,
  mine,
  suggestions,
  version,
  focused,
  showDismissed,
  actions,
}: {
  comment: ConversationComment;
  mine: boolean;
  suggestions: readonly Suggestion[];
  version: number;
  focused: CommentFocus | null;
  showDismissed: boolean;
  actions: CommentActions;
}) {
  const navigate = useBbNavigate();
  const draft = useReplyDraft(actions);
  const { busy, run } = useBusy();
  return (
    <CardShell focused={focused}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <CommentBody author={comment.author} createdAt={comment.createdAt} body={comment.body} note={comment.kind === "review" ? "reviewed" : undefined} />
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          onClick={() => openExternal(navigate, comment.url)}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </button>
      </div>
      {suggestions.map((suggestion) => (
        <SuggestionBlock
          key={suggestion.id}
          suggestion={suggestion}
          version={version}
          showDismissed={showDismissed}
          actions={actions}
          onUseReply={draft.use}
        />
      ))}
      {mine ? null : (
        <ReplyBox
          value={draft.text}
          onChange={draft.setText}
          busy={busy === "post"}
          label="Comment"
          inputRef={draft.input}
          onSubmit={() => run("post", () => draft.send((body) => actions.postConversation(body)))}
        />
      )}
    </CardShell>
  );
}

function sortThreads(threads: readonly ReviewThread[]): ReviewThread[] {
  return [...threads].sort(
    (left, right) =>
      Number(left.isResolved) - Number(right.isResolved) || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0),
  );
}

function AddressStatus({ review, actions }: { review: ReviewState; actions: CommentActions }) {
  const { threadId, running } = review.addressAgent;
  const open = review.suggestions.reduce((total, suggestion) => total + openSuggestionParts(suggestion), 0);
  const text =
    threadId === null
      ? "Click Address comments to have an agent suggest code changes and replies for these comments. Nothing changes until you accept a suggestion."
      : running
        ? "The address thread is working. Its suggestions appear under each comment when it records them."
        : review.suggestions.length === 0
          ? "The address thread has not recorded any suggestions yet."
          : `${open} open suggestion${open === 1 ? "" : "s"}. Accepted changes go to the address thread's worktree until you click Submit Address.`;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden /> : null}
      <span className="min-w-0 flex-1">{text}</span>
      {threadId === null ? null : (
        <Button size="sm" variant="ghost" className="h-6 shrink-0 text-xs" onClick={() => actions.openThread(threadId)}>
          Open thread
        </Button>
      )}
    </div>
  );
}

export function CommentsView({
  detail,
  review,
  focus,
  actions,
}: {
  detail: PullDetail;
  review: ReviewState;
  focus: CommentFocus | null;
  actions: CommentActions;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  const grouped = useMemo(() => suggestionsByComment(review.suggestions), [review.suggestions]);
  const threads = useMemo(() => sortThreads(detail.threads.filter((thread) => thread.comments.length > 0)), [detail.threads]);
  const dismissed = review.suggestions.reduce(
    (total, suggestion) =>
      total + Number(suggestion.edits.length > 0 && suggestion.changeState === "dismissed") + Number(suggestion.reply !== null && suggestion.replyState === "dismissed"),
    0,
  );
  const focusFor = (id: string) => (focus !== null && focus.commentId === id ? focus : null);
  const version = review.suggestions.filter((suggestion) => suggestion.changeState === "applied").length;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <AddressStatus review={review} actions={actions} />
      {dismissed > 0 ? (
        <button
          type="button"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowDismissed((value) => !value)}
        >
          {showDismissed ? "Hide" : "Show"} {dismissed} dismissed suggestion{dismissed === 1 ? "" : "s"}
        </button>
      ) : null}
      {threads.length + detail.conversation.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">This pull request has no comments yet.</p>
      ) : null}
      {threads.length === 0 ? null : (
        <section className="space-y-2" aria-label="Code comments">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code comments</h2>
          {threads.map((thread) => (
            <CodeCommentCard
              key={thread.id}
              thread={thread}
              suggestions={grouped.get(thread.id) ?? []}
              version={version}
              focused={focusFor(thread.id)}
              showDismissed={showDismissed}
              actions={actions}
            />
          ))}
        </section>
      )}
      {detail.conversation.length === 0 ? null : (
        <section className="space-y-2" aria-label="Conversation">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversation</h2>
          {detail.conversation.map((comment) => (
            <ConversationCard
              key={comment.id}
              comment={comment}
              mine={comment.author.login === detail.viewer}
              suggestions={grouped.get(comment.id) ?? []}
              version={version}
              focused={focusFor(comment.id)}
              showDismissed={showDismissed}
              actions={actions}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function snippet(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`[\]]/g, "").replace(/\s+/g, " ").trim() || "(no text)";
}

export function commentCount(detail: { threads: readonly ReviewThread[]; conversation: readonly ConversationComment[]; viewer: string }): number {
  return (
    detail.threads.filter((thread) => !thread.isResolved && thread.comments[0] !== undefined && !thread.comments[0].isBot).length +
    detail.conversation.filter((comment) => !comment.isBot && comment.author.login !== detail.viewer).length
  );
}

export function CommentIndex({
  detail,
  suggestions,
  selectedId,
  onSelect,
}: {
  detail: { threads: readonly ReviewThread[]; conversation: readonly ConversationComment[] };
  suggestions: readonly Suggestion[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const grouped = useMemo(() => suggestionsByComment(suggestions), [suggestions]);
  const threads = useMemo(() => sortThreads(detail.threads.filter((thread) => thread.comments.length > 0)), [detail.threads]);
  const items = [
    ...threads.map((thread) => ({
      id: thread.id,
      comment: thread.comments[0]!,
      where: `${thread.path}${thread.line === null ? "" : `:${thread.line}`}`,
      resolved: thread.isResolved,
    })),
    ...detail.conversation.map((comment) => ({ id: comment.id, comment, where: comment.kind === "review" ? "Review" : "Conversation", resolved: false })),
  ];
  if (items.length === 0) return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No comments yet.</p>;
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const open = (grouped.get(item.id) ?? []).reduce((total, suggestion) => total + openSuggestionParts(suggestion), 0);
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={selectedId === item.id ? "true" : undefined}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                selectedId === item.id && "bg-state-active",
                item.resolved && "opacity-60",
              )}
            >
              <span className="flex items-center gap-1.5">
                <Avatar person={item.comment.author} />
                <span className="shrink-0 font-medium">{item.comment.author.login}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{snippet(item.comment.body)}</span>
                {open > 0 ? (
                  <span className="rounded bg-sky-500/15 px-1 text-[10px] font-semibold tabular-nums text-sky-700 dark:text-sky-300" title="Open suggestions">
                    {open}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                {item.where}
                {item.resolved ? " · resolved" : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
