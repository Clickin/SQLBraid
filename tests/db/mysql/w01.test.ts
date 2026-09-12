import assert from "node:assert/strict";
import { createConnection } from "mysql2/promise";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { runW01 } from "../w01.js";

test("MySQL wrappers sharing one connection preserve transaction isolation", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  const observer = await createConnection(settings.connectionUri);
  try {
    const [versionRows] = await observer.query("SELECT VERSION() AS version");
    const version = (versionRows as { version: string }[])[0]?.version ?? "unknown";
    console.info(`[db-mysql] server_version=${version}`);
    const db = createMysql2Database(client);
    const secondaryDb = createMysql2Database(client);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => {
        const [result] = await observer.query("SELECT id FROM braid_w01 ORDER BY id");
        return (result as { id: string }[]).map((row) => row.id);
      },
      clear: async () => { await observer.query("DELETE FROM braid_w01"); },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});

test("MySQL result kinds follow payload metadata", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  try {
    const db = createMysql2Database(client);
    await client.query("DROP TABLE IF EXISTS braid_pv4");
    await client.query("CREATE TABLE braid_pv4 (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL)");
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

    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
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
    const mapped = v.object({
      payload: v.pipe(v.string(), v.parseJson(), v.object({ enabled: v.boolean() })),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT CAST('{"enabled":true}' AS CHAR) AS payload`)).rows,
      [{ payload: { enabled: true } }],
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv4").catch(() => undefined);
    await client.end();
  }
});
