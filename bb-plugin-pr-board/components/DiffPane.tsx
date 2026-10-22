import { useMemo, useRef, type ReactNode } from "react";
import { processFile, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { experimental_useCodeTheme, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Draft, Finding, PullDetail, PullFile, ReviewThread, Side, rpcContract } from "../contract";
import { highlightCss, type DiffStyle } from "../highlight";
import { isCommentable } from "../patch";
import { AnnotationView, annotationKey, FindingCard, ThreadCard, type AnnotationData, type Composer, type ReviewActions } from "./Annotations";
import { identifierAt, isModifierClick, useModifierUnderline, useScrollToLine, type LineFocus } from "./code";
import { explainSource } from "./Explain";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { useCached } from "./cache";

export interface DefinitionRequest {
  sha: string;
  path: string;
  line: number;
  character: number;
  symbol: string;
}

export interface DiffFocus extends LineFocus {
  side: Side;
  endLine: number;
}

interface Contents {
  old: string | null;
  new: string | null;
}

function gitPatch(file: PullFile, oldPath: string, patch: string): string {
  return [
    `diff --git a/${oldPath} b/${file.path}`,
    file.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.path}`,
    patch.endsWith("\n") ? patch : `${patch}\n`,
  ].join("\n");
}

function linesOf(contents: string | null, startLine: number, endLine: number): string | null {
  if (contents === null) return null;
  return contents.split("\n").slice(startLine - 1, endLine).join("\n");
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="m-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

export function DiffPane({
  detail,
  file,
  findings,
  drafts,
  threads,
  diffStyle,
  wrap,
  fullFile,
  focus,
  composer,
  actions,
  onCompose,
  onDefinition,
  onShowFullFile,
}: {
  detail: PullDetail;
  file: PullFile;
  findings: readonly Finding[];
  drafts: readonly Draft[];
  threads: readonly ReviewThread[];
  diffStyle: DiffStyle;
  wrap: boolean;
  fullFile: boolean;
  focus: DiffFocus | null;
  composer: Composer | null;
  actions: ReviewActions;
  onCompose(composer: Composer): void;
  onDefinition(request: DefinitionRequest): void;
  onShowFullFile(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const codeTheme = experimental_useCodeTheme();
  const host = useRef<HTMLDivElement>(null);
  const underline = useModifierUnderline();
  const oldPath = file.previousPath ?? file.path;

  const contents = useCached<Contents>(`contents:${detail.repo}@${detail.headSha}:${file.path}`, async () => {
    const [old, next] = await Promise.all([
      file.status === "added" ? null : rpc.call("fileAt", { repo: detail.repo, sha: detail.mergeBaseSha, path: oldPath }),
      file.status === "removed" ? null : rpc.call("fileAt", { repo: detail.repo, sha: detail.headSha, path: file.path }),
    ]);
    return {
      old: file.status === "added" ? "" : (old?.content ?? null),
      new: file.status === "removed" ? "" : (next?.content ?? null),
    };
  }, { immutable: true });
  const loaded = contents.value;

  const fileDiff = useMemo((): FileDiffMetadata | null => {
    if (file.patch === null || (loaded === null && contents.error === null)) return null;
    const patch = gitPatch(file, oldPath, file.patch);
    const cacheKey = `${detail.repo}@${detail.headSha}:${file.path}`;
    if (loaded !== null && loaded.old !== null && loaded.new !== null) {
      const full = processFile(patch, {
        isGitDiff: true,
        cacheKey: `${cacheKey}:full`,
        oldFile: { name: oldPath, contents: loaded.old },
        newFile: { name: file.path, contents: loaded.new },
      });
      if (full !== undefined) return full;
    }
    return processFile(patch, { isGitDiff: true, cacheKey }) ?? null;
  }, [contents.error, detail.headSha, detail.repo, file, loaded, oldPath]);

  const canExpand = fileDiff !== null && !fileDiff.isPartial;
  const { inlineFindings, fileFindings, inlineThreads, otherThreads } = useMemo(() => {
    const visible = (side: Side, line: number) => (fullFile && canExpand) || isCommentable(file.patch, side, line, line);
    const anchored = (finding: Finding): finding is Finding & { endLine: number } =>
      finding.endLine !== null && visible(finding.side, finding.endLine);
    const inlineThreads: Array<{ thread: ReviewThread; line: number }> = [];
    const otherThreads: ReviewThread[] = [];
    for (const thread of threads) {
      if (thread.line !== null && visible(thread.side, thread.line)) inlineThreads.push({ thread, line: thread.line });
      else otherThreads.push(thread);
    }
    return {
      inlineFindings: findings.filter(anchored),
      fileFindings: findings.filter((finding) => !anchored(finding)),
      inlineThreads,
      otherThreads,
    };
  }, [canExpand, file.patch, findings, fullFile, threads]);

  const annotations = useMemo((): DiffLineAnnotation<AnnotationData>[] => {
    const outdated = (finding: Finding) => finding.headSha !== null && finding.headSha !== detail.headSha;
    const list: DiffLineAnnotation<AnnotationData>[] = [
      ...inlineFindings.map((finding) => ({
        side: finding.side,
        lineNumber: finding.endLine,
        metadata: { kind: "finding" as const, finding, outdated: outdated(finding) },
      })),
      ...inlineThreads.map(({ thread, line }) => ({ side: thread.side, lineNumber: line, metadata: { kind: "thread" as const, thread } })),
      ...drafts
        .filter((draft) => draft.id !== composer?.draftId)
        .map((draft) => ({ side: draft.side, lineNumber: draft.endLine, metadata: { kind: "draft" as const, draft } })),
    ];
    if (composer !== null) {
      list.push({
        side: composer.side,
        lineNumber: composer.endLine,
        metadata: {
          kind: "composer",
          composer,
          suggestion:
            composer.side === "additions" && loaded !== null ? linesOf(loaded.new, composer.startLine, composer.endLine) : null,
        },
      });
    }
    return list;
  }, [composer, detail.headSha, drafts, inlineFindings, inlineThreads, loaded]);

  const handlers = useRef({
    token: (_props: TokenProps, _event: MouseEvent) => {},
    lines: (_range: SelectedLineRange | null) => {},
  });
  // Clicking or dragging line numbers and clicking + both end in a line selection, so both open the comment editor here.
  handlers.current.lines = (range) => {
    if (range === null) return;
    const side = range.endSide ?? range.side ?? "additions";
    const startLine = Math.min(range.start, range.end);
    const endLine = Math.max(range.start, range.end);
    if (!isCommentable(file.patch, side, startLine, endLine)) {
      toast.error("GitHub only takes review comments on lines inside one of the diff's hunks.");
      return;
    }
    onCompose({ path: file.path, side, startLine, endLine, draftId: null, initialBody: "" });
  };
  handlers.current.token = (props, event) => {
    if (!isModifierClick(event)) return;
    const identifier = identifierAt(props.tokenElement, props.tokenText, event.clientX);
    if (identifier === null) return;
    event.preventDefault();
    event.stopPropagation();
    const additions = props.side === "additions";
    onDefinition({
      sha: additions ? detail.headSha : detail.mergeBaseSha,
      path: additions ? file.path : oldPath,
      line: props.lineNumber,
      character: props.lineCharStart + identifier.offset,
      symbol: identifier.text,
    });
  };

  const css = useMemo(() => highlightCss(inlineFindings, drafts, diffStyle), [diffStyle, drafts, inlineFindings]);
  const options = useMemo(
    (): NonNullable<FileDiffProps<AnnotationData>["options"]> => ({
      theme: codeTheme.name,
      themeType: codeTheme.mode,
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      disableFileHeader: true,
      useTokenTransformer: true,
      expandUnchanged: fullFile,
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
      enableGutterUtility: true,
      enableLineSelection: true,
      lineHoverHighlight: "both",
      unsafeCSS: css,
      // Without this handler, + does not start a selection. The comment opens from onLineSelectionEnd instead.
      onGutterUtilityClick: () => {},
      onTokenClick: (props, event) => handlers.current.token(props, event),
      onLineSelectionEnd: (range) => handlers.current.lines(range),
      onTokenEnter: (props, event) => underline.enter(props.tokenElement, isModifierClick(event)),
      onTokenLeave: (props) => underline.leave(props.tokenElement),
    }),
    [codeTheme.mode, codeTheme.name, css, diffStyle, fullFile, underline, wrap],
  );

  const selectedLines = useMemo(
    () => (focus === null ? null : { start: focus.line, end: focus.endLine, side: focus.side, endSide: focus.side }),
    [focus],
  );
  useScrollToLine(host, focus, `${diffStyle}:${fullFile}`, diffStyle, () => {
    if (!fullFile && canExpand) onShowFullFile();
  });

  if (file.patch === null) {
    return (
      <Notice>
        {file.status === "renamed" ? `Renamed from ${file.previousPath} without changes.` : "GitHub has no text diff for this file (binary or too large)."}{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => {
            const url = `${detail.url}/files`;
            if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
          }}
        >
          Open on GitHub
        </button>
      </Notice>
    );
  }
  if (fileDiff === null) return <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>;

  return (
    <div ref={host} className="pb-24" {...explainSource("code", file.path)}>
      {fileFindings.length + otherThreads.length === 0 ? null : (
        <div className="space-y-1 border-b border-border py-2">
          {fileFindings.map((finding) => (
            <div key={finding.id} className="relative" data-anchor={`finding:${finding.id}`}>
              <FindingCard
                finding={finding}
                outdated={finding.headSha !== null && finding.headSha !== detail.headSha}
                focused={focus?.anchor === `finding:${finding.id}`}
                actions={actions}
              />
              {finding.endLine !== null && canExpand && !fullFile ? (
                <Button size="sm" variant="ghost" className="absolute right-4 top-3 h-6 text-xs" onClick={onShowFullFile}>
                  <Icon name="Maximize2" className="size-3" />
                  Show in full file
                </Button>
              ) : null}
            </div>
          ))}
          {otherThreads.map((thread) => (
            <div key={thread.id} data-anchor={`thread:${thread.id}`}>
              <p className="px-3 pt-1 text-[11px] text-muted-foreground">
                {thread.isOutdated || thread.line === null ? "Outdated comment" : `Comment on line ${thread.line}, outside the shown hunks`}
              </p>
              <ThreadCard thread={thread} focused={focus?.anchor === `thread:${thread.id}`} actions={actions} />
            </div>
          ))}
        </div>
      )}
      <FileDiff<AnnotationData>
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        disableWorkerPool
        renderAnnotation={(annotation) =>
          annotation.metadata === undefined ? null : (
            <div key={annotationKey(annotation.metadata)} data-anchor={annotationKey(annotation.metadata)}>
              <AnnotationView data={annotation.metadata} focused={focus?.anchor === annotationKey(annotation.metadata)} actions={actions} />
            </div>
          )
        }
      />
    </div>
  );
}

type TokenProps = Parameters<NonNullable<NonNullable<FileDiffProps<AnnotationData>["options"]>["onTokenClick"]>>[0];
