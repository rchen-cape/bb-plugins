import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { experimental_useAppPanel, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { UPDATES_CHANNEL } from "../channel";
import type {
  Definition,
  DefinitionResult,
  Finding,
  PullDetail,
  PullFile,
  ReviewEvent,
  ReviewState,
  rpcContract,
} from "../contract";
import type { DiffStyle } from "../highlight";
import { commentableRange } from "../patch";
import { EXPLAIN_THREAD_TAB, type PullRoute } from "../routes";
import { cn } from "../lib/utils";
import type { Composer, ReviewActions } from "./Annotations";
import { ChangeDiffPane, type ChangeTarget } from "./Changes";
import { CommentsView, commentLabels, type CommentActions } from "./Comments";
import { ToolbarToggle } from "./bits";
import { errorMessage, useCached } from "./cache";
import { DiffPane, type DefinitionRequest, type DiffFocus } from "./DiffPane";
import { ExplainBar, selectedTarget, type ExplainTarget } from "./Explain";
import { DefinitionPicker, PeekPane, type PeekTarget } from "./PeekPane";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { SubmitReviewDialog } from "./SubmitReview";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { usePreference } from "./use-preference";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { useWidth } from "./use-width";

type Location =
  | { kind: "diff"; path: string; focus: DiffFocus | null }
  | { kind: "peek"; target: PeekTarget }
  | { kind: "comments"; commentId: string | null; seq: number }
  | { kind: "change"; target: ChangeTarget };

type DiffStylePreference = DiffStyle | "auto";

const HISTORY_LIMIT = 50;
const NARROW_WIDTH = 900;
const SPLIT_MIN_WIDTH = 860;
const DIFF_STYLE_OPTIONS: ReadonlyArray<{ id: DiffStylePreference; label: string; icon: string | null }> = [
  { id: "auto", label: "Auto", icon: null },
  { id: "split", label: "Split", icon: "Columns2" },
  { id: "unified", label: "Unified", icon: "Rows2" },
];
const DIFF_STYLES = DIFF_STYLE_OPTIONS.map((option) => option.id);
const lastPaths = new Map<string, string>();

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function samePull(payload: unknown, pull: PullRoute): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const { repo, number } = payload as { repo?: unknown; number?: unknown };
  return repo === pull.repo && number === pull.number;
}

export function ReviewWorkspace({ pull }: { pull: PullRoute }) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `${pull.repo}#${pull.number}`;
  const force = useRef(false);
  const detail = useCached(`detail:${key}`, () => {
    const refresh = force.current;
    force.current = false;
    return rpc.call("pull", { ...pull, refresh });
  });
  const state = useCached(`state:${key}`, () => rpc.call("reviewState", pull));
  useRealtime(UPDATES_CHANNEL, (payload) => {
    if (samePull(payload, pull)) state.reload();
  });
  const refreshDetail = useCallback(() => {
    force.current = true;
    detail.reload();
  }, [detail.reload]);

  if (detail.value === null) {
    return detail.error === null ? (
      <p className="p-5 text-sm text-muted-foreground">Loading {key}…</p>
    ) : (
      <div className="space-y-3 p-5 text-sm">
        <p className="text-destructive">{detail.error}</p>
        <Button size="sm" variant="outline" onClick={detail.reload}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <Workspace
      key={key}
      detail={detail.value}
      refreshing={detail.refreshing}
      state={state.value}
      reloadState={state.reload}
      refreshDetail={refreshDetail}
    />
  );
}

const EMPTY_STATE: ReviewState = {
  agent: { threadId: null, running: false, findings: 0 },
  findings: [],
  drafts: [],
  addressAgent: { threadId: null, running: false },
  suggestions: [],
  explainAgent: { threadId: null, running: false },
};
const ADDRESS_POLL_MS = 10_000;

function Workspace({
  detail,
  refreshing,
  state,
  reloadState,
  refreshDetail,
}: {
  detail: PullDetail;
  refreshing: boolean;
  state: ReviewState | null;
  reloadState(): void;
  refreshDetail(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pull = { repo: detail.repo, number: detail.number };
  const review = state ?? EMPTY_STATE;
  const pullKey = `${detail.repo}#${detail.number}`;
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const [mainRef, mainWidth] = useWidth<HTMLElement>();
  const narrow = width !== null && width < NARROW_WIDTH;
  const [diffStylePreference, setDiffStylePreference] = usePreference<DiffStylePreference>("diff-style", "auto", DIFF_STYLES);
  const diffStyle: DiffStyle =
    diffStylePreference === "auto" ? (mainWidth !== null && mainWidth < SPLIT_MIN_WIDTH ? "unified" : "split") : diffStylePreference;
  const [wrap, setWrap] = usePreference<boolean>("wrap", false);
  const [sidebarOpen, setSidebarOpen] = usePreference<boolean>("sidebar", true);
  const [filesPanelOpen, setFilesPanelOpen] = usePreference<boolean>("files-panel", false);
  const filesOpen = narrow ? filesPanelOpen : sidebarOpen;
  const setFilesOpen = narrow ? setFilesPanelOpen : setSidebarOpen;
  const [tab, setTab] = useState<SidebarTab>("files");
  const [location, setLocation] = useState<Location | null>(() => {
    const path = lastPaths.get(pullKey);
    return path !== undefined && detail.files.some((file) => file.path === path) ? { kind: "diff", path, focus: null } : null;
  });
  const [history, setHistory] = useState<Location[]>([]);
  const [fullFiles, setFullFiles] = useState<ReadonlySet<string>>(new Set());
  const [composer, setComposer] = useState<Composer | null>(null);
  const [picker, setPicker] = useState<{ result: DefinitionResult; sha: string } | null>(null);
  const [viewed, setViewed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [submitOpen, setSubmitOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [addressing, setAddressing] = useState(false);
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null);
  const [explaining, setExplaining] = useState(false);
  const appPanel = experimental_useAppPanel();
  const seq = useRef(0);
  const nextSeq = () => ++seq.current;
  const addressThreadId = review.addressAgent.threadId;
  const forceChanges = useRef(false);
  const changes = useCached(`changes:${pullKey}:${addressThreadId ?? "none"}`, () => {
    const refresh = forceChanges.current;
    forceChanges.current = false;
    return addressThreadId === null ? Promise.resolve(null) : rpc.call("addressChanges", { ...pull, refresh });
  });
  const [changesVersion, setChangesVersion] = useState(0);
  useEffect(() => setChangesVersion((value) => value + 1), [changes.value]);
  useRealtime(UPDATES_CHANNEL, (payload) => {
    if (samePull(payload, pull)) changes.reload();
  });
  const refreshChanges = () => {
    forceChanges.current = true;
    changes.reload();
  };
  const labels = useMemo(() => commentLabels(detail), [detail]);
  const fixes = useMemo(() => new Map((changes.value?.comments ?? []).map((fix) => [fix.commentId, fix])), [changes.value]);

  const files = useMemo(
    () => detail.files.map((file) => ({ ...file, viewed: viewed.get(file.path) ?? file.viewed })),
    [detail.files, viewed],
  );
  const firstPath = files[0]?.path;
  const current = useMemo(
    (): Location | null => location ?? (firstPath === undefined ? null : { kind: "diff", path: firstPath, focus: null }),
    [firstPath, location],
  );
  const currentFile = current?.kind === "diff" ? (files.find((file) => file.path === current.path) ?? null) : null;
  const currentIndex = currentFile === null ? -1 : files.indexOf(currentFile);
  const [commentsVisited, setCommentsVisited] = useState(false);
  useEffect(() => {
    if (current?.kind === "comments") setCommentsVisited(true);
  }, [current?.kind]);
  useEffect(() => {
    if (currentFile !== null) lastPaths.set(pullKey, currentFile.path);
  }, [currentFile?.path, pullKey]);

  const goTo = useCallback(
    (next: Location, remember: boolean) => {
      if (remember && current !== null) setHistory((previous) => [...previous.slice(-HISTORY_LIMIT), current]);
      setLocation(next);
      setPicker(null);
    },
    [current],
  );
  const back = useCallback(() => {
    const last = history[history.length - 1];
    if (last === undefined) return;
    setHistory(history.slice(0, -1));
    setLocation(last.kind === "diff" && last.focus !== null ? { ...last, focus: { ...last.focus, seq: ++seq.current } } : last);
    if (last.kind === "comments") setTab("comments");
    else if (last.kind === "change") setTab("changes");
    else if (current?.kind === "comments" || current?.kind === "change") setTab("files");
    setPicker(null);
  }, [current?.kind, history]);

  const selectFile = useCallback((path: string) => goTo({ kind: "diff", path, focus: null }, false), [goTo]);
  const changeTab = (next: SidebarTab) => {
    setTab(next);
    if (next === "comments") {
      if (current?.kind !== "comments") goTo({ kind: "comments", commentId: null, seq: nextSeq() }, true);
    } else if (next !== "changes" && (current?.kind === "comments" || current?.kind === "change")) {
      const last = lastPaths.get(pullKey);
      const path = last !== undefined && files.some((file) => file.path === last) ? last : firstPath;
      if (path !== undefined) goTo({ kind: "diff", path, focus: null }, false);
    }
  };
  const showComments = () => {
    setTab("comments");
    setLocation((previous) => (previous?.kind === "comments" ? previous : { kind: "comments", commentId: null, seq: nextSeq() }));
  };
  const selectComment = (commentId: string) => goTo({ kind: "comments", commentId, seq: nextSeq() }, current?.kind !== "comments");
  const showComment = (commentId: string) => {
    setTab("comments");
    selectComment(commentId);
  };
  const selectChange = (target: ChangeTarget) => goTo({ kind: "change", target }, current?.kind !== "change");
  const stepFile = useCallback(
    (delta: number) => {
      const index = files.findIndex((file) => file.path === currentFile?.path);
      const next = files[Math.min(Math.max(index + delta, 0), files.length - 1)];
      if (next !== undefined) selectFile(next.path);
    },
    [currentFile?.path, files, selectFile],
  );

  const fileForFinding = (finding: Finding): PullFile | undefined =>
    files.find((file) => file.path === finding.path || file.previousPath === finding.path);

  const selectFinding = (finding: Finding) => {
    const file = fileForFinding(finding);
    if (file === undefined) {
      goTo({ kind: "peek", target: { kind: "repo", sha: detail.headSha, path: finding.path, line: finding.startLine ?? 1, seq: nextSeq() } }, true);
      return;
    }
    const focus =
      finding.startLine === null || finding.endLine === null
        ? null
        : { side: finding.side, line: finding.startLine, endLine: finding.endLine, anchor: `finding:${finding.id}`, seq: nextSeq() };
    goTo({ kind: "diff", path: file.path, focus }, true);
  };

  const jumpTo = (definition: Definition, sha: string) => {
    const focusAt = (side: DiffFocus["side"]): DiffFocus => ({ side, line: definition.line, endLine: definition.line, seq: nextSeq() });
    if (definition.external) {
      goTo({ kind: "peek", target: { kind: "external", path: definition.path, line: definition.line, seq: nextSeq() } }, true);
      return;
    }
    if (sha === detail.headSha) {
      const file = files.find((candidate) => candidate.path === definition.path && candidate.status !== "removed");
      if (file !== undefined) return goTo({ kind: "diff", path: file.path, focus: focusAt("additions") }, true);
    }
    if (sha === detail.mergeBaseSha) {
      const file = files.find((candidate) => (candidate.previousPath ?? candidate.path) === definition.path && candidate.status !== "added");
      if (file !== undefined) return goTo({ kind: "diff", path: file.path, focus: focusAt("deletions") }, true);
    }
    goTo({ kind: "peek", target: { kind: "repo", sha, path: definition.path, line: definition.line, seq: nextSeq() } }, true);
  };

  const findDefinition = (request: DefinitionRequest) => {
    // Most lookups answer in a few milliseconds; only say "Finding…" when one takes longer.
    const id = `definition:${nextSeq()}`;
    const slow = setTimeout(() => toast.loading(`Finding ${request.symbol}…`, { id }), 300);
    rpc
      .call("definition", { ...pull, ...request })
      .finally(() => clearTimeout(slow))
      .then((result) => {
        toast.dismiss(id);
        const [only, ...rest] = result.definitions;
        if (only === undefined) toast(result.message ?? `No definition of ${request.symbol} found.`);
        else if (rest.length === 0) jumpTo(only, request.sha);
        else setPicker({ result, sha: request.sha });
      })
      .catch((error: unknown) => toast.error(errorMessage(error), { id }));
  };

  const actions: ReviewActions = {
    async saveDraft(target, body) {
      await rpc.call("saveDraft", {
        ...pull,
        id: target.draftId,
        path: target.path,
        side: target.side,
        startLine: target.startLine,
        endLine: target.endLine,
        body,
      });
      setComposer(null);
      reloadState();
    },
    async deleteDraft(id) {
      await rpc.call("deleteDraft", { id });
      reloadState();
    },
    async postComment(target, body) {
      await rpc.call("postComment", {
        ...pull,
        headSha: detail.headSha,
        path: target.path,
        side: target.side,
        startLine: target.startLine,
        endLine: target.endLine,
        body,
      });
      setComposer(null);
      toast.success("Comment posted");
      refreshDetail();
    },
    async reply(commentId, body) {
      await rpc.call("reply", { ...pull, commentId, body });
      refreshDetail();
    },
    async resolveThread(threadId, resolved) {
      await rpc.call("resolveThread", { ...pull, threadId, resolved });
      refreshDetail();
    },
    async dismissFinding(id, dismissed) {
      await rpc.call("dismissFinding", { id, dismissed });
      reloadState();
    },
    composeFromFinding(finding) {
      const file = fileForFinding(finding);
      if (finding.startLine === null || finding.endLine === null || file === undefined) {
        toast.error("This finding has no line range in the diff to comment on.");
        return;
      }
      // GitHub only takes comments inside a hunk, so a finding that runs past one is trimmed to the lines it shares with it.
      const range = commentableRange(file.patch, finding.side, finding.startLine, finding.endLine);
      if (range === null) {
        toast.error(
          finding.headSha !== null && finding.headSha !== detail.headSha
            ? "This finding is outdated: its lines are no longer in the diff. Run the review again to place it on current lines."
            : "GitHub only takes review comments on changed lines, and none of this finding's lines are in the diff.",
        );
        return;
      }
      if (currentFile?.path !== file.path) selectFile(file.path);
      setComposer({
        path: file.path,
        side: finding.side,
        startLine: range.startLine,
        endLine: range.endLine,
        draftId: null,
        initialBody: `${finding.title}\n\n${finding.body}`.trim(),
      });
    },
    editDraft(draft) {
      setComposer({ ...draft, draftId: draft.id, initialBody: draft.body });
    },
    closeComposer() {
      setComposer(null);
    },
  };

  const toggleViewed = (file: PullFile) => {
    const next = !file.viewed;
    setViewed((previous) => new Map(previous).set(file.path, next));
    rpc.call("setViewed", { ...pull, pullNodeId: detail.nodeId, path: file.path, viewed: next }).catch((error: unknown) => {
      setViewed((previous) => new Map(previous).set(file.path, !next));
      toast.error(errorMessage(error));
    });
  };

  const runReview = () => {
    const starting = review.agent.threadId === null;
    setRunning(true);
    rpc
      .call("runReview", pull)
      .then((result) => {
        if (starting) toast.success("Started a review thread: it summarizes the PR, then runs the thermo-nuclear review.");
        else toast.success(result.delivery === "queued" ? "Review queued in the thread" : "Review started in the thread");
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setRunning(false));
  };

  const addressComments = () => {
    const starting = review.addressAgent.threadId === null;
    setAddressing(true);
    rpc
      .call("addressComments", pull)
      .then(() => {
        toast.success(
          starting
            ? "Started a thread that suggests changes and replies for the comments. Nothing changes until you accept a suggestion."
            : "Asked the address thread to suggest changes and replies again",
        );
        showComments();
        reloadState();
        refreshDetail();
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setAddressing(false));
  };

  useEffect(() => {
    rpc
      .call("openExplain", pull)
      .then(({ created }) => {
        if (created) reloadState();
      })
      .catch((error: unknown) => toast.error(`Could not start the explain thread: ${errorMessage(error)}`));
  }, [pullKey]);

  useEffect(() => setExplainTarget(null), [current?.kind, currentFile?.path]);

  const captureSelection = (event: MouseEvent) => {
    const origin = event.nativeEvent.composedPath()[0];
    if (!(origin instanceof Node) || isTyping(origin) || (origin instanceof Element && origin.closest("[data-explain-bar]") !== null)) return;
    setExplainTarget(selectedTarget(origin));
  };

  const explain = (question: string) => {
    if (explainTarget === null) return;
    setExplaining(true);
    rpc
      .call("explain", { ...pull, ...explainTarget, question })
      .then(() => {
        setExplainTarget(null);
        document.getSelection()?.removeAllRanges();
        if (!appPanel.openFixedTab({ surface: { kind: "current" }, tab: EXPLAIN_THREAD_TAB })) {
          toast.success("Sent to the explain thread. Open the Explain thread tab to read the answer.");
        }
        reloadState();
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setExplaining(false));
  };

  const commentActions: CommentActions = {
    reply: actions.reply,
    resolveThread: actions.resolveThread,
    async postConversation(body) {
      await rpc.call("postConversationComment", { ...pull, body });
      toast.success("Comment posted");
      refreshDetail();
    },
    async applySuggestion(id) {
      await rpc.call("applySuggestion", { id });
      toast.success("Applied the change to the address thread's worktree. It is not committed.");
      reloadState();
    },
    async setReplyState(id, state) {
      await rpc.call("setSuggestionState", { id, part: "reply", state });
      reloadState();
    },
    async setChangeState(id, state) {
      await rpc.call("setSuggestionState", { id, part: "change", state });
      reloadState();
    },
    viewInDiff(thread) {
      const file = files.find((candidate) => candidate.path === thread.path || candidate.previousPath === thread.path);
      if (file === undefined) {
        toast.error("This comment's file is not part of the diff anymore.");
        return;
      }
      const focus =
        thread.line === null
          ? null
          : { side: thread.side, line: thread.startLine ?? thread.line, endLine: thread.line, anchor: `thread:${thread.id}`, seq: nextSeq() };
      setTab("files");
      goTo({ kind: "diff", path: file.path, focus }, true);
    },
    openThread(threadId) {
      navigate.toThread(threadId);
    },
  };

  const submitReview = async (event: ReviewEvent, body: string) => {
    const result = await rpc.call("submitReview", { ...pull, headSha: detail.headSha, event, body });
    toast.success(`Review submitted${result.comments > 0 ? ` with ${result.comments} comment${result.comments === 1 ? "" : "s"}` : ""}`);
    reloadState();
    refreshDetail();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey) return;
      if (current?.kind === "comments" && (event.key === "j" || event.key === "k")) return;
      if ((event.altKey && event.key === "ArrowLeft") || (event.ctrlKey && event.key === "-")) {
        event.preventDefault();
        back();
      } else if (!event.altKey && !event.ctrlKey && (event.key === "j" || event.key === "k")) {
        stepFile(event.key === "j" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, current?.kind, stepFile]);

  useEffect(() => {
    if (!review.addressAgent.running) return;
    const timer = setInterval(() => {
      reloadState();
      changes.reload();
    }, ADDRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [changes.reload, reloadState, review.addressAgent.running]);

  const scoped = useMemo(() => {
    const path = currentFile?.path;
    const previousPath = currentFile?.previousPath;
    const matches = (candidate: string) => candidate === path || candidate === previousPath;
    return {
      findings: review.findings.filter((finding) => !finding.dismissed && matches(finding.path)),
      drafts: review.drafts.filter((draft) => draft.path === path),
      threads: detail.threads.filter((thread) => thread.path === path),
    };
  }, [currentFile?.path, currentFile?.previousPath, detail.threads, review.drafts, review.findings]);

  const fullFile = currentFile !== null && fullFiles.has(currentFile.path);
  const showFullFile = () => {
    if (currentFile !== null) setFullFiles((previous) => new Set(previous).add(currentFile.path));
  };
  const peekTarget = current?.kind === "peek" ? current.target : null;
  const peekFile =
    peekTarget?.kind === "repo" && peekTarget.sha === detail.headSha ? files.find((file) => file.path === peekTarget.path) : undefined;
  const sidebar = (
    <Sidebar
      files={files}
      selectedPath={currentFile?.path ?? null}
      findings={review.findings}
      drafts={review.drafts}
      threads={detail.threads}
      conversation={detail.conversation}
      viewer={detail.viewer}
      awaitingReply={detail.awaitingReply}
      suggestions={review.suggestions}
      selectedCommentId={current?.kind === "comments" ? current.commentId : null}
      changes={
        addressThreadId === null
          ? null
          : {
              value: changes.value,
              error: changes.error,
              refreshing: changes.refreshing,
              labels,
              selected: current?.kind === "change" ? current.target : null,
              onRefresh: refreshChanges,
              onSelect: selectChange,
              onShowComment: showComment,
            }
      }
      tab={tab}
      onTab={changeTab}
      onSelectFile={selectFile}
      onToggleViewed={toggleViewed}
      onSelectFinding={selectFinding}
      onSelectComment={selectComment}
    />
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" onMouseUp={captureSelection}>
      <WorkspaceHeader
        detail={detail}
        review={review}
        narrow={narrow}
        refreshing={refreshing}
        running={running}
        addressing={addressing}
        onShowFindings={() => {
          changeTab("findings");
          setFilesOpen(true);
        }}
        onRunReview={runReview}
        onAddressComments={addressComments}
        onSubmit={() => setSubmitOpen(true)}
      />
      <div className={cn("flex min-h-0 flex-1", narrow && "flex-col")}>
        {filesOpen ? (
          narrow ? (
            <section className="h-[32vh] min-h-48 shrink-0 border-b border-border" aria-label="Files and findings">
              {sidebar}
            </section>
          ) : (
            <aside className="w-72 shrink-0 border-r border-border">{sidebar}</aside>
          )
        ) : null}
        <main ref={mainRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-pressed={filesOpen}
              title={narrow ? "Toggle files and findings" : "Toggle the file list"}
              aria-label="Toggle the file list"
              onClick={() => setFilesOpen(!filesOpen)}
            >
              <Icon name={narrow ? "ListView" : "PanelLeft"} fallback="PanelLeft" className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" disabled={history.length === 0} title="Go back (⌥←)" aria-label="Go back" onClick={back}>
              <Icon name="ArrowLeft" className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" disabled={currentIndex <= 0} title="Previous file (k)" aria-label="Previous file" onClick={() => stepFile(-1)}>
              <Icon name="ArrowUp" className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={currentIndex < 0 || currentIndex >= files.length - 1}
              title="Next file (j)"
              aria-label="Next file"
              onClick={() => stepFile(1)}
            >
              <Icon name="ArrowDown" className="size-3.5" />
            </Button>
            <span className="min-w-0 flex-1 basis-40 truncate px-1 font-mono text-xs" title={currentFile?.path}>
              {currentFile === null
                ? current?.kind === "peek"
                  ? "Definition"
                  : current?.kind === "comments"
                    ? "Comments"
                    : current?.kind === "change"
                      ? `Changes  ${current.target.path}`
                      : ""
                : `${currentIndex + 1}/${files.length}  ${currentFile.path}`}
            </span>
            {narrow ? null : <span className="hidden text-[11px] text-muted-foreground 2xl:inline">⌘-click a symbol to go to its definition · j/k files</span>}
            <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Diff layout">
              {DIFF_STYLE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={diffStylePreference === option.id}
                  title={option.id === "auto" ? `Auto: ${diffStyle} at this width` : option.label}
                  aria-label={`${option.label} diff`}
                  onClick={() => setDiffStylePreference(option.id)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
                >
                  {option.icon === null ? null : <Icon name={option.icon} className="size-3.5" aria-hidden />}
                  {narrow && option.icon !== null ? null : option.label}
                </button>
              ))}
            </div>
            <ToolbarToggle pressed={wrap} label="Wrap" icon="TextWrap" showLabel={!narrow} onClick={() => setWrap(!wrap)} />
            {currentFile !== null ? (
              <>
                <ToolbarToggle
                  pressed={fullFile}
                  label="Full file"
                  icon="Maximize2"
                  showLabel={!narrow}
                  onClick={() =>
                    setFullFiles((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(currentFile.path)) next.add(currentFile.path);
                      return next;
                    })
                  }
                />
                <ToolbarToggle
                  pressed={currentFile.viewed}
                  label="Viewed"
                  icon={currentFile.viewed ? "CircleCheck" : "Circle"}
                  showLabel={!narrow}
                  onClick={() => toggleViewed(currentFile)}
                />
              </>
            ) : null}
          </div>
          {picker === null ? null : (
            <DefinitionPicker
              result={picker.result}
              onClose={() => setPicker(null)}
              onPick={(index) => {
                const definition = picker.result.definitions[index];
                if (definition !== undefined) jumpTo(definition, picker.sha);
              }}
            />
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            {current === null ? <p className="p-5 text-sm text-muted-foreground">This pull request has no changed files.</p> : null}
            {current?.kind === "diff" && currentFile !== null ? (
              <DiffPane
                key={currentFile.path}
                detail={detail}
                file={currentFile}
                findings={scoped.findings}
                drafts={scoped.drafts}
                threads={scoped.threads}
                diffStyle={diffStyle}
                wrap={wrap}
                fullFile={fullFile}
                focus={current.focus}
                composer={composer?.path === currentFile.path ? composer : null}
                actions={actions}
                onCompose={setComposer}
                onDefinition={findDefinition}
                onShowFullFile={showFullFile}
              />
            ) : null}
            {commentsVisited ? (
              <div className={current?.kind === "comments" ? undefined : "hidden"}>
                <CommentsView
                  detail={detail}
                  review={review}
                  fixes={fixes}
                  focus={current?.kind === "comments" && current.commentId !== null ? { commentId: current.commentId, seq: current.seq } : null}
                  actions={commentActions}
                />
              </div>
            ) : null}
            {current?.kind === "change" ? (
              <ChangeDiffPane
                key={`${current.target.sha ?? "worktree"}:${current.target.path}`}
                pull={pull}
                target={current.target}
                changes={changes.value}
                version={changesVersion}
                labels={labels}
                diffStyle={diffStyle}
                wrap={wrap}
                onSelectComment={showComment}
              />
            ) : null}
            {current?.kind === "peek" ? (
              <PeekPane
                key={`${current.target.kind}:${current.target.path}`}
                detail={detail}
                target={current.target}
                wrap={wrap}
                canOpenInDiff={peekFile !== undefined}
                onOpenInDiff={() => {
                  if (peekFile !== undefined) goTo({ kind: "diff", path: peekFile.path, focus: { side: "additions", line: current.target.line, endLine: current.target.line, seq: nextSeq() } }, true);
                }}
                onDefinition={findDefinition}
              />
            ) : null}
          </div>
          {explainTarget === null ? null : (
            <ExplainBar
              key={`${explainTarget.label}\n${explainTarget.quote}`}
              target={explainTarget}
              sending={explaining}
              onSend={explain}
              onClose={() => setExplainTarget(null)}
            />
          )}
        </main>
      </div>
      <SubmitReviewDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        pendingComments={review.drafts.length}
        isAuthor={detail.author.login === detail.viewer}
        onSubmit={submitReview}
      />
    </div>
  );
}
