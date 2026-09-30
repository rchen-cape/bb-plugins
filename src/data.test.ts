import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getNode, insertProject, migrations, type Db } from "./data";

/*
 * An older tree stores modes this build no longer knows, and a row that fails
 * to decode takes its whole project down. The upgrade has to rewrite them.
 */
function openAtRevision(revision: number): Db {
  const db = new Database(":memory:");
  for (const migration of migrations.slice(0, revision)) db.exec(migration);
  return db;
}

function insertLegacyNode(db: Db, args: { projectId: string; mode: string }) {
  const id = `trn_${args.mode}`;
  db.prepare(
    `INSERT INTO tree_nodes (
       id, project_id, ordinal, title, kind, completion, artifact_file,
       instruction, context_mode, handoff, custom_brief,
       workspace_kind, x, y, created_at, updated_at
     ) VALUES (?, ?, 0, 'Spec', 'agent', 'open', ?, '', ?, 'summary', '',
       'tree', 0, 0, 1, 1)`,
  ).run(id, args.projectId, `${args.mode}.md`, args.mode);
  return id;
}

describe("migrations", () => {
  it("collapses both retired context modes into all_parents", () => {
    const db = openAtRevision(migrations.length - 1);
    const project = insertProject(db, {
      name: "Auth",
      directory: "/t/auth",
      now: 1,
    });
    const compacted = insertLegacyNode(db, {
      projectId: project.id,
      mode: "auto_compact",
    });
    const full = insertLegacyNode(db, {
      projectId: project.id,
      mode: "full_parents",
    });

    const upgrade = migrations.at(-1);
    if (upgrade === undefined) throw new Error("No migration to apply.");
    db.exec(upgrade);

    expect(getNode(db, compacted)?.contextMode).toBe("all_parents");
    expect(getNode(db, full)?.contextMode).toBe("all_parents");
  });
});
