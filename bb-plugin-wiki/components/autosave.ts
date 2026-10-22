export type SaveState = { kind: "clean" } | { kind: "dirty" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "conflict" };

export type WriteOutcome = { outcome: "written"; sha256: string } | { outcome: "conflict" };

export interface AutosaveDocument {
  getValue(): string;
  getAlternativeVersionId(): number;
}

export interface DocAutosaveOptions {
  document: AutosaveDocument;
  sha256: string;
  write: (content: string, expectedSha256: string | null) => Promise<WriteOutcome>;
  onStateChange: (state: SaveState) => void;
  delayMs?: number;
  maxWaitMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
}

export const AUTOSAVE_DELAY_MS = 1000;
export const AUTOSAVE_MAX_WAIT_MS = 5000;
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];

interface PendingWrite {
  content: string;
  version: number;
  overwrite: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DocAutosave {
  private document: AutosaveDocument;
  private sha256: string;
  private conflictSha256: string | null = null;
  private savedVersion: number;
  private state: SaveState = { kind: "clean" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirtySince: number | null = null;
  private pending: PendingWrite | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private overwriting = false;
  private replacing = false;
  private closed = false;
  private readonly known = new Set<string>();
  private readonly write: DocAutosaveOptions["write"];
  private readonly onStateChange: DocAutosaveOptions["onStateChange"];
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => number;

  constructor(options: DocAutosaveOptions) {
    this.document = options.document;
    this.sha256 = options.sha256;
    this.known.add(options.sha256);
    this.savedVersion = options.document.getAlternativeVersionId();
    this.write = options.write;
    this.onStateChange = options.onStateChange;
    this.delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
    this.maxWaitMs = options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.now = options.now ?? Date.now;
  }

  get current(): SaveState {
    return this.state;
  }

  get baseSha256(): string {
    return this.sha256;
  }

  isClean(): boolean {
    return this.state.kind === "clean" && this.running === null && this.pending === null && !this.overwriting && this.isSaved();
  }

  knows(sha256: string): boolean {
    return this.known.has(sha256);
  }

  edited(): void {
    if (this.closed || this.replacing || this.state.kind === "conflict") return;
    if (this.running === null && this.isSaved() && !this.overwriting) {
      this.cancelTimer();
      this.dirtySince = null;
      this.setState({ kind: "clean" });
      return;
    }
    if (this.state.kind === "clean") this.setState({ kind: "dirty" });
    if (this.state.kind === "error" && this.timer !== null) return;
    this.dirtySince ??= this.now();
    this.schedule(this.debounceDelay());
  }

  flush(): Promise<SaveState> {
    if (this.closed || this.replacing) return this.idle();
    return this.enqueue(false);
  }

  conflict(): void {
    if (this.closed) return;
    this.cancelTimer();
    this.pending = null;
    this.setState({ kind: "conflict" });
  }

  overwrite(currentSha256: string | null): Promise<SaveState> {
    if (this.closed || this.replacing) return this.idle();
    if (this.state.kind !== "conflict" && !this.overwriting) return this.enqueue(false);
    this.conflictSha256 = currentSha256;
    return this.enqueue(true);
  }

  async replace(load: () => Promise<{ content: string; sha256: string }>, apply: (content: string) => void): Promise<void> {
    if (this.closed || this.replacing) return;
    this.cancelTimer();
    this.pending = null;
    this.replacing = true;
    try {
      await this.running;
      const file = await load();
      if (this.closed) return;
      apply(file.content);
      this.sha256 = file.sha256;
      this.known.add(file.sha256);
      this.conflictSha256 = null;
      this.overwriting = false;
      this.savedVersion = this.document.getAlternativeVersionId();
      this.failures = 0;
      this.dirtySince = null;
      this.setState({ kind: "clean" });
    } finally {
      this.replacing = false;
      if (!this.closed && this.state.kind !== "conflict" && !this.isSaved()) {
        this.dirtySince ??= this.now();
        this.schedule(this.delayMs);
      }
    }
  }

  close(save: boolean): Promise<SaveState> {
    if (this.closed) return this.idle();
    const content = this.document.getValue();
    const version = this.document.getAlternativeVersionId();
    this.document = { getValue: () => content, getAlternativeVersionId: () => version };
    this.closed = true;
    this.cancelTimer();
    if (!save || this.state.kind === "conflict" || this.replacing) {
      this.pending = null;
      return this.idle();
    }
    return this.enqueue(false);
  }

  idle(): Promise<SaveState> {
    return (this.running ?? Promise.resolve()).then(() => this.state);
  }

  private debounceDelay(): number {
    const since = this.dirtySince ?? this.now();
    return Math.max(0, Math.min(this.delayMs, since + this.maxWaitMs - this.now()));
  }

  private enqueue(requested: boolean): Promise<SaveState> {
    this.cancelTimer();
    const overwrite = requested || this.overwriting;
    const version = this.document.getAlternativeVersionId();
    if (this.state.kind === "conflict" && !overwrite) return this.idle();
    if (!overwrite && this.running === null && version === this.savedVersion) {
      this.dirtySince = null;
      this.setState({ kind: "clean" });
      return this.idle();
    }
    this.dirtySince = null;
    this.pending = { content: this.document.getValue(), version, overwrite: overwrite || (this.pending?.overwrite ?? false) };
    this.running ??= this.drain();
    return this.idle();
  }

  private async drain(): Promise<void> {
    while (this.pending !== null) {
      const job = this.pending;
      this.pending = null;
      if (!job.overwrite && job.version === this.savedVersion) continue;
      if (this.state.kind !== "error") this.setState({ kind: "saving" });
      let result: WriteOutcome;
      try {
        result = await this.write(job.content, job.overwrite ? this.conflictSha256 : this.sha256);
      } catch (error) {
        this.pending = null;
        if (job.overwrite) this.overwriting = true;
        this.failures += 1;
        this.setState({ kind: "error", message: errorText(error) });
        const retry = this.retryDelaysMs[Math.min(this.failures, this.retryDelaysMs.length) - 1];
        if (retry !== undefined) this.schedule(retry);
        break;
      }
      this.overwriting = false;
      if (result.outcome === "conflict") {
        this.pending = null;
        this.setState({ kind: "conflict" });
        break;
      }
      this.failures = 0;
      this.sha256 = result.sha256;
      this.known.add(result.sha256);
      this.conflictSha256 = null;
      this.savedVersion = job.version;
      if (this.state.kind === "error") this.setState({ kind: "saving" });
    }
    this.running = null;
    if (this.state.kind === "saving") {
      if (this.isSaved()) {
        this.setState({ kind: "clean" });
      } else {
        this.setState({ kind: "dirty" });
        this.dirtySince ??= this.now();
        if (this.timer === null) this.schedule(this.debounceDelay());
      }
    }
  }

  private isSaved(): boolean {
    return this.document.getAlternativeVersionId() === this.savedVersion;
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(next: SaveState): void {
    if (next.kind === this.state.kind && (next.kind !== "error" || (this.state.kind === "error" && this.state.message === next.message))) return;
    this.state = next;
    this.onStateChange(next);
  }
}
