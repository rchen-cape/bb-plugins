import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { Card, DocDetail, DocSummary, SearchResult, WikiRpcContract, WikiStatus } from "../contract";
import { CHANGED_CHANNEL, INBOX_CHANNEL, type DocType } from "../lib/wiki";

const SEARCH_DEBOUNCE_MS = 120;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWikiRpc() {
  return useRpc<WikiRpcContract>();
}

function useChannelVersion(channel: string): number {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  useRealtime(channel, bump);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current === "reconnecting") bump();
    previous.current = connection;
  }, [connection, bump]);
  return version;
}

export function useWikiVersion(): number {
  return useChannelVersion(CHANGED_CHANNEL);
}

export function useInboxVersion(): number {
  return useChannelVersion(INBOX_CHANNEL);
}

function useLoaded<T>(load: () => Promise<T>, deps: readonly unknown[]): { value: T | undefined; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ value: T | undefined; error: string | null }>({ value: undefined, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setState({ value, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) setState((current) => ({ value: current.value, error: errorMessage(cause) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  return { ...state, reload };
}

export function useWikiSearch(query: string, type: DocType | null, limit = 30) {
  const rpc = useWikiRpc();
  const version = useWikiVersion();
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isQueryEmpty = query.trim() === "";

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        rpc.call("search", { query, type, limit }).then(
          (next) => {
            if (cancelled) return;
            setResult(next);
            setError(null);
          },
          (cause: unknown) => {
            if (!cancelled) setError(errorMessage(cause));
          },
        );
      },
      isQueryEmpty ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, query, type, limit, isQueryEmpty, version]);

  return { result, error };
}

export function useDocs(type: DocType | null = null) {
  const rpc = useWikiRpc();
  const version = useWikiVersion();
  const { value, error, reload } = useLoaded<DocSummary[]>(() => rpc.call("docs", { type }), [rpc, type, version]);
  return { docs: value, error, reload };
}

export function useDoc(slug: string) {
  const rpc = useWikiRpc();
  const version = useWikiVersion();
  const [loaded, setLoaded] = useState<{ slug: string; doc: DocDetail | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("doc", { slug }).then(
      (doc) => {
        if (!cancelled) setLoaded({ slug, doc, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) setLoaded((current) => ({ slug, doc: current?.slug === slug ? current.doc : null, error: errorMessage(cause) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, slug, version]);

  const current = loaded?.slug === slug ? loaded : null;
  return { doc: current === null ? undefined : current.doc, error: current?.error ?? null };
}

export function useInbox(status: "open" | "accepted" | "skipped" = "open") {
  const rpc = useWikiRpc();
  const version = useInboxVersion();
  const { value, error, reload } = useLoaded<Card[]>(() => rpc.call("inbox", { status }), [rpc, status, version]);
  return { cards: value, error, reload };
}

export function useWikiStatus() {
  const rpc = useWikiRpc();
  const wikiVersion = useWikiVersion();
  const inboxVersion = useInboxVersion();
  const { value, error, reload } = useLoaded<WikiStatus>(() => rpc.call("status", {}), [rpc, wikiVersion, inboxVersion]);
  return { status: value, error, reload };
}

export function assetUrl(pluginId: string, relPath: string): string {
  return `/api/v1/plugins/${pluginId}/http/asset?path=${encodeURIComponent(relPath)}`;
}

export function cardMediaUrl(pluginId: string, relPath: string): string {
  return `/api/v1/plugins/${pluginId}/http/card-media?path=${encodeURIComponent(relPath)}`;
}
