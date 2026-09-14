import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createConnection, createPool, type Connection, type RowDataPacket } from "mysql2/promise";
import { inject, test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import {
  MYSQL2_LOSSLESS_TEXT,
  MYSQL2_NATIVE,
  representationProfiles,
  sql,
} from "@sqlbraid/mysql";
import { createMysqlInspector } from "@sqlbraid/mysql/inspector";
import { assertGeneratedProperty } from "../codegen.js";
import { stampSupportEnvironment } from "../support-target.js";

interface MysqlSettings {
  readonly connectionUri: string;
}

test("mysql.data.pool-observed-profile", { timeout: 30_000 }, async () => {
  const pool = createPool({ uri: inject("mysql").connectionUri, ...MYSQL2_NATIVE.connectionOptions, connectionLimit: 1 });
  try {
    const db = createMysql2PoolDatabase(pool);
    const query = sql.rows<{ payload: unknown; instant: Date }>`
      SELECT CAST('{"enabled":true}' AS JSON) AS payload,
             CAST('2026-09-14 12:34:56' AS DATETIME) AS instant
    `;
    const row = await db.one(query);
    assert.deepEqual(row.payload, { enabled: true });
    assert.ok(row.instant instanceof Date);
    assert.equal(row.instant.getTime(), new Date(2026, 8, 14, 12, 34, 56).getTime());
    assert.equal((await db.environment()).typePolicy, undefined);
    const textDb = createMysql2PoolDatabase(pool, { profile: MYSQL2_LOSSLESS_TEXT });
    await assert.rejects(() => textDb.one(query), { code: "BRAID_RESULT_EXACTNESS" });
  } finally {
    await pool.end();
  }
});

interface RawProfileRow extends RowDataPacket {
  readonly id: number | string;
  readonly payload: unknown;
  readonly datetime_value: unknown;
  readonly date_value: unknown;
  readonly time_value: unknown;
  readonly text_value: unknown;
  readonly binary_value: unknown;
  readonly bigint_value: unknown;
  readonly decimal_value: unknown;
}

const mysql2Version = (JSON.parse(
  readFileSync(new URL("../../../node_modules/mysql2/package.json", import.meta.url), "utf8"),
) as { readonly version: string }).version;

const tableName = "braid_pv18_profile_conformance";
const dateTimeValue = "2026-09-14 12:34:56.123456";
const dateValue = "2026-09-14";
const timeValue = "12:34:56.123456";
const textValue = "profile-conformance";
const binaryValue = Buffer.from([0, 255, 16]);
const bigintValue = "9007199254740993";
const decimalValue = "12345678901234567890.12345678901234567890";
const jsonTextRoots = [
  '{"enabled":true}',
  '[1,true,"text"]',
  '"text"',
  "7",
  "true",
  "null",
] as const;
const jsonNativeRoots: readonly unknown[] = [
  { enabled: true },
  [1, true, "text"],
  "text",
  7,
  true,
  null,
];

function connect(profile: typeof MYSQL2_LOSSLESS_TEXT | typeof MYSQL2_NATIVE): Promise<Connection> {
  const settings = inject("mysql") as MysqlSettings;
  assert.ok(profile.connectionOptions);
  return createConnection({ uri: settings.connectionUri, ...profile.connectionOptions });
}

async function rawRows(connection: Connection): Promise<readonly RawProfileRow[]> {
  const [payload] = await connection.query<RawProfileRow[]>(`
    SELECT id, payload, datetime_value, date_value, time_value, text_value, binary_value, bigint_value, decimal_value
    FROM ${tableName}
    ORDER BY id
  `);
  return payload;
}

function assertRawCommon(row: RawProfileRow): void {
  assert.equal(typeof row.id, "number");
  assert.equal(typeof row.time_value, "string");
  assert.equal(row.time_value, timeValue);
  assert.equal(typeof row.text_value, "string");
  assert.equal(row.text_value, textValue);
  assert.ok(Buffer.isBuffer(row.binary_value));
  assert.deepEqual([...row.binary_value as Buffer], [...binaryValue]);
  assert.equal(typeof row.bigint_value, "string");
  assert.equal(row.bigint_value, bigintValue);
  assert.equal(typeof row.decimal_value, "string");
  assert.equal(row.decimal_value, decimalValue);
}

function assertLocalDate(value: unknown, date: { readonly year: number; readonly month: number; readonly day: number }): void {
  assert.ok(value instanceof Date);
  assert.equal(value.getFullYear(), date.year);
  assert.equal(value.getMonth(), date.month - 1);
  assert.equal(value.getDate(), date.day);
}

test("mysql.data.profile-conformance", { timeout: 60_000 }, async () => {
  assert.notDeepEqual(MYSQL2_LOSSLESS_TEXT.connectionOptions, MYSQL2_NATIVE.connectionOptions);
  const losslessConnection = await connect(MYSQL2_LOSSLESS_TEXT);
  let nativeConnection: Connection | undefined;
  const losslessDb = createMysql2Database(losslessConnection, { profile: MYSQL2_LOSSLESS_TEXT });
  try {
    nativeConnection = await connect(MYSQL2_NATIVE);
    const nativeDb = createMysql2Database(nativeConnection, { profile: MYSQL2_NATIVE });
    await losslessConnection.query(`DROP TABLE IF EXISTS ${tableName}`);
    await losslessConnection.query(`
      CREATE TABLE ${tableName} (
        id INT NOT NULL PRIMARY KEY,
        payload JSON NOT NULL,
        datetime_value DATETIME(6) NOT NULL,
        date_value DATE NOT NULL,
        time_value TIME(6) NOT NULL,
        text_value TEXT NOT NULL,
        binary_value BLOB NOT NULL,
        bigint_value BIGINT NOT NULL,
        decimal_value DECIMAL(40, 20) NOT NULL
      ) ENGINE=InnoDB
    `);

    for (let index = 0; index < jsonTextRoots.length; index += 1) {
      await losslessDb.execute(sql.command`
        INSERT INTO ${sql.ident(tableName)}
          (id, payload, datetime_value, date_value, time_value, text_value, binary_value, bigint_value, decimal_value)
        VALUES
          (${index + 1}, ${jsonTextRoots[index]}, ${dateTimeValue}, ${dateValue}, ${timeValue}, ${textValue}, ${binaryValue}, ${bigintValue}, ${decimalValue})
      `);
    }

    const rawLosslessRows = await rawRows(losslessConnection);
    assert.equal(rawLosslessRows.length, jsonTextRoots.length);
    for (const [index, row] of rawLosslessRows.entries()) {
      assertRawCommon(row);
      assert.ok(typeof row.payload === "string");
      assert.deepEqual(JSON.parse(row.payload), jsonNativeRoots[index]);
      assert.equal(typeof row.datetime_value, "string");
      assert.equal(row.datetime_value, dateTimeValue);
      assert.equal(typeof row.date_value, "string");
      assert.equal(row.date_value, dateValue);
    }

    const losslessFirst = await losslessDb.one(sql.rows<{
      readonly id: string;
      readonly payload: string;
      readonly datetime_value: string;
      readonly date_value: string;
      readonly time_value: string;
      readonly text_value: string;
      readonly binary_value: Uint8Array;
      readonly bigint_value: string;
      readonly decimal_value: string;
    }>`
      SELECT id, payload, datetime_value, date_value, time_value, text_value, binary_value, bigint_value, decimal_value
      FROM ${sql.ident(tableName)}
      WHERE id = ${1}
    `);
    assert.deepEqual(losslessFirst, {
      id: "1",
      payload: rawLosslessRows[0]!.payload,
      datetime_value: dateTimeValue,
      date_value: dateValue,
      time_value: timeValue,
      text_value: textValue,
      binary_value: binaryValue,
      bigint_value: bigintValue,
      decimal_value: decimalValue,
    });

    const rawNativeRows = await rawRows(nativeConnection);
    assert.equal(rawNativeRows.length, jsonNativeRoots.length);
    for (const [index, row] of rawNativeRows.entries()) {
      assertRawCommon(row);
      assert.deepEqual(row.payload, jsonNativeRoots[index]);
      assertLocalDate(row.datetime_value, { year: 2026, month: 9, day: 14 });
      assertLocalDate(row.date_value, { year: 2026, month: 9, day: 14 });
    }

    const nativeFirst = await nativeDb.one(sql.rows<{
      readonly id: string;
      readonly payload: unknown;
      readonly datetime_value: Date;
      readonly date_value: Date;
      readonly time_value: string;
      readonly text_value: string;
      readonly binary_value: Uint8Array;
      readonly bigint_value: string;
      readonly decimal_value: string;
    }>`
      SELECT id, payload, datetime_value, date_value, time_value, text_value, binary_value, bigint_value, decimal_value
      FROM ${sql.ident(tableName)}
      WHERE id = ${1}
    `);
    assert.equal(nativeFirst.id, "1");
    assert.deepEqual(nativeFirst.payload, jsonNativeRoots[0]);
    assertLocalDate(nativeFirst.datetime_value, { year: 2026, month: 9, day: 14 });
    assertLocalDate(nativeFirst.date_value, { year: 2026, month: 9, day: 14 });
    assert.equal(nativeFirst.time_value, timeValue);
    assert.equal(nativeFirst.text_value, textValue);
    assert.ok(nativeFirst.binary_value instanceof Uint8Array);
    assert.deepEqual([...nativeFirst.binary_value], [...binaryValue]);
    assert.equal(nativeFirst.bigint_value, bigintValue);
    assert.equal(nativeFirst.decimal_value, decimalValue);

    const nativeRows = await nativeDb.all(sql.rows<{
      readonly id: string;
      readonly payload: unknown;
    }>`
      SELECT id, payload
      FROM ${sql.ident(tableName)}
      ORDER BY id
    `);
    assert.deepEqual(nativeRows.map((row) => row.payload), jsonNativeRoots);

    const snapshot = await createMysqlInspector(losslessConnection).inspect();
    const relation = Object.values(snapshot.relations).find((entry) => entry.name === tableName);
    assert.ok(relation);
    const codegenOptions = {
      filters: { includeRelations: [relation.identity] },
    } as const;
    const losslessModels = generateModels(snapshot, {
      ...codegenOptions,
      typePolicy: MYSQL2_LOSSLESS_TEXT.typePolicy,
    });
    const nativeModels = generateModels(snapshot, {
      ...codegenOptions,
      typePolicy: MYSQL2_NATIVE.typePolicy,
    });
    assert.deepEqual(losslessModels.diagnostics, []);
    assert.deepEqual(nativeModels.diagnostics, []);
    const losslessModel = losslessModels.models.find((model) => model.relationIdentity === relation.identity);
    const nativeModel = nativeModels.models.find((model) => model.relationIdentity === relation.identity);
    assert.ok(losslessModel);
    assert.ok(nativeModel);
    for (const model of [losslessModel, nativeModel]) {
      assertGeneratedProperty(
        model === losslessModel ? losslessModels.source : nativeModels.source,
        model.rowName,
        "time_value",
        "string",
        false,
      );
      assertGeneratedProperty(
        model === losslessModel ? losslessModels.source : nativeModels.source,
        model.rowName,
        "text_value",
        "string",
        false,
      );
      assertGeneratedProperty(
        model === losslessModel ? losslessModels.source : nativeModels.source,
        model.rowName,
        "binary_value",
        "Uint8Array",
        false,
      );
      assertGeneratedProperty(
        model === losslessModel ? losslessModels.source : nativeModels.source,
        model.rowName,
        "bigint_value",
        "string",
        false,
      );
      assertGeneratedProperty(
        model === losslessModel ? losslessModels.source : nativeModels.source,
        model.rowName,
        "decimal_value",
        "string",
        false,
      );
    }
    assertGeneratedProperty(losslessModels.source, losslessModel.rowName, "payload", "string", false);
    assertGeneratedProperty(losslessModels.source, losslessModel.rowName, "datetime_value", "string", false);
    assertGeneratedProperty(losslessModels.source, losslessModel.rowName, "date_value", "string", false);
    assertGeneratedProperty(nativeModels.source, nativeModel.rowName, "payload", "unknown", false);
    assertGeneratedProperty(nativeModels.source, nativeModel.rowName, "datetime_value", "Date", false);
    assertGeneratedProperty(nativeModels.source, nativeModel.rowName, "date_value", "Date", false);

    for (const selected of representationProfiles.filter((entry) => entry.json !== entry.temporal)) {
      const connection = await connect(selected);
      try {
        const mixed = createMysql2Database(connection, { profile: selected });
        const row = await mixed.one(sql.rows<{ payload: unknown; datetime_value: unknown }>`
          SELECT payload, datetime_value FROM ${sql.ident(tableName)} WHERE id = ${1}
        `);
        assert.equal(typeof row.payload, selected.json === "text" ? "string" : "object");
        assert.equal(row.datetime_value instanceof Date, selected.temporal === "native");
        if (selected.temporal === "text") assert.equal(typeof row.datetime_value, "string");
        const generated = generateModels(snapshot, { ...codegenOptions, typePolicy: selected.typePolicy });
        assertGeneratedProperty(generated.source, losslessModel.rowName, "payload", selected.json === "text" ? "string" : "unknown", false);
        assertGeneratedProperty(generated.source, losslessModel.rowName, "datetime_value", selected.temporal === "text" ? "string" : "Date", false);
      } finally {
        await connection.end();
      }
    }
    const nativeEnvironment = await nativeDb.environment();
    assert.equal(nativeEnvironment.driver.profile, MYSQL2_NATIVE.id);
    assert.deepEqual(nativeEnvironment.typePolicy, {
      id: MYSQL2_NATIVE.typePolicy.id,
      hash: MYSQL2_NATIVE.typePolicy.hash,
    });
    const environment = await losslessDb.environment();
    assert.equal(environment.driver.profile, MYSQL2_LOSSLESS_TEXT.id);
    assert.deepEqual(environment.typePolicy, {
      id: MYSQL2_LOSSLESS_TEXT.typePolicy.id,
      hash: MYSQL2_LOSSLESS_TEXT.typePolicy.hash,
    });
    const probe = await losslessDb.one(sql.rows<{
      readonly version: string;
      readonly version_comment: string;
    }>`SELECT VERSION() AS version, @@version_comment AS version_comment`);
    const edition = /\bcommunity\b/iu.test(`${probe.version} ${probe.version_comment}`)
      ? "community"
      : /\benterprise\b/iu.test(`${probe.version} ${probe.version_comment}`)
        ? "enterprise"
        : "unknown";
    assert.equal(edition, "community");
    stampSupportEnvironment("mysql", {
      ...environment,
      database: { product: "mysql", version: probe.version, edition },
      driver: { ...environment.driver, version: mysql2Version },
      runtime: { id: "node", version: process.versions.node },
    }, "mysql.data.profile-conformance");
  } finally {
    await losslessConnection.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
    if (nativeConnection !== undefined) await nativeConnection.end().catch(() => undefined);
    await losslessConnection.end();
  }
});
