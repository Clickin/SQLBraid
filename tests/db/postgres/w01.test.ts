import assert from "node:assert/strict";
import { Client } from "pg";
import { inject, test } from "vitest";
import type { StandardSchemaLike } from "@sqlbraid/core";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";
import { runW01 } from "../w01.js";

test("PostgreSQL wrappers sharing one client preserve transaction isolation", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  const observer = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  await observer.connect();
  try {
    const version = await observer.query<{ server_version: string }>("SHOW server_version");
    console.info(`[db-postgres] server_version=${version.rows[0]?.server_version ?? "unknown"}`);
    const db = createPgDatabase(client);
    const secondaryDb = createPgDatabase(client);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => (await observer.query<{ id: string }>("SELECT id FROM braid_w01 ORDER BY id")).rows.map((row) => row.id),
      clear: async () => { await observer.query("DELETE FROM braid_w01"); },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});

test("PostgreSQL result kinds follow driver metadata", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    const db = createPgDatabase(client);
    await client.query("DROP TABLE IF EXISTS braid_pv4");
    await client.query("CREATE TABLE braid_pv4 (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (1, 'Ada')");

    const rows = await db.execute(sql.rows<{ readonly id: number; readonly name: string }>`SELECT id, name FROM braid_pv4`);
    assert.equal(rows.kind, "rows");
    assert.deepEqual(rows.rows, [{ id: 1, name: "Ada" }]);
    const unknownRows = await db.execute(sql`SELECT id FROM braid_pv4`);
    assert.equal(unknownRows.kind, "rows");
    const command = await db.execute(sql.command`UPDATE braid_pv4 SET name = 'Grace' WHERE id = 1`);
    assert.equal(command.kind, "command");
    assert.deepEqual(command.rows, []);
    assert.equal(command.command.affectedRows, 1);
    const unknownCommand = await db.execute(sql`DELETE FROM braid_pv4 WHERE id = 1`);
    assert.equal(unknownCommand.kind, "command");
    assert.deepEqual(unknownCommand.rows, []);
    assert.equal(unknownCommand.command.affectedRows, 1);

    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (2, 'Bob')");
    const returning = await db.execute(sql.rows`INSERT INTO braid_pv4 (id, name) VALUES (3, 'Carol') RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: 3 }]);

    await assert.rejects(
      () => db.execute(sql.command`SELECT id FROM braid_pv4`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sql.rows`UPDATE braid_pv4 SET name = 'Dora' WHERE id = 2`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const schema: StandardSchemaLike<{ readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly id: number };
          return { value: { id: row.id + 10 } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: number }>`SELECT id FROM braid_pv4 WHERE id = 2`, { schema }),
      [{ id: 12 }],
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv4").catch(() => undefined);
    await client.end();
  }
});
