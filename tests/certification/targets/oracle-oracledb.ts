import oracledb from "oracledb";
import assert from "node:assert/strict";
import { createOracledbDatabase, createOracledbPoolDatabase, type OracleConnectionLike, type OracleExecuteResultLike, type OraclePoolLike, type OracleResultSetLike } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
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
    visible: row(`SELECT value AS VALUE FROM ${TABLE} ORDER BY id`),
    savepointInsert: command(`INSERT INTO ${TABLE} (id, value) VALUES (${SEQUENCE}.NEXTVAL, 'savepoint')`),
    savepointVisible: row(`SELECT value AS VALUE FROM ${TABLE} ORDER BY id`),
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
      largeExactInteger: row("SELECT TO_CHAR(CAST(9007199254740991 AS NUMBER(38,0))) AS VALUE FROM dual"),
      exactDecimal: row("SELECT TO_CHAR(CAST(12345678901234567890.123456789 AS NUMBER(38,9))) AS VALUE FROM dual"),
      temporal: row("SELECT TO_CHAR(TIMESTAMP '2026-09-14 12:34:56.789', 'YYYY-MM-DD HH24:MI:SS.FF3') AS VALUE FROM dual"),
      injection: row("SELECT '''; SELECT 1; --' AS VALUE FROM dual"),
      expected: {
        largeExactInteger: { VALUE: "9007199254740991" },
        exactDecimal: { VALUE: "12345678901234567890.123456789" },
        temporal: { VALUE: "2026-09-14 12:34:56.789" },
        injection: { VALUE: "'; SELECT 1; --" },
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

function streamFixture(db: Pick<Database, "stream">, faults: StreamFaults): StreamingConformanceFixture<unknown> {
  const query = row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3");
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
    initFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_INIT_FAILURE */"),
    initFailure: faults.initFailure,
    firstNextFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_FIRST_NEXT_FAILURE */"),
    firstNextFailure: faults.firstNextFailure,
    midStreamFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_MID_STREAM_FAILURE */"),
    midStreamFailure: faults.midStreamFailure,
    cleanupFailureQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3 /* CERT_CLEANUP_FAILURE */"),
    cleanupFailure: faults.cleanupFailure,
    largeResultQuery: row("SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 10000"),
    largeResultCount: 10000,
  };
}

function bulkFixture(db: Pick<Database, "bulk">): BulkConformanceFixture<unknown> {
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
    middleFailure: () => wrappedDb.bulk([3, "bad"], factory),
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
      const execute = connection.execute.bind(connection);
      connection.execute = async (text: string, binds?: unknown, executeOptions?: unknown): Promise<unknown> => {
        if (text.includes("CERT_INIT_FAILURE")) throw faults.initFailure;
        const result = (executeOptions === undefined
          ? await execute(text, binds)
          : await execute(text, binds, executeOptions)) as OracleExecuteResultLike;
        const native = result.resultSet;
        if (!native || typeof native.getRows !== "function") return result;
        const wrapped = Object.create(native) as OracleResultSetLike;
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
        if (text.includes("CERT_CLEANUP_FAILURE")) {
          wrapped.close = async (): Promise<void> => {
            await native.close();
            throw faults.cleanupFailure;
          };
        }
        return { ...result, resultSet: wrapped };
      };
      const direct = createOracledbDatabase(connection, { streamFetchSize: 2 });
      const pooled = createOracledbPoolDatabase(pool, { streamFetchSize: 2 });
      const nativePool = pool as unknown as { readonly connectionsInUse?: number; readonly connectionsOpen?: number };
      const pooledConnections = (): number => nativePool.connectionsInUse ?? 0;
      let sideEffects = 0;
      const reset = async (): Promise<void> => {
        await exec(connection, `TRUNCATE TABLE ${TABLE}`);
        await exec(connection, `TRUNCATE TABLE ${BULK_TABLE}`);
      };
      await reset();
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
        pooledScope: async (): Promise<void> => {
          await pooled.session(async (session) => {
            await session.one(makeQueries().identity);
            if (pooledConnections() < 1) throw new Error("Oracle pooled session did not borrow a native connection.");
          });
          if (pooledConnections() !== 0) throw new Error("Oracle pooled session leaked its native connection.");
        },
        routineCleanup: async (): Promise<void> => {
          await direct.call(makeQueries().routines!.call);
          await direct.one(makeQueries().identity);
        },
      };
      return {
        db: direct,
        pooled,
        queries: makeQueries(),
        stream: streamFixture(direct, faults),
        bulk: bulkFixture(direct),
        metrics,
        reset,
        unsupported,
        guarded: {
          "statement.cancel": {
            prove: async () => {
              const controller = new AbortController();
              const pending = direct.execute(command("BEGIN DBMS_SESSION.SLEEP(60); END;"), { signal: controller.signal });
              await new Promise((resolve) => setTimeout(resolve, 50));
              controller.abort(new Error("oracle-cert-cancel"));
              let rejected = false;
              try {
                await pending;
              } catch {
                rejected = true;
              }
              assert.equal(rejected, true, "Oracle cancellation must reject the in-flight operation.");
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
              sideEffects += 1;
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
