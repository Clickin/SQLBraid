import assert from "node:assert/strict";
import { createConnection, type Connection } from "mysql2/promise";
import { inject, test } from "vitest";
import { decodeExactDecimal, decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";

interface Settings {
  readonly connectionUri: string;
}

async function connect(): Promise<Connection> {
  const settings = inject("mysql") as Settings;
  const uri = new URL(settings.connectionUri);
  return createConnection({
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 3306,
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.replace(/^\//u, "")),
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    rowsAsArray: false,
    jsonStrings: false,
  });
}

test("mysql.sql.native-transparency", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const events: ExecutionEvent[] = [];
  const db = createMysql2Database(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const query = sql.rows`
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,
             ${7} AS actual
    `;
    await runTransparencyCase({
      capabilityId: "mysql.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,\n             ",
        " AS actual\n    ",
      ],
      expectedParameterizedSql: "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,\n             ? AS actual\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: true, actual: 7 }],
    });
  } finally {
    await connection.end();
  }
});

test("mysql.sql.generated-structure", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} AS value FROM (SELECT ${1} AS value) AS source`;
    assert.deepEqual(query.render().segments, ["SELECT `value` AS value FROM (SELECT ", " AS value) AS source"]);
    assert.deepEqual(await db.all(query), [{ value: 1 }]);
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: bigint;
      readonly unsafe: bigint;
      readonly min: bigint;
      readonly max: bigint;
    }>`
      SELECT
        CAST('9007199254740991' AS SIGNED) AS safe,
        CAST('9007199254740992' AS SIGNED) AS unsafe,
        CAST('-9223372036854775808' AS SIGNED) AS min,
        CAST('9223372036854775807' AS SIGNED) AS max
    `);
    assert.equal(decodeExactInteger(row.safe), 9007199254740991n);
    assert.equal(decodeExactInteger(row.unsafe), 9007199254740992n);
    assert.equal(decodeExactInteger(row.min), -9223372036854775808n);
    assert.equal(decodeExactInteger(row.max), 9223372036854775807n);
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly fraction: string;
      readonly trailing_value: string;
      readonly large: string;
    }>`
      SELECT
        CAST('0.1' AS DECIMAL(20, 10)) AS fraction,
        CAST('123.4500' AS DECIMAL(20, 4)) AS trailing_value,
        CAST('123456789012345678901234567890.1234567890' AS DECIMAL(40, 10)) AS large
    `);
    assert.equal(decodeExactDecimal(row.fraction), "0.1000000000");
    assert.equal(decodeExactDecimal(row.trailing_value), "123.4500");
    assert.equal(decodeExactDecimal(row.large), "123456789012345678901234567890.1234567890");
  } finally {
    await connection.end();
  }
});

test("mysql.data.json-native", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv16_json (id INT PRIMARY KEY, payload JSON NOT NULL)");
    await db.execute(sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, ${JSON.stringify({ enabled: true, nested: { count: 2 } })})`);
    const row = await db.one(sql.rows<{ readonly payload: unknown; readonly enabled: number }>`
      SELECT payload, JSON_EXTRACT(payload, '$.nested.count') AS enabled
      FROM braid_pv16_json
      WHERE id = ${1}
    `);
    assert.deepEqual(row.payload, { enabled: true, nested: { count: 2 } });
    assert.equal(row.enabled, 2);
  } finally {
    await connection.end();
  }
});

test("mysql.data.temporal", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{ readonly instant: Date }>`SELECT CAST('2026-09-14 12:34:56' AS DATETIME) AS instant`);
    assert.ok(row.instant instanceof Date);
    assert.equal(row.instant.getFullYear(), 2026);
    assert.equal(row.instant.getMonth(), 8);
    assert.equal(row.instant.getDate(), 14);
    assert.equal(row.instant.getHours(), 12);
    assert.equal(row.instant.getMinutes(), 34);
    assert.equal(row.instant.getSeconds(), 56);
  } finally {
    await connection.end();
  }
});

test("mysql.data.binary", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT UNHEX('00FF10') AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await connection.end();
  }
});

test("mysql.data.uuid", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{ readonly id: string }>`SELECT CAST('550e8400-e29b-41d4-a716-446655440000' AS CHAR(36)) AS id`);
    assert.equal(row.id, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await connection.end();
  }
});

test("mysql.result.command", { timeout: 30_000 }, async () => {
  const connection = await connect();
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
