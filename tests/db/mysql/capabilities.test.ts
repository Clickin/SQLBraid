import assert from "node:assert/strict";
import { createConnection } from "mysql2/promise";
import { inject, test } from "vitest";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";

test("MySQL 8 capability matrix preserves native syntax and no RETURNING claim", { timeout: 30_000 }, async () => {
  const settings = inject("mysql") as { readonly connectionUri: string };
  const connection = await createConnection(settings.connectionUri);
  const events: ExecutionEvent[] = [];
  const db = createMysql2Database(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_capability");
    await connection.query("CREATE TABLE braid_pv16_capability (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, team_id INT NOT NULL, payload JSON NOT NULL)");
    await connection.query(`INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (1, 'Ada', 10, '{"enabled": true}'), (2, 'Bob', 20, '{"enabled": false}'), (3, 'Cara', 20, '{"enabled": true}')`);
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "mysql",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(
      await db.bulk([{ id: 10, name: "Bulk-A", team_id: 30 }, { id: 11, name: "Bulk-B", team_id: 30 }], (input) =>
        sql.command`INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (${input.id}, ${input.name}, ${input.team_id}, '{}')`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );

    const lexical = await db.one(sql.rows<{ readonly id: number; readonly enabled: boolean }>`
      SELECT /*+ NO_INDEX(braid_pv16_capability) */ \`id\`, JSON_EXTRACT(payload, '$.enabled') AS enabled
      FROM braid_pv16_capability
      WHERE id = ${1} # a MySQL line comment
        AND name <> ${"nobody"}
    `);
    assert.equal(lexical.id, 1);
    assert.equal(lexical.enabled, true);

    const upserted = await db.execute(sql.command`
      INSERT INTO braid_pv16_capability (id, name, team_id, payload)
      VALUES (${2}, ${"Robert"}, ${20}, '{"enabled":true}') AS incoming
      ON DUPLICATE KEY UPDATE name = incoming.name
    `);
    assert.equal(upserted.command.affectedRows, 2);
    const updated = await db.execute(sql.command`
      UPDATE braid_pv16_capability AS target
      JOIN (SELECT ${1} AS id, ${"Grace"} AS name) AS source ON source.id = target.id
      SET target.name = source.name
    `);
    assert.equal(updated.command.affectedRows, 1);

    const cte = await db.all(sql.rows`
      WITH selected AS (SELECT id, name FROM braid_pv16_capability WHERE team_id = ${20})
      SELECT id, name FROM selected ORDER BY id
    `);
    assert.deepEqual(cte, [{ id: 2, name: "Robert" }, { id: 3, name: "Cara" }]);

    const deleted = await db.execute(sql.command`
      DELETE target FROM braid_pv16_capability AS target
      JOIN (SELECT ${10} AS team_id) AS doomed ON doomed.team_id = target.team_id
    `);
    assert.equal(deleted.command.affectedRows, 1);

    await assert.rejects(
      () => db.execute(sql.rows`INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (${4}, ${"Dora"}, ${10}, '{}') RETURNING id`),
    );
  } finally {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_capability").catch(() => undefined);
    await connection.end();
  }
});
