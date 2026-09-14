import assert from "node:assert/strict";
import { Client } from "pg";
import { inject, test } from "vitest";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";

type Settings = { readonly connectionUri: string; readonly version?: string };

test("PostgreSQL capability matrix preserves native DML returning semantics", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const events: ExecutionEvent[] = [];
  const db = createPgDatabase(client, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv16_capability");
    await client.query("CREATE TABLE braid_pv16_capability (id integer PRIMARY KEY, name text NOT NULL, team_id integer NOT NULL)");
    await client.query("INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (1, 'Ada', 10), (2, 'Bob', 20), (3, 'Cara', 20)");
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "postgres",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(
      await db.bulk([{ id: 10, name: "Bulk-A", team_id: 30 }, { id: 11, name: "Bulk-B", team_id: 30 }], (input) =>
        sql.command`INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${input.id}, ${input.name}, ${input.team_id})`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );

    const inserted = await db.all(sql.rows`INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${4}, ${"Dora"}, ${10}) RETURNING id, name`);
    assert.deepEqual(inserted, [{ id: 4, name: "Dora" }]);
    const updated = await db.all(sql.rows`UPDATE braid_pv16_capability SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`);
    assert.deepEqual(updated, [{ id: 2, name: "Bobby" }]);
    const deleted = await db.all(sql.rows`DELETE FROM braid_pv16_capability WHERE id = ${3} RETURNING id, name`);
    assert.deepEqual(deleted, [{ id: 3, name: "Cara" }]);
    const upserted = await db.all(sql.rows`
      INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${2}, ${"Robert"}, ${20})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name
    `);
    assert.deepEqual(upserted, [{ id: 2, name: "Robert" }]);
    const joined = await db.all(sql.rows`
      UPDATE braid_pv16_capability AS target
      SET name = source.name
      FROM (VALUES (${1}::integer, ${"Grace"}::text)) AS source(id, name)
      WHERE target.id = source.id
      RETURNING target.id, target.name
    `);
    assert.deepEqual(joined, [{ id: 1, name: "Grace" }]);
    const using = await db.all(sql.rows<{ readonly id: number }>`
      DELETE FROM braid_pv16_capability AS target
      USING (VALUES (${10}::integer)) AS doomed(team_id)
      WHERE target.team_id = doomed.team_id
      RETURNING target.id
    `);
    assert.deepEqual([...using].sort((left, right) => left.id - right.id), [{ id: 1 }, { id: 4 }]);
    const withDml = await db.all(sql.rows`
      WITH moved AS (
        UPDATE braid_pv16_capability SET name = ${"Moved"} WHERE id = ${2} RETURNING id, name
      ) SELECT id, name FROM moved
    `);
    assert.deepEqual(withDml, [{ id: 2, name: "Moved" }]);

    await assert.rejects(
      () => db.execute(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`),
      /BRAID_RESULT_COLUMNS/u,
    );

    const version = Number((await client.query<{ server_version_num: string }>("SHOW server_version_num")).rows[0]?.server_version_num ?? 0);
    if (version >= 180000) {
      const merge = await db.all(sql.rows<{ readonly action: string; readonly old_id: number | null; readonly new_id: number | null }>`
        MERGE INTO braid_pv16_capability AS target
        USING (VALUES (${2}::integer, ${"Merged"}::text), (${5}::integer, ${"Eve"}::text)) AS source(id, name)
        ON target.id = source.id
        WHEN MATCHED THEN UPDATE SET name = source.name
        WHEN NOT MATCHED THEN INSERT (id, name, team_id) VALUES (source.id, source.name, 30)
        RETURNING merge_action() AS action, old.id AS old_id, new.id AS new_id
      `);
      assert.deepEqual([...merge].sort((left, right) => (left.new_id ?? -1) - (right.new_id ?? -1)), [
        { action: "UPDATE", old_id: 2, new_id: 2 },
        { action: "INSERT", old_id: null, new_id: 5 },
      ]);
      const oldNew = await db.all(sql.rows`
        UPDATE braid_pv16_capability SET name = ${"Final"} WHERE id = ${2}
        RETURNING old.name AS old_name, new.name AS new_name
      `);
      assert.deepEqual(oldNew, [{ old_name: "Merged", new_name: "Final" }]);
    }
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv16_capability").catch(() => undefined);
    await client.end();
  }
});
