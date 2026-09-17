import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject } from "vitest";
import type { CommandQuery, Database, ExecutionOptions, RowQuery } from "@sqlbraid/core";
import { createTediousDatabase, createTediousPoolProvider, type TediousConnectionLike, type TediousPoolConnectionLike, type TediousPoolLike } from "@sqlbraid/mssql/tedious";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot } from "../types.js";

interface MssqlSettings {
  readonly server: string;
  readonly port: number;
  readonly userName: string;
  readonly password: string;
  readonly database: string;
}

interface Stats {
  requests: number;
  leased: boolean;
  acquires: number;
  bulkExecutions: number;
  releaseCount: number;
  closed: boolean;
  streamCleanupFailure?: Error;
  rollbackFailure?: Error;
  releaseFailure?: Error;
}

const TABLE = "dbo.braid_cert_mssql";
const PROCEDURES = [
  "dbo.braid_cert_mssql_out",
  "dbo.braid_cert_mssql_inout",
  "dbo.braid_cert_mssql_sets",
  "dbo.braid_cert_mssql_return",
  "dbo.braid_cert_mssql_lob",
] as const;

function connect(settings: MssqlSettings): Promise<Connection> {
  const connection = new Connection({
    server: settings.server,
    options: {
      port: settings.port,
      database: settings.database,
      encrypt: false,
      trustServerCertificate: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      connectionIsolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
    },
    authentication: { type: "default", options: { userName: settings.userName, password: settings.password } },
  });
  return new Promise<Connection>((resolve, reject) => {
    connection.once("connect", (error) => error ? reject(error) : resolve(connection));
    connection.connect();
  });
}

async function close(connection: Connection): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.once("end", resolve);
    connection.close();
    setTimeout(resolve, 500);
  });
}

function expectedRow(label: string, value: unknown): Record<string, unknown> {
  const row = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(row, label, { value, enumerable: true, configurable: true, writable: true });
  return row;
}

function trackedConnection(raw: Connection, stats: Stats): TediousPoolConnectionLike {
  const physical = raw as unknown as TediousConnectionLike;
  return {
    execSql(request) { stats.requests += 1; return physical.execSql(request); },
    prepare(request) { stats.requests += 1; return physical.prepare!(request); },
    execute(request, parameters) { stats.requests += 1; return physical.execute!(request, parameters); },
    unprepare(request) { stats.requests += 1; return physical.unprepare!(request); },
    callProcedure(request) { stats.requests += 1; return physical.callProcedure!(request); },
    beginTransaction(callback, name, isolation) { stats.requests += 1; return physical.beginTransaction(callback, name, isolation); },
    commitTransaction(callback) { stats.requests += 1; return physical.commitTransaction(callback); },
    rollbackTransaction(callback) {
      stats.requests += 1;
      if (stats.rollbackFailure) return callback(stats.rollbackFailure);
      return physical.rollbackTransaction(callback);
    },
    saveTransaction(callback, name) { stats.requests += 1; return physical.saveTransaction(callback, name); },
    cancel() { stats.requests += 1; return physical.cancel?.(); },
    close() { return physical.close?.(); },
    release() {
      stats.leased = false;
      stats.releaseCount += 1;
      const failure = stats.streamCleanupFailure ?? stats.releaseFailure;
      stats.streamCleanupFailure = undefined;
      if (failure) throw failure;
    },
    async destroy() {
      stats.leased = false;
      stats.closed = true;
      if (stats.releaseCount === 0) stats.releaseCount += 1;
      await physical.close?.();
      if (stats.releaseFailure) throw stats.releaseFailure;
    },
  };
}

async function executeSetup(connection: TediousConnectionLike): Promise<void> {
  const setup = createTediousDatabase(connection);
  for (const procedure of PROCEDURES) await setup.execute(sql`DROP PROCEDURE IF EXISTS ${sql.raw(procedure)}`);
  await setup.execute(sql`DROP TABLE IF EXISTS ${sql.raw(TABLE)}`);
  await setup.execute(sql`CREATE TABLE ${sql.raw(TABLE)} (id int NOT NULL PRIMARY KEY, value nvarchar(100) NOT NULL)`);
  await setup.execute(sql`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (${1}, ${"one"}), (${2}, ${"two"})`);
  await setup.execute(sql`CREATE PROCEDURE ${sql.raw(PROCEDURES[0])} @answer int OUTPUT AS BEGIN SET NOCOUNT ON; SET @answer = 42; END`);
  await setup.execute(sql`CREATE PROCEDURE ${sql.raw(PROCEDURES[1])} @answer int OUTPUT, @delta int AS BEGIN SET NOCOUNT ON; SET @answer = @answer + @delta; END`);
  await setup.execute(sql`CREATE PROCEDURE ${sql.raw(PROCEDURES[2])} @minimum int AS BEGIN SET NOCOUNT ON; SELECT @minimum AS user_id; SELECT CONCAT(N'payment-', @minimum) AS payment_id; END`);
  await setup.execute(sql`CREATE PROCEDURE ${sql.raw(PROCEDURES[3])} @value int AS BEGIN SET NOCOUNT ON; RETURN 17; END`);
  await setup.execute(sql`CREATE PROCEDURE ${sql.raw(PROCEDURES[4])} AS BEGIN SET NOCOUNT ON; SELECT REPLICATE(CAST(N'x' AS nvarchar(max)), 4096) AS payload; END`);
}

function queries(): CertificationFixture["queries"] {
  const specialValues: Record<string, unknown> = {
    RES001: expectedRow("__proto__", "proto"),
    RES002: expectedRow("constructor", "constructor"),
    RES003: expectedRow("prototype", "prototype"),
    RES004: expectedRow("toString", "toString"),
    RES005: expectedRow("hasOwnProperty", "hasOwnProperty"),
    RES006: { value: "hello" },
    RES007: { value: "" },
    RES008: { value: null },
    RES009: { value: "안녕하세요" },
    RES010: { value: Buffer.from([0, 255, 16]) },
    RES011: { value: "second" },
  };
  const special: Partial<Record<"RES001" | "RES002" | "RES003" | "RES004" | "RES005" | "RES006" | "RES007" | "RES008" | "RES009" | "RES010" | "RES011", RowQuery<unknown>>> = {
    RES001: sql.rows`SELECT N'proto' AS [__proto__]`,
    RES002: sql.rows`SELECT N'constructor' AS [constructor]`,
    RES003: sql.rows`SELECT N'prototype' AS [prototype]`,
    RES004: sql.rows`SELECT N'toString' AS [toString]`,
    RES005: sql.rows`SELECT N'hasOwnProperty' AS [hasOwnProperty]`,
    RES006: sql.rows`SELECT N'hello' AS value`,
    RES007: sql.rows`SELECT N'' AS value`,
    RES008: sql.rows`SELECT CAST(NULL AS nvarchar(20)) AS value`,
    RES009: sql.rows`SELECT N'안녕하세요' AS value`,
    RES010: sql.rows`SELECT CONVERT(varbinary(3), 0x00FF10) AS value`,
    RES011: sql.rows`SELECT N'second' AS value`,
  };
  const routines = {
    call: sql.call`SELECT N'call' AS value`,
    out: sql.call({ procedure: { name: PROCEDURES[0], parameterNames: ["answer"] } })`${sql.out("answer", mssqlParameter.int())}`,
    inout: sql.call({ procedure: { name: PROCEDURES[1], parameterNames: ["answer", "delta"] } })`${sql.inOut("answer", 1, mssqlParameter.int())}, ${41}`,
    resultSets: sql.call({ procedure: { name: PROCEDURES[2], parameterNames: ["minimum"] } })`${1}`,
    cursor: sql.call({ procedure: { name: "dbo.braid_cert_mssql_cursor", parameterNames: ["cursor"] } })`${sql.out("cursor", { databaseType: "cursor" })}`,
    returnValue: sql.call({ procedure: { name: PROCEDURES[3], parameterNames: ["value"] } })`${1}`,
    lob: sql.call({ procedure: { name: PROCEDURES[4], parameterNames: [] } })``,
  } satisfies NonNullable<CertificationFixture["queries"]["routines"]>;
  let factoryCalls = 0;
  const prepared = {
    command: (input: unknown) => { factoryCalls += 1; return sql.command`UPDATE ${sql.raw(TABLE)} SET value = ${String(input)} WHERE id = 1`; },
    rows: (input: unknown) => { factoryCalls += 1; return sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id >= ${Number(input)} ORDER BY id`; },
    input: 1,
    factoryCalls: () => factoryCalls,
  };
  const command = sql.command`UPDATE ${sql.raw(TABLE)} SET value = value WHERE id = 1`;
  const transaction = {
    insert: sql.command`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (3, N'transaction')`,
    visible: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id >= 3 ORDER BY id`,
    savepointInsert: sql.command`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (4, N'savepoint')`,
    savepointVisible: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id >= 4 ORDER BY id`,
  };
  return {
    zero: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE 1 = 0`,
    one: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id = 1`,
    many: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id IN (1, 2) ORDER BY id`,
    command,
    identity: sql.rows`SELECT CAST(@@SPID AS varchar(20)) AS id`,
    failure: sql.rows`RAISERROR (N'cert-failure', 16, 1)`,
    stream: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id IN (1, 2) ORDER BY id`,
    special,
    transaction,
    prepared,
    routines,
    fidelity: {
      largeExactInteger: sql.rows`SELECT CAST(${9007199254740993n} AS bigint) AS value`,
      exactDecimal: sql.rows`SELECT ${12345.6789} AS value`,
      temporal: sql.rows`SELECT CAST(${new Date("2026-09-14T12:34:56.789Z")} AS datetime2) AS value`,
      injection: sql.rows`SELECT ${"'; UPDATE dbo.braid_cert_mssql SET value=N'hacked' WHERE id=1; --"} AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740993" },
        exactDecimal: { value: 12345.6789 },
        temporal: { value: new Date("2026-09-14T12:34:56.789Z") },
        injection: { value: "'; UPDATE dbo.braid_cert_mssql SET value=N'hacked' WHERE id=1; --" },
      },
    },
    expected: {
      one: { value: "one" },
      many: [{ value: "one" }, { value: "two" }],
      special: {
        ...specialValues,
        CALL001: { output: {}, resultSets: [{ rows: [{ value: "call" }] }] },
        CALL002: { output: { answer: "42" }, resultSets: [], returnValue: 0 },
        CALL003: { output: { answer: "42" }, resultSets: [], returnValue: 0 },
        CALL004: { output: {}, resultSets: [{ rows: [{ user_id: "1" }] }, { rows: [{ payment_id: "payment-1" }] }], returnValue: 0 },
        CALL006: { output: {}, resultSets: [], returnValue: 17 },
      },
      commandAffectedRows: 1,
      failureCode: "EREQUEST",
    },
  };
}

import { MSSQL_EXPECTED_CAPABILITIES, MSSQL_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

const expectedCapabilities = MSSQL_EXPECTED_CAPABILITIES;

const expectedTransactionOptions = MSSQL_EXPECTED_TRANSACTION_OPTIONS;

export function createMssqlTediousTarget(sourceSha: string, measuredDriverVersion?: string): CertificationTarget {
  if (!sourceSha.trim()) throw new Error("MSSQL certification requires the tested candidate source SHA.");
  return {
  id: "mssql-tedious-developer-node-2022-cu18",
  sourceSha,
  ...(measuredDriverVersion === undefined ? {} : { measuredDriverVersion }),
  expectedCapabilities,
  expectedTransactionOptions,
  async createFixture(): Promise<CertificationFixture> {
    const settings = inject("mssql") as MssqlSettings;
    const raw = await connect(settings);
    let activeRaw = raw;
    const stats: Stats = { requests: 0, leased: false, acquires: 0, bulkExecutions: 0, releaseCount: 0, closed: false };
    const tracked = trackedConnection(raw, stats);
    await executeSetup(raw as unknown as TediousConnectionLike);
    stats.requests = 0;
    const pool: TediousPoolLike = {
      async acquire() {
        if (stats.leased) throw new Error("certification pool acquired while already leased");
        if (stats.closed) {
          const replacement = await connect(settings);
          activeRaw = replacement;
          stats.closed = false;
          stats.leased = true;
          stats.acquires += 1;
          return trackedConnection(replacement, stats);
        }
        stats.leased = true;
        stats.acquires += 1;
        return tracked;
      },
    };
    const baseProvider = createTediousPoolProvider(pool);
    let iteratorReturns = 0;
    const database = createPooledDatabase({
      ...baseProvider,
      async acquire() {
        const lease = await baseProvider.acquire();
        const stream = lease.stream?.bind(lease);
        if (!stream) return lease;
        return {
          ...lease,
          stream<Row>(rendered: Parameters<NonNullable<typeof lease.stream>>[0], binding: Parameters<NonNullable<typeof lease.stream>>[1], options: Parameters<NonNullable<typeof lease.stream>>[2]) {
            const sourceSql = (rendered as { readonly segments?: readonly string[] }).segments?.join("");
            if (sourceSql?.includes("CERT_STREAM_CLEANUP_FAILURE")) {
              stats.streamCleanupFailure = Object.assign(new Error("mssql-cert-stream-cleanup-failure"), { code: "EREQUEST" });
            }
            const source = stream(rendered, binding, options);
            const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Row>;
            const wrapped: AsyncIterator<Row> & AsyncIterable<Row> = {
              [Symbol.asyncIterator]() { return this; },
              next(value?: unknown) { return iterator.next(value); },
              return(value?: unknown) {
                iteratorReturns += 1;
                return iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value });
              },
              throw(error?: unknown) { return iterator.throw ? iterator.throw(error) : Promise.reject(error); },
            };
            return wrapped;
          },
        };
      },
    });
    const bulkDatabase = {
      bulk: (async <Input>(
        inputs: readonly Input[],
        factory: (input: Input, index: number) => CommandQuery,
        options?: ExecutionOptions,
      ) => {
        const before = stats.requests;
        try {
          return await database.bulk(inputs, factory, options);
        } finally {
          if (stats.requests > before) stats.bulkExecutions += 1;
        }
      }) as Database["bulk"],
    };
    const fixtureQueries = queries();
    const reset = async (): Promise<void> => {
      await database.execute(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id >= 3`);
      await database.execute(sql`UPDATE ${sql.raw(TABLE)} SET value = CASE id WHEN 1 THEN N'one' WHEN 2 THEN N'two' END WHERE id IN (1, 2)`);
      stats.releaseCount = 0;
      iteratorReturns = 0;
    };
    const unsupported: NonNullable<CertificationFixture["unsupported"]> = {
      CALL005: { feature: "routine.out-cursor", expectedCode: "BRAID_CALL_CURSOR_UNSUPPORTED", run: () => database.call(fixtureQueries.routines!.cursor!), sideEffects: () => stats.requests },
    };
    const txOptions: Array<[string, string, { readonly isolation?: "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable"; readonly readOnly: boolean }]> = [
      ["TX021", "transaction.read-only", { readOnly: true }], ["TX022", "transaction.read-only", { isolation: "read-committed", readOnly: true }],
      ["TX026", "transaction.read-only", { readOnly: false }], ["TX027", "transaction.read-only", { isolation: "read-uncommitted", readOnly: true }],
      ["TX028", "transaction.read-only", { isolation: "serializable", readOnly: true }], ["TX029", "transaction.read-only", { isolation: "read-uncommitted", readOnly: false }],
      ["TX030", "transaction.read-only", { isolation: "read-committed", readOnly: false }], ["TX031", "transaction.read-only", { isolation: "repeatable-read", readOnly: true }],
      ["TX032", "transaction.read-only", { isolation: "repeatable-read", readOnly: false }], ["TX033", "transaction.read-only", { isolation: "serializable", readOnly: false }],
    ];
    for (const [id, feature, options] of txOptions) {
      unsupported[id as keyof typeof unsupported] = { feature, expectedErrorFeature: "transaction.read-only", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: () => database.tx(options, async () => undefined), sideEffects: () => stats.requests };
    }
    const mappingFailure = new Error("cert-mapper-failure");
    const executionSchemaFailure = new Error("mssql-cert-execution-schema-failure");
    const streamInitFailure = sql.rows`SELECT * FROM dbo.braid_cert_mssql_missing`;
    const streamFirstNextFailure = sql.rows`SELECT CAST(N'not-an-int' AS int) AS value`;
    const streamMidFailure = sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id = 1; RAISERROR (N'cert-stream-mid-failure', 16, 1)`;
    const streamLarge = sql.rows`SELECT value FROM ${sql.raw(TABLE)} UNION ALL SELECT N'large' AS value`;
    const mappingQuery = sql.rows({
      "~standard": {
        version: 1 as const,
        vendor: "mssql-cert-mapping",
        validate() { throw mappingFailure; },
      },
    })`SELECT value FROM ${sql.raw(TABLE)} WHERE id IN (1, 2) ORDER BY id`;
    const stream = {
      db: database,
      query: fixtureQueries.stream!,
      expected: fixtureQueries.expected!.many,
      mappingQuery,
      mappingFailure,
      executionSchemaFailure,
      initFailureQuery: streamInitFailure,
      initFailure: { code: "EREQUEST" },
      initFailureCleanup: { iteratorReturns: 1, released: 1 },
      firstNextFailureQuery: streamFirstNextFailure,
      firstNextFailure: { code: "EREQUEST" },
      midStreamFailureQuery: streamMidFailure,
      midStreamFailure: { code: "EREQUEST" },
      cleanupFailureQuery: sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id = 1 /* CERT_STREAM_CLEANUP_FAILURE */`,
      cleanupFailure: { code: "EREQUEST" },
      largeResultQuery: streamLarge,
      largeResultCount: 3,
    } as StreamingConformanceFixture<unknown> & Record<string, unknown>;
    const bulk: BulkConformanceFixture<unknown> = {
      db: bulkDatabase,
      inputs: [{ id: 10, value: "bulk-a" }, { id: 11, value: "bulk-b" }],
      factory: (input) => sql.command`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (${sql.bind((input as { id: number }).id, mssqlParameter.int())}, ${sql.bind((input as { value: string }).value, mssqlParameter.nvarchar(80))})`,
      expected: { inputCount: 2, affectedRows: 2 },
      acquireCount: () => stats.acquires,
      executeCount: () => stats.bulkExecutions,
      middleFailure: async () => {
        let error: unknown;
        try {
          await database.bulk(
            [{ id: 12, value: "first" }, { id: 10, value: "duplicate" }, { id: 13, value: "later" }],
            bulk.factory,
          );
        } catch (caught) {
          error = caught;
        }
        if (error === undefined) throw new Error("MSSQL bulk middle failure did not reject.");
        const rows = await database.all<{ readonly id: unknown; readonly value: unknown }>(sql.rows`SELECT id, value FROM ${sql.raw(TABLE)} WHERE id IN (12, 13) ORDER BY id`);
        await database.execute(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id = 12`);
        const observedRows = rows.map((row) => ({ id: Number(row.id), value: row.value }));
        return {
          error,
          observedRows,
          expectedRows: [{ id: 12, value: "first" }],
          durability: "prefix" as const,
        };
      },
    };
    const metrics = {
      snapshot: (): ResourceSnapshot => ({ borrowedLeases: stats.leased ? 1 : 0, cleanupBalance: stats.leased ? 1 : 0 }),
      sideEffects: () => stats.requests,
      mutationSentinel: async (): Promise<unknown> => database.one(sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id = 1`),
      readOnlyWrite: async (): Promise<void> => {
        await database.tx((tx) => tx.execute(sql`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (999998, N'rw')`));
        await assert.rejects(
          () => database.tx({ readOnly: true }, (tx) => tx.execute(sql`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (999997, N'ro')`)),
          (error: unknown) => (error as { readonly code?: string }).code === "BRAID_TX_OPTION_UNSUPPORTED",
        );
        const row = await database.maybeOne<{ readonly value?: unknown }>(sql.rows`SELECT value FROM ${sql.raw(TABLE)} WHERE id = 999997`);
        assert.equal(row, undefined);
        await database.execute(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id IN (999998, 999997)`);
      },
      transactionCleanup: async (): Promise<void> => {
        const rollbackFailure = new Error("mssql-cert-rollback-failure");
        const releaseFailure = new Error("mssql-cert-release-failure");
        const primary = new Error("mssql-cert-transaction-primary");
        stats.rollbackFailure = rollbackFailure;
        stats.releaseFailure = releaseFailure;
        let error: unknown;
        const faultRaw = await connect(settings);
        const faultTracked = trackedConnection(faultRaw, stats);
        const faultPool: TediousPoolLike = {
          async acquire() {
            stats.leased = true;
            return faultTracked;
          },
        };
        const faultDatabase = createPooledDatabase(createTediousPoolProvider(faultPool));
        try {
          await faultDatabase.tx(async () => { throw primary; });
        } catch (caught) {
          error = caught;
        } finally {
          const observedLeased = stats.leased;
          stats.rollbackFailure = undefined;
          stats.releaseFailure = undefined;
          try {
            assert.equal(observedLeased, false);
          } finally {
            await close(faultRaw);
          }
        }
        assert.ok(error instanceof AggregateError);
        const nested = (value: unknown): readonly unknown[] => value instanceof AggregateError
          ? value.errors.flatMap((entry) => [entry, ...nested(entry)])
          : [];
        const errors = [error, ...nested(error)];
        assert.ok(errors.includes(primary));
        assert.ok(errors.includes(rollbackFailure));
        assert.ok(errors.includes(releaseFailure));
        await database.execute(fixtureQueries.identity);
      },
      routineCleanup: async (query = fixtureQueries.routines!.lob): Promise<void> => {
        if (!query) throw new Error("MSSQL routine LOB query missing.");
        const result = await database.call(query);
        const payload = (result.resultSets[0]?.rows[0] as { readonly payload?: unknown } | undefined)?.payload;
        assert.equal(typeof payload, "string");
        assert.equal((payload as string).length, 4096);
        await database.one(fixtureQueries.identity);
      },
    };
    return {
      db: database,
      queries: fixtureQueries,
      stream: {
        ...stream,
        db: database,
        released: () => stats.releaseCount,
        iteratorReturns: () => iteratorReturns,
        reuseAfterBreak: async () => { await database.one(fixtureQueries.identity); },
      },
      bulk,
      metrics,
      reset,
      unsupported,
      representationUnsupported: {
        "numeric.exact-decimal": {
          prove: async () => {
            await assert.rejects(
              () => database.one(sql.rows`SELECT CAST(${sql.bind("12.34", mssqlParameter.nvarchar(20))} AS decimal(10, 2)) AS value`),
              (error: unknown) => (error as { readonly code?: string }).code === "BRAID_RESULT_EXACTNESS",
            );
          },
        },
        "numeric.aggregate": {
          prove: async () => {
            await assert.rejects(
              () => database.one(sql.rows`SELECT SUM(CAST(${sql.bind("12.34", mssqlParameter.nvarchar(20))} AS decimal(10, 2))) AS value`),
              (error: unknown) => (error as { readonly code?: string }).code === "BRAID_RESULT_EXACTNESS",
            );
          },
        },
        "data.json-parsed": {
          prove: async () => {
            const row = await database.one<{ readonly value: unknown }>(sql.rows`SELECT CAST(N'{"ok":true}' AS nvarchar(max)) AS value`);
            if (typeof row.value !== "string") throw new Error("MSSQL JSON result is not the declared text representation.");
          },
        },
        "data.sql-variant": {
          prove: async () => {
            const row = await database.one<{ readonly value: unknown }>(sql.rows`SELECT CAST(1 AS sql_variant) AS value`);
            if (typeof row.value !== "number") throw new Error("MSSQL sql_variant result changed representation.");
          },
        },
        "data.temporal-lossless": {
          prove: async () => {
            const row = await database.one<{ readonly value: unknown }>(sql.rows`SELECT DATETIME2FROMPARTS(2026, 9, 14, 12, 34, 56, 7891234, 7) AS value`);
            if (!(row.value instanceof Date) || row.value.getUTCMilliseconds() !== 789) throw new Error("MSSQL temporal result did not expose driver precision loss.");
          },
        },
      },
      guarded: {
        "numeric.bind-exact": {
          prove: async () => {
            await assert.rejects(
              () => database.one(sql.rows`SELECT CAST(${sql.bind("12.34", mssqlParameter.nvarchar(20))} AS decimal(10, 2)) AS value`),
              (error: unknown) => (error as { readonly code?: string }).code === "BRAID_RESULT_EXACTNESS",
            );
            const row = await database.one(sql.rows<{ readonly value: string }>`SELECT CONVERT(varchar(64), CAST(${sql.bind("12.34", mssqlParameter.nvarchar(20))} AS decimal(10, 2))) AS value`);
            if (row.value !== "12.34") throw new Error("numeric bind guard failed");
          },
        },
        "metadata.command-safe": { prove: async () => { const result = await database.execute(fixtureQueries.command); if (result.command.affectedRows !== 1) throw new Error("safe count guard failed"); } },
        "data.temporal-native": { prove: async () => { const row = await database.one(sql.rows<{ readonly value: unknown }>`SELECT DATETIME2FROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 7) AS value`); if (!(row.value instanceof Date)) throw new Error("temporal guard failed"); } },
      },
      close: async () => { await close(activeRaw); },
    };
  },
  };
}

export { expectedCapabilities as mssqlTediousExpectedCapabilities, expectedTransactionOptions as mssqlTediousExpectedTransactionOptions };
