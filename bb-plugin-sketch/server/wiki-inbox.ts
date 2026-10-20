import { httpFailure } from "./wiki-errors.js";

export const INBOX_RECHECK_MS = 60_000;

export interface WikiBuild {
  version: string;
  status: string;
  updatedAt?: string | undefined;
}

interface Known {
  key: string;
  inbox: boolean;
  at: number;
}

export function buildKey(build: WikiBuild): string {
  return JSON.stringify([build.version, build.status, build.updatedAt ?? null]);
}

export function probeVerdict(error: unknown): boolean | null {
  const http = httpFailure(error);
  if (http === null) return null;
  if (http.code === "unknown_method") return false;
  if (http.code === "invalid_input" || http.status === 400) return true;
  return null;
}

export function createInboxCheck(probe: () => Promise<unknown>, now: () => number = Date.now) {
  let known: Known | null = null;

  async function ask(): Promise<boolean | null> {
    try {
      await probe();
      return true;
    } catch (error) {
      return probeVerdict(error);
    }
  }

  function fresh(key: string): Known | null {
    if (known === null || known.key !== key) return null;
    return known.inbox || now() - known.at < INBOX_RECHECK_MS ? known : null;
  }

  async function supported(build: WikiBuild): Promise<boolean> {
    const key = buildKey(build);
    const cached = fresh(key);
    if (cached !== null) return cached.inbox;
    const inbox = await ask();
    if (inbox !== null) known = { key, inbox, at: now() };
    return inbox ?? true;
  }

  function learn(inbox: boolean): void {
    if (known !== null) known = { ...known, inbox, at: now() };
  }

  return { supported, learn };
}
