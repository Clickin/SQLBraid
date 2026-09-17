import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CallQuery, CommandQuery, Database, RowQuery } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationCaseId, CertificationFixture, CertificationQueries, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey, UnsupportedProbe } from "../types.js";

type BulkStats = { ready: number; result: number };
type AnyRowQuery = RowQuery<unknown>;

type StandardSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: unknown };
  };
};

const schema: StandardSchema = {
  "~standard": {
    version: 1,
    vendor: "sqlbraid-sqlite-certification",
    validate(value) { return { value }; },
  },
};

const transactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported",
  "isolation:read-committed": "unsupported",
  "isolation:repeatable-read": "unsupported",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "guaranteed",
};

export function sqliteTransactionOptions(): typeof transactionOptions {
  return {
    ...transactionOptions,
    "readOnly:false": "unsupported",
    "combination:serializable+readWrite": "unsupported",
  };
}

export function libsqlTransactionOptions(): typeof transactionOptions {
  return {
    ...transactionOptions,
    "readOnly:false": "guaranteed",
    "isolation:serializable": "unsupported",
    "combination:serializable+readWrite": "unsupported",
  };
}

function unsupportedCapabilities(stream: boolean, session: boolean, localReadOnly: boolean): ExpectedCapabilityContract {
  const unsupported = (unsupportedCode: `BRAID_${string}`): { status: "unsupported"; unsupportedCode: `BRAID_${string}` } => ({ status: "unsupported", unsupportedCode });
  return {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": { status: "guaranteed", canonical: "string", rawRepresentations: ["string", "number", "bigint"] },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Uint8Array", "ArrayBuffer"] },
    "session.pinned": session ? { status: "guaranteed" } : unsupported("BRAID_SESSION_UNSUPPORTED"),
    "transaction": { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": localReadOnly
      ? { status: "unsupported", conditionCode: "libsql.file-read-only-not-enforced", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" }
      : unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.read-uncommitted": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.read-committed": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.repeatable-read": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.serializable": localReadOnly ? unsupported("BRAID_TX_OPTION_UNSUPPORTED") : { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": unsupported("BRAID_CANCEL_UNSUPPORTED"),
    "statement.stream": stream ? { status: "guaranteed" } : unsupported("BRAID_STREAM_UNSUPPORTED"),
    "statement.bulk": { status: "guaranteed" },
    "routine.call": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.out": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
    "routine.inout": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
    "routine.return-value": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.result-sets": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.out-cursor": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
  };
}

export function sqliteCapabilities(): ExpectedCapabilityContract {
  return unsupportedCapabilities(true, true, false);
}

export function libsqlCapabilities(): ExpectedCapabilityContract {
  return {
    ...unsupportedCapabilities(false, false, true),
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["ArrayBuffer", "Uint8Array"] },
    "session.pinned": { status: "unsupported", conditionCode: "libsql.client-no-session-pinning", unsupportedCode: "BRAID_SESSION_UNSUPPORTED" },
  };
}

function expectedSpecialRow(label: string, value: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  Object.defineProperty(row, label, { value, enumerable: true, writable: true, configurable: true });
  return row;
}

function queryFixtures(failureCode: string): CertificationQueries {
  const specialValues = {
    RES001: "safe",
    RES002: "safe",
    RES003: "safe",
    RES004: "safe",
    RES005: "safe",
    RES006: "hello",
    RES007: "",
    RES008: null,
    RES009: "안녕하세요",
    RES010: Uint8Array.from([0, 255, 16]),
    RES011: "second",
  } as const;
  const special = {
    RES001: sql.rows`SELECT 'safe' AS "__proto__"`,
    RES002: sql.rows`SELECT 'safe' AS "constructor"`,
    RES003: sql.rows`SELECT 'safe' AS "prototype"`,
    RES004: sql.rows`SELECT 'safe' AS "toString"`,
    RES005: sql.rows`SELECT 'safe' AS "hasOwnProperty"`,
    RES006: sql.rows`SELECT 'hello' AS value`,
    RES007: sql.rows`SELECT '' AS value`,
    RES008: sql.rows`SELECT NULL AS value`,
    RES009: sql.rows`SELECT '안녕하세요' AS value`,
    RES010: sql.rows`SELECT ${specialValues.RES010} AS value`,
    RES011: sql.rows`SELECT 'second' AS value`,
  };
  const command: CommandQuery = sql.command`INSERT INTO cert_items (value) VALUES ('command')`;
  const insert: CommandQuery = sql.command`INSERT INTO cert_items (value) VALUES ('transaction')`;
  const savepointInsert: CommandQuery = sql.command`INSERT INTO cert_items (value) VALUES ('savepoint')`;
  const failure: RowQuery<unknown> = sql.rows`SELECT * FROM cert_missing_table`;
  const identity = sql.rows<{ readonly id: string }>`SELECT 'sqlite-certification-session' AS id`;
  const many = sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const one = sql.rows`SELECT 'one' AS value`;
  return {
    zero: sql.rows`SELECT 'zero' AS value WHERE 0`,
    one,
    many,
    command,
    identity,
    failure,
    stream: one,
    special,
    transaction: {
      insert,
      visible: sql.rows`SELECT value FROM cert_items ORDER BY rowid`,
      savepointInsert,
      savepointVisible: sql.rows`SELECT value FROM cert_items ORDER BY rowid`,
    },
    expected: {
      one: { value: "one" },
      many: [{ value: "1" }, { value: "2" }],
      special: {
        RES006: { value: specialValues.RES006 },
        RES007: { value: specialValues.RES007 },
        RES008: { value: specialValues.RES008 },
        RES009: { value: specialValues.RES009 },
        RES010: { value: specialValues.RES010 },
        RES001: expectedSpecialRow("__proto__", specialValues.RES001),
        RES002: expectedSpecialRow("constructor", specialValues.RES002),
        RES003: expectedSpecialRow("prototype", specialValues.RES003),
        RES004: expectedSpecialRow("toString", specialValues.RES004),
        RES005: expectedSpecialRow("hasOwnProperty", specialValues.RES005),
        RES011: { value: specialValues.RES011 },
      },
      commandAffectedRows: 1,
      failureCode,
    },
  };
}

function makeUnsupported(db: Database, queries: CertificationQueries, targetKind: "sqlite" | "libsql"): Partial<Record<CertificationCaseId, UnsupportedProbe>> {
  const noSideEffects = () => 0;
  const call = sql.call`SELECT 1`;
  const out = sql.rows`SELECT ${sql.out("answer")}`;
  const inout = sql.call`SELECT ${sql.inOut("answer", 1, { databaseType: "INTEGER" })}`;
  const resultSets = sql.call({ resultSets: [schema] })`SELECT 1`;
  const returnValue = sql.call({ returnValue: schema })`SELECT 1`;
  const cursor = sql.rows`SELECT ${sql.out("cursor")}`;
  const runStream = async () => { for await (const row of db.stream(queries.one)) void row; };
  const runCall = async (query: CallQuery) => { await db.call(query); };
  const runRows = async (query: AnyRowQuery) => { await db.all(query); };
  const probes = {
    ...(targetKind === "libsql" ? {
      SES001: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      SES002: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      SES003: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      SES004: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      SES005: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      STRESS006: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects: noSideEffects },
      PRE003: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      PRE004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      PRE005: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR001: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR002: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR003: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR005: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR007: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR008: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STR009: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
      STRESS004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects: noSideEffects },
    } : {}),
    STR006: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: () => db.execute(queries.one, { signal: new AbortController().signal }), sideEffects: noSideEffects },
    TX020: { feature: "transaction.isolation.read-uncommitted", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted" }, async () => undefined), sideEffects: noSideEffects },
    TX021: { feature: "transaction.read-only", expectedErrorFeature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ readOnly: true }, async () => undefined), sideEffects: noSideEffects },
    TX022: { feature: "combination:read-committed+readOnly", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed", readOnly: true }, async () => undefined), sideEffects: noSideEffects },
    TX023: { feature: "transaction.isolation.read-committed", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed" }, async () => undefined), sideEffects: noSideEffects },
    TX024: { feature: "transaction.isolation.repeatable-read", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read" }, async () => undefined), sideEffects: noSideEffects },
    TX025: targetKind === "libsql"
      ? { feature: "transaction.isolation.serializable", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable" }, async () => undefined), sideEffects: noSideEffects }
      : undefined,
    TX026: targetKind === "sqlite"
      ? { feature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ readOnly: false }, async () => undefined), sideEffects: noSideEffects }
      : undefined,
    TX027: { feature: "combination:read-uncommitted+readOnly", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted", readOnly: true }, async () => undefined), sideEffects: noSideEffects },
    TX028: { feature: "combination:serializable+readOnly", expectedErrorFeature: targetKind === "sqlite" ? "transaction.read-only" : "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: true }, async () => undefined), sideEffects: noSideEffects },
    TX029: { feature: "combination:read-uncommitted+readWrite", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted", readOnly: false }, async () => undefined), sideEffects: noSideEffects },
    TX030: { feature: "combination:read-committed+readWrite", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed", readOnly: false }, async () => undefined), sideEffects: noSideEffects },
    TX031: { feature: "combination:repeatable-read+readOnly", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read", readOnly: true }, async () => undefined), sideEffects: noSideEffects },
    TX032: { feature: "combination:repeatable-read+readWrite", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read", readOnly: false }, async () => undefined), sideEffects: noSideEffects },
    TX033: targetKind === "sqlite"
      ? { feature: "combination:serializable+readWrite", expectedErrorFeature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: false }, async () => undefined), sideEffects: noSideEffects }
      : { feature: "combination:serializable+readWrite", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: false }, async () => undefined), sideEffects: noSideEffects },
    CALL001: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(call), sideEffects: noSideEffects },
    CALL002: { feature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => runRows(out), sideEffects: noSideEffects },
    CALL003: { feature: "routine.inout", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(inout), sideEffects: noSideEffects },
    CALL004: { feature: "routine.result-sets", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(resultSets), sideEffects: noSideEffects },
    CALL005: { feature: "routine.out-cursor", expectedErrorFeature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => runRows(cursor), sideEffects: noSideEffects },
    CALL006: { feature: "routine.return-value", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(returnValue), sideEffects: noSideEffects },
  };
  return Object.fromEntries(Object.entries(probes).filter(([, probe]) => probe !== undefined)) as Partial<Record<CertificationCaseId, UnsupportedProbe>>;
}

export interface SqliteFixtureOptions {
  readonly db: Database;
  readonly close: () => Promise<void>;
  readonly physicalSessionId: string;
  readonly capabilities: ExpectedCapabilityContract;
  readonly expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">>;
  readonly streamSupported: boolean;
  readonly sessionSupported: boolean;
  readonly localReadOnly: boolean;
  readonly failureCode: string;
  readonly streamFailureCode: string;
  readonly stats: BulkStats;
}

export function createSqliteFixture(options: SqliteFixtureOptions): CertificationFixture {
  type MutableQueries = Omit<CertificationQueries, "prepared"> & {
    prepared: NonNullable<CertificationQueries["prepared"]>;
  };
  const queries = { ...queryFixtures(options.failureCode), prepared: undefined } as unknown as MutableQueries;
  const streamQuery = sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const mappingFailure = new Error("cert-stream-mapper-failure");
  const mappingQuery = sql.rows({
    "~standard": {
      version: 1,
      vendor: "sqlbraid-certification",
      validate() {
        throw mappingFailure;
      },
    },
  })`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const stream: StreamingConformanceFixture<unknown> | undefined = options.streamSupported
    ? {
      db: options.db,
      query: streamQuery,
      expected: [{ value: "1" }, { value: "2" }],
      mappingQuery,
      mappingFailure,
      executionSchemaFailure: new Error("cert-stream-execution-schema-failure"),
      initFailureQuery: sql.rows`SELECT * FROM cert_missing_table`,
      initFailure: { code: options.streamFailureCode },
      firstNextFailureQuery: sql.rows`SELECT json_extract('{', '$') AS value`,
      firstNextFailure: { code: options.streamFailureCode },
      midStreamFailureQuery: sql.rows`SELECT json_extract(CASE value WHEN 1 THEN '{}' ELSE '{' END, '$') AS value FROM (SELECT 1 AS value UNION ALL SELECT 2 AS value)`,
      midStreamFailure: { code: options.streamFailureCode },
      cleanupFailureQuery: sql.rows`SELECT json_extract('{', '$') AS value`,
      cleanupFailure: { code: options.streamFailureCode },
      largeResultQuery: sql.rows`WITH RECURSIVE cert_numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM cert_numbers WHERE value < 20) SELECT CAST(value AS TEXT) AS value FROM cert_numbers`,
      largeResultCount: 20,
    }
    : undefined;
  const bulkFactory = (input: unknown): CommandQuery => sql.command`INSERT INTO cert_items (value) VALUES (${input})`;
  const bulkFailure: CommandQuery = sql.command`INSERT INTO cert_missing_table (value) VALUES ('bulk-failure')`;
  const bulk: BulkConformanceFixture<unknown> = {
    db: options.db,
    inputs: [1, 2],
    factory: (input) => bulkFactory(input),
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => options.stats.ready,
    executeCount: () => options.stats.result,
    middleFailure: async () => options.db.bulk([1, 2], (input) => input === 2 ? bulkFailure : bulkFactory(input)),
  };
  const preparedCalls = { count: 0 };
  queries.prepared = {
    command: () => { preparedCalls.count += 1; return bulkFactory("prepared"); },
    rows: () => { preparedCalls.count += 1; return queries.many; },
    input: "input",
    factoryCalls: () => preparedCalls.count,
  };
  const metrics = {
    snapshot: (): ResourceSnapshot => ({ borrowedLeases: 0, cleanupBalance: 0, openCursors: 0, openPrepared: 0 }),
    ...(options.sessionSupported ? { physicalSessionIds: () => [options.physicalSessionId] } : {}),
  };
  const unsupported = makeUnsupported(options.db, queries, options.localReadOnly ? "libsql" : "sqlite");
  return {
    db: options.db,
    queries,
    stream,
    bulk,
    metrics,
    reset: async () => { await options.db.execute(sql.command`DELETE FROM cert_items`); },
    unsupported,
    close: options.close,
  };
}

export async function makeLibsqlDirectory(): Promise<{ readonly directory: string; readonly cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-cert-libsql-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
