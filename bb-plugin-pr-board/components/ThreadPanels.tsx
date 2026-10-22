import { useEffect, useState } from "react";
import { ThreadChat, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { UPDATES_CHANNEL } from "../channel";
import type { ReviewState, rpcContract } from "../contract";
import { BOARD_PANEL, parseWorkspacePath, workspacePath, type PullRoute } from "../routes";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { errorMessage, useCached } from "./cache";

function Hint({ children }: { children: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
}

const THREAD_KINDS = {
  review: { name: "review thread", button: "Run review" },
  address: { name: "address thread", button: "Address comments" },
  explain: { name: "explain thread", button: null },
} as const;

type ThreadKind = keyof typeof THREAD_KINDS;

function threadIdOf(state: ReviewState | null, kind: ThreadKind): string | null {
  if (state === null) return null;
  return kind === "review" ? state.agent.threadId : kind === "address" ? state.addressAgent.threadId : state.explainAgent.threadId;
}

function PullThread({ pull, kind }: { pull: PullRoute; kind: ThreadKind }) {
  const rpc = useRpc<typeof rpcContract>();
  const state = useCached(`state:${pull.repo}#${pull.number}`, () => rpc.call("reviewState", pull));
  useRealtime(UPDATES_CHANNEL, state.reload);
  const [startError, setStartError] = useState<string | null>(null);
  const { name, button } = THREAD_KINDS[kind];
  const threadId = threadIdOf(state.value, kind);
  const startsItself = kind === "explain" && state.value !== null && threadId === null;
  useEffect(() => {
    if (!startsItself) return;
    rpc.call("openExplain", pull).then(state.reload, (error: unknown) => setStartError(errorMessage(error)));
  }, [startsItself]);
  if (state.value === null) return <Hint>{state.error ?? `Loading the ${name}…`}</Hint>;
  if (threadId === null) {
    if (button === null) return <Hint>{startError ?? `Starting the ${name}…`}</Hint>;
    return <Hint>{`No ${name} yet. Click ${button} on the PR page to start one.`}</Hint>;
  }
  const chat = <ThreadChat key={threadId} threadId={threadId} variant="compact" />;
  if (kind !== "address") return chat;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <OpenWorktreeBar pull={pull} />
      <div className="min-h-0 flex-1">{chat}</div>
    </div>
  );
}

function OpenWorktreeBar({ pull }: { pull: PullRoute }) {
  const rpc = useRpc<typeof rpcContract>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setOpening(true);
    setError(null);
    rpc
      .call("openAddressWorktree", pull)
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setOpening(false));
  };
  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-[11px] text-destructive" title={error ?? undefined}>
        {error}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        title="Open the address thread's worktree in VS Code"
        aria-label="Open the address thread's worktree in VS Code"
        disabled={opening}
        onClick={open}
      >
        <Icon name="Code" fallback="SquareArrowUpRight" className="size-3.5" />
        Open in VS Code
      </Button>
    </div>
  );
}

function PullThreadTab({ subPath, kind }: PluginNavPanelProps & { kind: ThreadKind }) {
  const pull = parseWorkspacePath(subPath);
  if (pull === null) return <Hint>{`Open a pull request from the board to see its ${THREAD_KINDS[kind].name} here.`}</Hint>;
  return <PullThread key={`${pull.repo}#${pull.number}`} pull={pull} kind={kind} />;
}

export function ReviewThreadTab(props: PluginNavPanelProps) {
  return <PullThreadTab {...props} kind="review" />;
}

export function AddressThreadTab(props: PluginNavPanelProps) {
  return <PullThreadTab {...props} kind="address" />;
}

export function ExplainThreadTab(props: PluginNavPanelProps) {
  return <PullThreadTab {...props} kind="explain" />;
}

export function ThreadDiffButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const route = useCached(`pull-for:${threadId}`, () => rpc.call("pullForThread", { threadId })).value;
  if (route === null) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs"
      title={`Open the diff of ${route.repo}#${route.number} in PR Board`}
      aria-label={`Open the diff of ${route.repo}#${route.number} in PR Board`}
      onClick={() => navigate.toPluginPanel(BOARD_PANEL, { subPath: workspacePath(route) })}
    >
      <Icon name="FileDiff" className="size-3.5" />
      {isCompactViewport ? null : "Review diff"}
    </Button>
  );
}
