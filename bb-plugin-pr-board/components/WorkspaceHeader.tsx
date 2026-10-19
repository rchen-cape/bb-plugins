import { useState } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PullDetail, ReviewState } from "../contract";
import { BOARD_PANEL } from "../routes";
import { cn } from "../lib/utils";
import { Avatar, ToolbarToggle } from "./bits";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

export function WorkspaceHeader({
  detail,
  review,
  narrow,
  refreshing,
  running,
  addressing,
  submittingAddress,
  onShowFindings,
  onRunReview,
  onAddressComments,
  onSubmit,
  onSubmitAddress,
}: {
  detail: PullDetail;
  review: ReviewState;
  narrow: boolean;
  refreshing: boolean;
  running: boolean;
  addressing: boolean;
  submittingAddress: boolean;
  onShowFindings(): void;
  onRunReview(): void;
  onAddressComments(): void;
  onSubmit(): void;
  onSubmitAddress(): void;
}) {
  const navigate = useBbNavigate();
  const [showDescription, setShowDescription] = useState(false);
  const threadId = review.agent.threadId;
  const openUrl = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          title="Back to the board"
          aria-label="Back to the board"
          onClick={() => navigate.toPluginPanel(BOARD_PANEL)}
        >
          <Icon name="ArrowLeft" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2">
            {detail.isDraft ? (
              <span className="shrink-0 rounded border border-border px-1 text-[10px] font-medium uppercase text-muted-foreground">Draft</span>
            ) : null}
            <h1 className={cn("text-sm font-semibold", narrow ? "line-clamp-2" : "truncate")} title={detail.title}>
              {detail.title}
            </h1>
            <span className="shrink-0 text-sm text-muted-foreground">#{detail.number}</span>
            {refreshing ? <Icon name="ArrowReloadHorizontal" className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Updating" /> : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="inline-flex shrink-0 items-center gap-1">
              <Avatar person={detail.author} />
              {detail.author.login}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex min-w-0 max-w-full items-center gap-1">
              <Icon name="GitBranch" className="size-3 shrink-0" />
              <span className="truncate font-mono">
                {detail.headRefName} → {detail.baseRefName}
              </span>
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{detail.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{detail.deletions}</span>
            </span>
            {review.agent.running ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-sky-600 dark:text-sky-400">
                <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
                agent working
              </span>
            ) : null}
            {review.agent.findings > 0 ? (
              <button type="button" className="shrink-0 text-amber-600 underline-offset-2 hover:underline dark:text-amber-400" onClick={onShowFindings}>
                {review.agent.findings} findings
              </button>
            ) : null}
          </div>
        </div>
        <div className={cn("ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1", narrow && "w-full")}>
          <ToolbarToggle
            pressed={showDescription}
            label="Description"
            icon="AlignLeft"
            showLabel={!narrow}
            onClick={() => setShowDescription(!showDescription)}
          />
          <ToolbarToggle
            pressed={false}
            label="Thread"
            icon="MessageSquare"
            showLabel={!narrow}
            disabled={threadId === null}
            onClick={() => threadId !== null && navigate.toThread(threadId)}
          />
          <ToolbarToggle pressed={false} label="GitHub" icon="Github" showLabel={!narrow} onClick={() => openUrl(detail.url)} />
          <span className={cn(narrow && "flex-1")} />
          <div className="grid shrink-0 grid-cols-2 gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 justify-start px-2 text-xs"
              disabled={running}
              onClick={onRunReview}
              title={
                threadId === null
                  ? "Start a review thread that summarizes the PR and runs /thermo-nuclear-code-quality-review"
                  : "Send /thermo-nuclear-code-quality-review to the review thread"
              }
            >
              <Icon name="Play" className="size-3.5" />
              Run review
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onSubmit}>
              Submit review
              {review.drafts.length > 0 ? <span className="rounded-full bg-background/25 px-1.5 tabular-nums">{review.drafts.length}</span> : null}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 justify-start px-2 text-xs"
              disabled={addressing}
              onClick={onAddressComments}
              title={
                review.addressAgent.threadId === null
                  ? "Start a thread that suggests code changes and replies for the PR's comments, without changing files"
                  : "Ask the address thread to suggest changes and replies for the current comments again"
              }
            >
              <Icon name="MessageCirclePlus" className="size-3.5" />
              Address comments
            </Button>
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={submittingAddress || review.addressAgent.threadId === null}
              onClick={onSubmitAddress}
              title={
                review.addressAgent.threadId === null
                  ? "Click Address comments first"
                  : `Check the accepted changes against the PR's GitHub Actions, then commit and push them to ${detail.headRefName}`
              }
            >
              Submit Address
            </Button>
          </div>
        </div>
      </header>
      {showDescription ? (
        <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border px-5 py-3">
          <Markdown content={detail.body.trim().length === 0 ? "_No description provided._" : detail.body} className="text-sm" />
        </div>
      ) : null}
    </>
  );
}
