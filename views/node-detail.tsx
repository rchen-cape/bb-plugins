import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, ThreadChat } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  CONTEXT_MODES,
  CONTEXT_MODE_LABELS,
  HANDOFF_LABELS,
  HANDOFF_MODES,
  NODE_STATE_LABELS,
  upstreamNodeIds,
  type ContextMode,
  type Handoff,
  type TreeNode,
  type WorkspaceTarget,
} from "../src/model";
import { formatRelativeTime } from "../src/time";
import { nextAutosaveDelayMs } from "./autosave";
import { StateMenu, type StateOption } from "./state-menu";
import { KIND_LABELS, kindChipClass, stateChipClass } from "./node-visuals";

export interface NodeUpdatePatch {
  title?: string;
  instruction?: string;
  contextMode?: ContextMode;
  handoff?: Handoff;
  customBrief?: string;
  workspace?: WorkspaceTarget;
  contextIncludes?: string[];
}

export interface ArtifactState {
  content: string;
  sha256: string | null;
  problem: string | null;
}

export interface NodeDetailProps {
  node: TreeNode;
  now: number;
  projectNodes: readonly TreeNode[];
  bbProjects: readonly { id: string; name: string }[];
  sharedEnvironments: readonly {
    id: string;
    projectId: string;
    label: string;
  }[];
  treeBbProjectId: string | null;
  branches: readonly string[];
  defaultBranch: string | null;
  branchProblem: string | null;
  artifact: ArtifactState | null;
  contextPreview: string | null;
  busyAction: string | null;
  onUpdate: (patch: NodeUpdatePatch) => void;
  onSaveArtifact: (content: string) => Promise<void>;
  onSaveSummary: (summary: string) => void;
  onAddDependency: (parentId: string) => void;
  onRemoveDependency: (parentId: string) => void;
  onPreviewContext: () => void;
  onCreateThread: (args: { baseBranch: string; prompt: string }) => void;
  onAttachBbProject: (bbProjectId: string) => void;
  onSetState: (target: StateTarget) => void;
  onResend: () => void;
  onOpenThread: () => void;
  onCompact: () => void;
  onDetachThread: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export type StateTarget = "open" | "working" | "done";

function workspaceValue(node: TreeNode): string {
  if (node.workspace.kind === "project") {
    return `project:${node.workspace.projectId}`;
  }
  if (node.workspace.kind === "environment") {
    return `environment:${node.workspace.environmentId}`;
  }
  return node.workspace.kind;
}

function parseWorkspaceValue(value: string): WorkspaceTarget | null {
  if (value === "tree") return { kind: "tree" };
  if (value.startsWith("project:")) {
    return { kind: "project", projectId: value.slice("project:".length) };
  }
  if (value.startsWith("environment:")) {
    return {
      kind: "environment",
      environmentId: value.slice("environment:".length),
    };
  }
  return null;
}

type StateChoice = "open" | "working" | "done" | "stale";

function stateSelectValue(node: TreeNode): StateChoice {
  if (node.state === "stale") return "stale";
  if (node.state === "in_progress") return "working";
  if (node.state === "completed") return "done";
  return "open";
}

function stateOptions(node: TreeNode): StateOption<StateChoice>[] {
  const blocked = node.state === "blocked";
  return [
    /*
     * Stale is the graph's verdict, so it can be where a task is but never
     * somewhere to put it. The same goes for blocked, which shares its entry
     * with ready because the way out of both is to have the work done.
     */
    ...(node.state === "stale"
      ? [
          {
            value: "stale" as const,
            label: NODE_STATE_LABELS.stale,
            state: "stale" as const,
            readOnly: true,
          },
        ]
      : []),
    {
      value: "open",
      label: blocked ? NODE_STATE_LABELS.blocked : NODE_STATE_LABELS.ready,
      state: blocked ? ("blocked" as const) : ("ready" as const),
    },
    {
      value: "working",
      label: NODE_STATE_LABELS.in_progress,
      state: "in_progress",
    },
    { value: "done", label: NODE_STATE_LABELS.completed, state: "completed" },
  ];
}

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function Disclosure({
  title,
  note,
  defaultOpen,
  children,
}: {
  title: string;
  note?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1 py-1.5 text-left text-2xs font-medium uppercase tracking-wide text-subtle-foreground hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="size-3 shrink-0"
          aria-hidden
        />
        <span className="min-w-0 truncate">{title}</span>
        {note}
      </button>
      {open ? (
        <div className="max-h-64 space-y-2 overflow-y-auto pb-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function AgentStart({
  treeBbProjectId,
  bbProjects,
  branches,
  defaultBranch,
  branchProblem,
  busy,
  busyAction,
  onAttachBbProject,
  onCreateThread,
  instruction,
  onInstructionChange,
  onInstructionCommit,
}: {
  treeBbProjectId: string | null;
  bbProjects: readonly { id: string; name: string }[];
  branches: readonly string[];
  defaultBranch: string | null;
  branchProblem: string | null;
  busy: boolean;
  busyAction: string | null;
  onAttachBbProject: (bbProjectId: string) => void;
  onCreateThread: (args: { baseBranch: string; prompt: string }) => void;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onInstructionCommit: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [bbProjectId, setBbProjectId] = useState("");
  const chosenBranch = branch === "" ? (defaultBranch ?? "") : branch;
  const chosenProject =
    bbProjectId === "" ? (bbProjects[0]?.id ?? "") : bbProjectId;

  if (treeBbProjectId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          This tree is not pointed at a bb project yet, so its agent tasks have
          nowhere to make a worktree.
        </p>
        {bbProjects.length === 0 ? (
          <p className="text-xs text-destructive" role="alert">
            Add a bb project first.
          </p>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <select
              aria-label="bb project for this tree"
              className={selectClass}
              value={chosenProject}
              disabled={busy}
              onChange={(event) => setBbProjectId(event.target.value)}
            >
              {bbProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={busy || chosenProject === ""}
              onClick={() => onAttachBbProject(chosenProject)}
            >
              {busyAction === "attach" ? "Linking…" : "Use this project"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Write what this task should do, then start it. It gets its own worktree
        off the branch you pick, and its thread opens with this instruction.
      </p>
      {branchProblem !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {branchProblem}
        </p>
      ) : null}
      <Textarea
        aria-label="Task instruction"
        placeholder="What should this task do?"
        className="min-h-24 flex-1 resize-none py-0 text-sm rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        onBlur={onInstructionCommit}
      />
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
        <select
          aria-label="Base branch"
          className={selectClass}
          value={chosenBranch}
          disabled={busy || branches.length === 0}
          onChange={(event) => setBranch(event.target.value)}
        >
          <option value="">Branch to work from…</option>
          {branches.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={
            busy || chosenBranch === "" || instruction.trim().length === 0
          }
          onClick={() =>
            onCreateThread({
              baseBranch: chosenBranch,
              prompt: instruction.trim(),
            })
          }
        >
          {busyAction === "open-thread" ? "Starting…" : "Start thread"}
        </Button>
      </div>
    </div>
  );
}

export function NodeDetail(props: NodeDetailProps) {
  const { node } = props;
  const [title, setTitle] = useState(node.title);
  const [instruction, setInstruction] = useState(node.instruction);
  const [customBrief, setCustomBrief] = useState(node.customBrief);
  const [summary, setSummary] = useState(node.summary);
  const [artifactDraft, setArtifactDraft] = useState<string | null>(null);
  const [isSavingArtifact, setIsSavingArtifact] = useState(false);
  const [dependencyChoice, setDependencyChoice] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstUnsavedAtRef = useRef<number | null>(null);
  const draftRef = useRef<string | null>(null);
  const writingRef = useRef(false);
  const queuedWriteRef = useRef<string | null>(null);
  const saveArtifactRef = useRef(props.onSaveArtifact);
  saveArtifactRef.current = props.onSaveArtifact;
  const nodeRef = useRef(node);
  const storedRef = useRef({
    title: node.title,
    instruction: node.instruction,
    customBrief: node.customBrief,
    summary: node.summary,
  });
  nodeRef.current = node;

  useEffect(() => {
    const previous = storedRef.current;
    storedRef.current = {
      title: node.title,
      instruction: node.instruction,
      customBrief: node.customBrief,
      summary: node.summary,
    };
    setTitle((draft) => (draft === previous.title ? node.title : draft));
    setInstruction((draft) =>
      draft === previous.instruction ? node.instruction : draft,
    );
    setCustomBrief((draft) =>
      draft === previous.customBrief ? node.customBrief : draft,
    );
    setSummary((draft) => (draft === previous.summary ? node.summary : draft));
  }, [node.title, node.instruction, node.customBrief, node.summary]);

  const busy = props.busyAction !== null;
  const isFinished = node.state === "completed" || node.state === "stale";
  const parents = node.dependsOn
    .map((parentId) =>
      props.projectNodes.find((candidate) => candidate.id === parentId),
    )
    .filter((candidate): candidate is TreeNode => candidate !== undefined);
  const dependencyCandidates = props.projectNodes.filter(
    (candidate) =>
      candidate.id !== node.id && !node.dependsOn.includes(candidate.id),
  );
  const upstreamIds = new Set(upstreamNodeIds(props.projectNodes, node.id));
  const includeCandidates = props.projectNodes.filter((candidate) =>
    upstreamIds.has(candidate.id),
  );
  const artifactContent = artifactDraft ?? props.artifact?.content ?? "";
  const isReadOnlyDocument = node.kind === "markdown" && isFinished;

  /*
   * One write at a time. Overlapping writes would race over the file's digest,
   * and the later edit is the only one worth keeping, so anything typed during
   * a write collapses into a single follow-up.
   */
  const writeArtifact = (content: string): void => {
    if (writingRef.current) {
      queuedWriteRef.current = content;
      return;
    }
    writingRef.current = true;
    setIsSavingArtifact(true);
    void saveArtifactRef.current(content).finally(() => {
      writingRef.current = false;
      const queued = queuedWriteRef.current;
      queuedWriteRef.current = null;
      if (queued !== null && queued !== content) {
        writeArtifact(queued);
        return;
      }
      setIsSavingArtifact(false);
    });
  };

  const clearSaveTimer = () => {
    if (saveTimerRef.current === null) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  };

  const queueArtifactSave = (content: string) => {
    setArtifactDraft(content);
    draftRef.current = content;
    setIsSavingArtifact(true);
    clearSaveTimer();
    if (firstUnsavedAtRef.current === null) {
      firstUnsavedAtRef.current = Date.now();
    }
    const delay = nextAutosaveDelayMs({
      firstUnsavedAt: firstUnsavedAtRef.current,
      now: Date.now(),
    });
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      firstUnsavedAtRef.current = null;
      writeArtifact(content);
    }, delay);
  };

  const flushArtifactSave = () => {
    if (saveTimerRef.current === null) return;
    clearSaveTimer();
    firstUnsavedAtRef.current = null;
    const pending = draftRef.current;
    if (pending !== null) writeArtifact(pending);
  };

  const flushRef = useRef(() => {});
  flushRef.current = flushArtifactSave;

  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Input
          aria-label="Task title"
          className="h-auto min-w-40 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-base font-semibold shadow-none focus-visible:ring-0 max-md:pointer-coarse:h-auto max-md:pointer-coarse:text-base"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const next = title.trim();
            if (next.length > 0 && next !== node.title) {
              props.onUpdate({ title: next });
            }
          }}
        />

        <StateMenu
          label="Task state"
          value={stateSelectValue(node)}
          state={node.state}
          disabled={busy}
          options={stateOptions(node)}
          onChange={(next) => {
            flushArtifactSave();
            if (next !== "stale") props.onSetState(next);
          }}
        />

        <span className={kindChipClass(node.kind)}>
          {KIND_LABELS[node.kind]}
        </span>

        <span className="shrink-0 text-2xs text-subtle-foreground">
          {isSavingArtifact
            ? "Saving…"
            : formatRelativeTime({ timestamp: node.updatedAt, now: props.now })}
        </span>

        {node.kind === "agent" && node.threadId !== null ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5"
            onClick={props.onOpenThread}
          >
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
            Open full thread
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="icon"
          aria-label="Close task details"
          className="size-7 shrink-0"
          onClick={props.onClose}
        >
          <Icon name="X" className="size-4" aria-hidden />
        </Button>
      </div>

      {node.state === "stale" ? (
        <p className="shrink-0 text-xs text-destructive-text">
          An upstream task changed after this one was completed. Set it back to{" "}
          {NODE_STATE_LABELS.ready} to redo it, or to{" "}
          {NODE_STATE_LABELS.completed} to keep this output.
        </p>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {node.kind === "agent" && node.threadId !== null ? (
          <ThreadChat
            threadId={node.threadId}
            variant="compact"
            /*
             * The task owns this thread, so the chat owns its own execution
             * controls rather than inheriting a pinned snapshot: the model and
             * the permission mode are the user's to change from here.
             */
            permissionPolicy="editable"
            className="-mx-3 min-h-0 flex-1"
          />
        ) : node.kind === "agent" ? (
          <AgentStart
            treeBbProjectId={props.treeBbProjectId}
            bbProjects={props.bbProjects}
            branches={props.branches}
            defaultBranch={props.defaultBranch}
            branchProblem={props.branchProblem}
            busy={busy}
            busyAction={props.busyAction}
            onAttachBbProject={props.onAttachBbProject}
            onCreateThread={props.onCreateThread}
            instruction={instruction}
            onInstructionChange={setInstruction}
            onInstructionCommit={() => {
              if (instruction !== node.instruction) {
                props.onUpdate({ instruction });
              }
            }}
          />
        ) : (
          <>
            {props.artifact !== null && props.artifact.problem !== null ? (
              <p className="shrink-0 text-xs text-destructive" role="alert">
                {props.artifact.problem}
              </p>
            ) : null}
            {isReadOnlyDocument ? (
              <div
                aria-label="Task document"
                aria-readonly="true"
                role="article"
                className="min-h-32 flex-1 overflow-y-auto"
              >
                <Markdown content={artifactContent} />
              </div>
            ) : (
              <Textarea
                aria-label="Task document"
                placeholder="Write the note here."
                className="min-h-32 flex-1 resize-none py-0 font-mono text-sm rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                value={artifactContent}
                disabled={props.artifact === null && artifactDraft === null}
                onChange={(event) => queueArtifactSave(event.target.value)}
                onBlur={flushArtifactSave}
              />
            )}
          </>
        )}
      </div>

      <div className="min-w-0 shrink-0 border-t border-border pt-1">
        <Disclosure key={`setup:${node.id}`} title="Setup" defaultOpen={false}>
          <Field
            label={
              parents.length === 0
                ? "Dependencies"
                : `Dependencies (${parents.length})`
            }
          >
            {parents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                A starting point — nothing upstream.
              </p>
            ) : (
              <ul className="space-y-1">
                {parents.map((parent) => (
                  <li
                    key={parent.id}
                    className="flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {parent.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove the dependency on ${parent.title}`}
                      className="size-6 shrink-0"
                      disabled={busy}
                      onClick={() => props.onRemoveDependency(parent.id)}
                    >
                      <Icon name="X" className="size-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {dependencyCandidates.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <select
                  aria-label="Add a dependency"
                  className={selectClass}
                  value={dependencyChoice}
                  onChange={(event) => setDependencyChoice(event.target.value)}
                >
                  <option value="">Add a dependency…</option>
                  {dependencyCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy || dependencyChoice === ""}
                  onClick={() => {
                    props.onAddDependency(dependencyChoice);
                    setDependencyChoice("");
                  }}
                >
                  Add
                </Button>
              </div>
            ) : null}
          </Field>

          <Field label="What it passes downstream">
            <select
              aria-label="Handoff"
              className={selectClass}
              value={node.handoff}
              onChange={(event) => {
                const next = HANDOFF_MODES.find(
                  (candidate) => candidate === event.target.value,
                );
                if (next !== undefined) props.onUpdate({ handoff: next });
              }}
            >
              {HANDOFF_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {HANDOFF_LABELS[mode]}
                </option>
              ))}
            </select>
            <p className="text-2xs text-subtle-foreground">
              {node.handoff === "full"
                ? "Tasks depending on this one receive this document in full, however little context they asked for."
                : "Tasks depending on this one receive its summary unless they ask for full parent output."}
            </p>
          </Field>

          <Field label="Context it receives">
            <select
              aria-label="Context mode"
              className={selectClass}
              value={node.contextMode}
              onChange={(event) => {
                const mode = CONTEXT_MODES.find(
                  (candidate) => candidate === event.target.value,
                );
                if (mode !== undefined) props.onUpdate({ contextMode: mode });
              }}
            >
              {CONTEXT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {CONTEXT_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
            {node.contextMode === "custom" ? (
              <>
                <Textarea
                  aria-label="What this task needs from upstream"
                  placeholder="What should be carried down from upstream?"
                  className="min-h-16 resize-y text-xs"
                  value={customBrief}
                  onChange={(event) => setCustomBrief(event.target.value)}
                  onBlur={() => {
                    if (customBrief !== node.customBrief) {
                      props.onUpdate({ customBrief });
                    }
                  }}
                />
                {includeCandidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing upstream yet.
                  </p>
                ) : (
                  includeCandidates.map((candidate) => (
                    <label
                      key={candidate.id}
                      className="flex min-w-0 items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={node.contextIncludes.includes(candidate.id)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...node.contextIncludes, candidate.id]
                            : node.contextIncludes.filter(
                                (id) => id !== candidate.id,
                              );
                          props.onUpdate({ contextIncludes: next });
                        }}
                      />
                      <span className="min-w-0 truncate">
                        {candidate.title}
                      </span>
                    </label>
                  ))
                )}
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={props.onPreviewContext}
            >
              {props.busyAction === "preview" ? "Loading…" : "Preview"}
            </Button>
            {props.contextPreview !== null ? (
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-2xs whitespace-pre-wrap">
                {props.contextPreview}
              </pre>
            ) : null}
          </Field>

          {node.kind === "agent" ? (
            <Field label="Where it runs">
              <select
                aria-label="Workspace"
                className={selectClass}
                value={workspaceValue(node)}
                onChange={(event) => {
                  const target = parseWorkspaceValue(event.target.value);
                  if (target !== null) props.onUpdate({ workspace: target });
                }}
              >
                <option value="tree">Scratch workspace (no repository)</option>
                {node.workspace.kind === "path" ? (
                  <option value="path">{node.workspace.path}</option>
                ) : null}
                {props.bbProjects.length > 0 ? (
                  <optgroup label="Its own new workspace">
                    {props.bbProjects.map((project) => (
                      <option key={project.id} value={`project:${project.id}`}>
                        {project.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {props.sharedEnvironments.length > 0 ? (
                  <optgroup label="Share an existing workspace">
                    {props.sharedEnvironments.map((environment) => (
                      <option
                        key={environment.id}
                        value={`environment:${environment.id}`}
                      >
                        {environment.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <p className="text-2xs text-subtle-foreground">
                {node.workspace.kind === "environment"
                  ? "Runs in a workspace it shares with anything else pointed at it."
                  : node.workspace.kind === "project"
                    ? "Gets its own workspace from that project — a fresh worktree when the project is set up for one."
                    : node.workspace.kind === "path"
                      ? "Set from the CLI. Runs in the bb project that owns this directory."
                      : "No repository. Its context arrives in the prompt and its deliverable is its final message."}
              </p>
            </Field>
          ) : null}

          {node.kind === "agent" && node.threadId !== null ? (
            <Field label="Thread">
              <div className="flex min-w-0 flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={props.onResend}
                >
                  {props.busyAction === "resend"
                    ? "Sending…"
                    : "Resend upstream context"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={props.onDetachThread}
                >
                  Detach thread
                </Button>
              </div>
            </Field>
          ) : null}

          <Field label="Danger zone">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={props.onDelete}
            >
              <Icon name="Trash2" className="size-3.5" aria-hidden />
              Delete task
            </Button>
          </Field>
        </Disclosure>

        <Disclosure
          key={`summary:${node.id}:${isFinished ? "open" : "closed"}`}
          title="Summary passed downstream"
          /*
           * Borrowed from the task states, so a summary in flight reads as
           * in progress and one that did not land reads as a problem.
           */
          note={
            node.summaryStatus === "pending" ? (
              <span className="shrink-0 text-warning-text">· summarizing…</span>
            ) : node.summaryStatus === "failed" ? (
              <span className="shrink-0 text-destructive-text">· failed</span>
            ) : undefined
          }
          defaultOpen={isFinished}
        >
          {node.summaryStatus === "failed" && node.summaryProblem !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {node.summaryProblem}
            </p>
          ) : null}
          <Textarea
            aria-label="Summary"
            placeholder="Completing this task fills this in."
            className="min-h-20 resize-y text-xs"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            onBlur={() => {
              if (summary !== node.summary) props.onSaveSummary(summary);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || node.summaryStatus === "pending"}
            onClick={props.onCompact}
          >
            {node.summaryStatus === "pending"
              ? "Summarizing…"
              : node.summaryStatus === "failed"
                ? "Try again"
                : "Compact with AI"}
          </Button>
        </Disclosure>
      </div>
    </div>
  );
}
