import oracledb from "oracledb";
import assert from "node:assert/strict";
import { createOracledbDatabase, createOracledbPoolProvider, type OracleConnectionLike, type OracleExecuteResultLike, type OraclePoolConnectionLike, type OraclePoolLike, type OracleResultSetLike } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { createPooledDatabase } from "@sqlbraid/runtime";
import type { CallQuery, CommandQuery, Database, RowQuery } from "@sqlbraid/core";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot } from "../types.js";

const TABLE = "BRAID_RC3_CERT_ROWS";
const BULK_TABLE = "BRAID_RC3_CERT_BULK";
const SEQUENCE = "BRAID_RC3_CERT_SEQ";
const HOSTILE = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"] as const;

import { ORACLE_EXPECTED_CAPABILITIES, ORACLE_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

async function exec(connection: OracleConnectionLike, statement: string): Promise<void> {
  await connection.execute(statement, []);
}

async function ensureSchema(connection: OracleConnectionLike): Promise<void> {
  await exec(connection, `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE ${TABLE} (id NUMBER PRIMARY KEY, value VARCHAR2(80))'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`);
  await exec(connection, `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE ${BULK_TABLE} (id NUMBER PRIMARY KEY, value VARCHAR2(80))'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`);
  await exec(connection, `BEGIN EXECUTE IMMEDIATE 'CREATE SEQUENCE ${SEQUENCE} START WITH 1'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_SCALAR (p_answer OUT NUMBER) IS BEGIN p_answer := 42; END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_NOOP IS BEGIN NULL; END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_INOUT (p_value IN OUT NUMBER) IS BEGIN p_value := p_value + 1; END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_SETS (p_users OUT SYS_REFCURSOR, p_payments OUT SYS_REFCURSOR) IS l_implicit SYS_REFCURSOR; BEGIN OPEN p_users FOR SELECT 'user-1' AS USER_ID FROM dual; OPEN p_payments FOR SELECT 'payment-1' AS PAYMENT_ID FROM dual; OPEN l_implicit FOR SELECT 'summary-1' AS SUMMARY FROM dual; DBMS_SQL.RETURN_RESULT(l_implicit); END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_CURSOR (p_cursor OUT SYS_REFCURSOR) IS BEGIN OPEN p_cursor FOR SELECT 'cursor-1' AS CURSOR_ID FROM dual; END;`);
  await exec(connection, `CREATE OR REPLACE PROCEDURE BRAID_RC3_CERT_LOB (p_payload OUT CLOB) IS BEGIN p_payload := TO_CLOB(RPAD('x', 4096, 'x')); END;`);
}

function row<Row>(text: string): RowQuery<Row> {
  return sql.rows<Row>`${sql.raw(text)}`;
}
function command(text: string): CommandQuery {
  return sql.command`${sql.raw(text)}`;
}
function call(text: string): CallQuery {
  return sql.call`${sql.raw(text)}`;
}
function expectedHostile(label: string, value: unknown): Record<string, unknown> {
  return Object.fromEntries([[label, value]]);
}

function makeQueries(): CertificationFixture["queries"] {
  const special: Record<string, RowQuery<unknown>> = {};
  const expectedSpecial: Record<string, unknown> = {};
  for (const [index, label] of HOSTILE.entries()) {
    const id = `RES00${index + 1}`;
    special[id] = row(`SELECT ${index + 1} AS "${label}" FROM dual`);
    expectedSpecial[id] = expectedHostile(label, String(index + 1));
  }
  for (let index = 6; index <= 11; index += 1) {
    const id = `RES${String(index).padStart(3, "0")}`;
    special[id] = row(`SELECT ${index} AS VALUE FROM dual`);
    expectedSpecial[id] = { VALUE: String(index) };
  }
  const transaction = {
    insert: command(`INSERT INTO ${TABLE} (id, value) VALUES (${SEQUENCE}.NEXTVAL, 'transaction')`),
    visible: row(`SELECT value AS VALUE FROM ${TABLE} WHERE id <> 999999 ORDER BY id`),
    savepointInsert: command(`INSERT INTO ${TABLE} (id, value) VALUES (${SEQUENCE}.NEXTVAL, 'savepoint')`),
    savepointVisible: row(`SELECT value AS VALUE FROM ${TABLE} WHERE id <> 999999 ORDER BY id`),
  };
  let factoryCalls = 0;
  const prepared = {
    command: (_input: unknown) => { factoryCalls += 1; return command(`INSERT INTO ${TABLE} (id, value) VALUES (${SEQUENCE}.NEXTVAL, 'prepared')`); },
    rows: (_input: unknown) => { factoryCalls += 1; return row("SELECT VALUE FROM (SELECT 'one' AS VALUE FROM dual UNION ALL SELECT 'two' FROM dual) ORDER BY VALUE"); },
    input: "prepared",
    factoryCalls: () => factoryCalls,
  };
  const routines = {
    call: call("BEGIN BRAID_RC3_CERT_NOOP; END;"),
    out: sql.call`BEGIN BRAID_RC3_CERT_SCALAR(${sql.out("answer", oracleParameter.number())}); END;`,
    inout: sql.call`BEGIN BRAID_RC3_CERT_INOUT(${sql.inOut("value", 7, oracleParameter.number())}); END;`,
    resultSets: sql.call`BEGIN BRAID_RC3_CERT_SETS(${sql.out("users", oracleParameter.refCursor())}, ${sql.out("payments", oracleParameter.refCursor())}); END;`,
    cursor: sql.call`BEGIN BRAID_RC3_CERT_CURSOR(${sql.out("cursor", oracleParameter.refCursor())}); END;`,
    returnValue: sql.call({ returnValue: { "~standard": { version: 1, vendor: "sqlbraid-oracle-cert", validate(value: unknown) { return { value }; } } } })`BEGIN BRAID_RC3_CERT_NOOP; END;`,
    lob: sql.call`BEGIN BRAID_RC3_CERT_LOB(${sql.out("payload", oracleParameter.clob())}); END;`,
  };
  const expected: NonNullable<CertificationFixture["queries"]["expected"]> = {
    one: { VALUE: "one" },
    many: [{ VALUE: "one" }, { VALUE: "two" }],
    special: {
      ...expectedSpecial,
      CALL001: { output: {}, resultSets: [] },
      CALL002: { output: { answer: "42" }, resultSets: [] },
      CALL003: { output: { value: "8" }, resultSets: [] },
      CALL004: { output: {}, resultSets: [{ rows: [{ USER_ID: "user-1" }] }, { rows: [{ PAYMENT_ID: "payment-1" }] }, { rows: [{ SUMMARY: "summary-1" }] }] },
      CALL005: { output: {}, resultSets: [{ rows: [{ CURSOR_ID: "cursor-1" }] }] },
    },
    commandAffectedRows: 1,
    failureCode: "ORA-00942",
  };
  return {
    zero: row("SELECT 'zero' AS VALUE FROM dual WHERE 1 = 0"),
    one: row("SELECT 'one' AS VALUE FROM dual"),
    many: row("SELECT VALUE FROM (SELECT 'one' AS VALUE FROM dual UNION ALL SELECT 'two' FROM dual) ORDER BY VALUE"),
    command: command(`INSERT INTO ${TABLE} (id, value) VALUES (${SEQUENCE}.NEXTVAL, 'command')`),
    identity: row("SELECT SYS_CONTEXT('USERENV', 'SID') AS ID FROM dual"),
    failure: row(`SELECT value FROM ${TABLE}_MISSING`),
    stream: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3"),
    special,
    transaction,
    prepared,
    routines,
    fidelity: {
      largeExactInteger: sql.rows`SELECT ${sql.bind(9007199254740993n, oracleParameter.number())} AS "value" FROM dual`,
      exactDecimal: sql.rows`SELECT CAST(${12345.6789} AS NUMBER(20,4)) AS "value" FROM dual`,
      temporal: sql.rows`SELECT CAST(${new Date("2026-09-14T12:34:56.789Z")} AS TIMESTAMP) AS "value" FROM dual`,
      injection: sql.rows`SELECT ${"'; UPDATE BRAID_RC3_CERT_ROWS SET value='hacked' WHERE id=999999; --"} AS "value" FROM dual`,
      expected: {
        largeExactInteger: { value: "9007199254740993" },
        exactDecimal: { value: "12345.6789" },
        temporal: { value: new Date("2026-09-14T12:34:56.789Z") },
        injection: { value: "'; UPDATE BRAID_RC3_CERT_ROWS SET value='hacked' WHERE id=999999; --" },
      },
    },
    expected,
  };
}

interface StreamFaults {
  readonly initFailure: Error;
  readonly firstNextFailure: Error;
  readonly midStreamFailure: Error;
  readonly cleanupFailure: Error;
}

interface StreamCounters {
  iteratorReturns: number;
  released: number;
  resultSetCloses: number;
}

function streamFixture(
  db: Pick<Database, "stream">,
  faults: StreamFaults,
  counters: StreamCounters,
  reuseAfterBreak: () => Promise<void>,
): StreamingConformanceFixture<unknown> {
  const query = row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3");
  const initFailureQuery = row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_INIT_FAILURE */");
  const mappingFailure = new Error("oracle-cert-mapping-failure");
  const executionSchemaFailure = new Error("oracle-cert-execution-schema-failure");
  return {
    db,
    query,
    expected: [{ VALUE: "1" }, { VALUE: "2" }, { VALUE: "3" }],
    mappingQuery: sql.rows({
      "~standard": {
        version: 1,
        vendor: "sqlbraid-oracle-cert",
        validate() { throw mappingFailure; },
      },
    })`SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3`,
    mappingFailure,
    executionSchemaFailure,
    initFailureQuery,
    initFailure: faults.initFailure,
    initFailureCleanup: { iteratorReturns: 1, released: 1 },
    firstNextFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_FIRST_NEXT_FAILURE */"),
    firstNextFailure: faults.firstNextFailure,
    midStreamFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_MID_STREAM_FAILURE */"),
    midStreamFailure: faults.midStreamFailure,
    cleanupFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_CLEANUP_FAILURE */"),
    cleanupFailure: faults.cleanupFailure,
    largeResultQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 10000"),
    largeResultCount: 10000,
    released: () => counters.released,
    iteratorReturns: () => counters.iteratorReturns,
    reuseAfterBreak,
  };
}

function bulkFixture(db: Pick<Database, "bulk" | "all" | "execute">, nativeBulkCalls: () => number): BulkConformanceFixture<unknown> {
  const factory = (input: unknown) => {
    if (typeof input !== "number") throw new TypeError("Oracle bulk certification input must be numeric.");
    return sql.command`INSERT INTO ${sql.ident(BULK_TABLE)} (id, value) VALUES (${sql.bind(input, oracleParameter.number())}, ${sql.bind("bulk", oracleParameter.varchar2())})`;
  };
  const wrappedDb: Pick<Database, "bulk"> = {
    bulk: (inputs, inputFactory) => db.bulk(inputs, inputFactory),
  };
  return {
    db: wrappedDb,
    inputs: [1, 2],
    factory,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: nativeBulkCalls,
    executeCount: nativeBulkCalls,
    middleFailure: async () => {
      let error: unknown;
      try {
        await wrappedDb.bulk([3, 1, 4], factory);
      } catch (caught) {
        error = caught;
      }
      if (error === undefined) throw new Error("Oracle bulk middle failure did not reject.");
      const rows = await db.all<{ readonly id: unknown; readonly value: unknown }>(sql.rows`SELECT id AS "id", value AS "value" FROM ${sql.ident(BULK_TABLE)} WHERE id IN (${sql.bind(3, oracleParameter.number())}, ${sql.bind(4, oracleParameter.number())}) ORDER BY id`);
      await db.execute(sql`DELETE FROM ${sql.ident(BULK_TABLE)} WHERE id = ${sql.bind(3, oracleParameter.number())}`);
      const observedRows = rows.map((row) => ({ id: Number(row.id), value: row.value }));
      return {
        error,
        observedRows,
        expectedRows: [{ id: 3, value: "bulk" }],
        durability: "prefix" as const,
      };
    },
  };
}

export interface OracleCertificationConnectionOptions {
  readonly connectionUri: string;
  readonly user: string;
  readonly password: string;
  readonly sourceSha: string;
  readonly measuredDriverVersion?: string;
}

export async function createOracleOracledbTarget(options: OracleCertificationConnectionOptions): Promise<CertificationTarget & { close(): Promise<void> }> {
  const pool = await oracledb.createPool({ user: options.user, password: options.password, connectString: options.connectionUri, poolMin: 0, poolMax: 4, poolIncrement: 1 }) as unknown as OraclePoolLike & { close(): Promise<void> };
  const target: CertificationTarget & { close(): Promise<void> } = {
    id: "oracle-oracledb-thin-node-23-9",
    sourceSha: options.sourceSha,
    ...(options.measuredDriverVersion === undefined ? {} : { measuredDriverVersion: options.measuredDriverVersion }),
    expectedCapabilities: ORACLE_EXPECTED_CAPABILITIES,
    expectedTransactionOptions: ORACLE_EXPECTED_TRANSACTION_OPTIONS,
    async createFixture(): Promise<CertificationFixture> {
      const connection = await oracledb.getConnection({ user: options.user, password: options.password, connectString: options.connectionUri }) as unknown as OracleConnectionLike;
      await ensureSchema(connection);
      const faults: StreamFaults = {
        initFailure: new Error("oracle-cert-init-failure"),
        firstNextFailure: new Error("oracle-cert-first-next-failure"),
        midStreamFailure: new Error("oracle-cert-mid-stream-failure"),
        cleanupFailure: new Error("oracle-cert-cleanup-failure"),
      };
      const streamCounters: StreamCounters = { iteratorReturns: 0, released: 0, resultSetCloses: 0 };
      let sideEffects = 0;
      let executeStarts = 0;
      let routineLobCloses = 0;
      const instrumentStreamConnection = (candidate: OracleConnectionLike, countSideEffects: boolean, onBreak?: () => void): OracleConnectionLike => {
        const execute = candidate.execute.bind(candidate);
        const breakNative = candidate.break?.bind(candidate);
        let activeOperations = 0;
        const instrumented: OracleConnectionLike = {
          execute: async (text: string, binds?: unknown, executeOptions?: unknown): Promise<unknown> => {
          if (text.includes("CERT_INIT_FAILURE")) throw faults.initFailure;
          if (countSideEffects) sideEffects += 1;
          if (countSideEffects) executeStarts += 1;
          activeOperations += 1;
          let result: OracleExecuteResultLike;
          try {
            result = (executeOptions === undefined
              ? await execute(text, binds)
              : await execute(text, binds, executeOptions)) as OracleExecuteResultLike;
          } finally {
            activeOperations -= 1;
          }
          const wrapLob = (value: unknown): unknown => {
            if (value === null || typeof value !== "object" || typeof (value as { readonly destroy?: unknown }).destroy !== "function") return value;
            const lob = value as { destroy(error?: Error): unknown };
            const destroyNative = lob.destroy.bind(value);
            lob.destroy = (error?: Error): unknown => {
              routineLobCloses += 1;
              return destroyNative(error);
            };
            return value;
          };
          if (result.outBinds !== undefined && result.outBinds !== null && typeof result.outBinds === "object") {
            const outBinds = result.outBinds as Record<string, unknown> | readonly unknown[];
            const wrappedOutBinds = Array.isArray(outBinds)
              ? outBinds.map(wrapLob)
              : Object.fromEntries(Object.entries(outBinds).map(([name, value]) => [name, wrapLob(value)]));
            result = { ...result, outBinds: wrappedOutBinds };
          }
          const native = result.resultSet;
          if (!native) return result;
          const wrapped = Object.create(native) as OracleResultSetLike;
          const closeNative = native.close.bind(native);
          let reads = 0;
          if (native.getRow) {
            wrapped.getRow = async (): Promise<unknown | null | undefined> => {
              reads += 1;
              if (text.includes("CERT_FIRST_NEXT_FAILURE") && reads === 1) throw faults.firstNextFailure;
              if (text.includes("CERT_MID_STREAM_FAILURE") && reads === 2) throw faults.midStreamFailure;
              activeOperations += 1;
              try {
                return await native.getRow!();
              } finally {
                activeOperations -= 1;
              }
            };
          }
          if (native.getRows) {
            wrapped.getRows = async (size?: number): Promise<readonly unknown[]> => {
              reads += 1;
              if (text.includes("CERT_FIRST_NEXT_FAILURE") && reads === 1) throw faults.firstNextFailure;
              if (text.includes("CERT_MID_STREAM_FAILURE") && reads === 2) throw faults.midStreamFailure;
              activeOperations += 1;
              try {
                return await native.getRows!(size);
              } finally {
                activeOperations -= 1;
              }
            };
          }
          wrapped.close = async (): Promise<void> => {
            streamCounters.resultSetCloses += 1;
            await closeNative();
            if (text.includes("CERT_CLEANUP_FAILURE")) throw faults.cleanupFailure;
          };
          return { ...result, resultSet: wrapped };
          },
          ...(candidate.executeMany === undefined ? {} : { executeMany: candidate.executeMany.bind(candidate) }),
          commit: candidate.commit.bind(candidate),
          rollback: candidate.rollback.bind(candidate),
          ...(candidate.stmtCacheSize === undefined ? {} : { stmtCacheSize: candidate.stmtCacheSize }),
          ...(breakNative === undefined ? {} : {
            break: async (): Promise<void> => {
              onBreak?.();
              if (activeOperations > 0) await breakNative();
            },
          }),
          ...(candidate.close === undefined ? {} : { close: candidate.close.bind(candidate) }),
        };
        return instrumented;
      };
      const directConnection = instrumentStreamConnection(connection, true);
      let nativeBulkCalls = 0;
      const nativeExecuteMany = directConnection.executeMany?.bind(directConnection);
      if (nativeExecuteMany) {
        directConnection.executeMany = async (statement: string, binds: unknown, executeOptions?: unknown): Promise<unknown> => {
          nativeBulkCalls += 1;
          return nativeExecuteMany(statement, binds, executeOptions);
        };
      }
      const direct = createOracledbDatabase(directConnection, { streamFetchSize: 2 });
      const nativePool = pool as unknown as { readonly connectionsInUse?: number; readonly connectionsOpen?: number };
      const pooledConnections = (): number => nativePool.connectionsInUse ?? 0;
      let rollbackFailure: Error | undefined;
      let releaseFailure: Error | undefined;
      let forceFaultConnectionCleanup: (() => Promise<void>) | undefined;
      const nativePoolGetConnection = pool.getConnection.bind(pool);
      const poolWithFaults: OraclePoolLike = {
        ...(pool.stmtCacheSize === undefined ? {} : { stmtCacheSize: pool.stmtCacheSize }),
        async getConnection(): Promise<OraclePoolConnectionLike> {
          const nativeConnection = await nativePoolGetConnection();
          let cancellationRequested = false;
          const instrumentedConnection = instrumentStreamConnection(nativeConnection, false, () => {
            cancellationRequested = true;
          });
          const nativeRollback = nativeConnection.rollback.bind(nativeConnection);
          const nativeClose = nativeConnection.close.bind(nativeConnection);
          forceFaultConnectionCleanup = async () => {
            try {
              await nativeRollback();
            } catch {
              // The fault path intentionally rejects rollback; close still releases the lease.
            }
            try {
              await nativeClose();
            } catch {
              // The fault path may reject release after native close has completed.
            }
          };
          return {
            ...instrumentedConnection,
            rollback: async () => {
              if (rollbackFailure) throw rollbackFailure;
              await nativeRollback();
            },
            close: async (closeOptions) => {
              streamCounters.released += 1;
              const effectiveCloseOptions = closeOptions ?? (cancellationRequested ? { drop: true } : undefined);
              const closeNative = effectiveCloseOptions === undefined
                ? (): Promise<void> => Promise.resolve(nativeClose())
                : (): Promise<void> => Promise.resolve(nativeClose(effectiveCloseOptions));
              if (releaseFailure) {
                await closeNative();
                throw releaseFailure;
              }
              await closeNative();
            },
          };
        },
      };
      const baseProvider = createOracledbPoolProvider(poolWithFaults, { streamFetchSize: 2 });
      const pooled = createPooledDatabase({
        ...baseProvider,
        async acquire() {
          const lease = await baseProvider.acquire();
          const stream = lease.stream?.bind(lease);
          if (!stream) return lease;
          return {
            ...lease,
            stream<Row>(rendered: Parameters<NonNullable<typeof lease.stream>>[0], binding: Parameters<NonNullable<typeof lease.stream>>[1], options: Parameters<NonNullable<typeof lease.stream>>[2]) {
              const source = stream(rendered, binding, options);
              const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Row>;
              const wrapped: AsyncIterator<Row> & AsyncIterable<Row> = {
                [Symbol.asyncIterator]() { return this; },
                next(value?: unknown) { return iterator.next(value); },
                return(value?: unknown) {
                  streamCounters.iteratorReturns += 1;
                  return iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value });
                },
                throw(error?: unknown) { return iterator.throw ? iterator.throw(error) : Promise.reject(error); },
              };
              return wrapped;
            },
          };
        },
      });
      const reset = async (): Promise<void> => {
        await exec(connection, `TRUNCATE TABLE ${TABLE}`);
        await exec(connection, `TRUNCATE TABLE ${BULK_TABLE}`);
        await exec(connection, `INSERT INTO ${TABLE} (id, value) VALUES (999999, 'sentinel')`);
        await (connection as OracleConnectionLike & { commit?: () => Promise<void> }).commit?.();
        streamCounters.released = 0;
        streamCounters.iteratorReturns = 0;
        streamCounters.resultSetCloses = 0;
      };
      await reset();
      sideEffects = 0;
      executeStarts = 0;
      const unsupportedTransaction = async (transactionOptions: Parameters<NonNullable<Database["tx"]>>[0]): Promise<void> => {
        const probeConnection = await oracledb.getConnection({ user: options.user, password: options.password, connectString: options.connectionUri }) as unknown as OracleConnectionLike;
        const probeExecute = probeConnection.execute.bind(probeConnection);
        const probeCommit = probeConnection.commit.bind(probeConnection);
        const probeRollback = probeConnection.rollback.bind(probeConnection);
        probeConnection.execute = async (...args: Parameters<OracleConnectionLike["execute"]>) => {
          sideEffects += 1;
          return probeExecute(...args);
        };
        probeConnection.commit = async () => {
          sideEffects += 1;
          await probeCommit();
        };
        probeConnection.rollback = async () => {
          sideEffects += 1;
          await probeRollback();
        };
        try {
          await createOracledbDatabase(probeConnection).tx(transactionOptions, async () => undefined);
        } finally {
          await probeConnection.close?.();
        }
      };
      const unsupported = {
        CALL006: { feature: "routine.return-value", expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED" as const, run: () => direct.call(makeQueries().routines!.returnValue!), sideEffects: () => sideEffects },
        TX020: { feature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "read-uncommitted" }), sideEffects: () => sideEffects },
        TX024: { feature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "repeatable-read" }), sideEffects: () => sideEffects },
        TX022: { feature: "combination:read-committed+readOnly", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "read-committed", readOnly: true }), sideEffects: () => sideEffects },
        TX027: { feature: "combination:read-uncommitted+readOnly", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "read-uncommitted", readOnly: true }), sideEffects: () => sideEffects },
        TX028: { feature: "combination:serializable+readOnly", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "serializable", readOnly: true }), sideEffects: () => sideEffects },
        TX031: { feature: "combination:repeatable-read+readOnly", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "repeatable-read", readOnly: true }), sideEffects: () => sideEffects },
        TX029: { feature: "combination:read-uncommitted+readWrite", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "read-uncommitted", readOnly: false }), sideEffects: () => sideEffects },
        TX032: { feature: "combination:repeatable-read+readWrite", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "repeatable-read", readOnly: false }), sideEffects: () => sideEffects },
        TX030: { feature: "combination:read-committed+readWrite", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "read-committed", readOnly: false }), sideEffects: () => sideEffects },
        TX033: { feature: "combination:serializable+readWrite", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED" as const, run: () => unsupportedTransaction({ isolation: "serializable", readOnly: false }), sideEffects: () => sideEffects },
      };
      const metrics = {
        snapshot: (): ResourceSnapshot => ({ borrowedLeases: pooledConnections(), cleanupBalance: pooledConnections() }),
        sideEffects: () => sideEffects,
        mutationSentinel: async (): Promise<unknown> => direct.one(row(`SELECT value AS VALUE FROM ${TABLE} WHERE id = 999999`)),
        transactionCleanup: async (): Promise<void> => {
          const rollbackError = new Error("oracle-cert-rollback-failure");
          const releaseError = new Error("oracle-cert-release-failure");
          const primary = new Error("oracle-cert-transaction-primary");
          rollbackFailure = rollbackError;
          releaseFailure = releaseError;
          let error: unknown;
          try {
            await pooled.tx(async () => { throw primary; });
          } catch (caught) {
            error = caught;
          } finally {
            rollbackFailure = undefined;
            releaseFailure = undefined;
            const observedLeases = pooledConnections();
            try {
              assert.equal(observedLeases, 0);
            } finally {
              try {
                await forceFaultConnectionCleanup?.();
              } finally {
                forceFaultConnectionCleanup = undefined;
              }
            }
          }
          assert.ok(error instanceof AggregateError);
          const nested = (value: unknown): readonly unknown[] => value instanceof AggregateError
            ? value.errors.flatMap((entry) => [entry, ...nested(entry)])
            : [];
          const errors = [error, ...nested(error)];
          assert.ok(errors.includes(primary));
          assert.ok(errors.includes(rollbackError));
          assert.ok(errors.includes(releaseError));
          await direct.one(makeQueries().identity);
        },
        readOnlyWrite: async (): Promise<void> => {
          const before = await direct.one(row(`SELECT COUNT(*) AS VALUE FROM ${TABLE} WHERE id = 999998`));
          await pooled.tx({ readOnly: false }, (tx) => tx.execute(command(`INSERT INTO ${TABLE} (id, value) VALUES (999998, 'rw')`)));
          await assert.rejects(
            () => pooled.tx({ readOnly: true }, (tx) => tx.execute(command(`INSERT INTO ${TABLE} (id, value) VALUES (999997, 'ro')`))),
          );
          const after = await direct.one(row(`SELECT COUNT(*) AS VALUE FROM ${TABLE} WHERE id = 999998`));
          assert.equal(Number((after as { readonly VALUE: number | string }).VALUE), Number((before as { readonly VALUE: number | string }).VALUE) + 1);
          const rejected = await direct.one(row(`SELECT COUNT(*) AS VALUE FROM ${TABLE} WHERE id = 999997`));
          assert.equal(Number((rejected as { readonly VALUE: number | string }).VALUE), 0);
          await direct.execute(command(`DELETE FROM ${TABLE} WHERE id IN (999998, 999997)`));
        },
        pooledScope: async (): Promise<void> => {
          await pooled.session(async (session) => {
            await session.one(makeQueries().identity);
            if (pooledConnections() < 1) throw new Error("Oracle pooled session did not borrow a native connection.");
          });
          if (pooledConnections() !== 0) throw new Error("Oracle pooled session leaked its native connection.");
        },
        routineCleanup: async (query = makeQueries().routines!.lob): Promise<void> => {
          if (!query) throw new Error("Oracle routine LOB query missing.");
          const beforeLobCloses = routineLobCloses;
          const result = await direct.call(query);
          const payload = result.output.payload;
          assert.equal(typeof payload, "string");
          assert.equal((payload as string).length, 4096);
          assert.equal(routineLobCloses, beforeLobCloses + 1);
          const nativeResult = await directConnection.execute(
            "BEGIN BRAID_RC3_CERT_LOB(:payload); END;",
            { payload: { dir: oracledb.BIND_OUT, type: oracledb.CLOB } },
          ) as OracleExecuteResultLike;
          const lob = (nativeResult.outBinds as { readonly payload?: unknown } | undefined)?.payload as {
            destroy?: () => unknown;
            once?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown;
            removeListener?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown;
          } | undefined;
          if (lob === undefined || typeof lob.destroy !== "function" || typeof lob.once !== "function") throw new Error("Oracle native LOB resource missing.");
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onError = (error: unknown): void => {
              if (settled) return;
              settled = true;
              lob.removeListener?.("close", onClose);
              reject(error);
            };
            const onClose = (): void => {
              if (settled) return;
              settled = true;
              lob.removeListener?.("error", onError);
              resolve();
            };
            lob.once!("error", onError);
            lob.once!("close", onClose);
            try {
              lob.destroy!();
            } catch (error) {
              onError(error);
            }
          });
          assert.equal(routineLobCloses, beforeLobCloses + 2);
          await direct.one(makeQueries().identity);
        },
      };
      return {
        db: direct,
        pooled,
        queries: makeQueries(),
        stream: streamFixture(pooled, faults, streamCounters, async () => { await pooled.one(makeQueries().identity); }),
        bulk: bulkFixture(direct, () => nativeBulkCalls),
        metrics,
        reset,
        unsupported,
        representationUnsupported: {
          "numeric.exact-integer": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT CAST(9007199254740991 AS NUMBER(19,0)) AS "value" FROM dual`));
              if (typeof result.value !== "string") throw new Error("Oracle exact integer did not expose its string representation.");
            },
          },
          "numeric.bind-exact": {
            prove: async () => {
              const result = await direct.one(sql.rows<{ readonly value: unknown }>`SELECT CAST(${sql.bind("12.34", oracleParameter.varchar2())} AS NUMBER(10,2)) AS "value" FROM dual`);
              if (typeof result.value !== "string") throw new Error("Oracle exact bind representation changed.");
            },
          },
          "data.json-lossless-text": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT JSON_OBJECT('ok' VALUE 1 RETURNING VARCHAR2(100)) AS "value" FROM dual`));
              if (typeof result.value !== "string") throw new Error("Oracle JSON lossless text proof did not return serialized JSON.");
            },
          },
          "data.oracle-object": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT SYS.ANYDATA.ConvertNumber(1) AS "value" FROM dual`));
              if (result.value === null || typeof result.value !== "object") throw new Error("Oracle object proof did not return a native object.");
            },
          },
          "data.oracle-collection": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT SYS.ODCINUMBERLIST(1, 2) AS "value" FROM dual`));
              if (result.value === null || typeof result.value !== "object") throw new Error("Oracle collection proof did not return a native collection.");
            },
          },
          "data.vector": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT TO_VECTOR('[1,2]') AS "value" FROM dual`));
              if (result.value === null || typeof result.value !== "object") throw new Error("Oracle vector proof did not return a native vector.");
            },
          },
          "data.temporal-lossless": {
            prove: async () => {
              const result = await direct.one(row<{ readonly value: unknown }>(`SELECT CAST(TIMESTAMP '2026-09-14 12:34:56.789123' AS TIMESTAMP) AS "value" FROM dual`));
              if (!(result.value instanceof Date) || result.value.getUTCMilliseconds() !== 789) throw new Error("Oracle temporal result did not expose the declared precision loss.");
            },
          },
        },
        guarded: {
          "statement.cancel": {
            prove: async () => {
              const controller = new AbortController();
              const reason = new Error("oracle-cert-cancel");
              const beforeStarts = executeStarts;
              const pending = direct.execute(command("BEGIN DBMS_SESSION.SLEEP(60); END;"), { signal: controller.signal });
              await new Promise((resolve) => setTimeout(resolve, 50));
              assert.ok(executeStarts > beforeStarts, "Oracle cancellation query did not start.");
              controller.abort(reason);
              await assert.rejects(pending, (error: unknown) => {
                const nested = (value: unknown): readonly unknown[] => value instanceof AggregateError
                  ? value.errors.flatMap((entry) => [entry, ...nested(entry)])
                  : [];
                return error === reason || error instanceof AggregateError && [error, ...nested(error)].includes(reason)
                  || error instanceof Error && error.cause === reason;
              });
              await direct.one(row("SELECT 1 AS VALUE FROM dual"));
            },
          },
          "data.temporal-native": {
            prove: async () => {
              const result = await direct.one(row("SELECT CAST(TIMESTAMP '2026-09-14 12:34:56.789' AS TIMESTAMP) AS VALUE FROM dual"));
              if (!((result as { readonly VALUE?: unknown }).VALUE instanceof Date)) throw new Error("Oracle temporal native guard did not return Date.");
            },
          },
          "metadata.command-safe": {
            prove: async () => {
              const result = await direct.execute(command(`INSERT INTO ${BULK_TABLE} (id, value) VALUES (999999, 'metadata')`));
              if ((result as { readonly command: { readonly affectedRows: number } }).command.affectedRows !== 1) throw new Error("Oracle command metadata guard failed.");
              await direct.execute(command(`DELETE FROM ${BULK_TABLE} WHERE id = 999999`));
            },
          },
        },
        close: async () => { await connection.close?.(); },
      };
    },
    close: async () => { await pool.close(); },
  };
  return target;
}
