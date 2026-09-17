import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import type { CallQuery, ConnectionProvider, Database, RowQuery, StreamOptions, TransactionOptions } from "@sqlbraid/core";
import {
  createMysql2Database,
  createMysql2PoolProvider,
  MYSQL2_LOSSLESS_TEXT,
  type Mysql2ConnectionLike,
  type Mysql2ExecuteOptionsLike,
  type Mysql2PoolConnectionLike,
  type Mysql2PoolLike,
  type Mysql2RawCommandLike,
  type Mysql2RawConnectionLike,
  type Mysql2RawStreamLike,
} from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { createPooledDatabase } from "@sqlbraid/runtime";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ResourceSnapshot } from "../types.js";

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

async function measureMysqlDatabase(
  connection: MysqlConnection,
): Promise<NonNullable<CertificationFixture["measuredDatabase"]>> {
  const response = await connection.query("SELECT VERSION() AS version, @@version_comment AS comment");
  const rows = Array.isArray(response) ? response[0] : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (row === undefined || typeof row !== "object" || row === null)
    throw new Error("MySQL version probe did not return a row.");
  const versionText = String((row as { readonly version?: unknown }).version ?? "");
  const comment = String((row as { readonly comment?: unknown }).comment ?? "");
  const version = /^(\d+(?:\.\d+)+)(?:-|$)/u.exec(versionText)?.[1];
  if (version === undefined) throw new Error(`Unable to parse MySQL version: ${versionText}`);
  if (!/\bMySQL\b/iu.test(comment) || !/\bCommunity\b/iu.test(comment))
    throw new Error(`MySQL version comment does not identify the community server: ${comment}`);
  return { product: "mysql", version, edition: "community" };
}

function q<Row = unknown>(query: RowQuery<Row>): RowQuery<Row> {
  return query;
}

function schema() {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-mysql-certification",
      validate(value: unknown) {
        return { value };
      },
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

function nativeErrorHas(error: unknown, key: "code" | "errno", expected: string | number): boolean {
  if (error !== null && typeof error === "object") {
    if ((error as Record<string, unknown>)[key] === expected) return true;
    if (error instanceof AggregateError && error.errors.some((nested) => nativeErrorHas(nested, key, expected)))
      return true;
    if ("cause" in error && nativeErrorHas(error.cause, key, expected)) return true;
  }
  return false;
}

function nativeLockTimeout(error: unknown): boolean {
  return nativeErrorHas(error, "errno", 1205);
}

function nativeReadOnlyRejection(error: unknown): boolean {
  return nativeErrorHas(error, "errno", 1792) || nativeErrorHas(error, "errno", 1223);
}

function instrumentMysqlConnection(
  connection: Mysql2ConnectionLike,
  onExecute: () => void,
  onPrepare: () => void,
  onPreparedExecute: (values?: readonly unknown[]) => void,
): Mysql2ConnectionLike {
  return new Proxy(connection as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "execute" && typeof value === "function") {
        return (sqlOrOptions: unknown, values?: readonly unknown[]) => {
          onExecute();
          return value.call(target, sqlOrOptions, values);
        };
      }
      if (property === "prepare" && typeof value === "function") {
        return async (sqlText: string) => {
          onPrepare();
          const prepared = (await value.call(target, sqlText)) as object;
          return new Proxy(prepared, {
            get(statementTarget, statementProperty, statementReceiver) {
              const statementValue = Reflect.get(statementTarget, statementProperty, statementReceiver);
              if (statementProperty === "execute" && typeof statementValue === "function") {
                return (preparedValues?: readonly unknown[]) => {
                  onPreparedExecute(preparedValues);
                  return statementValue.call(statementTarget, preparedValues);
                };
              }
              return typeof statementValue === "function" ? statementValue.bind(statementTarget) : statementValue;
            },
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Mysql2ConnectionLike;
}

function instrumentProviderStream(
  provider: ConnectionProvider,
  onIteratorReturn: () => void,
  onRelease: () => void,
): ConnectionProvider {
  return {
    ...provider,
    async acquire() {
      const lease = await provider.acquire();
      let released = false;
      let streamUsed = false;
      return {
        ...lease,
        stream: <Row>(...args: Parameters<typeof lease.stream>) => {
          streamUsed = true;
          const source = lease.stream<Row>(...args);
          return {
            [Symbol.asyncIterator]() {
              const iterator = source[Symbol.asyncIterator]();
              return {
                next: iterator.next.bind(iterator),
                return: async (value?: unknown) => {
                  onIteratorReturn();
                  return iterator.return ? iterator.return(value) : { done: true, value };
                },
                ...(iterator.throw ? { throw: iterator.throw.bind(iterator) } : {}),
              };
            },
          };
        },
        async release(options?: Parameters<typeof lease.release>[0]): Promise<void> {
          try {
            await lease.release(options);
          } finally {
            if (streamUsed && !released) {
              released = true;
              onRelease();
            }
          }
        },
      };
    },
  };
}

function faultSource(source: Mysql2RawStreamLike, mode: FaultMode, error: Error): Mysql2RawStreamLike {
  const wrapped: Mysql2RawStreamLike = {
    get destroyed() {
      return source.destroyed;
    },
    on(event, listener) {
      source.on?.call(source, event, listener);
      return wrapped;
    },
    once(event, listener) {
      source.once.call(source, event, listener);
      return wrapped;
    },
    destroy(reason) {
      source.destroy?.call(source, reason);
      return wrapped;
    },
    [Symbol.asyncIterator]() {
      if (mode === "iterator") throw error;
      const iterator = source[Symbol.asyncIterator]();
      let nextCount = 0;
      return {
        async next() {
          nextCount += 1;
          if (mode === "first" && nextCount === 1) throw error;
          if (mode === "mid" && nextCount === 2) throw error;
          if (mode === "cleanup" && nextCount === 1) throw error;
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
): Mysql2PoolConnectionLike & { readonly connection: Mysql2RawConnectionLike } {
  const api = connection as unknown as MysqlConnection;
  const physical = api;
  const raw: Mysql2RawConnectionLike = {
    execute(sqlOrOptions, values) {
      if (mode === "execute") throw error;
      const options: Mysql2ExecuteOptionsLike =
        typeof sqlOrOptions === "string"
          ? { sql: sqlOrOptions, ...(values === undefined ? {} : { values }) }
          : sqlOrOptions;
      const command = physical.connection.execute(options);
      if (mode !== "stream" && mode !== "iterator" && mode !== "first" && mode !== "mid" && mode !== "cleanup")
        return command;
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
    release: async () => {
      await api.end();
    },
    destroy: api.connection.destroy.bind(api.connection),
  };
}

async function end(connection: Pick<MysqlConnection, "end">): Promise<void> {
  await connection.end();
}

async function createFixture(connectionUri: string): Promise<CertificationFixture> {
  const options = connectionOptions(connectionUri);
  const pool = createPool({ ...options, connectionLimit: 4, idleTimeout: 0 }) as unknown as MysqlPool;
  const suffix = ++fixtureSerial;
  const table = `braid_rc3_mysql_cert_${suffix}`;
  const setsProcedure = `braid_rc3_mysql_cert_sets_${suffix}`;
  const lobProcedure = `braid_rc3_mysql_cert_lob_${suffix}`;
  const callProcedure = `braid_rc3_mysql_cert_call_${suffix}`;
  const outProcedure = `braid_rc3_mysql_cert_out_${suffix}`;
  const borrowed = { value: 0 };
  const acquired = { value: 0 };
  const nativeExecutes = { value: 0 };
  const nativePreparedExecutes = { value: 0 };
  const direct = instrumentMysqlConnection(
    (await createConnection(options)) as unknown as Mysql2ConnectionLike,
    () => {
      nativeExecutes.value += 1;
    },
    () => undefined,
    () => {
      nativePreparedExecutes.value += 1;
    },
  ) as MysqlConnection;
  const measuredDatabase = await measureMysqlDatabase(direct);
  await direct.query("SET SESSION innodb_lock_wait_timeout = 1");
  const physicalIds = new Set<string>();
  let streamReleases = 0;
  const streamReturns = { value: 0 };
  let lastStreamPhysicalId: number | undefined;
  let bulkExecutions = 0;
  let bulkValues: readonly (readonly unknown[])[] = [];
  let streamAcquirePending = false;
  const trackedPool: MysqlPool = {
    ...pool,
    async getConnection(): Promise<Mysql2PoolConnectionLike> {
      const connection = await pool.getConnection();
      await connection.query?.("SET SESSION innodb_lock_wait_timeout = 1");
      if (streamAcquirePending) {
        streamAcquirePending = false;
        lastStreamPhysicalId = Number((connection as unknown as { readonly threadId?: number }).threadId);
      }
      acquired.value += 1;
      return instrumentMysqlConnection(
        connection,
        () => {
          nativeExecutes.value += 1;
        },
        () => {
          bulkExecutions += 1;
        },
        (values) => {
          nativePreparedExecutes.value += 1;
          bulkValues = [...bulkValues, values === undefined ? [] : [...values]];
        },
      ) as Mysql2PoolConnectionLike;
    },
  };
  const baseProvider = createMysql2PoolProvider(trackedPool, { profile: MYSQL2_LOSSLESS_TEXT });
  const provider: ConnectionProvider = instrumentProviderStream(
    {
      ...baseProvider,
      async acquire() {
        const lease = await baseProvider.acquire();
        borrowed.value += 1;
        let released = false;
        return {
          ...lease,
          async release(releaseOptions?: Parameters<typeof lease.release>[0]): Promise<void> {
            if (released) return;
            released = true;
            try {
              await lease.release(releaseOptions);
            } finally {
              borrowed.value -= 1;
            }
          },
        };
      },
    },
    () => {
      streamReturns.value += 1;
    },
    () => {
      streamReleases += 1;
    },
  );
  const db = createPooledDatabase(provider);
  const directDb = createMysql2Database(direct);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(setsProcedure)}`);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(lobProcedure)}`);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(callProcedure)}`);
  await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(outProcedure)}`);
  await pool.query(`DROP TABLE IF EXISTS ${tableSql(table)}`);
  await pool.query(`CREATE TABLE ${tableSql(table)} (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB`);
  await pool.query(`INSERT INTO ${tableSql(table)} (id, value) VALUES (1, 0)`);
  await pool.query(
    `CREATE PROCEDURE ${tableSql(setsProcedure)}(IN input INT) BEGIN SELECT CAST(input AS CHAR) AS value; SELECT CAST(input + 1 AS CHAR) AS value; END`,
  );
  await pool.query(`CREATE PROCEDURE ${tableSql(lobProcedure)}() SELECT CAST('lob' AS BINARY) AS value`);
  await pool.query(`CREATE PROCEDURE ${tableSql(callProcedure)}(IN input INT) SELECT CAST(input AS CHAR) AS value`);
  await pool.query(`CREATE PROCEDURE ${tableSql(outProcedure)}(OUT answer INT) SET answer = 42`);

  const one = q(sql.rows`SELECT 'one' AS value`);
  const many = q(sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`);
  const stream = q(sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`);
  const largeInteger = "9007199254740993";
  const exactDecimal = "12345678901234567890.123456789";
  const exactTemporal = "2026-09-14 12:34:56.789";
  const boundInjection = `'; UPDATE ${tableSql(table)} SET value = 999 WHERE id = 1; --`;
  const mappingFailure = new Error("mysql certification mapping failure");
  const mappingSchema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-mysql-certification",
      validate() {
        throw mappingFailure;
      },
    },
  } as const;
  const mappingQuery = sql.rows(mappingSchema)`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const largeResultQuery = q(
    sql.rows`WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1000) SELECT CAST(n AS CHAR) AS value FROM seq`,
  );
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
    command: () => {
      preparedCalls += 1;
      return command;
    },
    rows: () => {
      preparedCalls += 1;
      return many;
    },
    input: undefined,
    factoryCalls: () => preparedCalls,
  };
  const routines = {
    call: sql.call`CALL ${sql.ident(callProcedure)}(${7})`,
    out: sql.call({ procedure: { name: outProcedure, parameterNames: ["answer"] } })`${sql.out("answer")}`,
    inout: sql.call({ procedure: { name: outProcedure, parameterNames: ["answer"] } })`${sql.inOut("answer", 7)}`,
    resultSets: sql.call`CALL ${sql.ident(setsProcedure)}(${7})`,
    lob: sql.call`CALL ${sql.ident(lobProcedure)}()`,
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
      largeExactInteger: q(sql.rows`SELECT CAST(${largeInteger} AS DECIMAL(19, 0)) AS value`),
      exactDecimal: q(sql.rows`SELECT CAST(${exactDecimal} AS DECIMAL(30, 9)) AS value`),
      temporal: q(sql.rows`SELECT CAST(${exactTemporal} AS DATETIME(3)) AS value`),
      injection: q(sql.rows`SELECT ${boundInjection} AS value`),
      expected: {
        largeExactInteger: { value: largeInteger },
        exactDecimal: { value: exactDecimal },
        temporal: { value: exactTemporal },
        injection: { value: boundInjection },
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
  const faultConnections: Connection[] = [];
  const faultDatabases = new Map<object, Database>();
  const createFaultDatabase = async (query: RowQuery<unknown>, mode: FaultMode, error: Error): Promise<void> => {
    const connection = await createConnection(connectionOptions(connectionUri));
    faultConnections.push(connection);
    const physical = faultConnection(connection, mode, error);
    const faultProvider = instrumentProviderStream(
      createMysql2PoolProvider({ getConnection: async () => physical }, { profile: MYSQL2_LOSSLESS_TEXT }),
      () => {
        streamReturns.value += 1;
      },
      () => {
        streamReleases += 1;
      },
    );
    faultDatabases.set(query as object, createPooledDatabase(faultProvider));
  };
  await createFaultDatabase(initFailureQuery, "execute", initFailure);
  await createFaultDatabase(firstNextFailureQuery, "first", firstFailure);
  await createFaultDatabase(midStreamFailureQuery, "mid", midFailure);
  await createFaultDatabase(cleanupFailureQuery, "cleanup", cleanupFailure);
  const streamForFixture = <Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row> => {
    const mode = streamFaults.get(query as object) ?? "normal";
    if (mode === "normal") {
      streamAcquirePending = true;
      return db.stream(query, options);
    }
    const faultDb = faultDatabases.get(query as object);
    if (faultDb === undefined) throw new Error(`mysql certification stream ${mode} fixture missing.`);
    return faultDb.stream(query, options);
  };
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
    iteratorReturns: () => streamReturns.value,
    initFailureCleanup: { iteratorReturns: 1, released: 1 },
    reuseAfterBreak: async () => {
      const reused = await pool.getConnection();
      try {
        const reusedId = Number((reused as unknown as { readonly threadId?: number }).threadId);
        await (reused as unknown as { query: (sql: string) => Promise<unknown> }).query("SELECT 1");
        assert.equal(
          reusedId,
          lastStreamPhysicalId,
          "mysql2 stream break must release and reuse the same physical session.",
        );
      } finally {
        (reused as unknown as { release: () => void }).release();
      }
    },
  };
  const bulk: BulkConformanceFixture<unknown> = {
    db,
    inputs: [1, 2],
    factory: (input) => sql.command`UPDATE ${sql.ident(table)} SET value = value + ${input} WHERE id = 1`,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => acquired.value,
    executeCount: () => bulkExecutions,
    values: () => bulkValues,
    middleFailure: async () => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      const factory = (input: number | null) =>
        sql.command`UPDATE ${sql.ident(table)} SET value = ${input} WHERE id = 1`;
      const beforePreparedExecutes = nativePreparedExecutes.value;
      let transactionFailure: unknown;
      let observedInTransaction: readonly unknown[] = [];
      try {
        await db.tx(async (tx) => {
          try {
            await tx.bulk([1, null, 3], factory);
          } catch (error) {
            assert.equal((error as { readonly code?: unknown }).code, "ER_BAD_NULL_ERROR");
            observedInTransaction = await tx.all(
              sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1 AND value > 0`,
            );
            assert.deepEqual(observedInTransaction, [{ value: "1" }]);
            throw error;
          }
        });
      } catch (error) {
        transactionFailure = error;
      }
      assert.ok(transactionFailure instanceof Error, "mysql2 transactional bulk middle failure must reject.");
      assert.equal(nativePreparedExecutes.value - beforePreparedExecutes, 2);
      const observedRows = await directDb.all(
        sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1 AND value > 0`,
      );
      const expectedRows: readonly unknown[] = [];
      assert.deepEqual(observedRows, expectedRows);
      return { error: transactionFailure, observedRows, expectedRows, durability: "atomic" as const };
    },
  };
  const transactionOption = async (optionDb: Database, transactionOptions: TransactionOptions): Promise<void> => {
    const resetOptionState = async (): Promise<void> => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
    };
    const readOptionState = async (tx: Database): Promise<string> => {
      const row = (await tx.one(
        sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`,
      )) as { readonly value?: unknown };
      return String(row.value);
    };
    const writeOptionState = sql.command`UPDATE ${sql.ident(table)} SET value = 7 WHERE id = 1`;
    const dirtyOptionState = sql.command`UPDATE ${sql.ident(table)} SET value = 1 WHERE id = 1`;
    const openWitness = async (): Promise<{ readonly connection: Connection; readonly db: Database }> => {
      const connection = await createConnection(connectionOptions(connectionUri));
      try {
        await connection.query("SET SESSION innodb_lock_wait_timeout = 1");
      } catch (error) {
        await connection.end();
        throw error;
      }
      return {
        connection,
        db: createMysql2Database(connection as unknown as Mysql2ConnectionLike, { profile: MYSQL2_LOSSLESS_TEXT }),
      };
    };
    const runProof = async (proof: () => Promise<void>): Promise<void> => {
      await resetOptionState();
      let primaryError: unknown;
      try {
        await proof();
      } catch (error) {
        primaryError = error;
      }
      let cleanupError: unknown;
      try {
        await resetOptionState();
      } catch (error) {
        cleanupError = error;
      }
      if (primaryError !== undefined && cleanupError !== undefined) throw new AggregateError([primaryError, cleanupError]);
      if (primaryError !== undefined) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    };
    if (transactionOptions.readOnly !== undefined) {
      await runProof(async () => {
        if (transactionOptions.readOnly === false) {
          await optionDb.tx(transactionOptions, async (tx) => {
            await tx.execute(writeOptionState);
          });
          assert.equal(await readOptionState(directDb), "7");
          return;
        }
        let caught: unknown;
        try {
          await optionDb.tx(transactionOptions, async (tx) => {
            await tx.execute(writeOptionState);
          });
        } catch (error) {
          caught = error;
        }
        if (!nativeReadOnlyRejection(caught))
          throw new Error("mysql2 read-only transaction did not reject the write with the native error.", {
            cause: caught,
          });
        assert.equal(await readOptionState(directDb), "0");
      });
    }
    if (transactionOptions.isolation === "read-uncommitted") {
      await runProof(async () => {
        const witness = await openWitness();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let observed: string | undefined;
        let primaryError: unknown;
        let writerError: unknown;
        const writer = witness.db.tx(async (tx) => {
          try {
            await tx.execute(dirtyOptionState);
            ready.resolve();
          } catch (error) {
            ready.reject(error);
            throw error;
          }
          await release.promise;
        });
        try {
          await ready.promise;
          observed = await optionDb.tx(transactionOptions, (tx) => readOptionState(tx));
        } catch (error) {
          primaryError = error;
        } finally {
          release.resolve();
        }
        try {
          await writer;
        } catch (error) {
          writerError = error;
        }
        try {
          await witness.connection.end();
        } catch (error) {
          if (primaryError === undefined && writerError === undefined) primaryError = error;
          else writerError ??= error;
        }
        if (primaryError !== undefined) throw primaryError;
        if (writerError !== undefined) throw writerError;
        assert.equal(observed, "1", "mysql2 read-uncommitted did not observe the dirty write.");
      });
    } else if (transactionOptions.isolation === "read-committed" || transactionOptions.isolation === "repeatable-read") {
      await runProof(async () => {
        const witness = await openWitness();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let before: string | undefined;
        let after: string | undefined;
        let primaryError: unknown;
        let readerError: unknown;
        let writerError: unknown;
        const reader = optionDb.tx(transactionOptions, async (tx) => {
          try {
            before = await readOptionState(tx);
            ready.resolve();
            await release.promise;
            after = await readOptionState(tx);
          } catch (error) {
            ready.reject(error);
            throw error;
          }
        });
        reader.catch((error) => ready.reject(error));
        try {
          await ready.promise;
          await witness.db.tx(async (tx) => {
            await tx.execute(dirtyOptionState);
          });
        } catch (error) {
          primaryError = error;
          release.resolve();
        } finally {
          release.resolve();
        }
        try {
          await reader;
        } catch (error) {
          readerError = error;
        }
        try {
          await witness.connection.end();
        } catch (error) {
          if (primaryError === undefined && readerError === undefined) primaryError = error;
          else writerError ??= error;
        }
        if (primaryError !== undefined) throw primaryError;
        if (readerError !== undefined) throw readerError;
        if (writerError !== undefined) throw writerError;
        assert.equal(before, "0", "mysql2 isolation proof did not start from the reset state.");
        assert.equal(
          after,
          transactionOptions.isolation === "read-committed" ? "1" : "0",
          `mysql2 ${transactionOptions.isolation} did not enforce its snapshot semantics.`,
        );
      });
    } else if (transactionOptions.isolation === "serializable") {
      await runProof(async () => {
        const witness = await openWitness();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let primaryError: unknown;
        let readerError: unknown;
        let writerError: unknown;
        const reader = optionDb.tx(transactionOptions, async (tx) => {
          try {
            await readOptionState(tx);
            ready.resolve();
            await release.promise;
          } catch (error) {
            ready.reject(error);
            throw error;
          }
        });
        reader.catch((error) => ready.reject(error));
        try {
          await ready.promise;
          try {
            await witness.db.tx(async (tx) => {
              await tx.execute(dirtyOptionState);
            });
          } catch (error) {
            writerError = error;
          }
        } catch (error) {
          primaryError = error;
        } finally {
          release.resolve();
        }
        try {
          await reader;
        } catch (error) {
          readerError = error;
        }
        try {
          await witness.connection.end();
        } catch (error) {
          if (primaryError === undefined && readerError === undefined && writerError === undefined) primaryError = error;
          else writerError ??= error;
        }
        if (primaryError !== undefined) throw primaryError;
        if (readerError !== undefined) throw readerError;
        if (!nativeLockTimeout(writerError))
          throw new Error("mysql2 serializable transaction did not enforce a native lock conflict.", {
            cause: writerError,
          });
      });
    }
  };
  const metrics = {
    snapshot: (): ResourceSnapshot => ({ borrowedLeases: borrowed.value, cleanupBalance: borrowed.value }),
    sideEffects: () => acquired.value + nativeExecutes.value,
    mutationSentinel: async () =>
      directDb.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`),
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
      const value = result.resultSets[0]?.rows[0] as { readonly value?: unknown } | undefined;
      assert.ok(value?.value instanceof Uint8Array, "mysql2 routine resource proof must observe a native LOB.");
      assert.equal(borrowed.value, 0, "mysql2 routine call leaked its pooled lease.");
      await directDb.one(identity);
    },
    transactionCleanup: async (): Promise<void> => {
      const cleanupError = new Error("mysql2 transaction rollback cleanup failure");
      const primaryError = new Error("mysql2 transaction primary failure");
      const failingProvider: ConnectionProvider = {
        ...provider,
        async acquire() {
          const lease = await provider.acquire();
          return {
            ...lease,
            rollback: async () => {
              throw cleanupError;
            },
          };
        },
      };
      const failingDb = createPooledDatabase(failingProvider, { observers: [] });
      let caught: unknown;
      try {
        await failingDb.tx(async () => {
          throw primaryError;
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(
        caught instanceof AggregateError,
        "mysql2 transaction cleanup must aggregate primary and rollback errors.",
      );
      assert.equal(caught.errors[0], primaryError);
      assert.ok(caught.errors.some((error) => error === cleanupError));
      assert.equal(borrowed.value, 0);
      await db.one(identity);
    },
    transactionOption,
    readOnlyWrite: async (): Promise<void> => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      await db.tx({ readOnly: false }, async (tx) => {
        await tx.execute(sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`);
      });
      await assert.rejects(
        () =>
          db.tx({ readOnly: true }, async (tx) => {
            await tx.execute(sql.command`UPDATE ${sql.ident(table)} SET value = value + 1 WHERE id = 1`);
          }),
        (error: unknown) => error instanceof Error,
      );
      assert.deepEqual(
        await db.one(sql.rows`SELECT CAST(value AS CHAR) AS value FROM ${sql.ident(table)} WHERE id = 1`),
        { value: "1" },
      );
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
    },
  };
  const unsupported = {
    CALL002: {
      feature: "routine.out",
      expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const,
      run: async () => {
        await db.call(routines.out);
      },
      sideEffects: () => acquired.value + nativeExecutes.value,
    },
    CALL003: {
      feature: "routine.inout",
      expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const,
      run: async () => {
        await db.call(routines.inout);
      },
      sideEffects: () => acquired.value + nativeExecutes.value,
    },
    CALL005: {
      feature: "routine.out-cursor",
      expectedErrorFeature: "routine.out",
      expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const,
      run: async () => {
        await db.call(routines.cursor);
      },
      sideEffects: () => acquired.value + nativeExecutes.value,
    },
    CALL006: {
      feature: "routine.return-value",
      expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED" as const,
      run: async () => {
        await db.call(routines.returnValue);
      },
      sideEffects: () => acquired.value + nativeExecutes.value,
    },
  };
  const representationUnsupported = {
    "data.json-parsed": {
      prove: async () => {
        const row = await directDb.one(
          sql.rows`SELECT JSON_OBJECT('large', CAST(${largeInteger} AS DECIMAL(19, 0))) AS value`,
        );
        const value = (row as { readonly value?: unknown }).value;
        assert.ok(typeof value === "string");
        assert.ok(value.includes(largeInteger), "mysql2 JSON text proof must preserve the exact numeric lexeme.");
      },
    },
    "data.temporal-native": {
      prove: async () => {
        const row = await directDb.one(sql.rows`SELECT CAST(${exactTemporal} AS DATETIME(3)) AS value`);
        assert.equal(typeof (row as { readonly value?: unknown }).value, "string");
      },
    },
  };
  const fixture: CertificationFixture = {
    db: directDb,
    measuredDatabase,
    pooled: db,
    queries: definitions,
    stream: streamFixture,
    bulk,
    metrics,
    reset: async () => {
      await pool.query(`UPDATE ${tableSql(table)} SET value = 0 WHERE id = 1`);
      preparedCalls = 0;
      physicalIds.clear();
      streamReleases = 0;
      streamReturns.value = 0;
      lastStreamPhysicalId = undefined;
      bulkExecutions = 0;
      bulkValues = [];
      acquired.value = 0;
      nativeExecutes.value = 0;
      nativePreparedExecutes.value = 0;
      const identityResult = await db.one(identity);
      physicalIds.add(identityResult.id);
    },
    unsupported,
    representationUnsupported,
    guarded: {
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
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(lobProcedure)}`).catch(() => undefined);
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(callProcedure)}`).catch(() => undefined);
      await pool.query(`DROP PROCEDURE IF EXISTS ${tableSql(outProcedure)}`).catch(() => undefined);
      await pool.query(`DROP TABLE IF EXISTS ${tableSql(table)}`).catch(() => undefined);
      for (const connection of faultConnections)
        await end(connection as unknown as MysqlConnection).catch(() => undefined);
      await end(direct);
      await end(pool);
    },
  };
  return fixture;
}

export function createMysql2NodeTarget(
  connectionUri: string,
  sourceSha: string,
  measuredDriverVersion?: string,
): CertificationTarget {
  return {
    id: "mysql-mysql2-node-8-4-2",
    sourceSha,
    ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
    createFixture: () => createFixture(connectionUri),
  };
}

export function createMysql2DenoTarget(
  connectionUri: string,
  sourceSha: string,
  measuredDriverVersion?: string,
): CertificationTarget {
  return {
    id: "mysql-mysql2-deno-2-9-3",
    sourceSha,
    ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
    expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS,
    createFixture: () => createFixture(connectionUri),
  };
}
