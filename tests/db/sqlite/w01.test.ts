import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
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

test("SQLite result kinds follow native columns metadata", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('Ada');");
    const db = createNodeSqliteDatabase(native);

    const explicitRows = await db.execute(sql.rows<{ readonly id: number; readonly name: string }>`SELECT id, name FROM users`);
    assert.equal(explicitRows.kind, "rows");
    assert.deepEqual(explicitRows.rows, [{ id: 1, name: "Ada" }]);

    const commandAsRows = await db.execute(sql`UPDATE users SET name = 'Grace' WHERE id = 1`);
    assert.equal(commandAsRows.kind, "command");
    assert.deepEqual(commandAsRows.rows, []);

    const explicitCommand = await db.execute(sql.command`UPDATE users SET name = 'Grace' WHERE id = 1`);
    assert.equal(explicitCommand.kind, "command");
    assert.equal(explicitCommand.rowCount, 1);
    assert.deepEqual(explicitCommand.rows, []);

    const unknownRows = await db.execute(sql`SELECT name FROM users`);
    assert.equal(unknownRows.kind, "rows");
    assert.deepEqual(unknownRows.rows, [{ name: "Grace" }]);

    const unknownCommand = await db.execute(sql`DELETE FROM users WHERE id = 1`);
    assert.equal(unknownCommand.kind, "command");
    assert.equal(unknownCommand.rowCount, 1);
    assert.deepEqual(unknownCommand.rows, []);

    const returning = await db.execute(sql.rows`INSERT INTO users (name) VALUES ('Bob') RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: 1 }]);

    await assert.rejects(
      () => db.execute(sql.command`SELECT name FROM users`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );

    await assert.rejects(
      () => db.execute(sql.rows`DELETE FROM users`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );
    await assert.rejects(() => db.call(sql.call`CALL unsupported()`), /BRAID_CALL_UNSUPPORTED/);
    await assert.rejects(() => db.execute(sql`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/);
    await assert.rejects(() => db.execute(sql.rows`SELECT 1 AS "", 2 AS ""`), /BRAID_RESULT_COLUMNS/);

    native.exec("INSERT INTO users (id, name) VALUES (1, 'Grace')");
    const schema: StandardSchemaV1<unknown, { readonly name: string }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly name: string };
          return { value: { name: row.name.toUpperCase() } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly name: string }>`SELECT name FROM users WHERE id = 1`, { schema }),
      [{ name: "GRACE" }],
    );
    const mapped = v.object({
      payload: v.pipe(v.string(), v.parseJson(), v.object({ enabled: v.boolean() })),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT '{"enabled":true}' AS payload`)).rows,
      [{ payload: { enabled: true } }],
    );
  } finally {
    native.close();
  }
});
