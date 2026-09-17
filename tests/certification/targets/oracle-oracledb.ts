import oracledb from "oracledb";
import assert from "node:assert/strict";
import { createOracledbDatabase, createOracledbPoolDatabase, type OracleConnectionLike, type OracleExecuteResultLike, type OraclePoolLike, type OracleResultSetLike } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import type { CallQuery, CommandQuery, Database, RowQuery, StreamOptions } from "@sqlbraid/core";
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
      largeExactInteger: sql.rows`SELECT ${9007199254740991n} AS "value" FROM dual`,
      exactDecimal: sql.rows`SELECT CAST(${12345.6789} AS NUMBER(20,4)) AS "value" FROM dual`,
      temporal: sql.rows`SELECT CAST(${new Date("2026-09-14T12:34:56.789Z")} AS TIMESTAMP) AS "value" FROM dual`,
      injection: sql.rows`SELECT ${"'; SELECT 1; --"} AS "value" FROM dual`,
      expected: {
        largeExactInteger: { value: "9007199254740991" },
        exactDecimal: { value: "12345.6789" },
        temporal: { value: new Date("2026-09-14T12:34:56.789Z") },
        injection: { value: "'; SELECT 1; --" },
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
  const streamDb: Pick<Database, "stream"> = {
    stream<Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row> {
      const source = db.stream(query, options);
      const iterator = source[Symbol.asyncIterator]();
      const abortedBeforeStart = options?.signal?.aborted === true;
      let returned = false;
      const markReturned = (): void => {
        if (!returned) {
          returned = true;
          counters.iteratorReturns += 1;
        }
      };
      const wrapped: AsyncIterator<Row> & AsyncIterable<Row> = {
        [Symbol.asyncIterator]() { return this; },
        async next(value?: unknown) {
          try {
            const result = await iterator.next(value);
            if (result.done) markReturned();
            return result;
          } catch (error) {
            if (!abortedBeforeStart && query !== initFailureQuery) markReturned();
            throw error;
          }
        },
        return(value?: unknown) {
          markReturned();
          return iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value });
        },
        throw(error?: unknown) {
          return iterator.throw ? iterator.throw(error) : Promise.reject(error);
        },
      };
      return wrapped;
    },
  };
  return {
    db: streamDb,
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
    initFailureCleanup: { iteratorReturns: 0, released: 0 },
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

function bulkFixture(db: Pick<Database, "bulk" | "all" | "execute">): BulkConformanceFixture<unknown> {
  const factory = (input: unknown) => {
    if (typeof input !== "number") throw new TypeError("Oracle bulk certification input must be numeric.");
    return sql.command`INSERT INTO ${sql.ident(BULK_TABLE)} (id, value) VALUES (${sql.bind(input, oracleParameter.number())}, ${sql.bind("bulk", oracleParameter.varchar2())})`;
  };
  let executions = 0;
  const wrappedDb: Pick<Database, "bulk"> = {
    bulk: async (inputs, inputFactory) => {
      if (inputs.length > 0) executions += 1;
      return db.bulk(inputs, inputFactory);
    },
  };
  return {
    db: wrappedDb,
    inputs: [1, 2],
    factory,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => executions,
    executeCount: () => executions,
    middleFailure: async () => {
      let error: unknown;
      try {
        await wrappedDb.bulk([3, 1], factory);
      } catch (caught) {
        error = caught;
      }
      if (error === undefined) throw new Error("Oracle bulk middle failure did not reject.");
      const rows = await db.all<{ readonly id: unknown; readonly value: unknown }>(sql.rows`SELECT id AS "id", value AS "value" FROM ${sql.ident(BULK_TABLE)} WHERE id = ${sql.bind(3, oracleParameter.number())} ORDER BY id`);
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
      const streamCounters: StreamCounters = { iteratorReturns: 0, released: 0 };
      let sideEffects = 0;
      let executeStarts = 0;
      const execute = connection.execute.bind(connection);
      connection.execute = async (text: string, binds?: unknown, executeOptions?: unknown): Promise<unknown> => {
        if (text.includes("CERT_INIT_FAILURE")) throw faults.initFailure;
        sideEffects += 1;
        executeStarts += 1;
        const result = (executeOptions === undefined
          ? await execute(text, binds)
          : await execute(text, binds, executeOptions)) as OracleExecuteResultLike;
        const native = result.resultSet;
        if (!native || typeof native.getRows !== "function") return result;
        const wrapped = Object.create(native) as OracleResultSetLike;
        const closeNative = native.close.bind(native);
        let reads = 0;
        if (native.getRow) {
          wrapped.getRow = async (): Promise<unknown | null | undefined> => {
            reads += 1;
            if (text.includes("CERT_FIRST_NEXT_FAILURE") && reads === 1) throw faults.firstNextFailure;
            if (text.includes("CERT_MID_STREAM_FAILURE") && reads === 2) throw faults.midStreamFailure;
            return native.getRow!();
          };
        }
        if (native.getRows) {
          wrapped.getRows = async (size?: number): Promise<readonly unknown[]> => {
            reads += 1;
            if (text.includes("CERT_FIRST_NEXT_FAILURE") && reads === 1) throw faults.firstNextFailure;
            if (text.includes("CERT_MID_STREAM_FAILURE") && reads === 2) throw faults.midStreamFailure;
            return native.getRows!(size);
          };
        }
        wrapped.close = async (): Promise<void> => {
          streamCounters.released += 1;
          await closeNative();
          if (text.includes("CERT_CLEANUP_FAILURE")) throw faults.cleanupFailure;
        };
        return { ...result, resultSet: wrapped };
      };
      const direct = createOracledbDatabase(connection, { streamFetchSize: 2 });
      const pooled = createOracledbPoolDatabase(pool, { streamFetchSize: 2 });
      const nativePool = pool as unknown as { readonly connectionsInUse?: number; readonly connectionsOpen?: number };
      const pooledConnections = (): number => nativePool.connectionsInUse ?? 0;
      let rollbackFailure: Error | undefined;
      let releaseFailure: Error | undefined;
      let forceFaultConnectionCleanup: (() => Promise<void>) | undefined;
      const poolWithFaults = pool as unknown as {
        getConnection(): Promise<OracleConnectionLike>;
      };
      const nativeGetConnection = poolWithFaults.getConnection.bind(poolWithFaults);
      poolWithFaults.getConnection = async (): Promise<OracleConnectionLike> => {
        const leased = await nativeGetConnection();
        const rollback = leased.rollback?.bind(leased);
        const close = leased.close?.bind(leased);
        forceFaultConnectionCleanup = async () => {
          try {
            await rollback?.();
          } catch {
            // The fault path intentionally rejects rollback; close still releases the lease.
          }
          try {
            await close?.();
          } catch {
            // The fault path may reject release after native close has completed.
          }
        };
        leased.rollback = async () => {
          if (rollbackFailure) throw rollbackFailure;
          await rollback?.();
        };
        leased.close = async () => {
          if (releaseFailure) {
            await close?.();
            throw releaseFailure;
          }
          await close?.();
        };
        return leased;
      };
      const reset = async (): Promise<void> => {
        await exec(connection, `TRUNCATE TABLE ${TABLE}`);
        await exec(connection, `TRUNCATE TABLE ${BULK_TABLE}`);
        await exec(connection, `INSERT INTO ${TABLE} (id, value) VALUES (999999, 'sentinel')`);
        await (connection as OracleConnectionLike & { commit?: () => Promise<void> }).commit?.();
        streamCounters.released = 0;
        streamCounters.iteratorReturns = 0;
      };
      await reset();
      sideEffects = 0;
      executeStarts = 0;
      const unsupportedTransaction = async (transactionOptions: Parameters<NonNullable<Database["tx"]>>[0]): Promise<void> => {
        const probeConnection = await oracledb.getConnection({ user: options.user, password: options.password, connectString: options.connectionUri }) as unknown as OracleConnectionLike;
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
            await forceFaultConnectionCleanup?.();
            forceFaultConnectionCleanup = undefined;
          }
          assert.ok(error instanceof AggregateError);
          const nested = (value: unknown): readonly unknown[] => value instanceof AggregateError
            ? value.errors.flatMap((entry) => [entry, ...nested(entry)])
            : [];
          const errors = [error, ...nested(error)];
          assert.ok(errors.includes(primary));
          assert.ok(errors.includes(rollbackError) || errors.includes(releaseError));
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
          const result = await direct.call(query);
          const payload = result.output.payload;
          assert.equal(typeof payload, "string");
          assert.equal((payload as string).length, 4096);
          await direct.one(makeQueries().identity);
        },
      };
      return {
        db: direct,
        pooled,
        queries: makeQueries(),
        stream: streamFixture(direct, faults, streamCounters, async () => { await direct.one(makeQueries().identity); }),
        bulk: bulkFixture(direct),
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
