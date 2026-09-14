import assert from "node:assert/strict";
import { Client, types } from "pg";
import { inject, test } from "vitest";
import { decodeExactDecimal, decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";

type Settings = { readonly connectionUri: string; readonly version?: string };

test("postgres.sql.native-transparency", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const events: ExecutionEvent[] = [];
  const db = createPgDatabase(client, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const query = sql.rows`
      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,
             '{"enabled":true}'::jsonb ? 'enabled' AS has_key,
             ${"Ada"}::text AS actual
    `;
    const rendered = query.render();
    await runTransparencyCase({
      capabilityId: "postgres.sql.native-transparency",
      query: rendered,
      expectedSegments: [
        "\n      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,\n             '{\"enabled\":true}'::jsonb ? 'enabled' AS has_key,\n             ",
        "::text AS actual\n    ",
      ],
      expectedParameterizedSql: "\n      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,\n             '{\"enabled\":true}'::jsonb ? 'enabled' AS has_key,\n             $1::text AS actual\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{
        marker: "literal ? :1 @p1 $1 /*@braid*/",
        has_key: true,
        actual: "Ada",
      }],
    });
  } finally {
    await client.end();
  }
});

test("postgres.sql.generated-structure", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} FROM (VALUES (${1}::integer)) AS source(value)`;
    const rendered = query.render();
    assert.deepEqual(rendered.segments, ['SELECT "value" FROM (VALUES (', '::integer)) AS source(value)']);
    assert.deepEqual(await db.all(query), [{ value: 1 }]);
  } finally {
    await client.end();
  }
});

test("postgres.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: bigint;
      readonly unsafe: bigint;
      readonly min: bigint;
      readonly max: bigint;
    }>`
      SELECT
        9007199254740991::int8 AS safe,
        9007199254740992::int8 AS unsafe,
        (-9223372036854775808)::int8 AS min,
        9223372036854775807::int8 AS max
    `);
    assert.equal(decodeExactInteger(row.safe), 9007199254740991n);
    assert.equal(decodeExactInteger(row.unsafe), 9007199254740992n);
    assert.equal(decodeExactInteger(row.min), -9223372036854775808n);
    assert.equal(decodeExactInteger(row.max), 9223372036854775807n);
  } finally {
    await client.end();
  }
});

test("postgres.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{
      readonly fraction: string;
      readonly trailing: string;
      readonly large: string;
      readonly scaleGreaterThanPrecision: string;
      readonly negativeScale: string;
    }>`
      SELECT
        0.1::numeric AS fraction,
        123.4500::numeric(20, 4) AS trailing,
        123456789012345678901234567890.1234567890::numeric(40, 10) AS large,
        0.00123::numeric(3, 5) AS "scaleGreaterThanPrecision",
        12345::numeric(2, -3) AS "negativeScale"
    `);
    assert.equal(decodeExactDecimal(row.fraction), "0.1");
    assert.equal(decodeExactDecimal(row.trailing), "123.4500");
    assert.equal(decodeExactDecimal(row.large), "123456789012345678901234567890.1234567890");
    assert.equal(decodeExactDecimal(row.scaleGreaterThanPrecision), "0.00123");
    assert.equal(decodeExactDecimal(row.negativeScale), "12000");
  } finally {
    await client.end();
  }
});

test("PostgreSQL parser overrides fail closed and report guarded numeric fidelity", async () => {
  const client = new Client({
    connectionString: inject("postgres").connectionUri,
    types: { getTypeParser: (oid, format) => oid === 20 || oid === 1700 ? Number : types.getTypeParser(oid, format) },
  });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const environment = await db.environment();
    assert.equal(environment.capabilities["numeric.exact-integer"]?.status, "guarded");
    assert.equal(environment.capabilities["numeric.exact-decimal"]?.status, "guarded");
    await assert.rejects(() => db.one(sql.rows`SELECT 9007199254740993::int8 AS value`), { code: "BRAID_RESULT_EXACTNESS" });
    await assert.rejects(() => db.one(sql.rows`SELECT 0.1::numeric AS value`), { code: "BRAID_RESULT_EXACTNESS" });
  } finally { await client.end(); }
});

test("postgres.data.json-native", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_json (id integer PRIMARY KEY, payload jsonb NOT NULL)");
    await db.execute(sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, ${JSON.stringify({ enabled: true, nested: { count: 2 } })}::jsonb)`);
    const row = await db.one(sql.rows<{ readonly payload: unknown; readonly hasEnabled: boolean }>`
      SELECT payload, payload ? ${"enabled"} AS "hasEnabled"
      FROM braid_pv16_json
      WHERE id = ${1}
    `);
    assert.deepEqual(row.payload, { enabled: true, nested: { count: 2 } });
    assert.equal(row.hasEnabled, true);
  } finally {
    await client.end();
  }
});

test("postgres.data.temporal", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{ readonly date_value: Date; readonly instant: Date }>`
      SELECT DATE '2026-09-14' AS date_value, TIMESTAMPTZ '2026-09-14 12:34:56+00' AS instant
    `);
    assert.ok(row.date_value instanceof Date);
    assert.equal(row.date_value.getFullYear(), 2026);
    assert.equal(row.date_value.getMonth(), 8);
    assert.equal(row.date_value.getDate(), 14);
    assert.ok(row.instant instanceof Date);
    assert.equal(row.instant.toISOString(), "2026-09-14T12:34:56.000Z");
  } finally {
    await client.end();
  }
});

test("postgres.data.binary", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT decode('00ff10', 'hex') AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await client.end();
  }
});

test("postgres.data.uuid", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{ readonly id: string }>`SELECT '550e8400-e29b-41d4-a716-446655440000'::uuid AS id`);
    assert.equal(row.id, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await client.end();
  }
});

test("postgres.dml.insert-returning", { timeout: 30_000 }, async () => {
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

test("postgres.dml.update-returning", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_update (id integer PRIMARY KEY, name text NOT NULL)");
    await client.query("INSERT INTO braid_pv16_update VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(
      await db.all(sql.rows`UPDATE braid_pv16_update SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`),
      [{ id: 2, name: "Bobby" }],
    );
  } finally {
    await client.end();
  }
});

test("postgres.dml.delete-returning", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_delete (id integer PRIMARY KEY, name text NOT NULL)");
    await client.query("INSERT INTO braid_pv16_delete VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(
      await db.all(sql.rows`DELETE FROM braid_pv16_delete WHERE id = ${1} RETURNING id, name`),
      [{ id: 1, name: "Ada" }],
    );
  } finally {
    await client.end();
  }
});
