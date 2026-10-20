import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { CHANGED_CHANNEL, LIMITS, SKETCH_PANEL } from "../lib/sketch.js";
import { errorMessage, Spinner } from "./bits";
import { useChannelVersion, useLatest, useLoaded, useSketchRpc } from "./hooks";
import { isOpenDoc, newDoc, openDetail, readSceneFile, renameDoc, type PageState } from "./page-state";
import { defaultSketch, routeSketchId, sketchSubPath, titleFromFileName } from "./routes";
import type { SketchSession } from "./session";
import { readLast, writeLast } from "./storage";
import { Button } from "./ui/button";
import { Workspace, type PageActions, type WorkspacePage } from "./Workspace";

function Shell({ children }: { children: ReactNode }) {
  return <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-background p-6">{children}</div>;
}

function Problem({ title, message, actions }: { title: string; message: string; actions: ReactNode }) {
  return (
    <Shell>
      <div role="alert" className="grid max-w-md gap-2 text-center">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="mt-2 flex justify-center gap-2">{actions}</div>
      </div>
    </Shell>
  );
}

function isDrafting(page: PageState, sessions: ReadonlyMap<string, SketchSession>): boolean {
  return page.kind === "open" && page.doc.id === null && sessions.get(page.doc.key)?.hasUnsavedChanges() === true;
}

export function SketchPage({ subPath }: PluginNavPanelProps) {
  const rpc = useSketchRpc();
  const navigate = useLatest(useBbNavigate());
  const version = useChannelVersion(CHANGED_CHANNEL);
  const list = useLoaded(() => rpc.call("list", {}), [rpc, version]);
  const [removed, setRemoved] = useState<{ readonly from: unknown; readonly ids: ReadonlySet<string> }>({ from: null, ids: new Set() });
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<PageState>({ kind: "loading" });
  const sessions = useRef(new Map<string, SketchSession>());
  const sketches = useMemo(
    () => (removed.from === list.value ? list.value?.filter((sketch) => !removed.ids.has(sketch.id)) : list.value),
    [list.value, removed],
  );
  const listRef = useLatest(list.value);
  const hide = useCallback(
    (id: string) =>
      setRemoved((current) => ({ from: listRef.current, ids: current.from === listRef.current ? new Set([...current.ids, id]) : new Set([id]) })),
    [listRef],
  );
  const routeId = routeSketchId(subPath);
  const openId = page.kind === "open" ? page.doc.id : null;
  const pageRef = useLatest(page);
  const openIdRef = useLatest(openId);
  const toastedMissing = useRef<string | null>(null);

  const go = useCallback(
    (id: string | null, replace = false) => {
      navigate.current.toPluginPanel(SKETCH_PANEL, id === null ? { subPath: "", replace } : { subPath: sketchSubPath(id), replace });
    },
    [navigate],
  );

  useEffect(() => {
    const current = pageRef.current;
    if (routeId !== null || sketches === undefined || isDrafting(current, sessions.current)) return;
    const target = defaultSketch(sketches, current.kind === "open" && current.doc.id !== null ? current.doc.id : readLast());
    if (target !== null) {
      go(target, true);
      return;
    }
    if (subPath.replace(/\//g, "") !== "") {
      go(null, true);
      return;
    }
    if (current.kind !== "open" || current.doc.id !== null) setPage({ kind: "open", doc: newDoc() });
  }, [routeId, sketches, subPath, go, pageRef]);

  useEffect(() => {
    if (routeId === null || routeId === openIdRef.current) return;
    let cancelled = false;
    rpc.call("get", { id: routeId }).then(
      (detail) => {
        if (cancelled) return;
        if (detail !== null) {
          const opened = openDetail(detail);
          setPage(opened.state);
          if (opened.notice !== null) toast.message(opened.notice);
          return;
        }
        if (toastedMissing.current !== routeId) toast.error(`Couldn't find “${routeId}”.`);
        toastedMissing.current = routeId;
        hide(routeId);
        go(null, true);
      },
      (cause: unknown) => {
        if (!cancelled) setPage({ kind: "broken", title: routeId, message: errorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, routeId, openIdRef, go, retry, hide]);

  useEffect(() => {
    if (openId !== null) writeLast(openId);
  }, [openId]);

  const actions = useMemo<Omit<PageActions, "identify">>(
    () => ({
      open: (id) => go(id),
      create: () => {
        rpc.call("create", { title: null, content: null }).then(
          (detail) => go(detail.id),
          (cause: unknown) => toast.error(`Couldn't create a sketch: ${errorMessage(cause)}`),
        );
      },
      importFile: (file) => {
        const run = async () => {
          const content = await readSceneFile(file);
          const detail = await rpc.call("create", { title: titleFromFileName(file.name, LIMITS.title), content });
          toast.success(`Opened “${detail.title}”`);
          go(detail.id);
        };
        run().catch((cause: unknown) => toast.error(`Couldn't open ${file.name}: ${errorMessage(cause)}`));
      },
      deleted: (id) => {
        hide(id);
        if (readLast() === id) writeLast(null);
        const next = defaultSketch((sketches ?? []).filter((sketch) => sketch.id !== id), null);
        go(next, true);
      },
    }),
    [rpc, go, sketches, hide],
  );

  const actionsFor = useCallback(
    (key: string): WorkspacePage => ({
      ...actions,
      identify: (id, title) => {
        const showing = isOpenDoc(pageRef.current, key);
        setPage((current) => renameDoc(current, key, id, title));
        if (showing) go(id, true);
        else toast.success(`Saved your drawing as “${title}”`);
        list.reload();
      },
      track: (session) => {
        sessions.current.set(key, session);
        return () => {
          if (sessions.current.get(key) === session) sessions.current.delete(key);
        };
      },
    }),
    [actions, pageRef, go, list.reload],
  );
  const openKey = page.kind === "open" ? page.doc.key : null;
  const workspacePage = useMemo(() => (openKey === null ? null : actionsFor(openKey)), [actionsFor, openKey]);

  if (page.kind === "broken") {
    return (
      <Problem
        title={`Couldn't open “${page.title}”`}
        message={page.message}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setRetry((current) => current + 1)}>
              Try again
            </Button>
            <Button size="sm" onClick={actions.create}>
              New sketch
            </Button>
          </>
        }
      />
    );
  }
  if (page.kind === "loading" || workspacePage === null) {
    if (list.error !== null && sketches === undefined) {
      return <Problem title="Couldn't load your sketches" message={list.error} actions={<Button variant="outline" size="sm" onClick={list.reload}>Try again</Button>} />;
    }
    return (
      <Shell>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </p>
      </Shell>
    );
  }
  return <Workspace key={page.doc.key} doc={page.doc} sketches={sketches} listError={list.error} page={workspacePage} />;
}
