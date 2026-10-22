import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

const REQUEST_TIMEOUT_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 2;

export interface Location {
  uri: string;
  /** 0-based, as LSP sends it. */
  line: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** A minimal LSP client over a pair of streams: it sends requests and answers the server's own requests with null. */
export function lspConnection(input: Writable, output: Readable) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let closed: Error | null = null;
  const pending = new Map<number, Pending>();

  const write = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    input.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  };

  const receive = (message: { id?: number | string; method?: string; params?: { items?: unknown[] }; result?: unknown; error?: { message: string } }) => {
    if (message.method !== undefined) {
      // workspace/configuration wants one entry per item; every other server request takes null.
      if (message.id !== undefined) write({ id: message.id, result: message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => null) : null });
      return;
    }
    const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (waiting === undefined) return;
    pending.delete(message.id as number);
    clearTimeout(waiting.timer);
    if (message.error !== undefined) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  };

  output.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      receive(JSON.parse(body));
    }
  });

  return {
    request(method: string, params: unknown): Promise<unknown> {
      if (closed !== null) return Promise.reject(closed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`gopls did not answer ${method} in time`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method: string, params: unknown): void {
      if (closed === null) write({ method, params });
    },
    close(error: Error): void {
      closed ??= error;
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
      }
      pending.clear();
    },
  };
}

type Connection = ReturnType<typeof lspConnection>;

interface Session {
  connection: Connection;
  ready: Promise<unknown>;
  stop(): void;
  idle?: NodeJS.Timeout;
}

/**
 * Keeps one `gopls` language server running per worktree commit, the way an editor does, so a
 * lookup after the first only asks the already loaded server. A server stops after ten idle minutes.
 */
export function createGoplsSessions() {
  const sessions = new Map<string, Session>();

  const stop = (key: string) => {
    const session = sessions.get(key);
    if (session === undefined) return;
    sessions.delete(key);
    clearTimeout(session.idle);
    session.stop();
  };

  const open = (gopls: string, root: string, key: string): Session => {
    const child = spawn(gopls, ["serve"], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    const connection = lspConnection(child.stdin, child.stdout);
    const exited = (error: Error) => {
      connection.close(error);
      if (sessions.get(key)?.connection === connection) stop(key);
    };
    child.on("error", exited);
    child.on("exit", () => exited(new Error("gopls exited")));
    child.stdin.on("error", () => {});
    const rootUri = pathToFileURL(root).href;
    const ready = connection
      .request("initialize", { processId: process.pid, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: "review" }] })
      .then(() => connection.notify("initialized", {}));
    ready.catch(() => stop(key));
    return { connection, ready, stop: () => child.kill() };
  };

  const session = (gopls: string, root: string, commit: string): Session => {
    const key = `${root}\u0000${commit}`;
    for (const other of sessions.keys()) if (other !== key && other.startsWith(`${root}\u0000`)) stop(other);
    let found = sessions.get(key);
    if (found === undefined) {
      if (sessions.size >= MAX_SESSIONS) stop(sessions.keys().next().value!);
      found = open(gopls, root, key);
    } else {
      sessions.delete(key);
    }
    sessions.set(key, found);
    clearTimeout(found.idle);
    found.idle = setTimeout(() => stop(key), IDLE_MS);
    found.idle.unref();
    return found;
  };

  return {
    /** `line` is 1-based and `character` counts UTF-16 code units, like a JS string index. */
    async definition(gopls: string, root: string, commit: string, file: string, line: number, character: number): Promise<Location | null> {
      const { connection, ready } = session(gopls, root, commit);
      await ready;
      const uri = pathToFileURL(file).href;
      connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: "go", version: 1, text: await readFile(file, "utf8") } });
      try {
        const result = await connection.request("textDocument/definition", { textDocument: { uri }, position: { line: line - 1, character } });
        const first = (Array.isArray(result) ? result[0] : result) as { uri?: string; targetUri?: string; range?: { start: { line: number } }; targetSelectionRange?: { start: { line: number } } } | undefined;
        const target = first?.uri ?? first?.targetUri;
        const start = first?.range ?? first?.targetSelectionRange;
        return target === undefined || start === undefined ? null : { uri: target, line: start.start.line };
      } finally {
        connection.notify("textDocument/didClose", { textDocument: { uri } });
      }
    },
    dispose(): void {
      for (const key of [...sessions.keys()]) stop(key);
    },
  };
}

export type GoplsSessions = ReturnType<typeof createGoplsSessions>;
