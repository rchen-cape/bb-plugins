import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Diff as Diff, useRpc } from "@get-bb/plugin-sdk/app";
import type { AddressChanges, AddressCommit, ChangeLetter, ChangedFile, rpcContract } from "../contract";
import type { DiffStyle } from "../highlight";
import { cn } from "../lib/utils";
import { useCached } from "./cache";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

export interface ChangeTarget {
  path: string;
  sha: string | null;
}

const LETTERS: Record<ChangeLetter, { className: string; title: string }> = {
  M: { className: "text-amber-600 dark:text-amber-400", title: "Modified" },
  A: { className: "text-emerald-600 dark:text-emerald-400", title: "Added" },
  D: { className: "text-red-600 dark:text-red-400", title: "Deleted" },
  R: { className: "text-sky-600 dark:text-sky-400", title: "Renamed" },
  U: { className: "text-emerald-600 dark:text-emerald-400", title: "Untracked" },
};

export function pendingChanges(changes: AddressChanges | null): number {
  return changes === null || !changes.available ? 0 : changes.uncommitted.length + changes.unpushed.length;
}

function sameTarget(left: ChangeTarget | null, right: ChangeTarget): boolean {
  return left !== null && left.path === right.path && left.sha === right.sha;
}

function CommentChips({ ids, labels, onSelect }: { ids: readonly string[]; labels: ReadonlyMap<string, string>; onSelect(id: string): void }) {
  if (ids.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          title={`Addresses ${labels.get(id) ?? id}`}
          className="max-w-full truncate rounded bg-sky-500/15 px-1 text-[10px] font-medium text-sky-700 outline-none hover:bg-sky-500/25 focus-visible:ring-1 focus-visible:ring-ring dark:text-sky-300"
        >
          addresses {labels.get(id) ?? id}
        </button>
      ))}
    </span>
  );
}

function FileRow({
  file,
  commentIds,
  selected,
  labels,
  indent,
  onSelect,
  onSelectComment,
}: {
  file: ChangedFile;
  commentIds: readonly string[];
  selected: boolean;
  labels: ReadonlyMap<string, string>;
  indent: boolean;
  onSelect(): void;
  onSelectComment(id: string): void;
}) {
  const slash = file.path.lastIndexOf("/");
  const letter = LETTERS[file.status];
  return (
    <li className={cn("space-y-0.5", indent && "pl-4")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
          selected && "bg-state-active",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{file.path.slice(slash + 1)}</span>
          {slash < 0 ? null : <span className="ml-1 text-muted-foreground">{file.path.slice(0, slash)}</span>}
        </span>
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", letter.className)} title={letter.title} aria-label={letter.title}>
          {file.status}
        </span>
      </button>
      {commentIds.length === 0 ? null : (
        <div className="pl-2">
          <CommentChips ids={commentIds} labels={labels} onSelect={onSelectComment} />
        </div>
      )}
    </li>
  );
}

function CommitRow({
  commit,
  selected,
  labels,
  onSelect,
  onSelectComment,
}: {
  commit: AddressCommit;
  selected: ChangeTarget | null;
  labels: ReadonlyMap<string, string>;
  onSelect(target: ChangeTarget): void;
  onSelectComment(id: string): void;
}) {
  const [open, setOpen] = useState(selected?.sha === commit.sha);
  return (
    <li className="space-y-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`${commit.sha}\n${commit.subject}`}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
        <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
      </button>
      {commit.commentIds.length === 0 ? null : (
        <div className="pl-7">
          <CommentChips ids={commit.commentIds} labels={labels} onSelect={onSelectComment} />
        </div>
      )}
      {open ? (
        <ul className="space-y-0.5">
          {commit.files.length === 0 ? <li className="pl-7 text-[11px] text-muted-foreground">No file changes (a merge commit).</li> : null}
          {commit.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              commentIds={[]}
              selected={sameTarget(selected, { path: file.path, sha: commit.sha })}
              labels={labels}
              indent
              onSelect={() => onSelect({ path: file.path, sha: commit.sha })}
              onSelectComment={onSelectComment}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-0.5">
      <h3 className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({count})
      </h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

export function ChangesIndex({
  changes,
  error,
  refreshing,
  labels,
  selected,
  onRefresh,
  onSelect,
  onSelectComment,
}: {
  changes: AddressChanges | null;
  error: string | null;
  refreshing: boolean;
  labels: ReadonlyMap<string, string>;
  selected: ChangeTarget | null;
  onRefresh(): void;
  onSelect(target: ChangeTarget): void;
  onSelectComment(id: string): void;
}) {
  const empty = changes !== null && changes.available && changes.uncommitted.length + changes.unpushed.length + changes.pushed.length === 0;
  const commits = (list: readonly AddressCommit[]) =>
    list.map((commit) => <CommitRow key={commit.sha} commit={commit} selected={selected} labels={labels} onSelect={onSelect} onSelectComment={onSelectComment} />);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Address thread's worktree</span>
        <Button size="icon" variant="ghost" className="size-6" title="Refresh the changes" aria-label="Refresh the changes" disabled={refreshing} onClick={onRefresh}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      {changes === null ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">{error ?? "Loading the changes…"}</p>
      ) : !changes.available ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">{changes.reason}</p>
      ) : empty ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes from Address comments yet.</p>
      ) : (
        <>
          <Section title="Uncommitted" count={changes.uncommitted.length}>
            {changes.uncommitted.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                commentIds={file.commentIds}
                selected={sameTarget(selected, { path: file.path, sha: null })}
                labels={labels}
                indent={false}
                onSelect={() => onSelect({ path: file.path, sha: null })}
                onSelectComment={onSelectComment}
              />
            ))}
          </Section>
          <Section title="Committed, not pushed" count={changes.unpushed.length}>
            {commits(changes.unpushed)}
          </Section>
          <Section title="Pushed" count={changes.pushed.length}>
            {commits(changes.pushed)}
          </Section>
        </>
      )}
    </div>
  );
}

function changeFile(changes: AddressChanges | null, target: ChangeTarget): { file: ChangedFile; commentIds: string[]; commit: AddressCommit | null } | null {
  if (changes === null) return null;
  if (target.sha === null) {
    const file = changes.uncommitted.find((candidate) => candidate.path === target.path);
    return file === undefined ? null : { file, commentIds: file.commentIds, commit: null };
  }
  const commit = [...changes.unpushed, ...changes.pushed].find((candidate) => candidate.sha === target.sha);
  const file = commit?.files.find((candidate) => candidate.path === target.path);
  return commit === undefined || file === undefined ? null : { file, commentIds: commit.commentIds, commit };
}

export function ChangeDiffPane({
  pull,
  target,
  changes,
  version,
  labels,
  diffStyle,
  wrap,
  onSelectComment,
}: {
  pull: { repo: string; number: number };
  target: ChangeTarget;
  changes: AddressChanges | null;
  version: number;
  labels: ReadonlyMap<string, string>;
  diffStyle: DiffStyle;
  wrap: boolean;
  onSelectComment(id: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `address-diff:${pull.repo}#${pull.number}:${target.sha ?? "worktree"}:${target.path}`;
  const diff = useCached(key, () => rpc.call("addressDiff", { ...pull, path: target.path, sha: target.sha }), { immutable: target.sha !== null });
  const seenVersion = useRef(version);
  useEffect(() => {
    if (target.sha !== null || seenVersion.current === version) return;
    seenVersion.current = version;
    diff.reload();
  }, [diff.reload, target.sha, version]);
  const found = changeFile(changes, target);
  const missing = changes !== null && found === null;
  return (
    <div className="pb-24">
      <div className="space-y-1 border-b border-border px-3 py-2 text-xs">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono">{target.path}</span>
          <span className="shrink-0 text-muted-foreground">
            {target.sha === null ? "· uncommitted" : `· ${found?.commit?.shortSha ?? target.sha.slice(0, 7)} ${found?.commit?.subject ?? ""}`}
          </span>
        </p>
        {found === null ? null : <CommentChips ids={found.commentIds} labels={labels} onSelect={onSelectComment} />}
      </div>
      {missing ? (
        <p className="p-4 text-sm text-muted-foreground">This change is no longer in the address thread's worktree.</p>
      ) : diff.value === null ? (
        <p className="p-4 text-sm text-muted-foreground">{diff.error ?? "Loading the diff…"}</p>
      ) : diff.value.patch.trim().length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No text changes to show: the file is binary, or only its mode changed.</p>
      ) : (
        <Diff patch={diff.value.patch} path={target.path} view={diffStyle} overflow={wrap ? "wrap" : "scroll"} />
      )}
    </div>
  );
}
