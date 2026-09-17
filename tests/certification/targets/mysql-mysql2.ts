import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import type { CallQuery, Database, RowQuery, StreamOptions } from "@sqlbraid/core";
import { createMysql2Database, createMysql2PoolProvider, MYSQL2_LOSSLESS_TEXT, type Mysql2ConnectionLike, type Mysql2ExecuteOptionsLike, type Mysql2PoolLike, type Mysql2RawCommandLike, type Mysql2RawConnectionLike, type Mysql2RawStreamLike } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { createPooledDatabase } from "@sqlbraid/runtime";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey } from "../types.js";

import { MYSQL2_EXPECTED_CAPABILITIES, MYSQL2_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";



type FaultMode = "normal" | "execute" | "stream" | "iterator" | "first" | "mid" | "cleanup";
type MysqlConnection = Mysql2ConnectionLike & {
  readonly connection: Mysql2RawConnectionLike;
  readonly end: () => Promise<void>;
  readonly query: (sql: string) => Promise<unknown>;
};
type MysqlPool = Mysql2PoolLike & {
  readonly query: (sql: string) => Promise<unknown>;
  readonly end: () => Promise<void>;
};

let fixtureSerial = 0;

function connectionOptions(connectionUri: string): Record<string, unknown> {
  const uri = new URL(connectionUri);
  return {
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    disableEval: false,
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 3306,
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.replace(/^\//u, "")),
  };
}

function q<Row = unknown>(query: RowQuery<Row>): RowQuery<Row> {
  return query;
}

function schema() {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-mysql-certification",
      validate(value: unknown) { return { value }; },
    },
  } as const;
}

function tableSql(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function expectedRow(label: string, value: unknown): Record<string, unknown> {
  return Object.fromEntries([[label, value]]);
}

function containsError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError && error.errors.some((nested) => containsError(nested, expected))) return true;
  if (error instanceof Error && "cause" in error) return containsError(error.cause, expected);
  return false;
}

function mutationSql(sqlText: string): boolean {
  return /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sqlText);
}

function faultSource(
  source: Mysql2RawStreamLike,
  mode: FaultMode,
  error: Error,
): Mysql2RawStreamLike {
  const wrapped: Mysql2RawStreamLike = {
    get destroyed() { return source.destroyed; },
    on(event, listener) { source.on?.call(source, event, listener); return wrapped; },
    once(event, listener) { source.once.call(source, event, listener); return wrapped; },
    destroy(reason) { source.destroy?.call(source, reason); return wrapped; },
    [Symbol.asyncIterator]() {
      if (mode === "iterator") throw error;
      const iterator = source[Symbol.asyncIterator]();
      let nextCount = 0;
      return {
        async next() {
          nextCount += 1;
          if (mode === "first" && nextCount === 1) throw error;
          if (mode === "mid" && nextCount === 2) throw error;
          if (mode === "cleanup" && nextCount >= 2) throw error;
          return iterator.next();
        },
      };
    },
  };
  return wrapped;
}

function faultConnection(
  connection: Connection,
  mode: FaultMode,
  error: Error,
): Mysql2ConnectionLike & { readonly connection: Mysql2RawConnectionLike } {
  const api = connection as unknown as MysqlConnection;
  const physical = api;
  const raw: Mysql2RawConnectionLike = {
    execute(sqlOrOptions, values) {
      if (mode === "execute") throw error;
      const options: Mysql2ExecuteOptionsLike = typeof sqlOrOptions === "string"
        ? { sql: sqlOrOptions, ...(values === undefined ? {} : { values }) }
        : sqlOrOptions;
      const command = physical.connection.execute(options);
      if (mode !== "stream" && mode !== "iterator" && mode !== "first" && mode !== "mid" && mode !== "cleanup") return command;
      return {
        stream(options?: { readonly highWaterMark?: number }) {
          if (mode === "stream") throw error;
          return faultSource(command.stream(options), mode, error);
        },
      } satisfies Mysql2RawCommandLike;
    },
    destroy: physical.connection.destroy.bind(physical.connection),
    stream: physical.connection.stream,
  };
  return {
    connection: raw,
    execute: api.execute.bind(api),
    query: api.query.bind(api),
    prepare: api.prepare?.bind(api),
    unprepare: api.unprepare?.bind(api),
    beginTransaction: api.beginTransaction.bind(api),
    commit: api.commit.bind(api),
    rollback: api.rollback.bind(api),
  };
}

async function end(connection: Pick<MysqlConnection, "end">): Promise<void> {
  await connection.end();
}

async function createFixture(connectionUri: string): Promise<CertificationFixture> {
  const options = connectionOptions(connectionUri);
  const pool = createPool({ ...options, connectionLimit: 4, idleTimeout: 0 }) as unknown as MysqlPool;
  const actualClient: Mysql2ConnectionLike = await createConnection(options);
  const direct = actualClient as MysqlConnection;
  const suffix = ++fixtureSerial;
  const table = `braid_rc3_mysql_cert_${suffix}`;
  const setsProcedure = `braid_rc3_mysql_cert_sets_${suffix}`;
  const callProcedure = `braid_rc3_mysql_cert_call_${suffix}`;
  const outProcedure = `braid_rc3_mysql_cert_out_${suffix}`;
  const borrowed = { value: 0 };
  const acquired = { value: 0 };
  const sideEffects = { value: 0 };
  const physicalIds = new Set<string>();
  const mutatingOperations = new Set<string>();
  let streamReleases = 0;
  let streamIterations = 0;
  let lastStreamPhysicalId: number | undefined;
  let bulkExecutions = 0;
  const observer = {
    onEvent(event: { readonly type: string; readonly operationId?: string; readonly sql?: string; readonly itemCount?: number }): void {
      if (event.type === "query:ready" && event.operationId && event.sql && mutationSql(event.sql)) mutatingOperations.add(event.operationId);
      if (event.type === "query:result" && event.operationId && mutatingOperations.delete(event.operationId)) sideEffects.value += 1;
      if (event.type === "bulk:result") sideEffects.value += event.itemCount ?? 0;
    },
  };
  const baseProvider = createMysql2PoolProvider(pool, { profile: MYSQL2_LOSSLESS_TEXT });
  const provider = {
    ...baseProvider,
    async acquire() {
      const lease = await baseProvider.acquire();
      borrowed.value += 1;
      acquired.value += 1;
      let released = false;
      return {
        ...lease,
        async release(releaseOptions?: Parameters<typeof lease.release>[0]): Promise<void> {
          if (released) return;
          released = true;
          try { await lease.release(releaseOptions); } finally { borrowed.value -= 1; }
        },
      };
    },
  };
  const db = createPooledDatabase(provider, { observers: [observer] });
  const directDb = createMysql2Database(direct, { profile: MYSQL2_LOSSLESS_TEXT });
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(setsProcedure)}`);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(callProcedure)}`);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(outProcedure)}`);
  await pool.query(`DROP TABLE IF EXISTS ${tableSql(table)}`);
  await pool.query(`CREATE TABLE ${tableSql(table)} (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB`);
  await pool.query(`INSERT INTO ${tableSql(table)} (id, value) VALUES (1, 0)`);
  await pool.query(`CREATE PROCEDURE ${tableSql(setsProcedure)}(IN input INT) BEGIN SELECT CAST(input AS CHAR) AS value; SELECT CAST(input + 1 AS CHAR) AS value; END`);
  await pool.query(`CREATE PROCEDURE ${tableSql(callProcedure)}(IN input INT) SELECT CAST(input AS CHAR) AS value`);
  await pool.query(`CREATE PROCEDURE ${tableSql(outProcedure)}(OUT answer INT) SET answer = 42`);

  const one = q(sql.rows`SELECT 'one' AS value`);
  const many = q(sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`);
  const stream = q(sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`);
  const mappingFailure = new Error("mysql certification mapping failure");
  const mappingSchema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-mysql-certification",
      validate() { throw mappingFailure; },
    },
  } as const;
  const mappingQuery = sql.rows(mappingSchema)`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const largeResultQuery = q(sql.rows`WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1000) SELECT CAST(n AS CHAR) AS value FROM seq`);
  const zero = q(sql.rows`SELECT 'zero' AS value WHERE 1 = 0`);
  const command = sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`;
  const identity = sql.rows<{ readonly id: string }>`SELECT CAST(CONNECTION_ID() AS CHAR) AS id`;
  const failure = q(sql.rows`SELECT * FROM braid_rc3_mysql_missing_table`);
  const special = {
    RES001: q(sql.rows`SELECT 'safe' AS \`__proto__\``),
    RES002: q(sql.rows`SELECT 'safe' AS \`constructor\``),
    RES003: q(sql.rows`SELECT 'safe' AS \`prototype\``),
    RES004: q(sql.rows`SELECT 'safe' AS \`toString\``),
    RES005: q(sql.rows`SELECT 'safe' AS \`hasOwnProperty\``),
    RES006: q(sql.rows`SELECT 'hello' AS value`),
    RES007: q(sql.rows`SELECT '' AS value`),
    RES008: q(sql.rows`SELECT NULL AS value`),
    RES009: q(sql.rows`SELECT '안녕하세요' AS value`),
    RES010: q(sql.rows`SELECT UNHEX('00FF10') AS value`),
    RES011: q(sql.rows`SELECT 'first' AS duplicate, 'second' AS duplicate`),
  } as const;
  const transaction = {
    insert: sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`,
    visible: q(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE value > 0`),
    savepointInsert: sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`,
    savepointVisible: q(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE value > 0`),
  };
  let preparedCalls = 0;
  const prepared = {
    command: () => { preparedCalls += 1; return command; },
    rows: () => { preparedCalls += 1; return many; },
    input: undefined,
    factoryCalls: () => preparedCalls,
  };
  const routines = {
    call: sql.call`CALL ${sql.ident(callProcedure)}(${7})`,
    out: sql.call({ procedure: { name: outProcedure, parameterNames: ["answer"] } })`${sql.out("answer")}`,
    inout: sql.call({ procedure: { name: outProcedure, parameterNames: ["answer"] } })`${sql.inOut("answer", 7)}`,
    resultSets: sql.call`CALL ${sql.ident(setsProcedure)}(${7})`,
    lob: sql.call`CALL ${sql.ident(setsProcedure)}(${7})`,
    cursor: sql.call({ procedure: { name: outProcedure, parameterNames: ["cursor"] } })`${sql.out("cursor")}`,
    returnValue: sql.call({ returnValue: schema() })`CALL ${sql.ident(callProcedure)}(${7})`,
  };
  const definitions = {
    zero,
    one,
    many,
    command,
    identity,
    failure,
    stream,
    special,
    transaction,
    prepared,
    routines,
    fidelity: {
      largeExactInteger: q(sql.rows`SELECT 9007199254740991 AS value`),
      exactDecimal: q(sql.rows`SELECT 12345678901234567890.123456789 AS value`),
      temporal: q(sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`),
      injection: q(sql.rows`SELECT ${"'; SELECT 1; --"} AS value`),
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
        RES001: expectedRow("__proto__", "safe"),
        RES002: expectedRow("constructor", "safe"),
        RES003: expectedRow("prototype", "safe"),
        RES004: expectedRow("toString", "safe"),
        RES005: expectedRow("hasOwnProperty", "safe"),
        RES006: { value: "hello" },
        RES007: { value: "" },
        RES008: { value: null },
        RES009: { value: "안녕하세요" },
        RES010: { value: Buffer.from([0, 255, 16]) },
        CALL001: { output: {}, resultSets: [{ rows: [{ value: "7" }] }] },
        CALL004: { output: {}, resultSets: [{ rows: [{ value: "7" }] }, { rows: [{ value: "8" }] }] },
      },
      specialErrors: { RES011: { code: "BRAID_RESULT_COLUMNS" } },
      commandAffectedRows: 1,
      failureCode: "ER_NO_SUCH_TABLE",
    },
  };
  const streamFaults = new Map<object, FaultMode>([
    [q(sql.rows`SELECT 'execute' AS value`) as object, "execute"],
    [q(sql.rows`SELECT 'stream' AS value`) as object, "stream"],
    [q(sql.rows`SELECT 'iterator' AS value`) as object, "iterator"],
  ]);
  const initFailureQuery = [...streamFaults.keys()][0] as RowQuery<unknown>;
  const initFailure = new Error("mysql certification stream execute failure");
  const firstFailure = new Error("mysql certification stream first failure");
  const midFailure = new Error("mysql certification stream mid failure");
  const firstNextFailureQuery = q(sql.rows`SELECT 'first' AS value`);
  const midStreamFailureQuery = q(sql.rows`SELECT 'mid' AS value UNION ALL SELECT 'mid2' AS value`);
  const cleanupFailureQuery = q(sql.rows`SELECT 'cleanup' AS value`);
  const cleanupFailure = new Error("mysql certification stream cleanup failure");
  streamFaults.set(firstNextFailureQuery as object, "first");
  streamFaults.set(midStreamFailureQuery as object, "mid");
  streamFaults.set(cleanupFailureQuery as object, "cleanup");
  const streamForFixture = <Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row> => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<Row> {
      const mode = streamFaults.get(query as object) ?? "normal";
      const pooledConnection = mode === "normal" ? await pool.getConnection() : undefined;
      const connection = pooledConnection ?? await createConnection(connectionOptions(connectionUri));
      const error = mode === "execute"
        ? initFailure
        : mode === "first"
          ? firstFailure
          : mode === "mid"
            ? midFailure
            : mode === "cleanup"
              ? cleanupFailure
              : new Error(`mysql certification stream ${mode} failure`);
      try {
        const physical = mode === "normal"
          ? connection as unknown as Mysql2ConnectionLike
          : faultConnection(connection as unknown as Connection, mode, error);
        const streamDb = createMysql2Database(physical, { profile: MYSQL2_LOSSLESS_TEXT });
        if (mode === "normal") lastStreamPhysicalId = Number((connection as unknown as { readonly threadId?: number }).threadId);
        let yielded = false;
        for await (const row of streamDb.stream(query, options)) {
          if (!yielded) {
            yielded = true;
            streamIterations += 1;
          }
          yield row as Row;
        }
      } finally {
        if (pooledConnection) pooledConnection.release();
        else await end(connection as unknown as Connection).catch(() => undefined);
        streamReleases += 1;
      }
    },
  });
  const streamFixture: StreamingConformanceFixture<unknown> = {
    db: { stream: streamForFixture },
    query: stream,
    expected: [{ value: "1" }, { value: "2" }],
    mappingQuery,
    mappingFailure,
    executionSchemaFailure: new Error("mysql certification execution schema failure"),
    initFailureQuery,
    initFailure,
    firstNextFailureQuery,
    firstNextFailure: firstFailure,
    midStreamFailureQuery,
    midStreamFailure: midFailure,
    cleanupFailureQuery,
    largeResultQuery,
    largeResultCount: 1000,
    cleanupFailure,
    released: () => streamReleases,
    iteratorReturns: () => streamIterations,
    reuseAfterBreak: async () => {
      const reused = await pool.getConnection();
      try {
        const reusedId = Number((reused as unknown as { readonly threadId?: number }).threadId);
        await (reused as unknown as { query: (sql: string) => Promise<unknown> }).query("SELECT 1");
        assert.equal(reusedId, lastStreamPhysicalId, "mysql2 stream break must release and reuse the same physical session.");
      } finally {
        (reused as unknown as { release: () => void }).release();
      }
    },
  };
  const bulk: BulkConformanceFixture<unknown> = {
    db: {
      ...db,
      bulk: async (inputs, factory) => {
        if (inputs.length === 0) return { inputCount: 0, affectedRows: 0 };
        bulkExecutions += 1;
        return db.bulk(inputs, factory);
      },
    },
    inputs: [1, 2],
    factory: (input) => sql.command`UPDATE ${sql.ident(table)} SET value = value + ${input} WHERE id = 1`,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => acquired.value,
    executeCount: () => bulkExecutions,
    middleFailure: async () => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      const failureCommand = sql.command`INSERT INTO braid_rc3_mysql_bulk_missing (value) VALUES (1)`;
      const factory = (input: number, index: number) => index === 1
        ? failureCommand
        : sql.command`UPDATE ${sql.ident(table)} SET value = value + ${input} WHERE id = 1`;
      let standaloneFailure: unknown;
      try {
        await db.bulk([1, 2, 3], factory);
      } catch (error) {
        standaloneFailure = error;
      }
      assert.ok(standaloneFailure instanceof Error, "mysql2 bulk middle failure must come from native bulk execution.");
      const observedRows = [await db.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`)];
      assert.deepEqual(observedRows, [{ value: "0" }]);
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      let transactionFailure: unknown;
      try {
        await db.tx(async (tx) => { await tx.bulk([1, 2, 3], factory); });
      } catch (error) {
        transactionFailure = error;
      }
      assert.ok(transactionFailure instanceof Error, "mysql2 transactional bulk middle failure must reject.");
      assert.deepEqual(await db.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`), { value: "0" });
      return { error: standaloneFailure, observedRows, expectedRows: [{ value: "0" }], durability: "atomic" as const };
    },
  };
  const metrics = {
    snapshot: (): ResourceSnapshot => ({ borrowedLeases: borrowed.value, cleanupBalance: borrowed.value }),
    sideEffects: () => sideEffects.value,
    mutationSentinel: async () => directDb.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`),
    physicalSessionIds: () => [...physicalIds],
    pooledScope: async (): Promise<void> => {
      await db.session(async (session) => {
        await session.one(identity);
        if (borrowed.value < 1) throw new Error("mysql2 pooled session did not borrow a native connection.");
      });
      if (borrowed.value !== 0) throw new Error("mysql2 pooled session leaked its native connection.");
    },
    routineCleanup: async (query?: CallQuery): Promise<void> => {
      const result = await db.call(query ?? routines.resultSets ?? routines.call);
      assert.ok(result.resultSets.length > 0, "mysql2 routine resource proof must observe result sets.");
      await directDb.one(identity);
    },
    transactionCleanup: async (): Promise<void> => {
      const cleanupError = new Error("mysql2 transaction rollback cleanup failure");
      const primaryError = new Error("mysql2 transaction primary failure");
      const failingProvider = {
        ...provider,
        async acquire() {
          const lease = await provider.acquire();
          return { ...lease, rollback: async () => { throw cleanupError; } };
        },
      };
      const failingDb = createPooledDatabase(failingProvider, { observers: [] });
      let caught: unknown;
      try {
        await failingDb.tx(async () => { throw primaryError; });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof AggregateError, "mysql2 transaction cleanup must aggregate primary and rollback errors.");
      assert.equal(caught.errors[0], primaryError);
      assert.ok(caught.errors.some((error) => error === cleanupError));
      assert.equal(borrowed.value, 0);
      await db.one(identity);
    },
    readOnlyWrite: async (): Promise<void> => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      await db.tx({ readOnly: false }, async (tx) => { await tx.execute(sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`); });
      await assert.rejects(
        () => db.tx({ readOnly: true }, async (tx) => { await tx.execute(sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`); }),
        (error: unknown) => error instanceof Error,
      );
      assert.deepEqual(await db.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`), { value: "1" });
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
    },
  };
  const unsupported = {
    CALL002: { feature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const, run: async () => { await db.call(routines.out); }, sideEffects: () => sideEffects.value },
    CALL003: { feature: "routine.inout", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const, run: async () => { await db.call(routines.inout); }, sideEffects: () => sideEffects.value },
    CALL005: { feature: "routine.out-cursor", expectedErrorFeature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const, run: async () => { await db.call(routines.cursor); }, sideEffects: () => sideEffects.value },
    CALL006: { feature: "routine.return-value", expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED" as const, run: async () => { await db.call(routines.returnValue); }, sideEffects: () => sideEffects.value },
  };
  const fixture: CertificationFixture = {
    db,
    pooled: db,
    queries: definitions,
    stream: streamFixture,
    bulk,
    metrics,
    reset: async () => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      preparedCalls = 0;
      sideEffects.value = 0;
      physicalIds.clear();
      streamReleases = 0;
      streamIterations = 0;
      lastStreamPhysicalId = undefined;
      bulkExecutions = 0;
      acquired.value = 0;
      const identityResult = await db.one(identity);
      physicalIds.add(identityResult.id);
    },
    unsupported,
    guarded: {
      "numeric.exact-integer": {
        prove: async () => {
          const row = await db.one(q(sql.rows`SELECT 9007199254740991 AS value`));
          if ((row as { readonly value?: unknown }).value !== "9007199254740991") throw new Error("mysql2 exact integer guard failed.");
        },
      },
      "numeric.exact-decimal": {
        prove: async () => {
          const row = await db.one(q(sql.rows`SELECT 12345678901234567890.123456789 AS value`));
          if ((row as { readonly value?: unknown }).value !== "12345678901234567890.123456789") throw new Error("mysql2 exact decimal guard failed.");
        },
      },
      "numeric.approximate-float": {
        prove: async () => {
          const row = await db.one(q(sql.rows`SELECT CAST(1.5 AS DOUBLE) AS value`));
          if (typeof (row as { readonly value?: unknown }).value !== "number") throw new Error("mysql2 float guard failed.");
        },
      },
      "data.json-lossless-text": {
        prove: async () => {
          await assert.rejects(
            () => db.one(q(sql.rows`SELECT JSON_OBJECT('large', 9007199254740993) AS value`)),
            (error: unknown) => error instanceof Error && /JSON results must remain strings/iu.test(error.message),
          );
        },
      },
      "data.json-parsed": {
        prove: async () => {
          const jsonConnection = await createConnection({ ...connectionOptions(connectionUri), jsonStrings: false });
          try {
            const jsonDb = createMysql2Database(jsonConnection as unknown as Mysql2ConnectionLike, { profile: MYSQL2_LOSSLESS_TEXT });
            const row = await jsonDb.one(q(sql.rows`SELECT JSON_OBJECT('value', 1) AS value`));
            const value = (row as { readonly value?: unknown }).value;
            if (value === null || typeof value !== "object") throw new Error("mysql2 JSON parsed guard failed.");
          } finally {
            await end(jsonConnection as unknown as MysqlConnection);
          }
        },
      },
      "data.temporal-lossless": {
        prove: async () => {
          const row = await db.one(q(sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`));
          if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error("mysql2 temporal text guard failed.");
        },
      },
      "data.temporal-native": {
        prove: async () => {
          const nativeConnection = await createConnection({ ...connectionOptions(connectionUri), dateStrings: false });
          try {
            const nativeDb = createMysql2Database(nativeConnection as unknown as Mysql2ConnectionLike, { profile: MYSQL2_LOSSLESS_TEXT });
            const row = await nativeDb.one(q(sql.rows`SELECT CAST('2026-09-14 12:34:56.789' AS DATETIME(3)) AS value`));
            if (!((row as { readonly value?: unknown }).value instanceof Date)) throw new Error("mysql2 temporal native guard failed.");
          } finally {
            await end(nativeConnection as unknown as MysqlConnection);
          }
        },
      },
      "statement.cancel": {
        prove: async () => {
          const controller = new AbortController();
          const abortError = new Error("mysql certification guarded cancellation");
          const pending = db.execute(sql.rows`SELECT SLEEP(60) AS value`, { signal: controller.signal });
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.abort(abortError);
          let cancellation: unknown;
          try {
            await pending;
          } catch (error) {
            cancellation = error;
          }
          assert.ok(cancellation instanceof Error);
          assert.ok(containsError(cancellation, abortError), "mysql2 cancellation must preserve the abort reason.");
          await db.one(identity);
        },
      },
    },
    close: async () => {
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(setsProcedure)}`).catch(() => undefined);
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(callProcedure)}`).catch(() => undefined);
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(outProcedure)}`).catch(() => undefined);
      await pool.query(`DROP TABLE IF EXISTS ${tableSql(table)}`).catch(() => undefined);
      await end(direct);
      await end(pool);
    },
  };
  return fixture;
}

export function createMysql2NodeTarget(connectionUri: string, sourceSha: string, measuredDriverVersion?: string): CertificationTarget {
  return {
    id: "mysql-mysql2-node-8-4-2",
    sourceSha,
    ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
    createFixture: () => createFixture(connectionUri),
  };
}

export function createMysql2DenoTarget(connectionUri: string, sourceSha: string, measuredDriverVersion?: string): CertificationTarget {
  return {
    id: "mysql-mysql2-deno-2-9-3",
    sourceSha,
    ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
    createFixture: () => createFixture(connectionUri),
  };
}
