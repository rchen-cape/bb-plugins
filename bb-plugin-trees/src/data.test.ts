import Database from "better-sqlite3";
import { runPluginStorageMigrations } from "@get-bb/plugin-sdk/internal/host-policy";
import { describe, expect, it } from "vitest";
import { getNode, insertProject, migrations, type Db } from "./data";

/*
 * The hash of every statement that has shipped. bb records these the first
 * time a statement runs and refuses to load the plugin when one of them
 * changes, so editing a released statement rather than appending a new one
 * bricks Trees for everyone who already has a tree. Append here alongside a
 * new migration; never edit a line above.
 */
const SHIPPED_HASHES = [
  "2fa2e82b837bdc8bb41bd5a6ba34c5ad79b8234187d0cbaccec5e3d244c8a1f1",
  "34e6ff0603bc4096324460ec52ba0041b01032efd828adc756cd341064ad39fa",
  "c747d3e38c46de57d49d531173f34b42f1e21a422a63f78150377c82d8ddee88",
  "1e0d13237d45ab109e89e196897c14a675f0656f49bde0d14324c5e95bc89469",
  "e817946404bc0adaca41b500aeff874a4038284e9bbc2beef02eef56cd1068a4",
  "c5ce5164ca9fb22d3ee64364ab47b94efb099c0928a7f5d076f7d2b30daa5938",
  "e42c7e85830fd056aaf426c889e6a6bc89254b12063b39af2e4d7d3cb3f65efa",
  "5c9de754f750ad205d83e0a9a5e12a8423603b3dfa863477bcc25488037e6a79",
];

/*
 * A tree that an earlier build already migrated, which is the only state the
 * retired modes survive in: bb has recorded what it ran under the hashes it
 * ran them with.
 */
function openExistingTree(revision: number): Db {
  const db = new Database(":memory:");
  runPluginStorageMigrations(db, migrations.slice(0, revision));
  const pin = db.prepare(
    "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ?",
  );
  SHIPPED_HASHES.slice(0, revision).forEach((hash, index) => {
    pin.run(hash, index);
  });
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
  it("has not changed a statement that already shipped", () => {
    const db = openExistingTree(SHIPPED_HASHES.length);
    expect(() => runPluginStorageMigrations(db, migrations)).not.toThrow();
  });

  /*
   * A mode this build cannot decode takes its whole project down, so the
   * upgrade has to rewrite every retired one.
   */
  it("collapses both retired context modes into all_parents", () => {
    const db = openExistingTree(migrations.length - 1);
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

    runPluginStorageMigrations(db, migrations);

    expect(getNode(db, compacted)?.contextMode).toBe("all_parents");
    expect(getNode(db, full)?.contextMode).toBe("all_parents");
  });
});
