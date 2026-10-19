import { useCallback, useEffect, useRef, useState } from "react";

const MEMORY_LIMIT = 200;
const STORAGE_PREFIX = "pr-board:cache:v2:";

interface Entry<T> {
  value: T;
  at: number;
}

const memory = new Map<string, Entry<unknown>>();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remember<T>(key: string, entry: Entry<T>, persist: boolean): void {
  memory.delete(key);
  memory.set(key, entry);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
  if (!persist) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(entry));
  } catch {
    return;
  }
}

function recall<T>(key: string, persist: boolean): Entry<T> | null {
  const hit = memory.get(key);
  if (hit !== undefined) return hit as Entry<T>;
  if (!persist) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    memory.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

export interface Cached<T> {
  value: T | null;
  refreshing: boolean;
  error: string | null;
  reload(): void;
}

export function useCached<T>(
  key: string,
  load: () => Promise<T>,
  { persist = false, immutable = false }: { persist?: boolean; immutable?: boolean } = {},
): Cached<T> {
  const [state, setState] = useState<{ key: string; entry: Entry<T> | null; error: string | null }>(() => ({
    key,
    entry: recall<T>(key, persist),
    error: null,
  }));
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    const cached = recall<T>(key, persist);
    if (immutable && cached !== null) {
      setState({ key, entry: cached, error: null });
      return;
    }
    let live = true;
    setRefreshing(true);
    latest
      .current()
      .then(
        (value) => {
          if (!live) return;
          const entry = { value, at: Date.now() };
          remember(key, entry, persist);
          setState({ key, entry, error: null });
        },
        (error: unknown) => {
          if (live) setState({ key, entry: recall<T>(key, persist), error: errorMessage(error) });
        },
      )
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
    };
  }, [key, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const current = state.key === key ? state : { key, entry: recall<T>(key, persist), error: null };
  return { value: current.entry?.value ?? null, refreshing, error: current.error, reload };
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
