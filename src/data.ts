import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  completionSchema,
  contextModeSchema,
  handoffSchema,
  summaryStatusSchema,
  type SummaryStatus,
  nodeKindSchema,
  type Completion,
  type ContextMode,
  type Handoff,
  type NodeKind,
  type WorkspaceTarget,
} from "./model.js";

export type Db = Database.Database;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS tree_projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     directory TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS tree_projects_directory_idx
     ON tree_projects(directory);
   CREATE TABLE IF NOT EXISTS tree_nodes (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES tree_projects(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     title TEXT NOT NULL,
     kind TEXT NOT NULL,
     completion TEXT NOT NULL DEFAULT 'open',
     artifact_file TEXT NOT NULL,
     artifact_digest TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     input_digest TEXT NOT NULL DEFAULT '',
     instruction TEXT NOT NULL DEFAULT '',
     context_mode TEXT NOT NULL DEFAULT 'auto_compact',
     custom_brief TEXT NOT NULL DEFAULT '',
     workspace_kind TEXT NOT NULL DEFAULT 'tree',
     workspace_ref TEXT,
     thread_id TEXT,
     x REAL NOT NULL DEFAULT 0,
     y REAL NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS tree_nodes_project_idx
     ON tree_nodes(project_id, ordinal);
   CREATE UNIQUE INDEX IF NOT EXISTS tree_nodes_artifact_idx
     ON tree_nodes(project_id, artifact_file);
   CREATE INDEX IF NOT EXISTS tree_nodes_thread_idx ON tree_nodes(thread_id);
   CREATE TABLE IF NOT EXISTS tree_edges (
     project_id TEXT NOT NULL,
     parent_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
     child_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
     PRIMARY KEY (parent_id, child_id)
   );
   CREATE INDEX IF NOT EXISTS tree_edges_project_idx ON tree_edges(project_id);
   CREATE INDEX IF NOT EXISTS tree_edges_child_idx ON tree_edges(child_id);
   CREATE TABLE IF NOT EXISTS tree_context_includes (
     node_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
     included_node_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
     PRIMARY KEY (node_id, included_node_id)
   );
   CREATE INDEX IF NOT EXISTS tree_context_includes_included_idx
     ON tree_context_includes(included_node_id);`,
  `ALTER TABLE tree_projects ADD COLUMN bb_project_id TEXT;`,
  `ALTER TABLE tree_nodes
     ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'idle';`,
  `ALTER TABLE tree_nodes ADD COLUMN summary_problem TEXT;`,
  `ALTER TABLE tree_nodes
     ADD COLUMN handoff TEXT NOT NULL DEFAULT 'summary';`,
];

export interface ProjectRow {
  id: string;
  name: string;
  directory: string;
  bbProjectId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NodeRow {
  id: string;
  projectId: string;
  ordinal: number;
  title: string;
  kind: NodeKind;
  completion: Completion;
  artifactFile: string;
  artifactDigest: string;
  summary: string;
  summaryStatus: SummaryStatus;
  summaryProblem: string | null;
  inputDigest: string;
  instruction: string;
  contextMode: ContextMode;
  handoff: Handoff;
  customBrief: string;
  workspace: WorkspaceTarget;
  threadId: string | null;
  x: number;
  y: number;
  createdAt: number;
  updatedAt: number;
  contextIncludes: string[];
}

export interface EdgeRow {
  parentId: string;
  childId: string;
}

const PROJECT_COLUMNS = `id, name, directory,
  bb_project_id AS bbProjectId,
  created_at AS createdAt, updated_at AS updatedAt`;

const NODE_COLUMNS = `id, project_id AS projectId, ordinal, title, kind,
  completion, artifact_file AS artifactFile,
  summary_status AS summaryStatus, summary_problem AS summaryProblem,
  artifact_digest AS artifactDigest, summary, input_digest AS inputDigest,
  instruction, context_mode AS contextMode, handoff,
  custom_brief AS customBrief,
  workspace_kind AS workspaceKind, workspace_ref AS workspaceRef,
  thread_id AS threadId, x, y,
  created_at AS createdAt, updated_at AS updatedAt`;

interface RawNodeRow extends Omit<
  NodeRow,
  | "workspace"
  | "contextIncludes"
  | "kind"
  | "completion"
  | "contextMode"
  | "handoff"
> {
  kind: string;
  completion: string;
  contextMode: string;
  handoff: string;
  workspaceKind: string;
  workspaceRef: string | null;
}

export class DataError extends Error {}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

export function createProjectId(): string {
  return newId("trp");
}

export function createNodeId(): string {
  return newId("trn");
}

function decodeWorkspace(raw: RawNodeRow): WorkspaceTarget {
  if (raw.workspaceKind === "project") {
    if (raw.workspaceRef === null || raw.workspaceRef.length === 0) {
      throw new DataError(
        `Node ${raw.id} targets a bb project but stores no project id.`,
      );
    }
    return { kind: "project", projectId: raw.workspaceRef };
  }
  if (raw.workspaceKind === "path") {
    if (raw.workspaceRef === null || raw.workspaceRef.length === 0) {
      throw new DataError(
        `Node ${raw.id} targets a directory but stores no path.`,
      );
    }
    return { kind: "path", path: raw.workspaceRef };
  }
  if (raw.workspaceKind === "environment") {
    if (raw.workspaceRef === null || raw.workspaceRef.length === 0) {
      throw new DataError(
        `Node ${raw.id} targets a shared environment but stores no id.`,
      );
    }
    return { kind: "environment", environmentId: raw.workspaceRef };
  }
  return { kind: "tree" };
}

function encodeWorkspace(workspace: WorkspaceTarget): {
  kind: string;
  ref: string | null;
} {
  if (workspace.kind === "project") {
    return { kind: "project", ref: workspace.projectId };
  }
  if (workspace.kind === "path") {
    return { kind: "path", ref: workspace.path };
  }
  if (workspace.kind === "environment") {
    return { kind: "environment", ref: workspace.environmentId };
  }
  return { kind: "tree", ref: null };
}

function decodeNodeRow(value: unknown, contextIncludes: string[]): NodeRow {
  const raw = value as RawNodeRow;
  return {
    id: raw.id,
    projectId: raw.projectId,
    ordinal: raw.ordinal,
    title: raw.title,
    kind: nodeKindSchema.parse(raw.kind),
    completion: completionSchema.parse(raw.completion),
    artifactFile: raw.artifactFile,
    artifactDigest: raw.artifactDigest,
    summary: raw.summary,
    summaryStatus: summaryStatusSchema.parse(raw.summaryStatus),
    summaryProblem: raw.summaryProblem,
    inputDigest: raw.inputDigest,
    instruction: raw.instruction,
    contextMode: contextModeSchema.parse(raw.contextMode),
    handoff: handoffSchema.parse(raw.handoff),
    customBrief: raw.customBrief,
    workspace: decodeWorkspace(raw),
    threadId: raw.threadId,
    x: raw.x,
    y: raw.y,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    contextIncludes,
  };
}

export function insertProject(
  db: Db,
  args: {
    name: string;
    directory: string;
    bbProjectId: string | null;
    now: number;
  },
): ProjectRow {
  const id = createProjectId();
  db.prepare(
    `INSERT INTO tree_projects
       (id, name, directory, bb_project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, args.name, args.directory, args.bbProjectId, args.now, args.now);
  const project = getProject(db, id);
  if (project === null) throw new DataError("The project was not stored.");
  return project;
}

export function listProjects(db: Db): ProjectRow[] {
  return db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM tree_projects ORDER BY created_at, id`,
    )
    .all() as ProjectRow[];
}

export function getProject(db: Db, projectId: string): ProjectRow | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM tree_projects WHERE id = ?`)
    .get(projectId);
  return row === undefined ? null : (row as ProjectRow);
}

export function findProjectByDirectory(
  db: Db,
  directory: string,
): ProjectRow | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM tree_projects WHERE directory = ?`)
    .get(directory);
  return row === undefined ? null : (row as ProjectRow);
}

export function setProjectBbProject(
  db: Db,
  args: { projectId: string; bbProjectId: string; now: number },
): void {
  db.prepare(
    `UPDATE tree_projects SET bb_project_id = ?, updated_at = ? WHERE id = ?`,
  ).run(args.bbProjectId, args.now, args.projectId);
}

export function renameProject(
  db: Db,
  args: { projectId: string; name: string; now: number },
): void {
  db.prepare(
    `UPDATE tree_projects SET name = ?, updated_at = ? WHERE id = ?`,
  ).run(args.name, args.now, args.projectId);
}

export function deleteProject(db: Db, projectId: string): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM tree_context_includes
        WHERE node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)
           OR included_node_id IN (SELECT id FROM tree_nodes WHERE project_id = ?)`,
    ).run(projectId, projectId);
    db.prepare(`DELETE FROM tree_edges WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM tree_nodes WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM tree_projects WHERE id = ?`).run(projectId);
  })();
}

export function touchProject(
  db: Db,
  args: { projectId: string; now: number },
): void {
  db.prepare(`UPDATE tree_projects SET updated_at = ? WHERE id = ?`).run(
    args.now,
    args.projectId,
  );
}

export function nextOrdinal(db: Db, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(ordinal), 0) AS highest FROM tree_nodes WHERE project_id = ?`,
    )
    .get(projectId) as { highest: number };
  return row.highest + 1;
}

function listContextIncludes(db: Db, projectId: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT includes.node_id AS nodeId,
              includes.included_node_id AS includedNodeId
         FROM tree_context_includes AS includes
         JOIN tree_nodes AS nodes ON nodes.id = includes.node_id
        WHERE nodes.project_id = ?
        ORDER BY includes.node_id, includes.included_node_id`,
    )
    .all(projectId) as { nodeId: string; includedNodeId: string }[];
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.nodeId);
    if (existing === undefined) {
      grouped.set(row.nodeId, [row.includedNodeId]);
      continue;
    }
    existing.push(row.includedNodeId);
  }
  return grouped;
}

export function listNodes(db: Db, projectId: string): NodeRow[] {
  const includes = listContextIncludes(db, projectId);
  return (
    db
      .prepare(
        `SELECT ${NODE_COLUMNS} FROM tree_nodes
          WHERE project_id = ? ORDER BY ordinal, id`,
      )
      .all(projectId) as unknown[]
  ).map((row) =>
    decodeNodeRow(row, includes.get((row as RawNodeRow).id) ?? []),
  );
}

export function getNode(db: Db, nodeId: string): NodeRow | null {
  const row = db
    .prepare(`SELECT ${NODE_COLUMNS} FROM tree_nodes WHERE id = ?`)
    .get(nodeId);
  if (row === undefined) return null;
  const includes = (
    db
      .prepare(
        `SELECT included_node_id AS includedNodeId FROM tree_context_includes
          WHERE node_id = ? ORDER BY included_node_id`,
      )
      .all(nodeId) as { includedNodeId: string }[]
  ).map((include) => include.includedNodeId);
  return decodeNodeRow(row, includes);
}

export function findNodeByThread(db: Db, threadId: string): NodeRow | null {
  const row = db
    .prepare(`SELECT id FROM tree_nodes WHERE thread_id = ?`)
    .get(threadId);
  return row === undefined ? null : getNode(db, (row as { id: string }).id);
}

export interface InsertNodeArgs {
  projectId: string;
  ordinal: number;
  title: string;
  kind: NodeKind;
  artifactFile: string;
  instruction: string;
  contextMode: ContextMode;
  handoff: Handoff;
  customBrief: string;
  workspace: WorkspaceTarget;
  x: number;
  y: number;
  now: number;
}

export function insertNode(db: Db, args: InsertNodeArgs): string {
  const id = createNodeId();
  const workspace = encodeWorkspace(args.workspace);
  db.prepare(
    `INSERT INTO tree_nodes (
       id, project_id, ordinal, title, kind, completion, artifact_file,
       instruction, context_mode, handoff, custom_brief,
       workspace_kind, workspace_ref,
       x, y, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.projectId,
    args.ordinal,
    args.title,
    args.kind,
    args.artifactFile,
    args.instruction,
    args.contextMode,
    args.handoff,
    args.customBrief,
    workspace.kind,
    workspace.ref,
    args.x,
    args.y,
    args.now,
    args.now,
  );
  return id;
}

export interface UpdateNodeArgs {
  nodeId: string;
  now: number;
  title?: string;
  instruction?: string;
  contextMode?: ContextMode;
  handoff?: Handoff;
  customBrief?: string;
  workspace?: WorkspaceTarget;
  summary?: string;
  summaryStatus?: SummaryStatus;
  summaryProblem?: string | null;
  completion?: Completion;
  artifactDigest?: string;
  inputDigest?: string;
  threadId?: string | null;
  artifactFile?: string;
  position?: { x: number; y: number };
}

export function updateNode(db: Db, args: UpdateNodeArgs): void {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (args.title !== undefined) set("title", args.title);
  if (args.instruction !== undefined) set("instruction", args.instruction);
  if (args.contextMode !== undefined) set("context_mode", args.contextMode);
  if (args.handoff !== undefined) set("handoff", args.handoff);
  if (args.customBrief !== undefined) set("custom_brief", args.customBrief);
  if (args.workspace !== undefined) {
    const workspace = encodeWorkspace(args.workspace);
    set("workspace_kind", workspace.kind);
    set("workspace_ref", workspace.ref);
  }
  if (args.summary !== undefined) set("summary", args.summary);
  if (args.summaryStatus !== undefined) {
    set("summary_status", args.summaryStatus);
  }
  if (args.summaryProblem !== undefined) {
    set("summary_problem", args.summaryProblem);
  }
  if (args.completion !== undefined) set("completion", args.completion);
  if (args.artifactDigest !== undefined) {
    set("artifact_digest", args.artifactDigest);
  }
  if (args.inputDigest !== undefined) set("input_digest", args.inputDigest);
  if (args.threadId !== undefined) set("thread_id", args.threadId);
  if (args.artifactFile !== undefined) set("artifact_file", args.artifactFile);
  const changedTask = assignments.length > 0;
  if (args.position !== undefined) {
    set("x", args.position.x);
    set("y", args.position.y);
  }
  if (assignments.length === 0) return;
  if (changedTask) set("updated_at", args.now);
  values.push(args.nodeId);
  db.prepare(
    `UPDATE tree_nodes SET ${assignments.join(", ")} WHERE id = ?`,
  ).run(...values);
}

export function deleteNode(db: Db, nodeId: string): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM tree_context_includes
        WHERE node_id = ? OR included_node_id = ?`,
    ).run(nodeId, nodeId);
    db.prepare(
      `DELETE FROM tree_edges WHERE parent_id = ? OR child_id = ?`,
    ).run(nodeId, nodeId);
    db.prepare(`DELETE FROM tree_nodes WHERE id = ?`).run(nodeId);
  })();
}

export function listPendingSummaryNodeIds(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM tree_nodes
          WHERE summary_status = 'pending'
          ORDER BY updated_at`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

export function listEdges(db: Db, projectId: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT parent_id AS parentId, child_id AS childId FROM tree_edges
        WHERE project_id = ? ORDER BY parent_id, child_id`,
    )
    .all(projectId) as EdgeRow[];
}

export function insertEdge(
  db: Db,
  args: { projectId: string; parentId: string; childId: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO tree_edges (project_id, parent_id, child_id)
     VALUES (?, ?, ?)`,
  ).run(args.projectId, args.parentId, args.childId);
}

export function deleteEdge(
  db: Db,
  args: { parentId: string; childId: string },
): void {
  db.prepare(`DELETE FROM tree_edges WHERE parent_id = ? AND child_id = ?`).run(
    args.parentId,
    args.childId,
  );
}

export function replaceContextIncludes(
  db: Db,
  args: { nodeId: string; includedNodeIds: readonly string[] },
): void {
  db.prepare(`DELETE FROM tree_context_includes WHERE node_id = ?`).run(
    args.nodeId,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tree_context_includes (node_id, included_node_id)
     VALUES (?, ?)`,
  );
  for (const includedNodeId of args.includedNodeIds) {
    insert.run(args.nodeId, includedNodeId);
  }
}

export function countNodes(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM tree_nodes`).get() as {
    total: number;
  };
  return row.total;
}
