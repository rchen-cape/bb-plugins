import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { experimental_useCodeTheme, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Transaction, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { toast } from "sonner";
import type { DocDetail, DocSummary } from "../contract";
import { headingLineForAnchor } from "../lib/markdown-doc";
import { WIKI_PANEL } from "../lib/wiki";
import { codeHighlighting, contentVersion, externalChange, minimalChange, openDocument, saveDocument, type CodeTheme, type DocumentFormat } from "../lib/live-preview/index.js";
import { DocAutosave, type SaveState } from "./autosave";
import { createResolver, parseThreadHref, parseWikiHref } from "./doc-render";
import { errorMessage, useWikiRpc } from "./hooks";
import { docSubPath } from "./nav";
import { WikiEditorConfig, createWikiState, wikiContext, type WikiEditorContext } from "./wiki-editor";

export type SaveStatus = "idle" | "saving" | "saved" | "dirty" | "error";
export type ConflictKind = "changed" | "deleted";

interface Session {
  readonly view: EditorView;
  readonly autosave: DocAutosave;
  readonly config: WikiEditorConfig;
  setFormat(format: DocumentFormat): void;
  discard(): void;
}

interface LiveDocInput {
  slug: string;
  doc: DocDetail | null | undefined;
  docs: readonly DocSummary[] | undefined;
  anchor: string | null;
  raw: boolean;
}

export interface LiveDoc {
  container: RefObject<HTMLDivElement | null>;
  shown: DocDetail | null;
  gone: boolean;
  status: SaveStatus;
  statusDetail: string | null;
  conflict: ConflictKind | null;
  busy: boolean;
  error: string | null;
  flush(): Promise<boolean>;
  reload(): Promise<void>;
  overwrite(): Promise<void>;
  discard(): void;
}

const ABSOLUTE_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/(?!\/))/i;
const DELETED_MESSAGE = "This doc was deleted on disk. Overwrite to save your version.";

class DeletedOnDisk extends Error {}

function statusOf(save: SaveState, savedOnce: boolean): SaveStatus {
  switch (save.kind) {
    case "saving":
      return "saving";
    case "dirty":
    case "conflict":
      return "dirty";
    case "error":
      return "error";
    case "clean":
      return savedOnce ? "saved" : "idle";
  }
}

function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function applyExternal(session: Session, content: string): void {
  const next = openDocument(content);
  session.setFormat(next.format);
  const change = minimalChange(session.view.state.doc.toString(), next.text);
  if (change === null) return;
  session.view.dispatch({ changes: change, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] });
}

function useOpenLink(slug: string): (href: string) => void {
  const navigate = useBbNavigate();
  return useCallback(
    (href: string) => {
      const wiki = parseWikiHref(href);
      if (wiki !== null) {
        navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(wiki.slug, wiki.anchor) });
        return;
      }
      const thread = parseThreadHref(href);
      if (thread !== null) {
        navigate.toThread(thread);
        return;
      }
      if (href.startsWith("#")) {
        navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(slug, href.slice(1)) });
        return;
      }
      if (!ABSOLUTE_LINK.test(href)) return;
      if (!navigate.openUrl(new URL(href, window.location.origin).toString())) toast.error("Couldn't open this link.");
    },
    [navigate, slug],
  );
}

export function useLiveDoc({ slug, doc, docs, anchor, raw }: LiveDocInput): LiveDoc {
  const rpc = useWikiRpc();
  const pluginId = experimental_usePluginId();
  const codeTheme: CodeTheme | null = experimental_useCodeTheme().theme;
  const openLink = useOpenLink(slug);
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const reconcileSeq = useRef(0);
  const scrolledTo = useRef<string | null>(null);
  const applied = useRef<{ context: WikiEditorContext; raw: boolean; codeTheme: CodeTheme | null } | null>(null);
  const [known, setKnown] = useState<DocDetail | null>(doc ?? null);
  const [gone, setGone] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  const [savedOnce, setSavedOnce] = useState(false);
  const [conflict, setConflict] = useState<ConflictKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = doc ?? known;
  const title = shown?.title ?? "";
  const resolve = useMemo(() => createResolver(docs ?? []), [docs]);
  const context = useMemo<WikiEditorContext>(() => ({ pluginId, slug, title, resolve }), [pluginId, slug, title, resolve]);
  const ready = shown !== null && docs !== undefined && !gone;

  const latest = useLatest({ shown, context, raw, codeTheme, openLink, title });

  const flush = useCallback(async () => {
    const current = session.current;
    if (current === null) return true;
    return (await current.autosave.flush()).kind === "clean";
  }, []);

  useEffect(() => {
    if (doc !== null && doc !== undefined) setKnown(doc);
  }, [doc]);

  useEffect(() => {
    const parent = container.current;
    const initial = latest.current.shown;
    if (!ready || parent === null || initial === null) return;
    const opened = openDocument(initial.content);
    let format = opened.format;
    let autosave: DocAutosave | null = null;
    let saving = false;
    const versions = new WeakMap<Text, number>();
    const versionOf = (text: Text): number => {
      let known = versions.get(text);
      if (known === undefined) {
        known = contentVersion(text.toString());
        versions.set(text, known);
      }
      return known;
    };
    const onUpdate = (update: ViewUpdate) => {
      if (update.docChanged && !update.transactions.every((tr) => tr.annotation(externalChange) === true)) autosave?.edited();
      if (update.focusChanged && !update.view.hasFocus) void autosave?.flush();
    };
    const config = new WikiEditorConfig({ openLink: (href) => latest.current.openLink(href), save: () => void flush(), onUpdate });
    const view = new EditorView({
      parent,
      state: createWikiState(opened.text, config.extensions({ context: latest.current.context, raw: latest.current.raw, codeTheme: latest.current.codeTheme })),
    });
    autosave = new DocAutosave({
      document: { getValue: () => saveDocument(view.state.doc, format), getAlternativeVersionId: () => versionOf(view.state.doc) },
      sha256: initial.sha256,
      write: async (content, expectedSha256) => {
        const result = await rpc.call("saveDoc", { slug, content, expectedSha256 });
        return result.outcome === "written" ? { outcome: "written", sha256: result.sha256 } : { outcome: "conflict" };
      },
      onStateChange: (state) => {
        setSave(state);
        if (state.kind === "saving") saving = true;
        if (state.kind === "clean") {
          setConflict(null);
          if (saving) setSavedOnce(true);
        }
        if (state.kind === "conflict") setConflict((current) => current ?? "changed");
      },
    });
    const closing = autosave;
    let discarded = false;
    session.current = {
      view,
      autosave,
      config,
      setFormat: (next) => {
        format = next;
      },
      discard: () => {
        discarded = true;
        void closing.close(false);
      },
    };
    applied.current = { context: latest.current.context, raw: latest.current.raw, codeTheme: latest.current.codeTheme };
    return () => {
      session.current = null;
      reconcileSeq.current += 1;
      const name = latest.current.title || slug;
      void closing.close(!discarded).then((state) => {
        if (!discarded && (state.kind === "error" || state.kind === "conflict")) toast.error(`Couldn't save ${name}`);
      });
      view.destroy();
    };
  }, [ready]);

  useEffect(() => {
    const current = session.current;
    const last = applied.current;
    if (current === null || last === null) return;
    const effects = [];
    if (last.context !== context) effects.push(current.config.context.reconfigure(wikiContext.of(context)));
    if (last.raw !== raw || (!raw && last.context !== context)) effects.push(current.config.mode.reconfigure(current.config.modeExtension(raw, context)));
    if (last.codeTheme !== codeTheme) effects.push(current.config.code.reconfigure(codeHighlighting(codeTheme)));
    applied.current = { context, raw, codeTheme };
    if (effects.length > 0) current.view.dispatch({ effects });
  }, [context, raw, codeTheme]);

  useEffect(() => {
    if (doc === undefined) return;
    const current = session.current;
    if (current === null) {
      if (doc !== null) setGone(false);
      return;
    }
    const seq = ++reconcileSeq.current;
    const stale = () => seq !== reconcileSeq.current || session.current !== current;
    void (async () => {
      await current.autosave.idle();
      if (stale()) return;
      let incoming = doc;
      if (incoming !== null && incoming.sha256 === current.autosave.baseSha256) return;
      if (incoming !== null && current.autosave.knows(incoming.sha256)) {
        let confirmed: DocDetail | null;
        try {
          confirmed = await rpc.call("doc", { slug });
        } catch {
          return;
        }
        await current.autosave.idle();
        if (stale()) return;
        if (confirmed !== null && confirmed.sha256 === current.autosave.baseSha256) return;
        if (confirmed !== null && confirmed.sha256 !== incoming.sha256 && current.autosave.knows(confirmed.sha256)) return;
        incoming = confirmed;
      }
      if (incoming === null) {
        if (current.autosave.isClean()) {
          setGone(true);
          return;
        }
        setConflict("deleted");
        current.autosave.conflict();
        return;
      }
      const next = incoming;
      if (current.autosave.isClean()) {
        await current.autosave.replace(
          async () => next,
          (content) => applyExternal(current, content),
        );
        return;
      }
      setConflict("changed");
      current.autosave.conflict();
    })();
  }, [doc]);

  useEffect(() => {
    const onHide = () => {
      void session.current?.autosave.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (anchor === null) {
      scrolledTo.current = null;
      return;
    }
    const current = session.current;
    const key = `${slug}#${anchor}`;
    if (current === null || scrolledTo.current === key) return;
    const state = current.view.state;
    const line = headingLineForAnchor(state.doc.toString(), anchor);
    if (line === null || line + 1 > state.doc.lines) return;
    current.view.dispatch({ effects: EditorView.scrollIntoView(state.doc.line(line + 1).from, { y: "start" }) });
    scrolledTo.current = key;
  }, [anchor, slug, ready]);

  const reload = useCallback(async () => {
    const current = session.current;
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      await current.autosave.replace(
        async () => {
          const latestDoc = await rpc.call("doc", { slug });
          if (latestDoc === null) throw new DeletedOnDisk(DELETED_MESSAGE);
          return latestDoc;
        },
        (content) => applyExternal(current, content),
      );
      setConflict(null);
    } catch (cause) {
      if (cause instanceof DeletedOnDisk) setConflict("deleted");
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc, slug]);

  const overwrite = useCallback(async () => {
    const current = session.current;
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      const latestDoc = await rpc.call("doc", { slug });
      const state = await current.autosave.overwrite(latestDoc?.sha256 ?? null);
      if (state.kind === "clean") setConflict(null);
      if (state.kind === "error") setError(state.message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc, slug]);

  const discard = useCallback(() => {
    const current = session.current;
    if (current === null) return;
    current.discard();
    setConflict(null);
    setGone(true);
  }, []);

  return {
    container,
    shown,
    gone,
    status: statusOf(save, savedOnce),
    statusDetail: save.kind === "error" ? save.message : null,
    conflict: save.kind === "conflict" ? (conflict ?? "changed") : null,
    busy,
    error,
    flush,
    reload,
    overwrite,
    discard,
  };
}
