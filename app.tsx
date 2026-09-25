import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PanelResizer,
  panelWidthStyle,
  readStoredPanelPercent,
  storePanelPercent,
} from "./views/panel-resizer";
import type { treesRpcContract } from "./src/rpc";
import {
  TREES_REALTIME_CHANNEL,
  type NodeKind,
  type TreeGraph,
  type TreeProject,
} from "./src/model";
import { GraphCanvas } from "./views/graph-canvas";
import type { NodeDraft } from "./views/node-draft-card";
import {
  NodeDetail,
  type ArtifactState,
  type HandDownDelivery,
  type NodeUpdatePatch,
} from "./views/node-detail";
import { ReadyList, type ReadyEntryView } from "./views/ready-list";

const PANEL_PATH = "trees";
const READY_SEGMENT = "ready";
const RELATIVE_TIME_TICK_MS = 30_000;

type TreesRpc = ReturnType<typeof useRpc<typeof treesRpcContract>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface QueryState<T> {
  data: T | null;
  error: string | null;
}

function useTreesQuery<T>(
  key: string | null,
  run: (rpc: TreesRpc) => Promise<T>,
): QueryState<T> & { reload: () => void } {
  const rpc = useRpc<typeof treesRpcContract>();
  const [state, setState] = useState<QueryState<T>>({
    data: null,
    error: null,
  });
  const requestRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;

  const reload = useCallback(() => {
    if (key === null) {
      requestRef.current += 1;
      setState({ data: null, error: null });
      return;
    }
    const requestId = ++requestRef.current;
    runRef.current(rpc).then(
      (value) => {
        if (requestRef.current !== requestId) return;
        setState({ data: value, error: null });
      },
      (cause: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({ data: null, error: errorMessage(cause) });
      },
    );
  }, [key, rpc]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtime(TREES_REALTIME_CHANNEL, () => {
    reload();
  });

  return { ...state, reload };
}

function parseSubPath(subPath: string): {
  view: "index" | "ready" | "project";
  projectId: string | null;
  nodeId: string | null;
} {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  const first = parts[0];
  if (first === undefined) {
    return { view: "index", projectId: null, nodeId: null };
  }
  if (first === READY_SEGMENT) {
    return { view: "ready", projectId: null, nodeId: null };
  }
  /*
   * A tree's ready list sits under the tree, so leaving it lands back on that
   * tree's canvas rather than on every tree. Task ids never collide with the
   * segment, which is why it can share the slot.
   */
  if (parts[1] === READY_SEGMENT) {
    return { view: "ready", projectId: first, nodeId: null };
  }
  return {
    view: "project",
    projectId: first,
    nodeId: parts[1] ?? null,
  };
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      {children}
    </div>
  );
}

function ProjectIndex({
  projects,
  bbProjects,
  error,
  busy,
  onOpen,
  onCreate,
  onOpenReady,
  onReveal,
}: {
  projects: readonly TreeProject[] | null;
  bbProjects: readonly { id: string; name: string }[];
  error: string | null;
  busy: boolean;
  onOpen: (projectId: string) => void;
  onCreate: (args: { name: string; bbProjectId: string }) => void;
  onOpenReady: () => void;
  onReveal: (projectId: string) => void;
}) {
  const [name, setName] = useState("");
  const [bbProjectId, setBbProjectId] = useState("");
  const chosenProject =
    bbProjectId === "" ? (bbProjects[0]?.id ?? "") : bbProjectId;
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            A tree keeps its Markdown in the Trees folder and references a bb
            project, which is where its agent tasks get their worktrees.
          </p>
          {bbProjects.length === 0 ? (
            <p className="text-sm text-destructive" role="alert">
              Add a bb project first so agent tasks have somewhere to run.
            </p>
          ) : null}
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (next.length === 0 || chosenProject === "") return;
            onCreate({ name: next, bbProjectId: chosenProject });
            setName("");
          }}
        >
          <Input
            aria-label="New tree name"
            placeholder="Build auth feature"
            className="max-w-sm"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <select
            aria-label="bb project"
            className="h-9 max-w-56 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={chosenProject}
            disabled={busy || bbProjects.length === 0}
            onChange={(event) => setBbProjectId(event.target.value)}
          >
            <option value="">Project it belongs to…</option>
            {bbProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <Button
            type="submit"
            size="sm"
            disabled={busy || name.trim().length === 0 || chosenProject === ""}
          >
            New tree
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenReady}
          >
            What&rsquo;s ready
          </Button>
        </form>

        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {projects === null ? (
          <p className="text-sm text-muted-foreground">Loading trees…</p>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No trees yet. Name one above to get started.
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {project.name}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {project.nodeCount} tasks · {project.readyCount} ready
                    {project.staleCount > 0
                      ? ` · ${project.staleCount} stale`
                      : ""}
                  </div>
                  <div
                    className="truncate text-xs text-subtle-foreground"
                    title={project.directory}
                  >
                    {project.directory}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Show ${project.name} in the file manager`}
                    className="size-8"
                    disabled={busy}
                    onClick={() => onReveal(project.id)}
                  >
                    <Icon name="FolderOpen" className="size-4" aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpen(project.id)}
                  >
                    Open
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TreesHeader({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof treesRpcContract>();
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const [busy, setBusy] = useState(false);
  const projectsQuery = useTreesQuery("header-projects", (client) =>
    client.call("projects_list").then((result) => result.projects),
  );

  const goToPanel = useCallback(
    (nextSubPath: string) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: nextSubPath });
    },
    [navigate],
  );

  const run = useCallback((task: () => Promise<unknown>) => {
    setBusy(true);
    task()
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setBusy(false));
  }, []);

  const project =
    route.projectId === null
      ? null
      : ((projectsQuery.data ?? []).find(
          (candidate) => candidate.id === route.projectId,
        ) ?? null);

  if (route.view === "index" || route.view === "ready") return null;

  const projectId = route.projectId;
  if (projectId === null) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await rpc.call("layout_apply", { projectId });
          })
        }
      >
        Tidy layout
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => {
          if (
            !window.confirm(
              "Remove this tree from Trees? Its Markdown files stay on disk.",
            )
          ) {
            return;
          }
          run(async () => {
            await rpc.call("projects_delete", { projectId });
            goToPanel("");
          });
        }}
      >
        Delete tree
      </Button>
    </div>
  );
}

function BreadcrumbChevron() {
  return (
    <Icon
      name="ChevronRight"
      className="size-3 shrink-0 text-subtle-foreground"
      aria-hidden
    />
  );
}

function TreesBreadcrumb({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const projectsQuery = useTreesQuery("breadcrumb-projects", (client) =>
    client.call("projects_list").then((result) => result.projects),
  );

  if (route.view === "index") return null;

  const projectId = route.projectId;
  const project =
    projectId === null
      ? null
      : ((projectsQuery.data ?? []).find(
          (candidate) => candidate.id === projectId,
        ) ?? null);
  const projectName = project?.name ?? "…";
  const insideTree = route.view === "ready" && projectId !== null;
  const counts = insideTree ? null : project;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <BreadcrumbChevron />
      {projectId === null ? (
        <span className="truncate text-sm font-semibold">
          What&rsquo;s ready
        </span>
      ) : insideTree ? (
        <>
          {/* The tree is the way back to its canvas; Trees goes to all of them. */}
          <button
            type="button"
            className="shrink-0 truncate text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline"
            onClick={() =>
              navigate.toPluginPanel(PANEL_PATH, { subPath: projectId })
            }
          >
            {projectName}
          </button>
          <BreadcrumbChevron />
          <span className="truncate text-sm font-semibold">
            What&rsquo;s ready
          </span>
        </>
      ) : (
        <span className="truncate text-sm font-semibold">{projectName}</span>
      )}
      {counts === null || projectId === null ? null : (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <span className="hidden lg:inline">{counts.nodeCount} tasks ·</span>
          {/*
           * The count of what can be worked on is the way into the list of it,
           * so the tree needs no separate button. It stays visible where the
           * task count does not, or a narrow window would have no way there.
           */}
          <button
            type="button"
            className="shrink-0 hover:text-foreground hover:underline"
            onClick={() =>
              navigate.toPluginPanel(PANEL_PATH, {
                subPath: `${projectId}/${READY_SEGMENT}`,
              })
            }
          >
            {counts.readyCount} ready
          </button>
          {counts.staleCount > 0 ? (
            <span className="hidden lg:inline">
              · {counts.staleCount} stale
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}

function TreesPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof treesRpcContract>();
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);
  /*
   * The digest a write must present, kept out of render state: saves chain one
   * after another and the next one cannot wait for React to have committed the
   * previous one's result.
   */
  const artifactShaRef = useRef<string | null>(null);
  const [contextPreview, setContextPreview] = useState<string | null>(null);
  const [handDown, setHandDown] = useState<HandDownDelivery[] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    route.nodeId,
  );
  const [now, setNow] = useState(() => Date.now());
  const [panelPercent, setPanelPercent] = useState(readStoredPanelPercent);
  const splitRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const projectsQuery = useTreesQuery("projects", (client) =>
    client.call("projects_list").then((result) => result.projects),
  );
  const graphQuery = useTreesQuery<TreeGraph>(
    route.projectId === null ? null : `graph:${route.projectId}`,
    (client) => {
      const projectId = route.projectId;
      if (projectId === null) {
        return Promise.reject(new Error("No tree is open."));
      }
      return client.call("graph_get", { projectId });
    },
  );
  const readyQuery = useTreesQuery<ReadyEntryView[]>(
    route.view === "ready" ? `ready:${route.projectId ?? "all"}` : null,
    (client) =>
      client
        .call("ready_list", { projectId: route.projectId })
        .then((result) => result.entries),
  );
  const workspaceQuery = useTreesQuery("workspaces", (client) =>
    client.call("workspace_options"),
  );
  const needsBranches =
    selectedNodeId !== null &&
    (graphQuery.data?.nodes ?? []).some(
      (node) =>
        node.id === selectedNodeId &&
        node.kind === "agent" &&
        node.threadId === null,
    );
  const branchQuery = useTreesQuery(
    route.projectId === null || !needsBranches
      ? null
      : `branches:${route.projectId}`,
    (client) => {
      const projectId = route.projectId;
      if (projectId === null) {
        return Promise.reject(new Error("No tree is open."));
      }
      return client.call("base_branches", { projectId });
    },
  );

  const nodes = graphQuery.data?.nodes ?? [];
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const goToPanel = useCallback(
    (nextSubPath: string) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: nextSubPath });
    },
    [navigate],
  );

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId((current) => (current === nodeId ? null : nodeId));
  }, []);

  const perform = useCallback((label: string, run: () => Promise<unknown>) => {
    setBusyAction(label);
    run()
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      })
      .finally(() => setBusyAction(null));
  }, []);

  const performQuiet = useCallback(
    (run: () => Promise<unknown>): Promise<void> =>
      run().then(
        () => undefined,
        (error: unknown) => {
          toast.error(errorMessage(error));
        },
      ),
    [],
  );

  useEffect(() => {
    setContextPreview(null);
    setHandDown(null);
  }, [selectedNodeId]);

  const openedProjectRef = useRef(route.projectId);
  useEffect(() => {
    if (openedProjectRef.current === route.projectId) return;
    openedProjectRef.current = route.projectId;
    setSelectedNodeId(route.nodeId);
  }, [route.nodeId, route.projectId]);

  /*
   * Only the identity of the open note, so republishing the graph — which every
   * save does — cannot send the document back to disk and take the editor away
   * while it is being typed in.
   */
  const documentNodeId =
    selectedNode !== null && selectedNode.kind === "markdown"
      ? selectedNode.id
      : null;

  useEffect(() => {
    if (documentNodeId === null) {
      setArtifact(null);
      return;
    }
    let active = true;
    setArtifact(null);
    artifactShaRef.current = null;
    rpc.call("artifact_read", { nodeId: documentNodeId }).then(
      (result) => {
        if (!active) return;
        artifactShaRef.current = result.sha256;
        setArtifact(result);
      },
      (error: unknown) => {
        if (active) {
          setArtifact({
            content: "",
            sha256: null,
            problem: errorMessage(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [documentNodeId, rpc]);

  const updateNode = useCallback(
    (patch: NodeUpdatePatch) => {
      if (selectedNode === null) return;
      performQuiet(async () => {
        await rpc.call("node_update", { nodeId: selectedNode.id, ...patch });
        graphQuery.reload();
      });
    },
    [graphQuery, performQuiet, rpc, selectedNode],
  );

  const createFromDraft = useCallback(
    (args: { title: string; kind: NodeKind }) => {
      const projectId = route.projectId;
      if (projectId === null || draft === null) return;
      perform("create-node", async () => {
        /*
         * Creating a task without a position lays the whole tree out, which is
         * what every new task gets: a task only has a row once the graph says
         * which row, and the canvas is tidied to match.
         */
        const { node } = await rpc.call("node_create", {
          projectId,
          title: args.title,
          kind: args.kind,
          ...(draft.anchor === "child" ? { dependsOn: [draft.nodeId] } : {}),
        });
        /*
         * A parent's dependency can only be drawn once the task exists, and it
         * changes the layering the create already laid out, so this one needs
         * laying out a second time.
         */
        if (draft.anchor === "parent") {
          await rpc.call("dependency_add", {
            parentId: node.id,
            childId: draft.nodeId,
          });
          await rpc.call("layout_apply", { projectId });
        }
        setDraft(null);
        graphQuery.reload();
        projectsQuery.reload();
      });
    },
    [draft, graphQuery, perform, projectsQuery, route.projectId, rpc],
  );

  useEffect(() => {
    setDraft(null);
  }, [route.projectId]);

  if (route.view === "ready") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          <div className="mx-auto w-full max-w-3xl">
            {readyQuery.error !== null ? (
              <p className="text-sm text-destructive" role="alert">
                {readyQuery.error}
              </p>
            ) : readyQuery.data === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ReadyList
                entries={readyQuery.data}
                onOpen={({ projectId, nodeId }) => {
                  setSelectedNodeId(nodeId);
                  goToPanel(`${projectId}/${nodeId}`);
                }}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (route.view === "index" || route.projectId === null) {
    return (
      <ProjectIndex
        projects={projectsQuery.data}
        bbProjects={workspaceQuery.data?.projects ?? []}
        error={projectsQuery.error}
        busy={busyAction !== null}
        onOpen={(projectId) => goToPanel(projectId)}
        onOpenReady={() => goToPanel("ready")}
        onReveal={(treeProjectId) =>
          perform("reveal", async () => {
            const { directory } = await rpc.call("project_reveal", {
              projectId: treeProjectId,
            });
            toast.success(`Opened ${directory}.`);
          })
        }
        onCreate={({ name, bbProjectId }) =>
          perform("create-project", async () => {
            const { project } = await rpc.call("projects_create", {
              name,
              bbProjectId,
            });
            projectsQuery.reload();
            goToPanel(project.id);
          })
        }
      />
    );
  }

  if (graphQuery.error !== null) {
    return (
      <div className="p-4 md:p-5">
        <p className="text-sm text-destructive" role="alert">
          {graphQuery.error}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => goToPanel("")}
        >
          All trees
        </Button>
      </div>
    );
  }

  const graph = graphQuery.data;
  const projectId = route.projectId;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-w-0 flex-1",
            selectedNode !== null && "hidden md:block",
          )}
        >
          {graph === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading tasks…</p>
          ) : (
            <GraphCanvas
              nodes={graph.nodes}
              now={now}
              selectedNodeId={selectedNodeId}
              draft={draft}
              busy={busyAction !== null}
              onDraftOpen={setDraft}
              onDraftCancel={() => setDraft(null)}
              onDraftSubmit={createFromDraft}
              onSelect={selectNode}
              onMove={({ nodeId, x, y }) =>
                performQuiet(async () => {
                  await rpc.call("node_move", { nodeId, x, y });
                  graphQuery.reload();
                })
              }
              onConnect={({ parentId, childId }) =>
                performQuiet(async () => {
                  await rpc.call("dependency_add", { parentId, childId });
                  graphQuery.reload();
                })
              }
              onDisconnect={({ parentId, childId }) =>
                performQuiet(async () => {
                  await rpc.call("dependency_remove", { parentId, childId });
                  graphQuery.reload();
                })
              }
            />
          )}
        </div>

        {selectedNode !== null ? (
          <PanelResizer
            containerRef={splitRef}
            percent={panelPercent}
            onResize={setPanelPercent}
            onCommit={storePanelPercent}
          />
        ) : null}

        {selectedNode !== null ? (
          <aside
            style={panelWidthStyle(panelPercent)}
            className="flex min-h-0 w-full min-w-0 shrink-0 flex-col border-border bg-sidebar md:w-[var(--trees-panel-width)] md:border-l"
          >
            <NodeDetail
              key={selectedNode.id}
              node={selectedNode}
              now={now}
              projectNodes={nodes}
              bbProjects={workspaceQuery.data?.projects ?? []}
              sharedEnvironments={workspaceQuery.data?.environments ?? []}
              treeBbProjectId={graph?.project.bbProjectId ?? null}
              branches={branchQuery.data?.branches ?? []}
              defaultBranch={branchQuery.data?.defaultBranch ?? null}
              branchProblem={branchQuery.error}
              onCreateThread={({ baseBranch, prompt }) =>
                perform("open-thread", async () => {
                  await rpc.call("node_open_thread", {
                    nodeId: selectedNode.id,
                    baseBranch,
                    prompt,
                  });
                  graphQuery.reload();
                  projectsQuery.reload();
                })
              }
              onAttachBbProject={(bbProjectId) =>
                perform("attach", async () => {
                  await rpc.call("projects_set_bb_project", {
                    projectId,
                    bbProjectId,
                  });
                  graphQuery.reload();
                  projectsQuery.reload();
                })
              }
              artifact={artifact}
              contextPreview={contextPreview}
              busyAction={busyAction}
              onClose={() => selectNode(null)}
              onUpdate={updateNode}
              onSaveArtifact={(content) =>
                performQuiet(async () => {
                  const result = await rpc.call("artifact_write", {
                    nodeId: selectedNode.id,
                    content,
                    expectedSha256: artifactShaRef.current,
                  });
                  artifactShaRef.current = result.sha256;
                  setArtifact({
                    content,
                    sha256: result.sha256,
                    problem: null,
                  });
                  graphQuery.reload();
                })
              }
              onSaveSummary={(summary) =>
                performQuiet(async () => {
                  await rpc.call("node_summary_set", {
                    nodeId: selectedNode.id,
                    summary,
                  });
                  graphQuery.reload();
                })
              }
              onAddDependency={(parentId) =>
                performQuiet(async () => {
                  await rpc.call("dependency_add", {
                    parentId,
                    childId: selectedNode.id,
                  });
                  graphQuery.reload();
                })
              }
              onRemoveDependency={(parentId) =>
                performQuiet(async () => {
                  await rpc.call("dependency_remove", {
                    parentId,
                    childId: selectedNode.id,
                  });
                  graphQuery.reload();
                })
              }
              onPreviewContext={() =>
                perform("preview", async () => {
                  const preview = await rpc.call("context_preview", {
                    nodeId: selectedNode.id,
                  });
                  setContextPreview(preview.prompt);
                })
              }
              onSetState={(target) =>
                perform("state", async () => {
                  if (target === "open") {
                    await rpc.call("node_reopen", {
                      nodeId: selectedNode.id,
                      discardThread: false,
                    });
                  } else if (target === "working") {
                    await rpc.call("node_mark_working", {
                      nodeId: selectedNode.id,
                    });
                  } else if (selectedNode.state === "stale") {
                    await rpc.call("node_acknowledge", {
                      nodeId: selectedNode.id,
                    });
                  } else {
                    const result = await rpc.call("node_complete", {
                      nodeId: selectedNode.id,
                    });
                    if (result.summaryProblem !== null) {
                      toast.warning(
                        `Completed, but the summary could not be generated: ${result.summaryProblem}`,
                      );
                    }
                  }
                  graphQuery.reload();
                  projectsQuery.reload();
                })
              }
              onResend={() =>
                perform("resend", async () => {
                  await rpc.call("node_resend", { nodeId: selectedNode.id });
                  graphQuery.reload();
                  toast.success("Sent the current context to the thread.");
                })
              }
              onOpenThread={() => {
                if (selectedNode.threadId !== null) {
                  navigate.toThread(selectedNode.threadId);
                }
              }}
              onCompact={() =>
                perform("compact", async () => {
                  await rpc.call("node_compact", { nodeId: selectedNode.id });
                  graphQuery.reload();
                })
              }
              handDown={handDown}
              onHandDown={() =>
                perform("handdown", async () => {
                  const result = await rpc.call("node_hand_down", {
                    nodeId: selectedNode.id,
                  });
                  setHandDown(result.deliveries);
                  graphQuery.reload();
                })
              }
              onDetachThread={() =>
                perform("detach", async () => {
                  await rpc.call("node_reopen", {
                    nodeId: selectedNode.id,
                    discardThread: true,
                  });
                  graphQuery.reload();
                  projectsQuery.reload();
                })
              }
              onDelete={() => {
                if (
                  !window.confirm(
                    `Delete “${selectedNode.title}”? Its children will depend on its parents instead, and ${selectedNode.artifactFile} stays on disk.`,
                  )
                ) {
                  return;
                }
                perform("delete-node", async () => {
                  await rpc.call("node_delete", { nodeId: selectedNode.id });
                  selectNode(null);
                  graphQuery.reload();
                  projectsQuery.reload();
                });
              }}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "trees",
    title: "Trees",
    icon: "Workflow",
    path: PANEL_PATH,
    component: TreesPanel,
    headerContent: TreesHeader,
    experimental_headerBreadcrumb: TreesBreadcrumb,
  });
});
