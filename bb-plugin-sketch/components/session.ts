import type { SaveResult } from "../contract";
import { sameElements } from "../lib/history.js";
import { serializeScene, type SceneAppState, type SketchElement } from "../lib/scene.js";
import { errorMessage } from "./bits";
import { Store } from "./store";

export const SAVE_DEBOUNCE_MS = 700;
export const SAVE_MAX_WAIT_MS = 4000;
export const PREVIEW_DELAY_MS = 3000;

export type SaveStatus =
  | { readonly kind: "saved" }
  | { readonly kind: "pending" }
  | { readonly kind: "saving" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "missing" };

export type Draft = { readonly elements: readonly SketchElement[]; readonly grid: boolean };

export type SessionFile = {
  readonly id: string | null;
  readonly sha256: string | null;
  readonly appState: SceneAppState;
  readonly files: Record<string, unknown>;
  readonly draft: Draft;
};

export type CreatedFile = { id: string; title: string; sha256: string };

export type CreateFile = (content: string) => Promise<CreatedFile>;

export type SessionDeps = {
  readonly save: (input: { id: string; content: string; expectedSha256: string | null }) => Promise<SaveResult>;
  readonly create: CreateFile;
  readonly savePreview: (input: { id: string; sha256: string; elements: readonly SketchElement[] }) => Promise<void>;
  readonly onCreated: (created: { id: string; title: string }) => void;
};

type WriteTarget = { readonly kind: "file"; readonly expected: string | null } | { readonly kind: "new"; readonly create: CreateFile };

type Timer = ReturnType<typeof setTimeout>;

function idle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else run();
}

export class SketchSession {
  readonly status = new Store<{ status: SaveStatus }>({ status: { kind: "saved" } });
  private fileId: string | null;
  private sha: string | null;
  private appState: SceneAppState;
  private files: Record<string, unknown>;
  private saved: Draft;
  private draft: Draft;
  private rescued: Draft | null = null;
  private debounce: Timer | null = null;
  private maxWait: Timer | null = null;
  private previewTimer: Timer | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly deps: SessionDeps,
    file: SessionFile,
  ) {
    this.fileId = file.id;
    this.sha = file.sha256;
    this.appState = file.appState;
    this.files = file.files;
    this.saved = file.draft;
    this.draft = file.draft;
  }

  get id(): string | null {
    return this.fileId;
  }

  get sha256(): string | null {
    return this.sha;
  }

  get current(): SaveStatus {
    return this.status.get().status;
  }

  get stuck(): boolean {
    const { kind } = this.current;
    return kind === "conflict" || kind === "missing";
  }

  private setStatus(status: SaveStatus): void {
    this.status.set({ status });
  }

  private isSaved(draft: Draft): boolean {
    return draft.grid === this.saved.grid && sameElements(draft.elements, this.saved.elements);
  }

  hasUnsavedChanges(): boolean {
    return this.inFlight !== null || !this.isSaved(this.draft);
  }

  content(draft: Draft = this.draft): string {
    return serializeScene({ elements: draft.elements, appState: { ...this.appState, gridModeEnabled: draft.grid }, files: this.files });
  }

  update(draft: Draft): void {
    if (this.stopped || (draft.grid === this.draft.grid && draft.elements === this.draft.elements)) return;
    this.draft = draft;
    if (this.inFlight !== null) {
      this.again = true;
      return;
    }
    if (this.isSaved(draft)) {
      this.clearTimers();
      if (this.current.kind === "pending") this.setStatus({ kind: "saved" });
      return;
    }
    if (this.stuck) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.current.kind !== "error") this.setStatus({ kind: "pending" });
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
    this.maxWait ??= setTimeout(() => void this.flush(), SAVE_MAX_WAIT_MS);
  }

  private clearTimers(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.maxWait !== null) clearTimeout(this.maxWait);
    this.debounce = null;
    this.maxWait = null;
  }

  async flush(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
    this.clearTimers();
    if (this.stopped || this.stuck || this.isSaved(this.draft)) {
      if (this.current.kind === "pending") this.setStatus({ kind: "saved" });
      return;
    }
    await this.write({ kind: "file", expected: this.sha });
  }

  async keepMine(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
    if (this.stopped || this.current.kind === "missing") return;
    this.clearTimers();
    await this.write({ kind: "file", expected: null });
  }

  async saveAsNew(create: CreateFile): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
    if (this.stopped) return;
    this.clearTimers();
    await this.write({ kind: "new", create });
  }

  async rescue(copy: (content: string) => Promise<void>): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
    const draft = this.draft;
    if (this.stopped || !this.stuck || this.isSaved(draft) || this.rescued === draft) return;
    this.rescued = draft;
    try {
      await copy(this.content(draft));
    } catch (cause) {
      if (this.rescued === draft) this.rescued = null;
      throw cause;
    }
  }

  markMissing(): void {
    if (this.stopped || this.current.kind === "missing") return;
    this.clearTimers();
    this.again = false;
    this.setStatus({ kind: "missing" });
  }

  private write(target: WriteTarget): Promise<void> {
    const draft = this.draft;
    this.setStatus({ kind: "saving" });
    const run = this.persist(draft, target).finally(() => {
      this.inFlight = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.afterWrite();
      }
    });
    this.inFlight = run;
    return run;
  }

  private afterWrite(): void {
    if (this.stuck || this.current.kind === "error") return;
    if (!this.isSaved(this.draft)) this.schedule();
  }

  private async createFile(content: string, create: CreateFile): Promise<void> {
    const created = await create(content);
    this.fileId = created.id;
    this.sha = created.sha256;
    this.deps.onCreated({ id: created.id, title: created.title });
  }

  private async saveFile(id: string, content: string, expected: string | null): Promise<boolean> {
    const result = await this.deps.save({ id, content, expectedSha256: expected });
    if (result.outcome === "conflict") {
      this.setStatus({ kind: "conflict" });
      return false;
    }
    this.sha = result.sha256;
    return true;
  }

  private async persist(draft: Draft, target: WriteTarget): Promise<void> {
    try {
      const content = this.content(draft);
      if (target.kind === "new") await this.createFile(content, target.create);
      else if (this.fileId === null) await this.createFile(content, this.deps.create);
      else if (!(await this.saveFile(this.fileId, content, target.expected))) return;
      this.saved = draft;
      this.setStatus(this.isSaved(this.draft) ? { kind: "saved" } : { kind: "pending" });
      this.schedulePreview();
    } catch (cause) {
      this.setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  schedulePreview(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      idle(() => void this.renderPreview());
    }, PREVIEW_DELAY_MS);
  }

  private async renderPreview(): Promise<void> {
    const id = this.fileId;
    const sha256 = this.sha;
    if (this.stopped || id === null || sha256 === null || this.inFlight !== null) return;
    try {
      await this.deps.savePreview({ id, sha256, elements: this.saved.elements });
    } catch {
      return;
    }
  }

  canAdopt(sha256: string): boolean {
    return !this.stopped && sha256 !== this.sha && !this.stuck && !this.hasUnsavedChanges();
  }

  adopt(file: { sha256: string; appState: SceneAppState; files: Record<string, unknown>; draft: Draft }): void {
    this.clearTimers();
    this.again = false;
    this.sha = file.sha256;
    this.appState = file.appState;
    this.files = file.files;
    this.saved = file.draft;
    this.draft = file.draft;
    this.setStatus({ kind: "saved" });
    this.schedulePreview();
  }

  renamed(id: string): void {
    this.fileId = id;
  }

  discard(): void {
    this.stopped = true;
    this.dispose();
  }

  resume(): void {
    this.stopped = false;
    if (!this.isSaved(this.draft)) this.schedule();
  }

  meta(): { appState: SceneAppState; files: Record<string, unknown> } {
    return { appState: this.appState, files: this.files };
  }

  dispose(): void {
    this.clearTimers();
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }
}
