import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CallQuery, CommandQuery, Database, RowQuery } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationCaseId, CertificationFixture, CertificationQueries, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey, UnsupportedProbe } from "../types.js";

export interface SqliteStats {
  ready: number;
  result: number;
  streamStarts: number;
  streamEnds: number;
  iteratorReturns: number;
  streamReleases: number;
  activeStreams: number;
}
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
  const failure: RowQuery<unknown> = sql.rows`INSERT INTO cert_items (value) VALUES (NULL) RETURNING value`;
  const identity = sql.rows<{ readonly id: string }>`SELECT id FROM temp.cert_identity`;
  const many = sql.rows`SELECT '1' AS value UNION ALL SELECT '2' AS value`;
  const one = sql.rows`SELECT 'one' AS value`;
  return {
    zero: sql.rows`SELECT 'zero' AS value WHERE 0`,
    one,
    many,
    command,
    identity,
    failure,
    stream: many,
    special,
    transaction: {
      insert,
      visible: sql.rows`SELECT value FROM cert_items ORDER BY rowid`,
      savepointInsert,
      savepointVisible: sql.rows`SELECT value FROM cert_items ORDER BY rowid`,
    },
    fidelity: {
      largeExactInteger: sql.rows`SELECT ${9223372036854775807n} AS value`,
      exactDecimal: sql.rows`SELECT ${"12345678901234567890.123456789"} AS value`,
      temporal: sql.rows`SELECT ${"2026-09-14T12:34:56.789Z"} AS value`,
      injection: sql.rows`SELECT ${"'); UPDATE cert_sentinel SET marker = 'mutated' WHERE id = 1; --"} AS value, (SELECT marker FROM cert_sentinel WHERE id = 1) AS sentinel`,
      expected: {
        largeExactInteger: { value: "9223372036854775807" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14T12:34:56.789Z" },
        injection: { value: "'); UPDATE cert_sentinel SET marker = 'mutated' WHERE id = 1; --", sentinel: "untouched" },
      },
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

function makeUnsupported(
  db: Database,
  queries: CertificationQueries,
  targetKind: "sqlite" | "libsql",
  sideEffects: () => number,
): Partial<Record<CertificationCaseId, UnsupportedProbe>> {
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
      SES001: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES002: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES003: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES004: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES005: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES006: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES007: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      SES008: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },
      STRESS006: { feature: "session.pinned", expectedCode: "BRAID_SESSION_UNSUPPORTED", run: () => db.session(async () => undefined), sideEffects },

      PRE003: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      PRE004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      PRE005: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      PRE011: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR001: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR002: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR003: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR005: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR007: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR008: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR009: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STR011: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
      STRESS004: { feature: "statement.stream", expectedCode: "BRAID_STREAM_UNSUPPORTED", run: runStream, sideEffects },
    } : {}),
    PRE008: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(call), sideEffects },
    STR006: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: () => db.execute(queries.one, { signal: new AbortController().signal }), sideEffects },
    STR010: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: () => db.execute(queries.one, { signal: new AbortController().signal }), sideEffects },
    ...(targetKind === "sqlite" ? { PRE011: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: () => db.execute(queries.one, { signal: new AbortController().signal }), sideEffects } } : {}),
    TX020: { feature: "transaction.isolation.read-uncommitted", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted" }, async () => undefined), sideEffects },
    TX021: { feature: "transaction.read-only", expectedErrorFeature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ readOnly: true }, async () => undefined), sideEffects },
    TX022: { feature: "combination:read-committed+readOnly", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed", readOnly: true }, async () => undefined), sideEffects },
    TX023: { feature: "transaction.isolation.read-committed", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed" }, async () => undefined), sideEffects },
    TX024: { feature: "transaction.isolation.repeatable-read", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read" }, async () => undefined), sideEffects },
    TX025: targetKind === "libsql"
      ? { feature: "transaction.isolation.serializable", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable" }, async () => undefined), sideEffects }
      : undefined,
    TX026: targetKind === "sqlite"
      ? { feature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ readOnly: false }, async () => undefined), sideEffects }
      : undefined,
    TX027: { feature: "combination:read-uncommitted+readOnly", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted", readOnly: true }, async () => undefined), sideEffects },
    TX028: { feature: "combination:serializable+readOnly", expectedErrorFeature: targetKind === "sqlite" ? "transaction.read-only" : "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: true }, async () => undefined), sideEffects },
    TX029: { feature: "combination:read-uncommitted+readWrite", expectedErrorFeature: "transaction.isolation.read-uncommitted", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-uncommitted", readOnly: false }, async () => undefined), sideEffects },
    TX030: { feature: "combination:read-committed+readWrite", expectedErrorFeature: "transaction.isolation.read-committed", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "read-committed", readOnly: false }, async () => undefined), sideEffects },
    TX031: { feature: "combination:repeatable-read+readOnly", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read", readOnly: true }, async () => undefined), sideEffects },
    TX032: { feature: "combination:repeatable-read+readWrite", expectedErrorFeature: "transaction.isolation.repeatable-read", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "repeatable-read", readOnly: false }, async () => undefined), sideEffects },
    TX033: targetKind === "sqlite"
      ? { feature: "combination:serializable+readWrite", expectedErrorFeature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: false }, async () => undefined), sideEffects }
      : { feature: "combination:serializable+readWrite", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => db.tx({ isolation: "serializable", readOnly: false }, async () => undefined), sideEffects },
    CALL001: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(call), sideEffects },
    CALL002: { feature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => runRows(out), sideEffects },
    CALL003: { feature: "routine.inout", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(inout), sideEffects },
    CALL004: { feature: "routine.result-sets", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(resultSets), sideEffects },
    CALL005: { feature: "routine.out-cursor", expectedErrorFeature: "routine.out", expectedCode: "BRAID_CALL_OUT_UNSUPPORTED", run: () => runRows(cursor), sideEffects },
    CALL006: { feature: "routine.return-value", expectedErrorFeature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(returnValue), sideEffects },
    CALL007: { feature: "routine.call", expectedCode: "BRAID_CALL_UNSUPPORTED", run: () => runCall(call), sideEffects },
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
  readonly stats: SqliteStats;
  readonly transactionCleanup?: () => Promise<void>;
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
      cleanupFailureQuery: sql.rows`SELECT 'cleanup' AS value /* __cert_cleanup_failure__ */`,
      cleanupFailure: { code: options.streamFailureCode },
      iteratorReturns: () => options.stats.iteratorReturns,
      released: () => options.stats.streamReleases,
      initFailureCleanup: { iteratorReturns: 0, released: 0 },
      reuseAfterBreak: async () => {
        const row = await options.db.one(queries.identity);
        if (row.id !== options.physicalSessionId) throw new Error("SQLite stream reuse changed physical session identity.");
      },
      largeResultQuery: sql.rows`WITH RECURSIVE cert_numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM cert_numbers WHERE value < 20) SELECT CAST(value AS TEXT) AS value FROM cert_numbers`,
      largeResultCount: 20,
    }
    : undefined;
  const bulkFactory = (input: unknown): CommandQuery => sql.command`INSERT INTO cert_items (value) VALUES (${input})`;
  const bulk: BulkConformanceFixture<unknown> = {
    db: options.db,
    inputs: [1, 2],
    factory: (input) => bulkFactory(input),
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => options.stats.ready,
    executeCount: () => options.stats.result,
    middleFailure: async () => {
      await options.db.execute(sql.command`DELETE FROM cert_items`);
      let error: unknown;
      try {
      await options.db.bulk([1, null, 3], (input) => bulkFactory(input));
      } catch (caught) {
        error = caught;
      }
      if (error === undefined) throw new Error("SQLite bulk middle-item failure was not observed.");
      if (!String((error as { readonly message?: unknown }).message).includes("NOT NULL constraint failed")) {
        throw new Error("SQLite bulk middle-item failure was not the native NOT NULL constraint.", { cause: error });
      }
      const observedRows = await options.db.all(sql.rows<{ readonly value: string }>`SELECT value FROM cert_items ORDER BY rowid`);
      const prefixRows = [{ value: "1.0" }];
      const atomicRows: typeof prefixRows = [];
      const observedText = JSON.stringify(observedRows);
      if (observedText === JSON.stringify(prefixRows)) {
        return { error, observedRows, expectedRows: prefixRows, durability: "prefix" as const };
      }
      if (observedText === JSON.stringify(atomicRows)) {
        return { error, observedRows, expectedRows: atomicRows, durability: "atomic" as const };
      }
      throw new Error(`SQLite bulk middle-item durability was not the expected prefix or atomic state: ${observedText}.`);
    },
  };
  const preparedCalls = { count: 0 };
  queries.prepared = {
    command: () => { preparedCalls.count += 1; return bulkFactory("prepared"); },
    rows: () => { preparedCalls.count += 1; return queries.many; },
    input: "input",
    factoryCalls: () => preparedCalls.count,
    resources: () => options.stats.activeStreams,
  };
  const metrics = {
    snapshot: (): ResourceSnapshot => {
      const openCursors = options.stats.activeStreams;
      return { borrowedLeases: 0, cleanupBalance: openCursors, openCursors, openPrepared: 0 };
    },
    sideEffects: () => options.stats.result,
    mutationSentinel: async () => {
      const row = await options.db.one(sql.rows<{ readonly marker: string }>`SELECT marker FROM cert_sentinel WHERE id = 1`);
      return row.marker;
    },
    readOnlyWrite: async () => {
      await options.db.execute(sql.command`DELETE FROM cert_items`);
      await options.db.tx(async (tx) => { await tx.execute(queries.transaction!.insert); });
      const before = await options.db.all(queries.transaction!.visible);
      if (before.length !== 1) throw new Error(`SQLite read-write transaction proof expected one row, got ${before.length}.`);
      let error: unknown;
      try {
        await options.db.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.savepointInsert); });
      } catch (caught) {
        error = caught;
      }
      if ((error as { readonly code?: unknown } | undefined)?.code !== "BRAID_TX_OPTION_UNSUPPORTED") {
        throw new Error("SQLite read-only transaction did not reject with BRAID_TX_OPTION_UNSUPPORTED.", { cause: error });
      }
      const after = await options.db.all(queries.transaction!.visible);
      if (after.length !== 1) throw new Error(`SQLite read-only rejection changed state: ${after.length} rows.`);
    },
    ...(options.transactionCleanup === undefined ? {} : { transactionCleanup: options.transactionCleanup }),
    ...(options.sessionSupported ? { physicalSessionIds: () => [options.physicalSessionId] } : {}),
  };
  const unsupported = makeUnsupported(options.db, queries, options.localReadOnly ? "libsql" : "sqlite", () => options.stats.result);
  return {
    db: options.db,
    queries,
    stream,
    bulk,
    metrics,
    reset: async () => {
      options.stats.streamStarts = 0;
      options.stats.streamEnds = 0;
      options.stats.iteratorReturns = 0;
      options.stats.streamReleases = 0;
      options.stats.activeStreams = 0;
      await options.db.execute(sql.command`DELETE FROM cert_items`);
      await options.db.execute(sql.command`UPDATE cert_sentinel SET marker = 'untouched' WHERE id = 1`);
    },
    unsupported,
    close: options.close,
  };
}

export async function makeLibsqlDirectory(): Promise<{ readonly directory: string; readonly cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-cert-libsql-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
