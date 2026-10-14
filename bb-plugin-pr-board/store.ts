import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { changeStateSchema, replyStateSchema, suggestionEditSchema, type Draft, type Finding, type Severity, type Side, type Suggestion, type SuggestionEdit } from "./contract.js";

export interface PullKey {
  repo: string;
  number: number;
}

export interface NewFinding {
  path: string;
  side: Side;
  startLine: number | null;
  endLine: number | null;
  severity: Severity;
  title: string;
  body: string;
}

export type DraftInput = Omit<Draft, "id"> & { id: string | null };

export interface NewSuggestion {
  commentId: string;
  summary: string;
  reply: string | null;
  edits: SuggestionEdit[];
}

interface SuggestionRow {
  id: string;
  comment_id: string;
  summary: string;
  reply: string | null;
  reply_state: string;
  edits: string;
  change_state: string;
}

const editsSchema = z.array(suggestionEditSchema);

interface FindingRow {
  id: string;
  path: string;
  side: Side;
  start_line: number | null;
  end_line: number | null;
  severity: Severity;
  title: string;
  body: string;
  head_sha: string | null;
  dismissed: number;
}

interface DraftRow {
  id: string;
  path: string;
  side: Side;
  start_line: number;
  end_line: number;
  body: string;
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    path: row.path,
    side: row.side,
    startLine: row.start_line,
    endLine: row.end_line,
    severity: row.severity,
    title: row.title,
    body: row.body,
    headSha: row.head_sha,
    dismissed: row.dismissed === 1,
  };
}

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    commentId: row.comment_id,
    summary: row.summary,
    reply: row.reply,
    replyState: replyStateSchema.parse(row.reply_state),
    edits: editsSchema.parse(JSON.parse(row.edits)),
    changeState: changeStateSchema.parse(row.change_state),
  };
}

function toDraft(row: DraftRow): Draft {
  return { id: row.id, path: row.path, side: row.side, startLine: row.start_line, endLine: row.end_line, body: row.body };
}

export function createStore(storage: BbPluginApi["storage"]) {
  const db = storage.database();
  storage.migrate(db, [
    `CREATE TABLE review_threads (
      thread_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX review_threads_pull ON review_threads (repo, number, created_at)`,
    `CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT,
      path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL
    )`,
    `CREATE INDEX findings_pull ON findings (repo, number, position)`,
    `CREATE TABLE drafts (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX drafts_pull ON drafts (repo, number, created_at)`,
    `CREATE TABLE address_threads (
      thread_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX address_threads_pull ON address_threads (repo, number, created_at)`,
    `CREATE TABLE suggestions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      comment_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      reply TEXT,
      reply_state TEXT NOT NULL,
      edits TEXT NOT NULL,
      change_state TEXT NOT NULL,
      position INTEGER NOT NULL
    )`,
    `CREATE INDEX suggestions_pull ON suggestions (repo, number, position)`,
  ]);

  const statements = {
    recordThread: db.prepare(
      "INSERT OR REPLACE INTO review_threads (thread_id, repo, number, created_at) VALUES (?, ?, ?, ?)",
    ),
    threadsForPull: db.prepare(
      "SELECT thread_id FROM review_threads WHERE repo = ? AND number = ? ORDER BY created_at DESC",
    ),
    pullForThread: db.prepare("SELECT repo, number FROM review_threads WHERE thread_id = ?"),
    findings: db.prepare(
      "SELECT id, path, side, start_line, end_line, severity, title, body, head_sha, dismissed FROM findings WHERE repo = ? AND number = ? ORDER BY position",
    ),
    findingCounts: db.prepare(
      "SELECT repo, number, COUNT(*) AS count FROM findings WHERE dismissed = 0 GROUP BY repo, number",
    ),
    clearFindings: db.prepare("DELETE FROM findings WHERE repo = ? AND number = ?"),
    insertFinding: db.prepare(
      `INSERT INTO findings (id, thread_id, repo, number, head_sha, path, side, start_line, end_line, severity, title, body, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    maxFindingPosition: db.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM findings WHERE repo = ? AND number = ?"),
    dismissFinding: db.prepare("UPDATE findings SET dismissed = ? WHERE id = ?"),
    pullForFinding: db.prepare("SELECT repo, number FROM findings WHERE id = ?"),
    drafts: db.prepare(
      "SELECT id, path, side, start_line, end_line, body FROM drafts WHERE repo = ? AND number = ? ORDER BY created_at",
    ),
    upsertDraft: db.prepare(
      `INSERT INTO drafts (id, repo, number, path, side, start_line, end_line, body, created_at)
       VALUES (@id, @repo, @number, @path, @side, @startLine, @endLine, @body, @createdAt)
       ON CONFLICT (id) DO UPDATE SET path = @path, side = @side, start_line = @startLine, end_line = @endLine, body = @body`,
    ),
    draft: db.prepare("SELECT id, path, side, start_line, end_line, body FROM drafts WHERE id = ?"),
    pullForDraft: db.prepare("SELECT repo, number FROM drafts WHERE id = ?"),
    deleteDraft: db.prepare("DELETE FROM drafts WHERE id = ?"),
    clearDrafts: db.prepare("DELETE FROM drafts WHERE repo = ? AND number = ?"),
    recordAddressThread: db.prepare(
      "INSERT OR REPLACE INTO address_threads (thread_id, repo, number, created_at) VALUES (?, ?, ?, ?)",
    ),
    addressThreadsForPull: db.prepare(
      "SELECT thread_id FROM address_threads WHERE repo = ? AND number = ? ORDER BY created_at DESC",
    ),
    pullForAddressThread: db.prepare("SELECT repo, number FROM address_threads WHERE thread_id = ?"),
    suggestions: db.prepare(
      "SELECT id, comment_id, summary, reply, reply_state, edits, change_state FROM suggestions WHERE repo = ? AND number = ? AND thread_id = ? ORDER BY position",
    ),
    suggestion: db.prepare(
      "SELECT id, thread_id, repo, number, comment_id, summary, reply, reply_state, edits, change_state FROM suggestions WHERE id = ?",
    ),
    retireSuggestions: db.prepare(
      `UPDATE suggestions
       SET change_state = CASE change_state WHEN 'open' THEN 'dismissed' ELSE change_state END,
           reply_state = CASE reply_state WHEN 'open' THEN 'dismissed' ELSE reply_state END
       WHERE repo = ? AND number = ? AND (change_state = 'applied' OR reply_state = 'used')`,
    ),
    clearSuggestions: db.prepare(
      "DELETE FROM suggestions WHERE repo = ? AND number = ? AND change_state != 'applied' AND reply_state != 'used'",
    ),
    insertSuggestion: db.prepare(
      `INSERT INTO suggestions (id, thread_id, repo, number, comment_id, summary, reply, reply_state, edits, change_state, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 'open', ?)`,
    ),
    maxSuggestionPosition: db.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM suggestions WHERE repo = ? AND number = ?"),
    setReplyState: db.prepare("UPDATE suggestions SET reply_state = ? WHERE id = ?"),
    setChangeState: db.prepare("UPDATE suggestions SET change_state = ? WHERE id = ?"),
  };

  return {
    recordThread(threadId: string, pull: PullKey, now: number): void {
      statements.recordThread.run(threadId, pull.repo, pull.number, now);
    },
    threadsForPull(pull: PullKey): string[] {
      return (statements.threadsForPull.all(pull.repo, pull.number) as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },
    pullForThread(threadId: string): PullKey | null {
      return (statements.pullForThread.get(threadId) as PullKey | undefined) ?? null;
    },
    findings(pull: PullKey): Finding[] {
      return (statements.findings.all(pull.repo, pull.number) as FindingRow[]).map(toFinding);
    },
    findingCounts(): Map<string, number> {
      const rows = statements.findingCounts.all() as Array<PullKey & { count: number }>;
      return new Map(rows.map((row) => [`${row.repo}#${row.number}`, row.count]));
    },
    recordFindings(threadId: string, pull: PullKey, headSha: string | null, findings: readonly NewFinding[], replace: boolean): void {
      db.transaction(() => {
        if (replace) statements.clearFindings.run(pull.repo, pull.number);
        const start = (statements.maxFindingPosition.get(pull.repo, pull.number) as { position: number }).position + 1;
        findings.forEach((finding, index) => {
          statements.insertFinding.run(
            randomUUID(),
            threadId,
            pull.repo,
            pull.number,
            headSha,
            finding.path,
            finding.side,
            finding.startLine,
            finding.endLine,
            finding.severity,
            finding.title,
            finding.body,
            start + index,
          );
        });
      })();
    },
    dismissFinding(id: string, dismissed: boolean): PullKey | null {
      statements.dismissFinding.run(dismissed ? 1 : 0, id);
      return (statements.pullForFinding.get(id) as PullKey | undefined) ?? null;
    },
    drafts(pull: PullKey): Draft[] {
      return (statements.drafts.all(pull.repo, pull.number) as DraftRow[]).map(toDraft);
    },
    saveDraft(pull: PullKey, draft: DraftInput, now: number): Draft {
      if (draft.id !== null) {
        const owner = statements.pullForDraft.get(draft.id) as PullKey | undefined;
        if (owner === undefined || owner.repo !== pull.repo || owner.number !== pull.number) {
          throw new Error("That draft comment does not exist on this pull request.");
        }
      }
      const id = draft.id ?? randomUUID();
      statements.upsertDraft.run({ ...draft, id, repo: pull.repo, number: pull.number, createdAt: now });
      return toDraft(statements.draft.get(id) as DraftRow);
    },
    deleteDraft(id: string): PullKey | null {
      const pull = (statements.pullForDraft.get(id) as PullKey | undefined) ?? null;
      statements.deleteDraft.run(id);
      return pull;
    },
    clearDrafts(pull: PullKey): void {
      statements.clearDrafts.run(pull.repo, pull.number);
    },
    recordAddressThread(threadId: string, pull: PullKey, now: number): void {
      statements.recordAddressThread.run(threadId, pull.repo, pull.number, now);
    },
    addressThreadsForPull(pull: PullKey): string[] {
      return (statements.addressThreadsForPull.all(pull.repo, pull.number) as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },
    pullForAddressThread(threadId: string): PullKey | null {
      return (statements.pullForAddressThread.get(threadId) as PullKey | undefined) ?? null;
    },
    suggestions(pull: PullKey, threadId: string): Suggestion[] {
      return (statements.suggestions.all(pull.repo, pull.number, threadId) as SuggestionRow[]).map(toSuggestion);
    },
    suggestion(id: string): { suggestion: Suggestion; threadId: string; pull: PullKey } | null {
      const row = statements.suggestion.get(id) as (SuggestionRow & PullKey & { thread_id: string }) | undefined;
      if (row === undefined) return null;
      return { suggestion: toSuggestion(row), threadId: row.thread_id, pull: { repo: row.repo, number: row.number } };
    },
    recordSuggestions(threadId: string, pull: PullKey, suggestions: readonly NewSuggestion[], replace: boolean): void {
      db.transaction(() => {
        if (replace) {
          statements.retireSuggestions.run(pull.repo, pull.number);
          statements.clearSuggestions.run(pull.repo, pull.number);
        }
        const start = (statements.maxSuggestionPosition.get(pull.repo, pull.number) as { position: number }).position + 1;
        suggestions.forEach((suggestion, index) => {
          statements.insertSuggestion.run(
            randomUUID(),
            threadId,
            pull.repo,
            pull.number,
            suggestion.commentId,
            suggestion.summary,
            suggestion.reply,
            JSON.stringify(suggestion.edits),
            start + index,
          );
        });
      })();
    },
    setReplyState(id: string, state: Suggestion["replyState"]): void {
      statements.setReplyState.run(state, id);
    },
    setChangeState(id: string, state: Suggestion["changeState"]): void {
      statements.setChangeState.run(state, id);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
