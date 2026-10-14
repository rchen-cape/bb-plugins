import { useMemo, useState } from "react";
import type { ConversationComment, Draft, FileStatus, Finding, PullFile, ReviewThread, Severity, Suggestion } from "../contract";
import { cn } from "../lib/utils";
import { SeverityBadge, lineLabel } from "./bits";
import { CommentIndex, commentCount } from "./Comments";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

export type SidebarTab = "files" | "findings" | "comments";

const STATUS: Record<FileStatus, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-600 dark:text-emerald-400" },
  removed: { letter: "D", className: "text-red-600 dark:text-red-400" },
  modified: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  renamed: { letter: "R", className: "text-sky-600 dark:text-sky-400" },
  copied: { letter: "C", className: "text-sky-600 dark:text-sky-400" },
  changed: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  unchanged: { letter: "·", className: "text-muted-foreground" },
};

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function Count({ value, className, title }: { value: number | undefined; className: string; title: string }) {
  if (value === undefined || value === 0) return null;
  return (
    <span className={cn("rounded px-1 text-[10px] font-semibold tabular-nums", className)} title={title}>
      {value}
    </span>
  );
}

function FileRow({
  file,
  selected,
  findings,
  threads,
  drafts,
  onSelect,
  onToggleViewed,
}: {
  file: PullFile;
  selected: boolean;
  findings: number | undefined;
  threads: number | undefined;
  drafts: number | undefined;
  onSelect(): void;
  onToggleViewed(): void;
}) {
  const slash = file.path.lastIndexOf("/");
  const status = STATUS[file.status];
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-8 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
          selected && "bg-state-active",
          file.viewed && !selected && "opacity-60",
        )}
      >
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", status.className)}>{status.letter}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{file.path.slice(slash + 1)}</span>
          {slash < 0 ? null : <span className="ml-1 text-muted-foreground">{file.path.slice(0, slash)}</span>}
        </span>
        <Count value={findings} className="bg-amber-500/20 text-amber-700 dark:text-amber-300" title="Review findings" />
        <Count value={threads} className="bg-sky-500/15 text-sky-700 dark:text-sky-300" title="Unresolved comment threads" />
        <Count value={drafts} className="bg-violet-500/15 text-violet-700 dark:text-violet-300" title="Pending comments" />
      </button>
      <button
        type="button"
        onClick={onToggleViewed}
        aria-pressed={file.viewed}
        aria-label={file.viewed ? `Mark ${file.path} as not viewed` : `Mark ${file.path} as viewed`}
        title={file.viewed ? "Viewed" : "Mark as viewed"}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
          file.viewed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <Icon name={file.viewed ? "CircleCheck" : "Circle"} className="size-3.5" />
      </button>
    </li>
  );
}

export function Sidebar({
  files,
  selectedPath,
  findings,
  drafts,
  threads,
  conversation,
  viewer,
  suggestions,
  selectedCommentId,
  tab,
  onTab,
  onSelectFile,
  onToggleViewed,
  onSelectFinding,
  onSelectComment,
}: {
  files: readonly PullFile[];
  selectedPath: string | null;
  findings: readonly Finding[];
  drafts: readonly Draft[];
  threads: readonly ReviewThread[];
  conversation: readonly ConversationComment[];
  viewer: string;
  suggestions: readonly Suggestion[];
  selectedCommentId: string | null;
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  onSelectFile(path: string): void;
  onToggleViewed(file: PullFile): void;
  onSelectFinding(finding: Finding): void;
  onSelectComment(id: string): void;
}) {
  const [filter, setFilter] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  const open = useMemo(() => findings.filter((finding) => !finding.dismissed), [findings]);
  const dismissed = findings.length - open.length;
  const counts = useMemo(
    () => ({
      findings: countBy(open, (finding) => finding.path),
      threads: countBy(
        threads.filter((thread) => !thread.isResolved),
        (thread) => thread.path,
      ),
      drafts: countBy(drafts, (draft) => draft.path),
    }),
    [drafts, open, threads],
  );
  const shown = files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const viewed = files.filter((file) => file.viewed).length;
  const listed = [...(showDismissed ? findings : open)].sort(
    (left, right) => Number(left.dismissed) - Number(right.dismissed) || SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-border p-1.5" role="tablist">
        {(["files", "findings", "comments"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className="flex-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-selected:bg-state-active aria-selected:text-foreground"
          >
            {id === "files"
              ? `Files ${viewed}/${files.length}`
              : id === "findings"
                ? `Findings ${open.length}`
                : `Comments ${commentCount({ threads, conversation, viewer })}`}
          </button>
        ))}
      </div>
      {tab === "files" ? (
        <>
          <div className="shrink-0 p-1.5">
            <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" aria-label="Filter files" className="h-7 text-xs" />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {shown.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={file.path === selectedPath}
                findings={counts.findings.get(file.path)}
                threads={counts.threads.get(file.path)}
                drafts={counts.drafts.get(file.path)}
                onSelect={() => onSelectFile(file.path)}
                onToggleViewed={() => onToggleViewed(file)}
              />
            ))}
          </ul>
        </>
      ) : tab === "comments" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <CommentIndex detail={{ threads, conversation }} suggestions={suggestions} selectedId={selectedCommentId} onSelect={onSelectComment} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {listed.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No findings yet. They appear here when the review thread records them.
            </p>
          ) : (
            <ul className="space-y-1">
              {listed.map((finding) => (
                <li key={finding.id}>
                  <button
                    type="button"
                    onClick={() => onSelectFinding(finding)}
                    className={cn(
                      "w-full rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                      finding.dismissed && "opacity-50",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <SeverityBadge severity={finding.severity} />
                      <span className="min-w-0 flex-1 truncate font-medium">{finding.title}</span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {finding.path} {lineLabel(finding.startLine, finding.endLine)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dismissed > 0 ? (
            <button
              type="button"
              className="mt-2 w-full px-2 py-1 text-left text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowDismissed((value) => !value)}
            >
              {showDismissed ? "Hide" : "Show"} {dismissed} dismissed
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
