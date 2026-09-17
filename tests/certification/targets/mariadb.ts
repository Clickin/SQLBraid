import mariadb, { type Pool } from "mariadb";
import assert from "node:assert/strict";
import { inject } from "vitest";
import { sql, MARIADB_LOSSLESS_TEXT } from "@sqlbraid/mariadb";
import { createMariaDbDatabase, createMariaDbPoolDatabase } from "@sqlbraid/mariadb/mariadb";
import type { CommandQuery, RowQuery, StandardSchemaV1 } from "@sqlbraid/core";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type {
  CertificationFixture,
  CertificationTarget,
  ExpectedCapabilityContract,
  ResourceSnapshot,
  TransactionOptionKey,
} from "../types.js";

const TABLE = "braid_rc3_mariadb_cert";

function returnSchema(): StandardSchemaV1<unknown, number> {
  return { "~standard": { version: 1, vendor: "sqlbraid-rc3-mariadb", validate: (value) => ({ value: Number(value) }) } };
}

import { MARIADB_EXPECTED_CAPABILITIES, MARIADB_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

export const mariadbExpectedCapabilities = MARIADB_EXPECTED_CAPABILITIES;

const expectedTransactionOptions = MARIADB_EXPECTED_TRANSACTION_OPTIONS;

type MariaDbPoolConfig = Exclude<Parameters<typeof mariadb.createPool>[0], string>;

function connectorOptions(overrides: Partial<MariaDbPoolConfig> = {}): MariaDbPoolConfig {
  const uri = new URL(process.env.SQLBRAID_MARIADB_URL ?? inject("mariadb").connectionUri);
  return {
    ...MARIADB_LOSSLESS_TEXT.connectionOptions,
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
    connectionLimit: 4,
    idleTimeout: 0,
    ...overrides,
  };
}

function rowQueries(): CertificationFixture["queries"] {
  const one = sql.rows`SELECT 'one' AS value`;
  const many = sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const command = sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES ('command')`;
  const failure = sql.rows`SELECT * FROM braid_rc3_mariadb_missing`;
  const identity = sql.rows<{ readonly id: string }>`SELECT CONNECTION_ID() AS id`;
  const transaction = {
    insert: sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES ('tx')`,
    visible: sql.rows`SELECT value FROM ${sql.ident(TABLE)} ORDER BY id`,
    savepointInsert: sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES ('savepoint')`,
    savepointVisible: sql.rows`SELECT value FROM ${sql.ident(TABLE)} ORDER BY id`,
  };
  const special = {
    RES001: sql.rows`SELECT 'safe' AS ${sql.ident("__proto__")}`,
    RES002: sql.rows`SELECT 'safe' AS ${sql.ident("constructor")}`,
    RES003: sql.rows`SELECT 'safe' AS ${sql.ident("prototype")}`,
    RES004: sql.rows`SELECT 'safe' AS ${sql.ident("toString")}`,
    RES005: sql.rows`SELECT 'safe' AS ${sql.ident("hasOwnProperty")}`,
    RES006: sql.rows`SELECT 'hello' AS value`,
    RES007: sql.rows`SELECT '' AS value`,
    RES008: sql.rows`SELECT NULL AS value`,
    RES009: sql.rows`SELECT '안녕하세요' AS value`,
    RES010: sql.rows`SELECT CAST(UNHEX('00FF10') AS BINARY) AS value`,
    RES011: sql.rows`SELECT 1 AS value, 2 AS value`,
  };
  const call = sql.call`CALL braid_rc3_mariadb_call('called')`;
  const resultSets = sql.call`CALL braid_rc3_mariadb_sets()`;
  const out = sql.call`CALL braid_rc3_mariadb_call(${sql.out("answer")})`;
  const inout = sql.call`CALL braid_rc3_mariadb_call(${sql.inOut("answer", "called")})`;
  const cursor = sql.call`CALL braid_rc3_mariadb_call(${sql.out("cursor", { databaseType: "refcursor" })})`;
  const returnValue = sql.call({ returnValue: returnSchema() })`CALL braid_rc3_mariadb_call('called')`;
  let factoryCalls = 0;
  const prepared = {
    command: (input: unknown): CommandQuery => {
      factoryCalls += 1;
      return sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES (${String(input)})`;
    },
    rows: (input: unknown): RowQuery<unknown> => {
      factoryCalls += 1;
      return sql.rows`SELECT ${String(input)} AS value UNION ALL SELECT '2' AS value`;
    },
    input: "1",
    factoryCalls: () => factoryCalls,
  };
  return {
    zero: sql.rows`SELECT value FROM ${sql.ident(TABLE)} WHERE 1 = 0`,
    one,
    many,
    command,
    identity,
    failure,
    stream: many,
    special,
    transaction,
    prepared,
    routines: { executionScope: "root", call, out, inout, resultSets, cursor, returnValue },
    fidelity: {
      largeExactInteger: sql.rows`SELECT CAST('9007199254740991' AS DECIMAL(38,0)) AS value`,
      exactDecimal: sql.rows`SELECT CAST('12345678901234567890.123456789' AS DECIMAL(38,9)) AS value`,
      temporal: sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`,
      injection: sql.rows`SELECT ${"'; SELECT 1; --"} AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740991" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14 12:34:56.789" },
        injection: { value: "'; SELECT 1; --" },
      },
    },
    expected: {
      one: { value: "one" },
      many: [{ value: "1" }, { value: "2" }],
      special: {
        RES001: expectedLabelRow("__proto__"),
        RES002: expectedLabelRow("constructor"),
        RES003: expectedLabelRow("prototype"),
        RES004: expectedLabelRow("toString"),
        RES005: expectedLabelRow("hasOwnProperty"),
        RES006: { value: "hello" },
        RES007: { value: "" },
        RES008: { value: null },
        RES009: { value: "안녕하세요" },
        RES010: { value: Buffer.from([0, 255, 16]) },
        RES011: { value: "second" },
        CALL001: { output: {}, resultSets: [{ rows: [{ value: "called" }] }] },
        CALL004: { output: {}, resultSets: [{ rows: [{ value: "one" }] }, { rows: [{ value: "two" }] }] },
      },
      specialErrors: { RES011: { code: "BRAID_RESULT_COLUMNS" } },
      commandAffectedRows: 1,
      failureCode: "ER_NO_SUCH_TABLE",
    },
  };
}

function expectedDriverFailure(code: string): { readonly code: string } {
  return { code };
}

function expectedLabelRow(label: string): Record<string, unknown> {
  const row = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(row, label, { value: "safe", enumerable: true, configurable: true, writable: true });
  return row;
}

async function createFixture(): Promise<CertificationFixture> {
  const connection = await mariadb.createConnection(connectorOptions());
  const pool: Pool = mariadb.createPool(connectorOptions());
  let acquisitions = 0;
  const trackedPool = {
    getConnection: async () => {
      acquisitions += 1;
      return pool.getConnection();
    },
  };
  const db = createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT });
  const pooled = createMariaDbPoolDatabase(trackedPool, { profile: MARIADB_LOSSLESS_TEXT });
  await connection.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255) NULL)`);
  await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_call");
  await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_sets");
  await connection.query("CREATE PROCEDURE braid_rc3_mariadb_call(IN input_value VARCHAR(255)) BEGIN SELECT input_value AS value; END");
  await connection.query("CREATE PROCEDURE braid_rc3_mariadb_sets() BEGIN SELECT 'one' AS value; SELECT 'two' AS value; END");
  const queries = rowQueries();
  const mappingFailure = new Error("mariadb query-bound mapping failure");
  const executionSchemaFailure = new Error("mariadb execution schema failure");
  const missingTableFailure = expectedDriverFailure("ER_NO_SUCH_TABLE");
  const mappingQuery = sql.rows({
    "~standard": {
      version: 1,
      vendor: "sqlbraid-rc3-mariadb",
      validate() {
        throw mappingFailure;
      },
    },
  })`SELECT 'mapped' AS value`;
  const stream: StreamingConformanceFixture<unknown> = {
    db,
    query: queries.stream!,
    expected: queries.expected!.many,
    mappingQuery,
    mappingFailure,
    executionSchemaFailure,
    initFailureQuery: queries.failure,
    initFailure: missingTableFailure,
    firstNextFailureQuery: sql.rows`SELECT * FROM braid_rc3_mariadb_missing_first`,
    firstNextFailure: missingTableFailure,
    midStreamFailureQuery: sql.rows`SELECT * FROM braid_rc3_mariadb_missing_mid`,
    midStreamFailure: missingTableFailure,
    cleanupFailureQuery: queries.failure,
    cleanupFailure: missingTableFailure,
    largeResultQuery: sql.rows`SELECT value FROM ${sql.ident(TABLE)} WHERE 1 = 0 UNION ALL SELECT '1' UNION ALL SELECT '2' UNION ALL SELECT '3' UNION ALL SELECT '4' UNION ALL SELECT '5'`,
    largeResultCount: 5,
  };
  const bulk: BulkConformanceFixture<unknown> = {
    db: pooled,
    inputs: ["bulk-a", "bulk-b"],
    factory: (input) => sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES (${String(input)})`,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => acquisitions,
    executeCount: () => acquisitions,
    values: () => [["bulk-a"], ["bulk-b"]],
    middleFailure: async () => { await pooled.execute(queries.failure); },
  };
  const snapshot = (): ResourceSnapshot => {
    const active = pool.activeConnections();
    return { borrowedLeases: active, cleanupBalance: active };
  };
  const pooledScope = async (): Promise<void> => {
    await pooled.session(async () => {
      if (pool.activeConnections() < 1) throw new Error("MariaDB pooled session did not borrow a native connection.");
    });
    if (pool.activeConnections() !== 0) throw new Error("MariaDB pooled session leaked its native connection.");
  };
  const threadId = String((connection as unknown as { readonly threadId?: number }).threadId ?? "direct");
  const fixture: CertificationFixture = {
    db,
    pooled,
    queries,
    stream,
    bulk,
    metrics: {
      snapshot,
      sideEffects: () => acquisitions,
      physicalSessionIds: () => [threadId],
      pooledScope,
      routineCleanup: async () => {
        await db.call(queries.routines!.call);
        await pooled.one(queries.identity);
      },
    },
    reset: async () => { await connection.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255) NULL)`); await connection.query(`DELETE FROM ${TABLE}`); },
    unsupported: {
      CALL002: {
        feature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.call(queries.routines!.out!), sideEffects: () => 0,
      },
      CALL003: {
        feature: "routine.inout", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.call(queries.routines!.inout!), sideEffects: () => 0,
      },
      CALL005: {
        feature: "routine.out-cursor", expectedErrorFeature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.tx((tx) => tx.call(queries.routines!.cursor!)), sideEffects: () => 0,
      },
      CALL006: {
        feature: "routine.return-value", expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED", run: () => db.call(queries.routines!.returnValue!), sideEffects: () => 0,
      },
    },
    guarded: {
      "numeric.exact-integer": {
        prove: async () => {
          const row = await db.one(sql.rows`SELECT CAST('9007199254740991' AS DECIMAL(38,0)) AS value`);
          if ((row as { readonly value?: unknown }).value !== "9007199254740991") throw new Error("MariaDB exact integer guard failed.");
        },
      },
      "numeric.exact-decimal": {
        prove: async () => {
          const row = await db.one(sql.rows`SELECT CAST('12345678901234567890.123456789' AS DECIMAL(38,9)) AS value`);
          if ((row as { readonly value?: unknown }).value !== "12345678901234567890.123456789") throw new Error("MariaDB exact decimal guard failed.");
        },
      },
      "data.json-lossless-text": {
        prove: async () => {
          const row = await db.one(sql.rows`SELECT JSON_OBJECT('value', 1) AS value`);
          if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error("MariaDB JSON lossless guard failed.");
        },
      },
      "data.json-parsed": {
        prove: async () => {
          const parsedConnection = await mariadb.createConnection(connectorOptions({ autoJsonMap: true }));
          try {
            const parsedDb = createMariaDbDatabase(parsedConnection, { profile: MARIADB_LOSSLESS_TEXT });
            const row = await parsedDb.one(sql.rows`SELECT JSON_OBJECT('value', 1) AS value`);
            const value = (row as { readonly value?: unknown }).value;
            if (value === null || typeof value !== "object") throw new Error("MariaDB JSON parsed guard failed.");
          } finally {
            await parsedConnection.end();
          }
        },
      },
      "data.temporal-lossless": {
        prove: async () => {
          const row = await db.one(sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`);
          if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error("MariaDB temporal text guard failed.");
        },
      },
      "data.temporal-native": {
        prove: async () => {
          const nativeConnection = await mariadb.createConnection(connectorOptions({ dateStrings: false }));
          try {
            const nativeDb = createMariaDbDatabase(nativeConnection, { profile: MARIADB_LOSSLESS_TEXT });
            const row = await nativeDb.one(sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`);
            if (!((row as { readonly value?: unknown }).value instanceof Date)) throw new Error("MariaDB temporal native guard failed.");
          } finally {
            await nativeConnection.end();
          }
        },
      },
      "statement.cancel": {
        prove: async () => {
          const controller = new AbortController();
          const pending = pooled.execute(sql.command`SELECT SLEEP(3)`, { signal: controller.signal });
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.abort(new Error("cert-cancel"));
          let rejected = false;
          try {
            await pending;
          } catch {
            rejected = true;
          }
          assert.equal(rejected, true, "MariaDB cancellation must reject the in-flight operation.");
          await pooled.one(queries.one);
        },
      },
      "metadata.command-safe": {
        prove: async () => { assertCommandAffectedRows(await db.execute(queries.command)); },
      },
    },
    close: async () => {
      await connection.end();
      await pool.end();
    },
  };
  return fixture;
}

function assertCommandAffectedRows(result: unknown): void {
  const command = (result as { readonly command?: { readonly affectedRows?: unknown } }).command;
  if (command?.affectedRows !== 1) throw new Error("MariaDB command-safe proof did not observe one affected row.");
}

export function createMariaDbCertificationTarget(sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA, measuredDriverVersion?: string): CertificationTarget {
  if (sourceSha === undefined || sourceSha.trim().length === 0) {
    throw new Error("SQLBRAID_CERT_SOURCE_SHA is required for MariaDB certification.");
  }
  return {
    id: "mariadb-connector-node-11-8-9",
    sourceSha,
    ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
    expectedCapabilities: mariadbExpectedCapabilities,
    expectedTransactionOptions,
    createFixture,
  };
}
