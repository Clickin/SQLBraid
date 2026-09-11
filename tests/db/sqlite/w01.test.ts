import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";
import { runW01 } from "../w01.js";

test("SQLite wrappers sharing one database preserve transaction isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-sqlite-w01-"));
  const file = join(directory, "w01.sqlite");
  const native = new DatabaseSync(file);
  const observer = new DatabaseSync(file);
  try {
    const version = observer.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    console.info(`[db-sqlite] version=${version.version}`);
    const db = createNodeSqliteDatabase(native);
    const secondaryDb = createNodeSqliteDatabase(native);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => (observer.prepare("SELECT id FROM braid_w01 ORDER BY id").all() as { id: string }[]).map((row) => row.id),
      clear: async () => { observer.prepare("DELETE FROM braid_w01").run(); },
    });
  } finally {
    observer.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});
