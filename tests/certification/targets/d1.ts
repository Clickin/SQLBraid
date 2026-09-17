import { defineResultProperty } from "@sqlbraid/core/driver";
import { sql } from "@sqlbraid/sqlite";
import { createD1Database, type D1DatabaseLike } from "@sqlbraid/sqlite/d1";
import type { RowQuery } from "@sqlbraid/core";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { CertificationCaseId, CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot, TransactionOptionKey, UnsupportedProbe } from "../types.js";

interface D1Stats { prepares: number; batches: number; }

function expectedObject(key: string, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  defineResultProperty(result, key, value);
  return result;
}

const expectedCapabilities: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guarded", canonical: "string", rawRepresentations: ["number"], conditionCode: "cloudflare-d1.safe-integer" },
  "numeric.approximate-float": { status: "guarded", canonical: "number", rawRepresentations: ["number"], conditionCode: "cloudflare-d1.numeric-profile" },
  "numeric.bind-exact": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "cloudflare-d1.safe-integer" },
  "session.pinned": { status: "unsupported", conditionCode: "cloudflare-d1.no-physical-session-pinning" },
  transaction: { status: "unsupported" },
  "transaction.savepoint": { status: "unsupported" },
  "transaction.read-only": { status: "unsupported" },
  "transaction.isolation.read-uncommitted": { status: "unsupported" },
  "transaction.isolation.read-committed": { status: "unsupported" },
  "transaction.isolation.repeatable-read": { status: "unsupported" },
  "transaction.isolation.serializable": { status: "unsupported" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "unsupported" },
  "statement.stream": { status: "unsupported" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "unsupported" },
  "routine.out": { status: "unsupported" },
  "routine.inout": { status: "unsupported" },
  "routine.return-value": { status: "unsupported" },
  "routine.result-sets": { status: "unsupported" },
  "routine.out-cursor": { status: "unsupported" },
};

const expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported", "isolation:read-committed": "unsupported", "isolation:repeatable-read": "unsupported", "isolation:serializable": "unsupported",
  "readOnly:true": "unsupported", "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported", "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported", "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported", "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported", "combination:serializable+readWrite": "unsupported",
};

function buildQueries(stats: D1Stats): CertificationFixture["queries"] {
  let preparedCalls = 0;
  const special = {
    RES001: sql.rows`SELECT 'safe' AS "__proto__"`, RES002: sql.rows`SELECT 'safe' AS "constructor"`, RES003: sql.rows`SELECT 'safe' AS "prototype"`,
    RES004: sql.rows`SELECT 'safe' AS "toString"`, RES005: sql.rows`SELECT 'safe' AS "hasOwnProperty"`, RES006: sql.rows`SELECT 'hello' AS value`,
    RES007: sql.rows`SELECT '' AS value`, RES008: sql.rows`SELECT NULL AS value`, RES009: sql.rows`SELECT '안녕하세요' AS value`,
    RES010: sql.rows`SELECT ${new Uint8Array([0, 255, 16])} AS value`, RES011: sql.rows`SELECT 'second' AS value`,
  } as const;
  const one = sql.rows`SELECT 'one' AS value`;
  const many = sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`;
  const identity = sql.rows`SELECT 'cloudflare-d1-certification' AS id` as RowQuery<{ readonly id: string }>;
  const command = sql.command`INSERT INTO cert_values (value) VALUES (${"command"})`;
  const failure = sql.rows`SELECT * FROM cert_missing_table`;
  const preparedRows = (_input: unknown) => { preparedCalls += 1; return sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`; };
  const preparedCommand = (_input: unknown) => { preparedCalls += 1; return sql.command`INSERT INTO cert_values (value) VALUES (${"prepared"})`; };
  const call = sql.call`SELECT 1`;
  return {
    zero: sql.rows`SELECT value FROM cert_values WHERE 0`, one, many, command, identity, failure,
    special,
    transaction: {
      insert: sql.command`INSERT INTO cert_values (value) VALUES (${"transaction"})`,
      visible: sql.rows`SELECT value FROM cert_values WHERE value = 'transaction'`,
      savepointInsert: sql.command`INSERT INTO cert_values (value) VALUES (${"savepoint"})`,
      savepointVisible: sql.rows`SELECT value FROM cert_values WHERE value = 'savepoint'`,
    },
    prepared: { command: preparedCommand, rows: preparedRows, input: "prepared-input", factoryCalls: () => preparedCalls, resources: () => 0 },
    routines: { call, out: sql.call`SELECT ${sql.out("answer")}`, inout: sql.call`SELECT ${sql.inOut("answer", 1)}`, resultSets: call, cursor: call, returnValue: call },
    fidelity: {
      largeExactInteger: sql.rows`SELECT '9007199254740991' AS value`,
      exactDecimal: sql.rows`SELECT '12345678901234567890.123456789' AS value`,
      temporal: sql.rows`SELECT '2026-09-14T12:34:56.789Z' AS value`,
      injection: sql.rows`SELECT "'; SELECT 1; --" AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740991" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14T12:34:56.789Z" },
        injection: { value: "'; SELECT 1; --" },
      },
    },
    expected: {
      one: { value: "one" }, many: [{ value: "one" }, { value: "two" }],
      special: { RES001: expectedObject("__proto__", "safe"), RES002: expectedObject("constructor", "safe"), RES003: expectedObject("prototype", "safe"), RES004: expectedObject("toString", "safe"), RES005: expectedObject("hasOwnProperty", "safe"), RES006: { value: "hello" }, RES007: { value: "" }, RES008: { value: null }, RES009: { value: "안녕하세요" }, RES010: { value: new Uint8Array([0, 255, 16]) }, RES011: { value: "second" } },
      failureCode: undefined,
    },
  };
}

function probe(run: () => Promise<unknown>, feature: string, expectedCode: `BRAID_${string}`, sideEffects: () => number, expectedErrorFeature = feature): UnsupportedProbe {
  return { feature, expectedErrorFeature: expectedErrorFeature === feature ? undefined : expectedErrorFeature, expectedCode, run, sideEffects };
}

export function createD1Target(database: D1DatabaseLike, sourceSha: string): CertificationTarget {
  return {
    id: "d1-cloudflare-workerd-2026-07-30",
    sourceSha,
    expectedCapabilities,
    expectedTransactionOptions,
    createFixture: async (): Promise<CertificationFixture> => {
      const stats: D1Stats = { prepares: 0, batches: 0 };
      const binding: D1DatabaseLike = {
        prepare(text) { stats.prepares += 1; return database.prepare(text); },
        batch(statements) { stats.batches += 1; return database.batch(statements); },
      };
      const db = createD1Database(binding);
      await db.execute(sql.command`CREATE TABLE IF NOT EXISTS cert_values (value TEXT NOT NULL)`);
      const queries = buildQueries(stats);
      const unsupported: NonNullable<CertificationFixture["unsupported"]> = {};
      const streamQuery = sql.rows`SELECT value FROM cert_values`;
      for (const id of ["SES001", "SES002", "SES003", "SES004", "SES005", "SES006", "SES008", "STRESS006"] as const) unsupported[id] = probe(() => db.session(async () => undefined), "session.pinned", "BRAID_SESSION_UNSUPPORTED", () => stats.prepares);
      unsupported.SES007 = probe(async () => { for await (const row of db.stream(streamQuery)) void row; }, "statement.stream", "BRAID_STREAM_UNSUPPORTED", () => stats.prepares);
      for (const id of ["TX001", "TX002", "TX003", "TX004", "TX005", "TX008", "TX009", "TX012", "STRESS002", "STRESS005"] as const) unsupported[id] = probe(() => db.tx(async () => undefined), "transaction", "BRAID_TX_UNSUPPORTED", () => stats.prepares);
      unsupported.BULK004 = probe(() => db.tx(async () => undefined), "transaction", "BRAID_TX_UNSUPPORTED", () => stats.prepares);
      for (const id of ["TX010", "TX011", "TX013"] as const) unsupported[id] = { ...probe(() => db.tx(async () => undefined), "transaction.savepoint", "BRAID_TX_UNSUPPORTED", () => stats.prepares, "transaction"), expectedErrorFeature: "transaction" };
      for (const id of ["STR001", "STR002", "STR003", "STR004", "STR005", "STR007", "STR008", "STR009", "STR011", "STRESS004"] as const) unsupported[id] = probe(async () => { for await (const row of db.stream(streamQuery)) void row; }, "statement.stream", "BRAID_STREAM_UNSUPPORTED", () => stats.prepares);
      unsupported.STR006 = probe(async () => { const controller = new AbortController(); for await (const row of db.stream(streamQuery, { signal: controller.signal })) void row; }, "statement.cancel", "BRAID_CANCEL_UNSUPPORTED", () => stats.prepares);
      unsupported.STR010 = unsupported.STR006;
      for (const id of ["PRE003", "PRE004", "PRE005", "PRE011"] as const) unsupported[id] = probe(async () => { for await (const row of db.stream(streamQuery)) void row; }, "statement.stream", "BRAID_STREAM_UNSUPPORTED", () => stats.prepares);
      unsupported.CALL001 = probe(() => db.call(queries.routines!.call), "routine.call", "BRAID_CALL_UNSUPPORTED", () => stats.prepares);
      unsupported.CALL002 = probe(() => db.call(queries.routines!.out!), "routine.out", "BRAID_CALL_UNSUPPORTED", () => stats.prepares, "routine.call");
      unsupported.CALL003 = probe(() => db.call(queries.routines!.inout!), "routine.inout", "BRAID_CALL_UNSUPPORTED", () => stats.prepares, "routine.call");
      unsupported.CALL004 = probe(() => db.call(queries.routines!.resultSets!), "routine.result-sets", "BRAID_CALL_UNSUPPORTED", () => stats.prepares, "routine.call");
      unsupported.CALL005 = probe(() => db.call(queries.routines!.cursor!), "routine.out-cursor", "BRAID_CALL_UNSUPPORTED", () => stats.prepares, "routine.call");
      unsupported.CALL006 = probe(() => db.call(queries.routines!.returnValue!), "routine.return-value", "BRAID_CALL_UNSUPPORTED", () => stats.prepares, "routine.call");
      const options: Readonly<Record<string, { readonly value: Parameters<NonNullable<CertificationFixture["db"]["tx"]>>[0]; readonly feature: string }>> = {
        TX020: { value: { isolation: "read-uncommitted" }, feature: "transaction.isolation.read-uncommitted" }, TX021: { value: { readOnly: true }, feature: "transaction.read-only" }, TX022: { value: { isolation: "read-committed", readOnly: true }, feature: "transaction.isolation.read-committed" }, TX023: { value: { isolation: "read-committed" }, feature: "transaction.isolation.read-committed" }, TX024: { value: { isolation: "repeatable-read" }, feature: "transaction.isolation.repeatable-read" }, TX025: { value: { isolation: "serializable" }, feature: "transaction.isolation.serializable" }, TX026: { value: { readOnly: false }, feature: "transaction.read-only" }, TX027: { value: { isolation: "read-uncommitted", readOnly: true }, feature: "transaction.isolation.read-uncommitted" }, TX028: { value: { isolation: "serializable", readOnly: true }, feature: "transaction.isolation.serializable" }, TX029: { value: { isolation: "read-uncommitted", readOnly: false }, feature: "transaction.isolation.read-uncommitted" }, TX030: { value: { isolation: "read-committed", readOnly: false }, feature: "transaction.isolation.read-committed" }, TX031: { value: { isolation: "repeatable-read", readOnly: true }, feature: "transaction.isolation.repeatable-read" }, TX032: { value: { isolation: "repeatable-read", readOnly: false }, feature: "transaction.isolation.repeatable-read" }, TX033: { value: { isolation: "serializable", readOnly: false }, feature: "transaction.isolation.serializable" },
      };
      for (const [id, option] of Object.entries(options)) unsupported[id as CertificationCaseId] = probe(() => db.tx(option.value, async () => undefined), option.feature, "BRAID_TX_OPTION_UNSUPPORTED", () => stats.prepares);
      const bulk: BulkConformanceFixture<unknown> = { db, inputs: [1, 2], factory: (input) => sql.command`INSERT INTO cert_values (value) VALUES (${String(input)})`, expected: { inputCount: 2, affectedRows: 2 }, acquireCount: () => stats.batches, executeCount: () => stats.batches, middleFailure: async () => db.bulk([1, 2], (input) => input === 2 ? sql.command`INSERT INTO cert_missing_bulk (value) VALUES (${input})` : sql.command`INSERT INTO cert_values (value) VALUES (${input})`) };
      const metrics = { snapshot: (): ResourceSnapshot => ({ borrowedLeases: 0, cleanupBalance: 0 }), sideEffects: () => stats.prepares, physicalSessionIds: () => ["cloudflare-d1"] };
      return {
        db, queries, bulk, metrics, reset: async () => { await db.execute(sql.command`DELETE FROM cert_values`); }, unsupported,
        guarded: {
          "numeric.exact-integer": { prove: async () => { const row = await db.one(sql.rows`SELECT CAST('9007199254740991' AS INTEGER) AS value`) as { readonly value: unknown }; if (row.value !== "9007199254740991") throw new Error("D1 exact-integer guarded proof failed."); } },
          "numeric.approximate-float": { prove: async () => { const row = await db.one(sql.rows`SELECT CAST(1.5 AS REAL) AS value`) as { readonly value: unknown }; if (row.value !== 1.5) throw new Error("D1 approximate-float guarded proof failed."); } },
          "numeric.bind-exact": { prove: async () => { const row = await db.one(sql.rows`SELECT ${"9007199254740991"} AS value`) as { readonly value: unknown }; if (row.value !== "9007199254740991") throw new Error("D1 bind-exact guarded proof failed."); } },
        },
      };
    },
  };
}
