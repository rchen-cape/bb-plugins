import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { SketchRpcContract } from "../contract";
import { errorMessage } from "./bits";

export function useSketchRpc() {
  return useRpc<SketchRpcContract>();
}

export type SketchRpc = ReturnType<typeof useSketchRpc>;

export function useReconnect(onReconnect: () => void): void {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  const latest = useRef(onReconnect);
  latest.current = onReconnect;
  useEffect(() => {
    if (connection === "connected" && previous.current === "reconnecting") latest.current();
    previous.current = connection;
  }, [connection]);
}

export function useChannelVersion(channel: string): number {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  useRealtime(channel, bump);
  useReconnect(bump);
  return version;
}

export type Loaded<T> = { readonly value: T | undefined; readonly error: string | null; readonly reload: () => void };

export function useLoaded<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
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

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
