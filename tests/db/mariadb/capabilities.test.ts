import assert from "node:assert/strict";
import mariadb from "mariadb";
import { inject, test } from "vitest";
import * as v from "valibot";
import { generateModels } from "@sqlbraid/codegen";
import { decodeExactDecimal, decodeExactInteger, type ExecutionEvent } from "@sqlbraid/core";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";
import { createMariaDbInspector } from "@sqlbraid/mariadb/inspector";
import { sql, typePolicy } from "@sqlbraid/mariadb";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty, assertGeneratedPropertyAbsent } from "../codegen.js";

async function connect() {
  return mariadb.createConnection(inject("mariadb").connectionUri);
}

test("mariadb.sql.native-transparency", async () => {
  const connection = await connect();
  const events: ExecutionEvent[] = [];
  const db = createMariaDbDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    const query = sql.rows`
      SELECT 'literal $1 :1 @p1 ?' AS \`marker\`,
             CAST(JSON_VALUE(JSON_OBJECT('enabled', TRUE), '$.enabled') AS UNSIGNED) AS \`enabled\`,
             ${7} AS \`actual\`
    `;
    await runTransparencyCase({
      capabilityId: "mariadb.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT 'literal $1 :1 @p1 ?' AS `marker`,\n             CAST(JSON_VALUE(JSON_OBJECT('enabled', TRUE), '$.enabled') AS UNSIGNED) AS `enabled`,\n             ",
        " AS `actual`\n    ",
      ],
      expectedParameterizedSql: "\n      SELECT 'literal $1 :1 @p1 ?' AS `marker`,\n             CAST(JSON_VALUE(JSON_OBJECT('enabled', TRUE), '$.enabled') AS UNSIGNED) AS `enabled`,\n             ? AS `actual`\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: 1n, actual: 7 }],
    });
  } finally {
    await connection.end();
  }
});

test("mariadb.sql.generated-structure", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} AS value FROM (SELECT ${1} AS value) AS source`;
    assert.deepEqual(query.render().segments, ["SELECT `value` AS value FROM (SELECT ", " AS value) AS source"]);
    assert.deepEqual(await db.all(query), [{ value: 1 }]);
  } finally {
    await connection.end();
  }
});

test("mariadb.numeric.exact-integer", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
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

test("mariadb.result.standard-schema", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const mapper = v.pipe(v.object({ label: v.string() }), v.transform(({ label }) => label.toUpperCase()));
    const prepared = db.prepare("mariadb-mapped", () => sql.rows(mapper)`SELECT ${"Ada"} AS label`);
    assert.deepEqual((await prepared.execute()).rows, ["ADA"]);
  } finally { await connection.end(); }
});

test("mariadb.routine.resultsets", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE OR REPLACE PROCEDURE braid_pv16_sets(IN label VARCHAR(64)) BEGIN SELECT label AS label; SELECT CAST('12345678901234567890.1234' AS DECIMAL(24,4)) AS amount; END");
    const result = await db.call(sql.call`CALL braid_pv16_sets(${"Ada"})`);
    assert.deepEqual(result.output, {});
    assert.deepEqual(result.resultSets, [{ rows: [{ label: "Ada" }] }, { rows: [{ amount: "12345678901234567890.1234" }] }]);
    await assert.rejects(() => db.all(sql.rows`CALL braid_pv16_sets(${"Ada"})`), /BRAID_RESULT_SETS_UNSUPPORTED/u);
    assert.deepEqual(await db.one(sql.rows`SELECT ${"reusable"} AS label`), { label: "reusable" });
  } finally {
    await connection.query("DROP PROCEDURE IF EXISTS braid_pv16_sets");
    await connection.end();
  }
});

test("mariadb.metadata.types", async () => {
  const connection = await connect();
  try {
    await connection.query("CREATE TABLE braid_pv16_models (external_id INT PRIMARY KEY, identity_value BIGINT NOT NULL AUTO_INCREMENT UNIQUE, amount DECIMAL(40,10) NOT NULL, calculated INT GENERATED ALWAYS AS (external_id + 1) STORED)");
    await connection.query("CREATE PROCEDURE braid_pv16_metadata(IN value INT) SELECT value");
    const snapshot = await createMariaDbInspector(connection).inspect();
    const relation = Object.values(snapshot.relations).find((entry) => entry.name === "braid_pv16_models");
    assert.ok(relation);
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    assert.equal(columns.get("external_id")?.identity, undefined);
    assert.equal(columns.get("identity_value")?.identity, true);
    assert.equal(columns.get("amount")?.precision, 40);
    assert.equal(columns.get("amount")?.scale, 10);
    assert.deepEqual(relation.columns.map((column) => column.ordinal), [0, 1, 2, 3]);
    assert.equal(columns.get("calculated")?.generated, true);
    assert.equal(snapshot.routines?.braid_pv16_metadata?.[0]?.argumentsComplete, false);
    const generated = generateModels(snapshot, { typePolicy });
    const model = generated.models.find((entry) => entry.relationIdentity === relation.identity);
    assert.ok(model?.insertName && model.updateName);
    assertGeneratedProperty(generated.source, model.rowName, "identity_value", "bigint", false);
    assertGeneratedProperty(generated.source, model.rowName, "amount", "string", false);
    assertGeneratedProperty(generated.source, model.insertName, "external_id", "number", false);
    assertGeneratedProperty(generated.source, model.insertName, "identity_value", "bigint", true);
    assertGeneratedPropertyAbsent(generated.source, model.insertName, "calculated");
    assertGeneratedPropertyAbsent(generated.source, model.updateName, "calculated");
    await assertCompilesGeneratedSource(generated.source, "mariadb-pv16");
  } finally {
    await connection.query("DROP PROCEDURE IF EXISTS braid_pv16_metadata");
    await connection.query("DROP TABLE IF EXISTS braid_pv16_models");
    await connection.end();
  }
});

test("mariadb.numeric.exact-decimal", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly value: string }>`
      SELECT CAST('123456789012345678901234567890.1234567890' AS DECIMAL(40, 10)) AS value
    `);
    assert.equal(decodeExactDecimal(row.value), "123456789012345678901234567890.1234567890");
  } finally {
    await connection.end();
  }
});

test("mariadb.data.json-text", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv16_json (payload JSON)");
    await db.execute(sql.command`INSERT INTO braid_pv16_json VALUES (JSON_OBJECT('enabled', TRUE, 'nested', JSON_OBJECT('count', 2)))`);
    const native = await db.one(sql.rows<{ readonly payload: unknown }>`SELECT payload FROM braid_pv16_json`);
    assert.deepEqual(native.payload, { enabled: true, nested: { count: 2 } });
    const row = await db.one(sql.rows<{ readonly payload: string; readonly enabled: bigint }>`
      SELECT CAST(payload AS CHAR) AS payload,
             CAST(JSON_VALUE(payload, '$.enabled') AS UNSIGNED) AS enabled
      FROM braid_pv16_json
    `);
    assert.deepEqual(JSON.parse(row.payload), { enabled: true, nested: { count: 2 } });
    assert.equal(row.enabled, 1n);
  } finally {
    await connection.end();
  }
});

test("mariadb.data.temporal", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly value: Date }>`SELECT CAST('2026-09-14 12:34:56' AS DATETIME) AS value`);
    assert.ok(row.value instanceof Date);
  } finally {
    await connection.end();
  }
});

test("mariadb.data.binary", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT UNHEX('00FF10') AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await connection.end();
  }
});

test("mariadb.data.uuid", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly id: string }>`SELECT CAST('550e8400-e29b-41d4-a716-446655440000' AS CHAR(36)) AS id`);
    assert.equal(row.id, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await connection.end();
  }
});

test("mariadb.result.rows", async () => {
  const connection = await connect();
  const events: ExecutionEvent[] = [];
  const db = createMariaDbDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    await connection.query("DROP TABLE IF EXISTS braid_mariadb_capability");
    await connection.query(`
      CREATE TABLE braid_mariadb_capability (
        id INT NOT NULL PRIMARY KEY,
        \`label\` VARCHAR(255) NOT NULL,
        payload JSON NOT NULL
      )
    `);
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "mariadb",
      expectedMode: "native-bulk",
      events,
    });
    assert.equal(bulkReport.executionMode, "native-bulk");
    const marker = "quoted ? :1 $1 @p1";
    await db.execute(sql.command`
      /* MariaDB native comment: quoted ? :1 $1 @p1 */
      INSERT INTO braid_mariadb_capability (id, \`label\`, payload)
      VALUES (${1}, ${marker}, JSON_OBJECT('enabled', TRUE))
    `);
    assert.deepEqual(
      await db.all(sql.rows<{ readonly label: string; readonly enabled: bigint }>`
        WITH selected AS (
          SELECT \`label\`, CAST(JSON_VALUE(payload, '$.enabled') AS UNSIGNED) AS enabled
          FROM braid_mariadb_capability
        )
        SELECT \`label\`, enabled FROM selected
      `),
      [{ label: marker, enabled: 1n }],
    );

    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq");
    await connection.query("CREATE SEQUENCE braid_mariadb_capability_seq START WITH 17");
    assert.deepEqual(
      await db.one(sql.rows<{ readonly value: bigint }>`
        SELECT NEXT VALUE FOR braid_mariadb_capability_seq AS value
      `),
      { value: 17n },
    );
  } finally {
    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq").catch(() => undefined);
    await connection.query("DROP TABLE IF EXISTS braid_mariadb_capability").catch(() => undefined);
    await connection.end();
  }
});
