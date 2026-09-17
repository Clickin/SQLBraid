import { Client, Pool } from "pg";
import { createPgDatabase, createPgPoolDatabase, type PgClientLike, type PgCursorFactory, type PgPoolClientLike, type PgPoolLike, type PgResultLike } from "@sqlbraid/postgres/pg";
import { postgresParameter, sql } from "@sqlbraid/postgres";
import type { CallQuery, CommandQuery, Database, ExecutionEvent, RowQuery } from "@sqlbraid/core";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type {
  CertificationFixture,
  CertificationTarget,
  ExpectedCapabilityContract,
  ResourceSnapshot,
} from "../types.js";

const expectedCapabilities: ExpectedCapabilityContract = Object.freeze({
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": { status: "guarded", conditionCode: "pg.read-uncommitted-maps-to-read-committed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guarded", conditionCode: "pg.physical-connection-destroy" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "guaranteed" },
  "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.approximate-float": { status: "guarded", canonical: "number", rawRepresentations: ["number"], conditionCode: "pg.extra-float-digits" },
  "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.json-parsed": { status: "unsupported", rawRepresentations: ["unknown"], conditionCode: "pg.json-parser-profile" },
  "data.temporal-lossless": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-native": { status: "unsupported", rawRepresentations: ["Date", "string", "unknown"], conditionCode: "pg.temporal-parser-profile" },
});

const expectedTransactionOptions = Object.freeze({
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "guaranteed",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "guaranteed",
  "combination:read-uncommitted+readWrite": "guaranteed",
  "combination:read-committed+readOnly": "guaranteed",
  "combination:read-committed+readWrite": "guaranteed",
  "combination:repeatable-read+readOnly": "guaranteed",
  "combination:repeatable-read+readWrite": "guaranteed",
  "combination:serializable+readOnly": "guaranteed",
  "combination:serializable+readWrite": "guaranteed",
} as const);

interface Shared {
  readonly targetId: string;
  readonly table: string;
  readonly missingTable: string;
  readonly callProcedure: string;
  readonly scalarProcedure: string;
  readonly setsProcedure: string;
  readonly cursorProcedure: string;
  readonly client: Client;
  readonly pool: Pool;
  readonly direct: PgClientLike;
  readonly poolLike: PgPoolLike;
  readonly cursor: PgCursorFactory;
  readonly cancelPool: Pool;
  readonly cancelPoolLike: PgPoolLike;
  readonly cancelCursor: PgCursorFactory;
  readonly cancelReady: () => Promise<void>;
  readonly activeLeases: { value: number };
  readonly acquireCount: { value: number };
  readonly releaseCount: { value: number };
  readonly sideEffects: { value: number };
  readonly openCursors: { value: number };
  readonly cursorCloses: { value: number };
  readonly streamErrors: {
    readonly init: Error;
    readonly first: Error;
    readonly mid: Error;
    readonly cleanup: Error;
  };
  releaseBefore: number;
  cursorCloseBefore: number;
  setup: () => Promise<void>;
  dispose: () => Promise<void>;
}

interface Metrics {
  readonly activeLeases: { value: number };
  readonly acquireCount: { value: number };
  readonly releaseCount: { value: number };
  readonly sideEffects: { value: number };
  readonly openCursors: { value: number };
  readonly cursorCloses: { value: number };
  readonly streamErrors: {
    readonly init: Error;
    readonly first: Error;
    readonly mid: Error;
    readonly cleanup: Error;
  };
}

const sharedTargets = new Map<string, Promise<Shared>>();

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function markSideEffect(text: string, state: Metrics): void {
  if (/\b(?:INSERT|UPDATE|DELETE|CALL)\b/iu.test(text)) state.sideEffects.value += 1;
}

function queryText(value: unknown): string {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && "text" in value
      ? String((value as { readonly text: unknown }).text)
      : "";
}

function trackedClient(raw: PgClientLike, state: Metrics, pooled: boolean): PgPoolClientLike | PgClientLike {
  const query = raw.query.bind(raw);
  const wrapped: PgClientLike = {
    ...raw,
    async query(value: unknown, values?: readonly unknown[]) {
      markSideEffect(queryText(value), state);
      return (query as unknown as (query: unknown, values?: readonly unknown[]) => Promise<PgResultLike>)(value, values);
    },
    escapeIdentifier: raw.escapeIdentifier.bind(raw),
    escapeLiteral: raw.escapeLiteral.bind(raw),
    ...(raw.getTypeParser ? { getTypeParser: raw.getTypeParser.bind(raw) } : {}),
    ...(raw.end ? { end: raw.end.bind(raw) } : {}),
  };
  if (!pooled) return wrapped;
  const client = raw as PgPoolClientLike;
  return {
    ...wrapped,
    async release(destroy = false) {
      state.releaseCount.value += 1;
      state.activeLeases.value -= 1;
      await client.release(destroy);
    },
  };
}

function makePoolLike(rawPool: Pool, state: Metrics): PgPoolLike {
  return {
    async connect() {
      const raw = await rawPool.connect() as unknown as PgPoolClientLike;
      state.acquireCount.value += 1;
      state.activeLeases.value += 1;
      try {
        await raw.query({ text: "SET extra_float_digits = 0", values: [] });
      } catch (error) {
        state.activeLeases.value -= 1;
        await raw.release(true);
        throw error;
      }
      return trackedClient(raw, state, true) as PgPoolClientLike;
    },
  };
}

function makeCancelPoolLike(rawPool: Pool): PgPoolLike {
  return {
    async connect() {
      const raw = await rawPool.connect() as unknown as PgPoolClientLike;
      await raw.query({ text: "SET extra_float_digits = 0", values: [] });
      return raw;
    },
  };
}

function makeRollbackFaultPoolLike(rawPool: Pool, state: Metrics): PgPoolLike {
  return {
    async connect() {
      const raw = await rawPool.connect() as unknown as PgPoolClientLike;
      state.acquireCount.value += 1;
      state.activeLeases.value += 1;
      const tracked = trackedClient(raw, state, true) as PgPoolClientLike;
      let failed = false;
      return {
        ...tracked,
        async query(value: unknown, values?: readonly unknown[]) {
          if (!failed && /^\s*ROLLBACK(?:\s|$)/iu.test(queryText(value))) {
            failed = true;
            throw new Error("cert-rollback-cleanup");
          }
          return (tracked.query as unknown as (query: unknown, values?: readonly unknown[]) => Promise<PgResultLike>)(value, values);
        },
      };
    },
  };
}

function makeRoutineCleanupFaultClient(raw: PgClientLike, state: Metrics): PgClientLike {
  const tracked = trackedClient(raw, state, false) as PgClientLike;
  let failed = false;
  return {
    ...tracked,
    async query(value: unknown, values?: readonly unknown[]) {
      if (!failed && /^\s*CLOSE\s/iu.test(queryText(value))) {
        failed = true;
        throw new Error("cert-routine-cleanup");
      }
      return (tracked.query as unknown as (query: unknown, values?: readonly unknown[]) => Promise<PgResultLike>)(value, values);
    },
  };
}

async function loadCursor(): Promise<PgCursorFactory> {
  const loaded = await import("pg-cursor") as unknown as { readonly default?: unknown };
  return (loaded.default ?? loaded) as PgCursorFactory;
}

function faultCursorFactory(base: PgCursorFactory, state: Metrics): PgCursorFactory {
  return class CertificationCursor extends base {
    private readonly mode: "normal" | "init" | "first" | "mid" | "cleanup";
    private reads = 0;
    private counted = true;

    constructor(text: string, values: readonly unknown[], config?: { readonly types?: unknown }) {
      const mode = text.includes("CERT_STREAM_INIT")
        ? "init"
        : text.includes("CERT_STREAM_FIRST")
          ? "first"
          : text.includes("CERT_STREAM_MID")
            ? "mid"
            : text.includes("CERT_STREAM_CLEANUP")
              ? "cleanup"
              : "normal";
      if (mode === "init") throw state.streamErrors.init;
      super(text, values, config as never);
      this.mode = mode;
      state.openCursors.value += 1;
    }

    override read(rowCount: number, callback: (error: unknown, rows?: readonly unknown[], result?: PgResultLike) => void): void {
      this.reads += 1;
      // Keep the native cursor result contract while injecting deterministic faults.
      if (this.mode === "first" && this.reads === 1) {
        callback(state.streamErrors.first);
        return;
      }
      if (this.mode === "mid" && this.reads === 2) {
        callback(state.streamErrors.mid);
        return;
      }
      super.read(rowCount, callback as never);
    }

    override close(callback: (error?: unknown) => void): void {
      super.close((error?: unknown) => {
        if (this.counted) {
          this.counted = false;
          state.openCursors.value -= 1;
          state.cursorCloses.value += 1;
        }
        if (this.mode === "cleanup") callback(state.streamErrors.cleanup);
        else callback(error);
      });
    }
  } as unknown as PgCursorFactory;
}

function cancelCursorFactory(base: PgCursorFactory, ready: { resolve: () => void }): PgCursorFactory {
  return class CancellationCursor extends base {
    override read(rowCount: number, callback: (error: unknown, rows?: readonly unknown[], result?: PgResultLike) => void): void {
      ready.resolve();
      super.read(rowCount, callback as never);
    }
  } as unknown as PgCursorFactory;
}

async function createShared(targetId: string, connectionUri: string): Promise<Shared> {
  const safe = targetId.replaceAll(/[^a-z0-9]+/giu, "_").toLowerCase();
  const table = `braid_cert_pg_${safe}`;
  const missingTable = `${table}_missing`;
  const callProcedure = `${table}_call`;
  const scalarProcedure = `${table}_scalar`;
  const setsProcedure = `${table}_sets`;
  const cursorProcedure = `${table}_cursor`;
  const client = new Client({ connectionString: connectionUri });
  await client.connect();
  await client.query("SET extra_float_digits = 0");
  const pool = new Pool({ connectionString: connectionUri, max: 2, idleTimeoutMillis: 0 });
  const cancelPool = new Pool({ connectionString: connectionUri, max: 1, idleTimeoutMillis: 0 });
  const activeLeases = { value: 0 };
  const acquireCount = { value: 0 };
  const releaseCount = { value: 0 };
  const sideEffects = { value: 0 };
  const openCursors = { value: 0 };
  const cursorCloses = { value: 0 };
  const streamErrors = {
    init: new Error("cert-stream-init-failure"),
    first: new Error("cert-stream-first-failure"),
    mid: new Error("cert-stream-mid-failure"),
    cleanup: new Error("cert-cleanup-failure"),
  };
  const metrics: Metrics = { activeLeases, acquireCount, releaseCount, sideEffects, openCursors, cursorCloses, streamErrors };
  const cancelReadyState = Promise.withResolvers<void>();
  const baseCursor = await loadCursor();
  const cancelBaseCursor = await loadCursor();
  const cancelCursor = cancelCursorFactory(cancelBaseCursor, { resolve: () => cancelReadyState.resolve() });
  const setup = async (): Promise<void> => {
    await client.query(`DROP TABLE IF EXISTS ${identifier(table)} CASCADE`);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(callProcedure)}(integer)`);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(scalarProcedure)}(integer,integer)`);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(setsProcedure)}(integer,refcursor,refcursor)`);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(cursorProcedure)}(integer,refcursor)`);
    await client.query(`CREATE TABLE ${identifier(table)} (id text PRIMARY KEY, value text NOT NULL, marker integer NOT NULL)`);
    await client.query(`
      CREATE PROCEDURE ${identifier(callProcedure)}(IN p integer)
      LANGUAGE plpgsql AS $$ BEGIN PERFORM p; END; $$
    `);
    await client.query(`
      CREATE PROCEDURE ${identifier(scalarProcedure)}(IN p integer, OUT answer integer)
      LANGUAGE plpgsql AS $$ BEGIN answer := p * 2; END; $$
    `);
    await client.query(`
      CREATE PROCEDURE ${identifier(setsProcedure)}(IN p integer, OUT users refcursor, OUT payments refcursor)
      LANGUAGE plpgsql AS $$
      BEGIN
        users := '${table}_users';
        payments := '${table}_payments';
        OPEN users FOR SELECT p AS id, 'set-one'::text AS value;
        OPEN payments FOR SELECT (p + 1) AS id, 'set-two'::text AS value;
      END;
      $$
    `);
    await client.query(`
      CREATE PROCEDURE ${identifier(cursorProcedure)}(IN p integer, OUT users refcursor)
      LANGUAGE plpgsql AS $$
      BEGIN
        users := '${table}_cursor';
        OPEN users FOR SELECT p AS id, 'cursor'::text AS value;
      END;
      $$
    `);
  };
  const dispose = async (): Promise<void> => {
    await client.query(`DROP TABLE IF EXISTS ${identifier(table)} CASCADE`).catch(() => undefined);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(callProcedure)}(integer)`).catch(() => undefined);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(scalarProcedure)}(integer,integer)`).catch(() => undefined);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(setsProcedure)}(integer,refcursor,refcursor)`).catch(() => undefined);
    await client.query(`DROP PROCEDURE IF EXISTS ${identifier(cursorProcedure)}(integer,refcursor)`).catch(() => undefined);
    await client.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await cancelPool.end().catch(() => undefined);
  };
  const shared: Shared = {
    targetId,
    table,
    missingTable,
    callProcedure,
    scalarProcedure,
    setsProcedure,
    cursorProcedure,
    client,
    pool,
    direct: trackedClient(client as unknown as PgClientLike, metrics, false),
    poolLike: makePoolLike(pool, metrics),
    cursor: faultCursorFactory(baseCursor, metrics),
    cancelPool,
    cancelPoolLike: makeCancelPoolLike(cancelPool),
    cancelCursor,
    cancelReady: () => cancelReadyState.promise,
    activeLeases,
    acquireCount,
    releaseCount,
    sideEffects,
    openCursors,
    cursorCloses,
    streamErrors,
    releaseBefore: 0,
    cursorCloseBefore: 0,
    setup,
    dispose,
  };
  await shared.setup();
  return shared;
}

async function sharedFor(targetId: string, connectionUri: string): Promise<Shared> {
  let value = sharedTargets.get(targetId);
  if (!value) {
    value = createShared(targetId, connectionUri);
    sharedTargets.set(targetId, value);
  }
  return value;
}

export async function disposePostgresTarget(targetId: string): Promise<void> {
  const value = sharedTargets.get(targetId);
  if (!value) return;
  sharedTargets.delete(targetId);
  await (await value).dispose();
}

function rowQueries(state: Shared): CertificationFixture["queries"] {
  const table = sql.ident(state.table);
  const one = sql.rows`SELECT id, value FROM ${table} WHERE id = 'one'`;
  const many = sql.rows`SELECT id, value FROM ${table} WHERE id IN ('one', 'two') ORDER BY id`;
  const transactionVisible = sql.rows`SELECT id, value FROM ${table} WHERE id IN ('tx-row', 'savepoint-row') ORDER BY id`;
  const special: CertificationFixture["queries"]["special"] = {
    RES001: sql.rows`SELECT 'value'::text AS "__proto__"`,
    RES002: sql.rows`SELECT 'value'::text AS "constructor"`,
    RES003: sql.rows`SELECT 'value'::text AS "prototype"`,
    RES004: sql.rows`SELECT 'value'::text AS "toString"`,
    RES005: sql.rows`SELECT 'value'::text AS "hasOwnProperty"`,
    RES006: sql.rows`SELECT 'value'::text AS value`,
    RES007: sql.rows`SELECT ''::text AS value`,
    RES008: sql.rows`SELECT NULL::text AS value`,
    RES009: sql.rows`SELECT '안녕하세요'::text AS value`,
    RES010: sql.rows`SELECT decode('00ff10', 'hex') AS value`,
    RES011: sql.rows`SELECT 1::integer AS value, 2::integer AS value`,
  };
  const prepared = {
    command: (input: unknown): CommandQuery => sql.command`UPDATE ${table} SET value = ${String(input)} WHERE id = 'baseline'`,
    rows: (input: unknown): RowQuery<unknown> => sql.rows`SELECT id, value FROM ${table} WHERE id IN ('one', 'two') AND ${String(input)}::text IS NOT NULL ORDER BY id`,
    input: "prepared",
    factoryCalls: () => preparedCalls,
    resources: () => state.openCursors.value,
  };
  let preparedCalls = 0;
  const preparedFactory = {
    command: (input: unknown): CommandQuery => {
      preparedCalls += 1;
      return prepared.command(input);
    },
    rows: (input: unknown): RowQuery<unknown> => {
      preparedCalls += 1;
      return prepared.rows(input);
    },
    input: prepared.input,
    factoryCalls: prepared.factoryCalls,
    resources: prepared.resources,
  };
  const routines = {
    executionScope: "transaction" as const,
    call: sql.call`CALL ${sql.ident(state.callProcedure)}(${1})`,
    out: sql.call`CALL ${sql.ident(state.scalarProcedure)}(${7}, ${sql.out("answer")})`,
    resultSets: sql.call`CALL ${sql.ident(state.setsProcedure)}(${1}, ${sql.out("users", postgresParameter.refcursor())}, ${sql.out("payments", postgresParameter.refcursor())})`,
    cursor: sql.call`CALL ${sql.ident(state.cursorProcedure)}(${1}, ${sql.out("users", postgresParameter.refcursor())})`,
    inout: sql.call`CALL ${sql.ident(state.scalarProcedure)}(${sql.inOut("answer", 1)})`,
    returnValue: sql.call({ returnValue: { "~standard": { version: 1, vendor: "sqlbraid-pg-cert", validate: (value: unknown) => ({ value }) } } })`SELECT 1`,
  };
  return {
    zero: sql.rows`SELECT id, value FROM ${table} WHERE false`,
    one,
    many,
    command: sql.command`UPDATE ${table} SET marker = marker + 1 WHERE id = 'baseline'`,
    identity: sql.rows`SELECT pg_backend_pid()::text AS id`,
    failure: sql.rows`SELECT * FROM ${sql.ident(state.missingTable)}`,
    stream: sql.rows`SELECT id, value FROM ${table} WHERE id IN ('one', 'two') ORDER BY id`,
    special,
    transaction: {
      insert: sql.command`INSERT INTO ${table} (id, value, marker) VALUES ('tx-row', 'transaction', 1)`,
      visible: transactionVisible,
      savepointInsert: sql.command`INSERT INTO ${table} (id, value, marker) VALUES ('savepoint-row', 'savepoint', 1)`,
      savepointVisible: transactionVisible,
    },
    prepared: preparedFactory,
    routines: { ...routines, lob: routines.cursor },
    fidelity: {
      largeExactInteger: sql.rows`SELECT 9007199254740991::numeric(38,0) AS value`,
      exactDecimal: sql.rows`SELECT 12345678901234567890.123456789::numeric(38,9) AS value`,
      temporal: sql.rows`SELECT TIMESTAMP '2026-09-14 12:34:56.789' AS value`,
      injection: sql.rows`SELECT ${"'; SELECT 1; --"} AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740991" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14 12:34:56.789" },
        injection: { value: "'; SELECT 1; --" },
      },
    },
    expected: {
      one: { id: "one", value: "one" },
      many: [{ id: "one", value: "one" }, { id: "two", value: "two" }],
      special: {
        RES001: Object.fromEntries([["__proto__", "value"]]),
        RES002: Object.fromEntries([["constructor", "value"]]),
        RES003: Object.fromEntries([["prototype", "value"]]),
        RES004: Object.fromEntries([["toString", "value"]]),
        RES005: Object.fromEntries([["hasOwnProperty", "value"]]),
        RES006: { value: "value" },
        RES007: { value: "" },
        RES008: { value: null },
        RES009: { value: "안녕하세요" },
        RES010: { value: Buffer.from([0, 255, 16]) },
        CALL001: { output: {}, resultSets: [] },
        CALL002: { output: { answer: "14" }, resultSets: [] },
        CALL004: { output: {}, resultSets: [{ rows: [{ id: "1", value: "set-one" }] }, { rows: [{ id: "2", value: "set-two" }] }] },
        CALL005: { output: {}, resultSets: [{ rows: [{ id: "1", value: "cursor" }] }] },
      },
      specialErrors: { RES011: { code: "BRAID_RESULT_COLUMNS" } },
      commandAffectedRows: 1,
      failureCode: "42P01",
    },
  };
}

async function createFixture(state: Shared): Promise<CertificationFixture> {
  const queries = rowQueries(state);
  let bulkExec = 0;
  let bulkValues: readonly (readonly unknown[])[] = [];
  const bulkObserver = {
    onEvent(event: ExecutionEvent): void {
      if (event.type === "bulk:result") bulkExec += 1;
      if (event.type === "bulk:ready" && event.itemCount !== undefined && event.valuesAt !== undefined) {
        bulkValues = Array.from({ length: event.itemCount }, (_, index) => event.valuesAt!(index));
      }
    },
  };
  const pooled = createPgPoolDatabase(state.poolLike, { cursor: state.cursor, streamBatchSize: 2, observers: [bulkObserver] });
  const direct = createPgDatabase(state.direct, { cursor: state.cursor, streamBatchSize: 2 });
  const bulkDb: Pick<Database, "bulk"> = {
    bulk: async (inputs, factory, options) => {
      return pooled.bulk(inputs, factory, options);
    },
  };
  const inputs = [{ id: "bulk-one", value: "one" }, { id: "bulk-two", value: "two" }];
  const bulk: BulkConformanceFixture<unknown> = {
    db: bulkDb,
    inputs,
    factory: (input) => sql.command`INSERT INTO ${sql.ident(state.table)} (id, value, marker) VALUES (${(input as typeof inputs[number]).id}, ${(input as typeof inputs[number]).value}, ${1})`,
    expected: { inputCount: 2, affectedRows: 2 },
    acquireCount: () => state.acquireCount.value,
    executeCount: () => bulkExec,
    values: () => bulkValues,
    middleFailure: async () => {
      const failureInputs = [{ id: "bulk-middle", value: "first" }, { id: "bulk-middle", value: "duplicate" }];
      let error: unknown;
      try {
        await bulkDb.bulk(failureInputs, (input) => sql.command`INSERT INTO ${sql.ident(state.table)} (id, value, marker) VALUES (${input.id}, ${input.value}, ${1})`);
      } catch (caught) {
        error = caught;
      }
      if (error === undefined) throw new Error("BULK003 did not reject its middle item.");
      const observedRows = await direct.all(sql.rows<{ readonly id: string; readonly value: string }>`SELECT id, value FROM ${sql.ident(state.table)} WHERE id = 'bulk-middle' ORDER BY id`);
      const expectedRows = [{ id: "bulk-middle", value: "first" }];
      if (JSON.stringify(observedRows) !== JSON.stringify(expectedRows)) throw new Error(`BULK003 expected one durable prefix row, got ${JSON.stringify(observedRows)}.`);
      await direct.one(sql.rows`SELECT 1 AS usable`);
      return { error, observedRows, expectedRows, durability: "prefix" as const };
    },
  };
  const mappingFailure = new Error("cert-mapper-failure");
  const executionSchemaFailure = new Error("cert-mapper-failure");
  const mappingSchema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pg-cert",
      validate: () => { throw mappingFailure; },
    },
  } as const;
  const stream = Object.assign({
    db: pooled,
    query: queries.stream!,
    expected: [queries.expected!.many[0], queries.expected!.many[1]],
    mappingQuery: sql.rows(mappingSchema)`SELECT id, value FROM ${sql.ident(state.table)} WHERE id IN ('one', 'two') ORDER BY id`,
    initFailureQuery: sql.rows`/* CERT_STREAM_INIT */ SELECT id, value FROM ${sql.ident(state.table)}`,
    firstNextFailureQuery: sql.rows`/* CERT_STREAM_FIRST */ SELECT id, value FROM ${sql.ident(state.table)}`,
    midStreamFailureQuery: sql.rows`/* CERT_STREAM_MID */ SELECT id, value FROM ${sql.ident(state.table)}`,
    cleanupFailureQuery: sql.rows`/* CERT_STREAM_CLEANUP */ SELECT id, value FROM ${sql.ident(state.table)}`,
    largeResultQuery: sql.rows`SELECT value::text AS id FROM generate_series(1, 100000) AS value`,
    cleanupFailure: state.streamErrors.cleanup,
    released: () => state.releaseCount.value - state.releaseBefore,
    iteratorReturns: () => state.cursorCloses.value - state.cursorCloseBefore,
    reuseAfterBreak: async () => {
      await pooled.one(queries.identity);
      if (state.activeLeases.value !== 0) throw new Error("STR011 did not release the pooled resource after reuse.");
    },
  }, {
    mappingFailure,
    executionSchemaFailure,
    initFailure: state.streamErrors.init,
    firstNextFailure: state.streamErrors.first,
    midStreamFailure: state.streamErrors.mid,
    largeResultCount: 100000,
  }) as StreamingConformanceFixture<unknown>;
  const metrics = {
    snapshot: (): ResourceSnapshot => ({
      borrowedLeases: state.activeLeases.value,
      cleanupBalance: state.openCursors.value,
      openCursors: state.openCursors.value,
    }),
    sideEffects: () => state.sideEffects.value,
    mutationSentinel: async () => (await pooled.one(sql.rows<{ readonly marker: number }>`SELECT marker FROM ${sql.ident(state.table)} WHERE id = 'baseline'`)).marker,
    pooledScope: async (): Promise<void> => {
      await pooled.session(async (session) => {
        await session.one(queries.identity);
        if (state.activeLeases.value < 1) throw new Error("pg pooled session did not borrow a native client.");
      });
      if (state.activeLeases.value !== 0) throw new Error("pg pooled session leaked its native client.");
    },
    transactionCleanup: async (): Promise<void> => {
      const faultDb = createPgPoolDatabase(makeRollbackFaultPoolLike(state.pool, state), { cursor: state.cursor });
      const primary = new Error("cert-transaction-primary");
      let error: unknown;
      try {
        await faultDb.tx(async () => { throw primary; });
      } catch (caught) {
        error = caught;
      }
      if (!(error instanceof AggregateError) || !error.errors.includes(primary) || !error.errors.some((item) => item instanceof Error && item.message === "cert-rollback-cleanup")) {
        throw new Error("TX007 did not preserve both the transaction primary and rollback cleanup failures.");
      }
      if (state.activeLeases.value !== 0) throw new Error("TX007 leaked the faulted pooled lease.");
      await pooled.one(queries.identity);
    },
    readOnlyWrite: async (): Promise<void> => {
      await state.client.query(`DELETE FROM ${identifier(state.table)}`);
      await state.client.query(`INSERT INTO ${identifier(state.table)} (id, value, marker) VALUES ('one', 'one', 0), ('two', 'two', 0), ('baseline', 'baseline', 0)`);
      await pooled.tx(async (tx) => { await tx.execute(queries.transaction!.insert); });
      const committed = await direct.one(sql.rows<{ readonly count: string }>`SELECT count(*)::text AS count FROM ${sql.ident(state.table)} WHERE id = 'tx-row'`);
      if (committed.count !== "1") throw new Error("TX009 did not establish a valid read-write baseline.");
      await state.client.query(`DELETE FROM ${identifier(state.table)} WHERE id = 'tx-row'`);
      let error: unknown;
      try {
        await pooled.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.insert); });
      } catch (caught) {
        error = caught;
      }
      if ((error as { readonly code?: unknown } | undefined)?.code !== "25006") throw new Error(`TX009 read-only write returned an unexpected native code: ${String((error as { readonly code?: unknown } | undefined)?.code)}`);
      const durable = await direct.one(sql.rows<{ readonly count: string }>`SELECT count(*)::text AS count FROM ${sql.ident(state.table)} WHERE id = 'tx-row'`);
      if (durable.count !== "0") throw new Error("TX009 read-only write changed durable state.");
    },
    routineCleanup: async (query?: CallQuery): Promise<void> => {
      if (query === undefined) throw new Error("CALL007 routine cleanup query missing.");
      const faultDb = createPgDatabase(makeRoutineCleanupFaultClient(state.client as unknown as PgClientLike, state), { cursor: state.cursor });
      let error: unknown;
      try {
        await faultDb.tx(async (tx) => { await tx.call(query); });
      } catch (caught) {
        error = caught;
      }
      const cleanupPreserved = error instanceof AggregateError
        ? error.errors.some((item) => item instanceof Error && item.message === "cert-routine-cleanup")
        : error instanceof Error && error.message === "cert-routine-cleanup";
      if (!cleanupPreserved) throw new Error("CALL007 did not preserve the native routine cursor cleanup failure.");
      await direct.one(queries.identity);
    },
  };
  const unsupported = {
    CALL003: {
      feature: "routine.inout",
      expectedCode: "BRAID_CALL_OUT_UNSUPPORTED" as const,
      run: () => direct.call(queries.routines!.inout!),
      sideEffects: () => state.sideEffects.value,
    },
    CALL006: {
      feature: "routine.return-value",
      expectedErrorFeature: "routine.return-value",
      expectedCode: "BRAID_CALL_RETURN_UNSUPPORTED" as const,
      run: () => direct.call(queries.routines!.returnValue!),
      sideEffects: () => state.sideEffects.value,
    },
  };
  const guarded = {
    "transaction.isolation.read-uncommitted": {
      prove: async () => {
        const observed = await direct.tx({ isolation: "read-uncommitted" }, async (tx) =>
          tx.one(sql.rows<{ readonly transaction_isolation: string }>`SHOW transaction_isolation`));
        if (observed.transaction_isolation !== "read uncommitted") throw new Error(`PostgreSQL read-uncommitted setting was not observed: ${observed.transaction_isolation}`);
      },
    },
    "numeric.approximate-float": {
      prove: async () => {
        const observed = await direct.one(sql.rows<{ readonly value: number; readonly digits: string }>`
          SELECT 0.1::float8 AS value, current_setting('extra_float_digits') AS digits
        `);
        if (observed.digits !== "0" || typeof observed.value !== "number") {
          throw new Error(`PostgreSQL float guard setup was not deterministic: ${JSON.stringify(observed)}`);
        }
      },
    },
    "statement.cancel": {
      prove: async () => {
        const ready = Promise.withResolvers<void>();
        const cursor = cancelCursorFactory(state.cancelCursor, { resolve: () => ready.resolve() });
        const db = createPgPoolDatabase(state.cancelPoolLike, { cursor });
        const before = await db.one(sql.rows<{ readonly id: string }>`SELECT pg_backend_pid()::text AS id`);
        const controller = new AbortController();
        const iterator = db.stream(sql.rows`SELECT pg_sleep(60)`, { signal: controller.signal })[Symbol.asyncIterator]();
        const next = iterator.next();
        await Promise.race([ready.promise, state.cancelReady()]);
        controller.abort(new Error("cert-statement-abort"));
        let rejected = false;
        try { await next; } catch { rejected = true; }
        if (!rejected) throw new Error("statement.cancel did not reject the active stream.");
        const after = await db.one(sql.rows<{ readonly id: string }>`SELECT pg_backend_pid()::text AS id`);
        if (after.id === before.id) throw new Error("statement.cancel reused the destroyed physical connection.");
      },
    },
  };
  return {
    db: pooled,
    pooled,
    queries,
    stream,
    bulk,
    metrics,
    reset: async () => {
      await state.client.query(`DELETE FROM ${identifier(state.table)}`);
      await state.client.query(`INSERT INTO ${identifier(state.table)} (id, value, marker) VALUES ('one', 'one', 0), ('two', 'two', 0), ('baseline', 'baseline', 0)`);
      state.sideEffects.value = 0;
      state.releaseBefore = state.releaseCount.value;
      state.cursorCloseBefore = state.cursorCloses.value;
      bulkValues = [];
      bulkExec = 0;
    },
    unsupported,
    guarded,
    close: async () => undefined,
  };
}

export type PostgresTargetId = "postgres-pg-node-16-4" | "postgres-current" | "postgres-pg-deno-2-9-3";

export function createPostgresTarget(
  id: PostgresTargetId,
  connectionUri: string,
  sourceSha: string,
): CertificationTarget {
  if (!sourceSha.trim()) throw new Error("PostgreSQL certification sourceSha must be non-empty.");
  return {
    id,
    sourceSha,
    expectedCapabilities,
    expectedTransactionOptions,
    createFixture: async () => createFixture(await sharedFor(id, connectionUri)),
  };
}

export { expectedCapabilities as postgresExpectedCapabilities, expectedTransactionOptions as postgresExpectedTransactionOptions };
