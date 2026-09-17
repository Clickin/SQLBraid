import mariadb, { type Pool } from "mariadb";
import assert from "node:assert/strict";
import { inject } from "vitest";
import { sql, MARIADB_LOSSLESS_TEXT, MARIADB_NATIVE } from "@sqlbraid/mariadb";
import { createMariaDbDatabase, createMariaDbPoolDatabase, createMariaDbPoolProvider, type MariaDbConnectionLike, type MariaDbPoolConnectionLike } from "@sqlbraid/mariadb/mariadb";
import { createPooledDatabase } from "@sqlbraid/runtime";
import type { CallQuery, CommandQuery, ConnectionProvider, Database, RowQuery, StandardSchemaV1 } from "@sqlbraid/core";
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
const JSON_TABLE = "braid_rc3_mariadb_json";

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
  const largeInteger = "9007199254740993";
  const exactDecimal = "12345678901234567890.123456789";
  const exactTemporal = "2026-09-14 12:34:56.789";
  const boundInjection = `'; UPDATE ${JSON_TABLE} SET payload = JSON_OBJECT('injected', 1); --`;
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
    routines: { executionScope: "root", call, out, inout, resultSets, lob: sql.call`CALL braid_rc3_mariadb_lob()`, cursor, returnValue },
    fidelity: {
      largeExactInteger: sql.rows`SELECT CAST(${largeInteger} AS DECIMAL(19, 0)) AS value`,
      exactDecimal: sql.rows`SELECT CAST(${exactDecimal} AS DECIMAL(30, 9)) AS value`,
      temporal: sql.rows`SELECT CAST(${exactTemporal} AS DATETIME(3)) AS value`,
      injection: sql.rows`SELECT ${boundInjection} AS value`,
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

function expectedLabelRow(label: string): Record<string, unknown> {
  const row = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(row, label, { value: "safe", enumerable: true, configurable: true, writable: true });
  return row;
}

function containsError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError && error.errors.some((nested) => containsError(nested, expected))) return true;
  if (error instanceof Error && "cause" in error) return containsError(error.cause, expected);
  return false;
}

function instrumentMariaDbConnection(
  connection: MariaDbConnectionLike,
  onExecute: () => void,
  onBatch: (values: readonly (readonly unknown[])[]) => void,
): MariaDbConnectionLike {
  return new Proxy(connection as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "execute" && typeof value === "function") {
        return (sqlOrOptions: unknown, values?: readonly unknown[]) => {
          onExecute();
          return value.call(target, sqlOrOptions, values);
        };
      }
      if (property === "batch" && typeof value === "function") {
        return (sqlText: string, values: readonly (readonly unknown[])[]) => {
          onBatch(values);
          return value.call(target, sqlText, values);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MariaDbConnectionLike;
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
      const stream = lease.stream.bind(lease);
      let released = false;
      let streamUsed = false;
      return {
        ...lease,
        stream: (...args: Parameters<typeof lease.stream>) => {
          streamUsed = true;
          const source = stream(...args);
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

function faultMariaStream(
  source: import("@sqlbraid/mariadb/mariadb").MariaDbStreamLike,
  mode: "first" | "mid" | "cleanup",
  error: Error,
): import("@sqlbraid/mariadb/mariadb").MariaDbStreamLike {
  const sourceIterator = source[Symbol.asyncIterator]();
  let nextCalls = 0;
  return new Proxy(source as object, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => ({
          next: async () => {
            nextCalls += 1;
            if ((mode === "first" && nextCalls === 1) || (mode === "mid" && nextCalls === 2) || (mode === "cleanup" && nextCalls === 1)) throw error;
            return sourceIterator.next();
          },
        });
      }
      if (property === "close" && mode === "cleanup") return () => { throw error; };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as import("@sqlbraid/mariadb/mariadb").MariaDbStreamLike;
}

function faultMariaConnection(
  connection: MariaDbConnectionLike,
  mode: "execute" | "first" | "mid" | "cleanup",
  error: Error,
): MariaDbPoolConnectionLike {
  return new Proxy(connection as object, {
    get(target, property, receiver) {
      if (property === "release") return async () => { await Promise.resolve(connection.end?.()); };
      if (property === "queryStream") {
        return (sqlOrOptions: unknown, values?: readonly unknown[]) => {
          if (mode === "execute") throw error;
          const queryStream = Reflect.get(target, property, receiver) as (sqlOrOptions: unknown, values?: readonly unknown[]) => import("@sqlbraid/mariadb/mariadb").MariaDbStreamLike;
          return faultMariaStream(queryStream.call(target, sqlOrOptions, values), mode, error);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MariaDbPoolConnectionLike;
}
async function createFixture(): Promise<CertificationFixture> {
  const nativeConnection = await mariadb.createConnection(connectorOptions()) as unknown as MariaDbConnectionLike;
  const pool: Pool = mariadb.createPool(connectorOptions());
  let acquisitions = 0;
  let bulkExecutions = 0;
  let bulkValues: readonly (readonly unknown[])[] = [];
  const nativeExecutes = { value: 0 };
  let streamReleases = 0;
  const streamReturns = { value: 0 };
  const connection = instrumentMariaDbConnection(nativeConnection, () => { nativeExecutes.value += 1; }, () => undefined);
  const directPhysicalId = String((connection as unknown as { readonly threadId?: number }).threadId ?? "direct");
  const physicalIds = new Set<string>();
  const trackedPool = {
    getConnection: async () => {
      acquisitions += 1;
      const pooledConnection = await pool.getConnection() as unknown as MariaDbPoolConnectionLike;
      const physicalId = (pooledConnection as unknown as { readonly threadId?: number }).threadId;
      if (physicalId !== undefined) physicalIds.add(String(physicalId));
      return instrumentMariaDbConnection(
        pooledConnection,
        () => { nativeExecutes.value += 1; },
        (values) => {
          nativeExecutes.value += 1;
          bulkExecutions += 1;
          bulkValues = values.map((value) => [...value]);
        },
      ) as MariaDbPoolConnectionLike;
    },
  };
  const db = createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT });
  const provider = instrumentProviderStream(
    createMariaDbPoolProvider(trackedPool, { profile: MARIADB_LOSSLESS_TEXT }),
    () => { streamReturns.value += 1; },
    () => { streamReleases += 1; },
  );
  const pooled = createPooledDatabase(provider);
  await connection.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await connection.query(`CREATE TABLE ${TABLE} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255) NOT NULL CHECK (value <> ''))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS ${JSON_TABLE} (payload JSON NOT NULL)`);
  await connection.query(`DELETE FROM ${JSON_TABLE}`);
  await connection.query(`INSERT INTO ${JSON_TABLE} (payload) VALUES (JSON_OBJECT('large', CAST('9007199254740993' AS DECIMAL(19, 0))))`);
  await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_call");
  await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_sets");
  await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_lob");
  await connection.query("CREATE PROCEDURE braid_rc3_mariadb_call(IN input_value VARCHAR(255)) BEGIN SELECT input_value AS value; END");
  await connection.query("CREATE PROCEDURE braid_rc3_mariadb_sets() BEGIN SELECT 'one' AS value; SELECT 'two' AS value; END");
  await connection.query("CREATE PROCEDURE braid_rc3_mariadb_lob() SELECT CAST('lob' AS BINARY) AS value");
  const queries = rowQueries();
  const mappingFailure = new Error("mariadb query-bound mapping failure");
  const executionSchemaFailure = new Error("mariadb execution schema failure");
  const initFailureQuery = sql.rows`SELECT 'init' AS value`;
  const firstNextFailureQuery = sql.rows`SELECT 'first' AS value`;
  const midStreamFailureQuery = sql.rows`SELECT 'mid' AS value UNION ALL SELECT 'mid2' AS value`;
  const cleanupFailureQuery = sql.rows`SELECT 'cleanup' AS value`;
  const initFailure = new Error("mariadb stream initialization failure");
  const firstFailure = new Error("mariadb stream first failure");
  const midFailure = new Error("mariadb stream mid failure");
  const cleanupFailure = new Error("mariadb stream cleanup failure");
  const faultConnections: MariaDbConnectionLike[] = [];
  const faultDatabases = new Map<object, Database>();
  const createFaultDatabase = async (
    query: RowQuery<unknown>,
    mode: "execute" | "first" | "mid" | "cleanup",
    error: Error,
  ): Promise<void> => {
    const faultNative = await mariadb.createConnection(connectorOptions()) as unknown as MariaDbConnectionLike;
    faultConnections.push(faultNative);
    const faultConnection = faultMariaConnection(faultNative, mode, error);
    const faultProvider = instrumentProviderStream(
      createMariaDbPoolProvider({
        getConnection: async () => faultConnection,
      }, { profile: MARIADB_LOSSLESS_TEXT }),
      () => { streamReturns.value += 1; },
      () => { streamReleases += 1; },
    );
    faultDatabases.set(query as object, createPooledDatabase(faultProvider));
  };
  await createFaultDatabase(initFailureQuery, "execute", initFailure);
  await createFaultDatabase(firstNextFailureQuery, "first", firstFailure);
  await createFaultDatabase(midStreamFailureQuery, "mid", midFailure);
  await createFaultDatabase(cleanupFailureQuery, "cleanup", cleanupFailure);
  const streamDatabase = {
    stream(query: Parameters<typeof db.stream>[0], options?: Parameters<typeof db.stream>[1]) {
      const fault = faultDatabases.get(query as object);
      return (fault ?? pooled).stream(query, options);
    },
  } as Pick<Database, "stream">;
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
    db: streamDatabase,
    query: queries.stream!,
    expected: queries.expected!.many,
    mappingQuery,
    mappingFailure,
    executionSchemaFailure,
    initFailureQuery,
    initFailure,
    firstNextFailureQuery,
    firstNextFailure: firstFailure,
    midStreamFailureQuery,
    midStreamFailure: midFailure,
    cleanupFailureQuery,
    cleanupFailure,
    released: () => streamReleases,
    iteratorReturns: () => streamReturns.value,
    initFailureCleanup: { iteratorReturns: 1, released: 1 },
    reuseAfterBreak: async () => {
      await db.one(queries.identity);
      assert.equal(pool.activeConnections(), 0, "MariaDB stream break must release the pooled connection.");
    },
    largeResultQuery: sql.rows`SELECT value FROM ${sql.ident(TABLE)} WHERE 1 = 0 UNION ALL SELECT '1' UNION ALL SELECT '2' UNION ALL SELECT '3' UNION ALL SELECT '4' UNION ALL SELECT '5'`,
    largeResultCount: 5,
  };
  const bulk: BulkConformanceFixture<unknown> = {
    db: pooled,
    inputs: ["bulk-a", "bulk-b"],
    factory: (input) => sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES (${String(input)})`,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => acquisitions,
    executeCount: () => bulkExecutions,
    values: () => bulkValues,
    middleFailure: async () => {
      await pool.query(`DELETE FROM ${TABLE}`);
      const factory = (input: string | null) => sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES (${input})`;
      let transactionError: unknown;
      let observedInTransaction: readonly unknown[] = [];
      try {
        await pooled.tx(async (tx) => {
          try {
            await tx.bulk(["bulk-a", null, "bulk-c"], factory);
          } catch (error) {
            assert.equal((error as { readonly code?: unknown }).code, "ER_BAD_NULL_ERROR");
            observedInTransaction = await tx.all(sql.rows`SELECT value FROM ${sql.ident(TABLE)} ORDER BY id`);
            assert.deepEqual(observedInTransaction, []);
            throw error;
          }
        });
      } catch (error) {
        transactionError = error;
      }
      assert.ok(transactionError instanceof Error, "MariaDB transactional bulk middle failure must reject.");
      const observedRows = await db.all(sql.rows`SELECT value FROM ${sql.ident(TABLE)} ORDER BY id`);
      const expectedRows: readonly unknown[] = [];
      assert.deepEqual(observedRows, expectedRows);
      return { error: transactionError, observedRows, expectedRows, durability: "atomic" as const };
    },
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
  const metrics = {
    snapshot,
    sideEffects: () => acquisitions + nativeExecutes.value,
    mutationSentinel: async () => db.one(sql.rows`SELECT payload FROM ${sql.ident(JSON_TABLE)}`),
    physicalSessionIds: () => [...physicalIds, directPhysicalId],
    pooledScope,
    routineCleanup: async (query?: CallQuery): Promise<void> => {
      const result = await pooled.call(query ?? queries.routines!.resultSets!);
      assert.ok(result.resultSets.length > 0, "MariaDB routine resource proof must observe result sets.");
      const value = result.resultSets[0]?.rows[0] as { readonly value?: unknown } | undefined;
      assert.ok(value?.value instanceof Uint8Array, "MariaDB routine resource proof must observe a native LOB.");
      assert.equal(pool.activeConnections(), 0, "MariaDB routine call leaked its pooled lease.");
      await pooled.one(queries.identity);
    },
    transactionCleanup: async (): Promise<void> => {
      const cleanupError = new Error("MariaDB transaction rollback cleanup failure");
      const primaryError = new Error("MariaDB transaction primary failure");
      const failingPool = {
        getConnection: async () => {
          const native = await pool.getConnection();
          return new Proxy(native, {
            get(target, property, receiver) {
              if (property === "rollback") return async () => { throw cleanupError; };
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
      const failingDb = createMariaDbPoolDatabase(failingPool, { profile: MARIADB_LOSSLESS_TEXT });
      let caught: unknown;
      try {
        await failingDb.tx(async () => { throw primaryError; });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof AggregateError, "MariaDB transaction cleanup must aggregate primary and rollback errors.");
      assert.equal(caught.errors[0], primaryError);
      assert.ok(caught.errors.some((error) => error === cleanupError));
      assert.equal(pool.activeConnections(), 0);
      await pooled.one(queries.identity);
    },
    readOnlyWrite: async (): Promise<void> => {
      await pool.query(`DELETE FROM ${TABLE}`);
      await db.tx({ readOnly: false }, async (tx) => { await tx.execute(queries.transaction!.insert); });
      await assert.rejects(
        () => db.tx({ readOnly: true }, async (tx) => { await tx.execute(sql.command`INSERT INTO ${sql.ident(TABLE)} (value) VALUES ('must-not-commit')`); }),
        (error: unknown) => error instanceof Error,
      );
      assert.deepEqual(await db.all(sql.rows`SELECT value FROM ${sql.ident(TABLE)} ORDER BY id`), [{ value: "tx" }]);
      await pool.query(`DELETE FROM ${TABLE}`);
    },
  };
  const fixture: CertificationFixture = {
    db,
    pooled,
    queries,
    stream,
    bulk,
    metrics,
    reset: async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255) NOT NULL CHECK (value <> ''))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${JSON_TABLE} (payload JSON NOT NULL)`);
      await pool.query(`DELETE FROM ${TABLE}`);
      await pool.query(`DELETE FROM ${JSON_TABLE}`);
      await pool.query(`INSERT INTO ${JSON_TABLE} (payload) VALUES (JSON_OBJECT('large', CAST('9007199254740993' AS DECIMAL(19, 0))))`);
      acquisitions = 0;
      nativeExecutes.value = 0;
      physicalIds.clear();
      physicalIds.add(directPhysicalId);
      streamReleases = 0;
      streamReturns.value = 0;
      bulkExecutions = 0;
      bulkValues = [];
    },
    unsupported: {
      CALL002: {
        feature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.call(queries.routines!.out!), sideEffects: () => acquisitions + nativeExecutes.value,
      },
      CALL003: {
        feature: "routine.inout", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.call(queries.routines!.inout!), sideEffects: () => acquisitions + nativeExecutes.value,
      },
      CALL005: {
        feature: "routine.out-cursor", expectedErrorFeature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => db.tx((tx) => tx.call(queries.routines!.cursor!)), sideEffects: () => acquisitions + nativeExecutes.value,
      },
      CALL006: {
        feature: "routine.return-value", expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED", run: () => db.call(queries.routines!.returnValue!), sideEffects: () => acquisitions + nativeExecutes.value,
      },
    },
    guarded: {
      "numeric.exact-integer": {
        prove: async () => {
          const before = await db.one(sql.rows`SELECT value FROM ${sql.ident(TABLE)} WHERE id = 1`);
          const injected = await db.one(queries.fidelity!.injection);
          assert.deepEqual(injected, queries.fidelity!.expected.injection);
          assert.deepEqual(await db.one(sql.rows`SELECT value FROM ${sql.ident(TABLE)} WHERE id = 1`), before);
          const row = await db.one(queries.fidelity!.largeExactInteger);
          if ((row as { readonly value?: unknown }).value !== "9007199254740993") throw new Error("MariaDB exact integer guard failed.");
        },
      },
      "numeric.exact-decimal": {
        prove: async () => {
          const row = await db.one(queries.fidelity!.exactDecimal);
          if ((row as { readonly value?: unknown }).value !== "12345678901234567890.123456789") throw new Error("MariaDB exact decimal guard failed.");
        },
      },
      "data.json-lossless-text": {
        prove: async () => {
          const row = await db.one(sql.rows`SELECT payload AS value FROM ${sql.ident(JSON_TABLE)}`);
          const value = (row as { readonly value?: unknown }).value;
          if (typeof value !== "string" || !value.includes("9007199254740993")) throw new Error("MariaDB JSON lossless guard failed.");
        },
      },
      "data.json-parsed": {
        prove: async () => {
          const parsedConnection = await mariadb.createConnection(connectorOptions({ autoJsonMap: true, dateStrings: false }));
          try {
            const parsedDb = createMariaDbDatabase(parsedConnection, { profile: MARIADB_NATIVE });
            const row = await parsedDb.one(sql.rows`SELECT payload AS value FROM ${sql.ident(JSON_TABLE)}`);
            const value = (row as { readonly value?: unknown }).value;
            if (value === null || typeof value !== "object") throw new Error("MariaDB JSON parsed guard failed.");
            if (typeof (value as { readonly large?: unknown }).large !== "number") throw new Error("MariaDB JSON parsed guard did not observe native numeric JSON.");
          } finally {
            await parsedConnection.end();
          }
        },
      },
      "data.temporal-lossless": {
        prove: async () => {
          const row = await db.one(queries.fidelity!.temporal);
          if ((row as { readonly value?: unknown }).value !== "2026-09-14 12:34:56.789") throw new Error("MariaDB temporal text guard failed.");
        },
      },
      "data.temporal-native": {
        prove: async () => {
          const nativeConnection = await mariadb.createConnection(connectorOptions({ dateStrings: false }));
          try {
            const nativeDb = createMariaDbDatabase(nativeConnection, { profile: MARIADB_NATIVE });
            const row = await nativeDb.one(queries.fidelity!.temporal);
            if (!((row as { readonly value?: unknown }).value instanceof Date)) throw new Error("MariaDB temporal native guard failed.");
          } finally {
            await nativeConnection.end();
          }
        },
      },
      "statement.cancel": {
        prove: async () => {
          const controller = new AbortController();
          const abortError = new Error("cert-cancel");
          const pending = pooled.execute(sql.command`SELECT SLEEP(3)`, { signal: controller.signal });
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.abort(abortError);
          let cancellation: unknown;
          try {
            await pending;
          } catch (error) {
            cancellation = error;
          }
          assert.ok(cancellation instanceof Error, "MariaDB cancellation must reject the in-flight operation.");
          assert.equal((cancellation as Error & { readonly code?: unknown }).code, "BRAID_RESOURCE_CLEANUP");
          assert.ok(containsError(cancellation, abortError), "MariaDB cancellation must preserve the abort reason.");
          await pooled.one(queries.one);
        },
      },
      "metadata.command-safe": {
        prove: async () => { assertCommandAffectedRows(await db.execute(queries.command)); },
      },
    },
    close: async () => {
      await connection.query("DROP PROCEDURE IF EXISTS braid_rc3_mariadb_lob").catch(() => undefined);
      await pool.query(`DROP TABLE IF EXISTS ${JSON_TABLE}`);
      for (const fault of faultConnections) await Promise.resolve(fault.end?.()).catch(() => undefined);
      await nativeConnection.end?.();
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
