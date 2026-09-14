import assert from "node:assert/strict";
import mariadb, { type ConnectionConfig } from "mariadb";
import { inject, test } from "vitest";
import * as v from "valibot";
import { generateModels } from "@sqlbraid/codegen";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";
import { createMariaDbInspector } from "@sqlbraid/mariadb/inspector";
import { sql, typePolicy } from "@sqlbraid/mariadb";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { assertFloatBits, binary32Finite, binary64Finite, exactJsonText } from "../fidelity.js";
import { runTransparencyCase } from "../../transparency.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty, assertGeneratedPropertyAbsent } from "../codegen.js";

function connectorOptions(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const uri = new URL(inject("mariadb").connectionUri);
  return {
    host: uri.hostname,
    port: Number(uri.port || 3306),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    decimalAsNumber: false,
    insertIdAsNumber: false,
    autoJsonMap: false,
    dateStrings: true,
    timezone: "Z",
    ...overrides,
  };
}

async function connect(overrides: Partial<ConnectionConfig> = {}) {
  return mariadb.createConnection(connectorOptions(overrides));
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
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: "1", actual: "7" }],
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
    assert.deepEqual(await db.all(query), [{ value: "1" }]);
  } finally {
    await connection.end();
  }
});

test("mariadb.numeric.exact-integer", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: string;
      readonly unsafe: string;
      readonly min: string;
      readonly max: string;
    }>`
      SELECT
        CAST('9007199254740991' AS SIGNED) AS safe,
        CAST('9007199254740992' AS SIGNED) AS unsafe,
        CAST('-9223372036854775808' AS SIGNED) AS min,
        CAST('9223372036854775807' AS SIGNED) AS max
    `);
    assert.deepEqual(row, {
      safe: "9007199254740991",
      unsafe: "9007199254740992",
      min: "-9223372036854775808",
      max: "9223372036854775807",
    });
    await connection.query(`
      CREATE TEMPORARY TABLE braid_pv17_integer_types (
        tiny_value TINYINT,
        small_value SMALLINT,
        medium_value MEDIUMINT,
        int_value INT,
        big_value BIGINT
      )
    `);
    await connection.query("INSERT INTO braid_pv17_integer_types VALUES ('7', '32767', '8388607', '2147483647', '9223372036854775807')");
    assert.deepEqual(
      await db.one(sql.rows<{
        readonly tiny_value: string;
        readonly small_value: string;
        readonly medium_value: string;
        readonly int_value: string;
        readonly big_value: string;
      }>`SELECT tiny_value, small_value, medium_value, int_value, big_value FROM braid_pv17_integer_types`),
      {
        tiny_value: "7",
        small_value: "32767",
        medium_value: "8388607",
        int_value: "2147483647",
        big_value: "9223372036854775807",
      },
    );
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
    assertGeneratedProperty(generated.source, model.rowName, "identity_value", "string", false);
    assertGeneratedProperty(generated.source, model.rowName, "amount", "string", false);
    assertGeneratedProperty(generated.source, model.insertName, "external_id", "string", false);
    assertGeneratedProperty(generated.source, model.insertName, "identity_value", "string", true);
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
    assert.equal(row.value, "123456789012345678901234567890.1234567890");
  } finally {
    await connection.end();
  }
});

test("mariadb.numeric.bind-exact", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_exact_bind (integer_value BIGINT, decimal_value DECIMAL(40,20))");
    await db.execute(sql.command`
      INSERT INTO braid_pv17_exact_bind (integer_value, decimal_value)
      VALUES (${"9223372036854775807"}, ${"12345678901234567890.12345678901234567890"})
    `);
    assert.deepEqual(
      await db.one(sql.rows<{ readonly integer_value: string; readonly decimal_value: string }>`
        SELECT integer_value, decimal_value FROM braid_pv17_exact_bind
      `),
      {
        integer_value: "9223372036854775807",
        decimal_value: "12345678901234567890.12345678901234567890",
      },
    );
  } finally {
    await connection.end();
  }
});

test("mariadb.data.json-lossless-text", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv16_json (payload JSON)");
    await db.execute(sql.command`INSERT INTO braid_pv16_json VALUES (${exactJsonText})`);
    const row = await db.one(sql.rows<{ readonly payload: string; readonly largeInteger: string }>`
      SELECT CAST(payload AS CHAR) AS payload,
             JSON_VALUE(payload, '$.largeInteger') AS largeInteger
      FROM braid_pv16_json
    `);
    assert.equal(row.payload, exactJsonText);
    assert.equal(row.largeInteger, "9223372036854775807");
  } finally {
    await connection.end();
  }
});

test("mariadb.data.json-parsed", async () => {
  const connection = await connect({ autoJsonMap: true });
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv16_json_parsed (payload JSON)");
    await db.execute(sql.command`INSERT INTO braid_pv16_json_parsed VALUES (${exactJsonText})`);
    const row = await db.one(sql.rows<{ readonly payload: { readonly largeInteger: number } }>`
      SELECT payload FROM braid_pv16_json_parsed
    `);
    assert.equal(typeof row.payload.largeInteger, "number");
    assert.notEqual(String(row.payload.largeInteger), "9223372036854775807");
  } finally {
    await connection.end();
  }
});

test("mariadb.data.temporal-lossless", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.query(`
      CREATE TEMPORARY TABLE braid_pv17_temporal (
        date_value DATE,
        time_value TIME(6),
        datetime_value DATETIME(6),
        timestamp_value TIMESTAMP(6)
      )
    `);
    await connection.query("INSERT INTO braid_pv17_temporal VALUES ('2026-09-14', '12:34:56.123456', '2026-09-14 12:34:56.123456', '2026-09-14 12:34:56.123456')");
    assert.deepEqual(
      await db.one(sql.rows<{
        readonly date_value: string;
        readonly time_value: string;
        readonly datetime_value: string;
        readonly timestamp_value: string;
      }>`SELECT date_value, time_value, datetime_value, timestamp_value FROM braid_pv17_temporal`),
      {
        date_value: "2026-09-14",
        time_value: "12:34:56.123456",
        datetime_value: "2026-09-14 12:34:56.123456",
        timestamp_value: "2026-09-14 12:34:56.123456",
      },
    );
  } finally {
    await connection.end();
  }
});

test("mariadb.data.temporal-native", async () => {
  const connection = await connect({ dateStrings: false });
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_temporal_native (value DATETIME(6))");
    await connection.query("INSERT INTO braid_pv17_temporal_native VALUES ('2026-09-14 12:34:56.123456')");
    const row = await db.one(sql.rows<{ readonly value: Date }>`SELECT value FROM braid_pv17_temporal_native`);
    assert.ok(row.value instanceof Date);
  } finally {
    await connection.end();
  }
});

test("mariadb.numeric.aggregate", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_aggregate (value DECIMAL(40,20))");
    await db.bulk(
      [{ value: "9007199254740993.12345678901234567890" }, { value: "1.00000000000000000001" }],
      (entry) => sql.command`INSERT INTO braid_pv17_aggregate (value) VALUES (${entry.value})`,
    );
    assert.deepEqual(
      await db.one(sql.rows<{ readonly total: string; readonly maximum: string }>`
        SELECT SUM(value) AS total, MAX(value) AS maximum FROM braid_pv17_aggregate
      `),
      { total: "9007199254740994.12345678901234567891", maximum: "9007199254740993.12345678901234567890" },
    );
  } finally {
    await connection.end();
  }
});

test("mariadb.numeric.approximate-ieee", async () => {
  const connection = await connect();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_ieee (single_value FLOAT, double_value DOUBLE)");
    await db.execute(sql.command`
      INSERT INTO braid_pv17_ieee VALUES (${binary32Finite[2]}, ${binary64Finite[3]})
    `);
    const row = await db.one(sql.rows<{ readonly single_value: number; readonly double_value: number }>`
      SELECT single_value, double_value FROM braid_pv17_ieee
    `);
    assertFloatBits(row.single_value, binary32Finite[2], 32);
    assertFloatBits(row.double_value, binary64Finite[3], 64);
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
      await db.all(sql.rows<{ readonly label: string; readonly enabled: string }>`
        WITH selected AS (
          SELECT \`label\`, CAST(JSON_VALUE(payload, '$.enabled') AS UNSIGNED) AS enabled
          FROM braid_mariadb_capability
        )
        SELECT \`label\`, enabled FROM selected
      `),
      [{ label: marker, enabled: "1" }],
    );

    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq");
    await connection.query("CREATE SEQUENCE braid_mariadb_capability_seq START WITH 17");
    assert.deepEqual(
      await db.one(sql.rows<{ readonly value: string }>`
        SELECT NEXT VALUE FOR braid_mariadb_capability_seq AS value
      `),
      { value: "17" },
    );
  } finally {
    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq").catch(() => undefined);
    await connection.query("DROP TABLE IF EXISTS braid_mariadb_capability").catch(() => undefined);
    await connection.end();
  }
});
