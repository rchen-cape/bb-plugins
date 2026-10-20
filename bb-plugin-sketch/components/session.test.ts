import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveResult } from "../contract";
import { parseSceneFile, type SketchElement } from "../lib/scene";
import { rect } from "../lib/test-fixtures";
import { PREVIEW_DELAY_MS, SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS, SketchSession, type SessionDeps } from "./session";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

type SaveInput = { id: string; content: string; expectedSha256: string | null };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { id?: string | null; save?: (input: SaveInput) => Promise<SaveResult> } = {}) {
  const saves: SaveInput[] = [];
  const save = vi.fn(async (input: SaveInput): Promise<SaveResult> => {
    saves.push(input);
    return options.save === undefined ? { outcome: "written", sha256: SHA_B, updatedAt: "now" } : options.save(input);
  });
  const create = vi.fn(async () => ({ id: "Untitled", title: "Untitled", sha256: SHA_B }));
  const savePreview = vi.fn(async () => undefined);
  const onCreated = vi.fn();
  const deps: SessionDeps = { save, create, savePreview, onCreated };
  const initial: readonly SketchElement[] = [rect(0, 0, 10, 10, { id: "a" })];
  const session = new SketchSession(deps, {
    id: options.id === undefined ? "Plan" : options.id,
    sha256: options.id === null ? null : SHA_A,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
    draft: { elements: initial, grid: false },
  });
  return { session, saves, save, create, savePreview, onCreated, initial };
}

function edit(elements: readonly SketchElement[]): readonly SketchElement[] {
  return [...elements, rect(20, 20, 10, 10)];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SketchSession autosave", () => {
  it("debounces edits and saves the latest draft with the last sha", async () => {
    const { session, saves, initial } = setup();
    const first = edit(initial);
    session.update({ elements: first, grid: false });
    expect(session.current).toEqual({ kind: "pending" });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    const second = edit(first);
    session.update({ elements: second, grid: false });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedSha256).toBe(SHA_A);
    expect(parseSceneFile(saves[0]?.content ?? "").scene.elements).toHaveLength(3);
    expect(session.current).toEqual({ kind: "saved" });
    expect(session.sha256).toBe(SHA_B);
  });

  it("saves within the max wait while edits keep coming", async () => {
    const { session, saves, initial } = setup();
    let elements = initial;
    for (let elapsed = 0; elapsed < SAVE_MAX_WAIT_MS; elapsed += 500) {
      elements = edit(elements);
      session.update({ elements, grid: false });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(saves).toHaveLength(1);
  });

  it("does nothing when an edit is undone back to the saved state", async () => {
    const { session, saves, initial } = setup();
    session.update({ elements: edit(initial), grid: false });
    session.update({ elements: initial, grid: false });
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT_MS);
    expect(saves).toHaveLength(0);
    expect(session.current).toEqual({ kind: "saved" });
  });

  it("writes the grid into appState", async () => {
    const { session, saves, initial } = setup();
    session.update({ elements: initial, grid: true });
    await session.flush();
    expect(parseSceneFile(saves[0]?.content ?? "").scene.appState).toMatchObject({ gridModeEnabled: true, viewBackgroundColor: "#ffffff" });
  });

  it("queues edits made while a save is in flight", async () => {
    const pending = deferred<SaveResult>();
    let calls = 0;
    const { session, saves, initial } = setup({
      save: async () => {
        calls += 1;
        return calls === 1 ? pending.promise : { outcome: "written", sha256: SHA_A, updatedAt: "now" };
      },
    });
    const first = edit(initial);
    session.update({ elements: first, grid: false });
    const flushing = session.flush();
    const second = edit(first);
    session.update({ elements: second, grid: false });
    pending.resolve({ outcome: "written", sha256: SHA_B, updatedAt: "now" });
    await flushing;
    await session.flush();
    expect(saves).toHaveLength(2);
    expect(saves[1]?.expectedSha256).toBe(SHA_B);
    expect(session.current).toEqual({ kind: "saved" });
  });

  it("stops on a conflict until Keep mine overwrites without a sha", async () => {
    let conflict = true;
    const { session, saves, initial } = setup({
      save: async () => (conflict ? { outcome: "conflict" } : { outcome: "written", sha256: SHA_B, updatedAt: "now" }),
    });
    session.update({ elements: edit(initial), grid: false });
    await session.flush();
    expect(session.current).toEqual({ kind: "conflict" });
    session.update({ elements: edit(edit(initial)), grid: false });
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT_MS);
    expect(saves).toHaveLength(1);
    conflict = false;
    await session.keepMine();
    expect(saves).toHaveLength(2);
    expect(saves[1]?.expectedSha256).toBeNull();
    expect(session.current).toEqual({ kind: "saved" });
  });

  it("reports errors and retries on flush", async () => {
    let fail = true;
    const { session, saves, initial } = setup({
      save: async () => {
        if (fail) throw new Error("disk full");
        return { outcome: "written", sha256: SHA_B, updatedAt: "now" };
      },
    });
    session.update({ elements: edit(initial), grid: false });
    await session.flush();
    expect(session.current).toEqual({ kind: "error", message: "disk full" });
    fail = false;
    await session.flush();
    expect(saves).toHaveLength(2);
    expect(session.current).toEqual({ kind: "saved" });
  });

  it("creates the file on the first save of a new sketch", async () => {
    const { session, create, onCreated, saves, initial } = setup({ id: null });
    session.update({ elements: edit(initial), grid: false });
    await session.flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith({ id: "Untitled", title: "Untitled" });
    expect(session.id).toBe("Untitled");
    session.update({ elements: edit(edit(initial)), grid: false });
    await session.flush();
    expect(saves).toEqual([expect.objectContaining({ id: "Untitled", expectedSha256: SHA_B })]);
  });

  it("stores a preview a while after a save, keyed to that sha", async () => {
    const { session, savePreview, initial } = setup();
    const next = edit(initial);
    session.update({ elements: next, grid: false });
    await session.flush();
    expect(savePreview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS);
    expect(savePreview).toHaveBeenCalledWith({ id: "Plan", sha256: SHA_B, elements: next });
  });

  it("adopts a remote file only when there are no unsaved changes", async () => {
    const { session, initial } = setup();
    expect(session.canAdopt(SHA_A)).toBe(false);
    expect(session.canAdopt(SHA_B)).toBe(true);
    session.update({ elements: edit(initial), grid: false });
    expect(session.canAdopt(SHA_B)).toBe(false);
    session.adopt({ sha256: SHA_B, appState: {}, files: {}, draft: { elements: initial, grid: false } });
    expect(session.sha256).toBe(SHA_B);
    expect(session.hasUnsavedChanges()).toBe(false);
  });

  it("never saves after it is discarded", async () => {
    const { session, saves, initial } = setup();
    session.update({ elements: edit(initial), grid: false });
    session.discard();
    await session.flush();
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT_MS);
    expect(saves).toHaveLength(0);
  });
});

describe("SketchSession when the file is in trouble", () => {
  it("copies edits made during a conflict once, and only when there are any", async () => {
    const { session, initial } = setup({ save: async () => ({ outcome: "conflict" }) });
    const copies: string[] = [];
    const copy = async (content: string) => {
      copies.push(content);
    };
    await session.rescue(copy);
    expect(copies).toEqual([]);
    session.update({ elements: edit(initial), grid: false });
    await session.flush();
    expect(session.current).toEqual({ kind: "conflict" });
    const more = edit(edit(initial));
    session.update({ elements: more, grid: false });
    await session.rescue(copy);
    await session.rescue(copy);
    expect(copies).toHaveLength(1);
    expect(parseSceneFile(copies[0] ?? "").scene.elements).toEqual(more);
  });

  it("waits for a save in flight before deciding to copy", async () => {
    const pending = deferred<SaveResult>();
    const { session, initial } = setup({ save: () => pending.promise });
    session.update({ elements: edit(initial), grid: false });
    void session.flush();
    const copies: string[] = [];
    const rescuing = session.rescue(async (content) => {
      copies.push(content);
    });
    pending.resolve({ outcome: "conflict" });
    await rescuing;
    expect(copies).toHaveLength(1);
  });

  it("never copies after it is discarded, and lets a failed copy be retried", async () => {
    const { session, initial } = setup({ save: async () => ({ outcome: "conflict" }) });
    session.update({ elements: edit(initial), grid: false });
    await session.flush();
    await expect(
      session.rescue(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    const copy = vi.fn(async () => undefined);
    await session.rescue(copy);
    expect(copy).toHaveBeenCalledTimes(1);
    session.update({ elements: edit(edit(initial)), grid: false });
    session.discard();
    await session.rescue(copy);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("stops saving a missing file and never re-creates it with Keep mine", async () => {
    const { session, saves, initial } = setup();
    session.markMissing();
    expect(session.current).toEqual({ kind: "missing" });
    session.update({ elements: edit(initial), grid: false });
    await vi.advanceTimersByTimeAsync(SAVE_MAX_WAIT_MS);
    await session.flush();
    await session.keepMine();
    expect(saves).toEqual([]);
    expect(session.canAdopt(SHA_B)).toBe(false);
  });

  it("saves a missing sketch as a new file and keeps saving there", async () => {
    const { session, saves, onCreated, initial } = setup();
    session.markMissing();
    const next = edit(initial);
    session.update({ elements: next, grid: false });
    const create = vi.fn(async (_content: string) => ({ id: "Plan (my edits)", title: "Plan (my edits)", sha256: SHA_B }));
    await session.saveAsNew(create);
    expect(parseSceneFile(create.mock.calls[0]?.[0] ?? "").scene.elements).toEqual(next);
    expect(onCreated).toHaveBeenCalledWith({ id: "Plan (my edits)", title: "Plan (my edits)" });
    expect(session.current).toEqual({ kind: "saved" });
    session.update({ elements: edit(next), grid: false });
    await session.flush();
    expect(saves).toEqual([expect.objectContaining({ id: "Plan (my edits)", expectedSha256: SHA_B })]);
  });
});
