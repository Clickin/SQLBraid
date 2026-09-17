import { Buffer } from "node:buffer";
import { Connection, ISOLATION_LEVEL } from "tedious";
import { inject } from "vitest";
import type { CommandQuery, Database, ExecutionOptions, RowQuery } from "@sqlbraid/core";
import { createTediousDatabase, createTediousPoolDatabase, type TediousConnectionLike, type TediousPoolConnectionLike, type TediousPoolLike } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey } from "../types.js";

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
}

const TABLE = "dbo.braid_cert_mssql";
const PROCEDURES = [
  "dbo.braid_cert_mssql_out",
  "dbo.braid_cert_mssql_inout",
  "dbo.braid_cert_mssql_sets",
  "dbo.braid_cert_mssql_return",
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
    rollbackTransaction(callback) { stats.requests += 1; return physical.rollbackTransaction(callback); },
    saveTransaction(callback, name) { stats.requests += 1; return physical.saveTransaction(callback, name); },
    cancel() { stats.requests += 1; return physical.cancel?.(); },
    close() { return physical.close?.(); },
    release() { stats.leased = false; },
    destroy() { stats.leased = false; return physical.close?.(); },
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

const expectedCapabilities: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["number", "string"] },
  "numeric.exact-decimal": { status: "unsupported", canonical: "string", rawRepresentations: ["number"] },
  "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "numeric.bind-exact": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "mssql.character-cast-required" },
  "numeric.aggregate": { status: "unsupported", canonical: "string", rawRepresentations: ["number"], conditionCode: "mssql.exact-decimal-text-cast-required" },
  "metadata.command-safe": { status: "guarded", rawRepresentations: ["number"], conditionCode: "mssql.safe-count" },
  "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.json-parsed": { status: "unsupported" },
  "data.sql-variant": { status: "unsupported", rawRepresentations: ["driver-native"], conditionCode: "mssql.sql-variant-unclassified" },
  "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
  "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-lossless": { status: "unsupported", conditionCode: "mssql.temporal-text-cast-required" },
  "data.temporal-native": { status: "guarded", rawRepresentations: ["Date", "string"], conditionCode: "mssql.temporal-text-cast-required" },
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
  "transaction.isolation.read-uncommitted": { status: "guaranteed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guaranteed" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "guaranteed" },
  "routine.return-value": { status: "guaranteed" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_CURSOR_UNSUPPORTED" },
};

const expectedTransactionOptions: CertificationTarget["expectedTransactionOptions"] = {
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "unsupported",
};

export function createMssqlTediousTarget(sourceSha: string): CertificationTarget {
  if (!sourceSha.trim()) throw new Error("MSSQL certification requires the tested candidate source SHA.");
  return {
  id: "mssql-tedious-developer-node-2022-cu18",
  sourceSha,
  expectedCapabilities,
  expectedTransactionOptions,
  async createFixture(): Promise<CertificationFixture> {
    const settings = inject("mssql") as MssqlSettings;
    const raw = await connect(settings);
    const stats: Stats = { requests: 0, leased: false, acquires: 0, bulkExecutions: 0 };
    const tracked = trackedConnection(raw, stats);
    await executeSetup(raw as unknown as TediousConnectionLike);
    stats.requests = 0;
    const pool: TediousPoolLike = {
      async acquire() {
        if (stats.leased) throw new Error("certification pool acquired while already leased");
        stats.leased = true;
        stats.acquires += 1;
        return tracked;
      },
    };
    const database = createTediousPoolDatabase(pool);
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
      initFailure: "EREQUEST",
      firstNextFailureQuery: streamFirstNextFailure,
      firstNextFailure: "EREQUEST",
      midStreamFailureQuery: streamMidFailure,
      midStreamFailure: "EREQUEST",
      cleanupFailureQuery: streamMidFailure,
      cleanupFailure: new Error("cert-stream-mid-failure"),
      largeResultQuery: streamLarge,
      largeResultCount: 3,
    } as StreamingConformanceFixture<unknown> & Record<string, unknown>;
    const bulk: BulkConformanceFixture<unknown> = {
      db: bulkDatabase,
      inputs: [{ id: 10, value: "bulk-a" }, { id: 11, value: "bulk-b" }],
      factory: (input) => sql.command`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (${(input as { id: number }).id}, ${(input as { value: string }).value})`,
      expected: { inputCount: 2, affectedRows: 2 },
      acquireCount: () => stats.acquires,
      executeCount: () => stats.bulkExecutions,
      middleFailure: () => database.bulk([{ id: 12, value: "first" }, { id: 10, value: "duplicate" }], (input) => sql.command`INSERT INTO ${sql.raw(TABLE)} (id, value) VALUES (${(input as { id: number }).id}, ${(input as { value: string }).value})`),
    };
    const metrics = {
      snapshot: (): ResourceSnapshot => ({ borrowedLeases: stats.leased ? 1 : 0, cleanupBalance: stats.leased ? 1 : 0 }),
      sideEffects: () => stats.requests,
    };
    return {
      db: database,
      queries: fixtureQueries,
      stream,
      bulk,
      metrics,
      reset,
      unsupported,
      guarded: {
        "numeric.bind-exact": { prove: async () => { const row = await database.one(sql.rows<{ readonly value: string }>`SELECT CONVERT(varchar(64), CAST(${sql.bind("12.34", mssqlParameter.nvarchar(20))} AS decimal(10, 2))) AS value`); if (row.value !== "12.34") throw new Error("numeric bind guard failed"); } },
        "metadata.command-safe": { prove: async () => { const result = await database.execute(fixtureQueries.command); if (result.command.affectedRows !== 1) throw new Error("safe count guard failed"); } },
        "data.temporal-native": { prove: async () => { const row = await database.one(sql.rows<{ readonly value: unknown }>`SELECT DATETIME2FROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 7) AS value`); if (!(row.value instanceof Date)) throw new Error("temporal guard failed"); } },
      },
      close: async () => { await close(raw); },
    };
  },
  };
}

export { expectedCapabilities as mssqlTediousExpectedCapabilities, expectedTransactionOptions as mssqlTediousExpectedTransactionOptions };
