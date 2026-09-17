import { defineResultProperty } from "@sqlbraid/core/driver";
import { sql } from "@sqlbraid/sqlite";
import { createD1Database, type D1DatabaseLike } from "@sqlbraid/sqlite/d1";
import type { RowQuery } from "@sqlbraid/core";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type {
  CertificationCaseId,
  CertificationFixture,
  CertificationTarget,
  ResourceSnapshot,
  UnsupportedProbe,
} from "../types.js";

interface D1Stats {
  prepares: number;
  batches: number;
}
const D1_EXACT_INTEGER = "9007199254740991";
const D1_INJECTION = "'); UPDATE cert_sentinel SET marker = 'mutated' WHERE id = 1; --";

function expectedObject(key: string, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  defineResultProperty(result, key, value);
  return result;
}

import { D1_EXPECTED_CAPABILITIES, D1_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

const expectedCapabilities = D1_EXPECTED_CAPABILITIES;

const expectedTransactionOptions = D1_EXPECTED_TRANSACTION_OPTIONS;

export interface D1CertificationTargetOptions {
  readonly measuredDriverVersion: string;
  readonly measuredRuntimeVersion: string;
}

function buildQueries(_stats: D1Stats): CertificationFixture["queries"] {
  let preparedCalls = 0;
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
    RES010: sql.rows`SELECT ${new Uint8Array([0, 255, 16])} AS value`,
    RES011: sql.rows`SELECT 'second' AS value`,
  } as const;
  const one = sql.rows`SELECT 'one' AS value`;
  const many = sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`;
  const identity = sql.rows`SELECT 'cloudflare-d1-certification' AS id` as RowQuery<{ readonly id: string }>;
  const command = sql.command`INSERT INTO cert_values (value) VALUES (${"command"})`;
  const failure = sql.rows`SELECT * FROM cert_missing_table`;
  const preparedRows = (_input: unknown) => {
    preparedCalls += 1;
    return sql.rows`SELECT 'one' AS value UNION ALL SELECT 'two' AS value`;
  };
  const preparedCommand = (_input: unknown) => {
    preparedCalls += 1;
    return sql.command`INSERT INTO cert_values (value) VALUES (${"prepared"})`;
  };
  const call = sql.call`SELECT 1`;
  return {
    zero: sql.rows`SELECT value FROM cert_values WHERE 0`,
    one,
    many,
    command,
    identity,
    failure,
    special,
    transaction: {
      insert: sql.command`INSERT INTO cert_values (value) VALUES (${"transaction"})`,
      visible: sql.rows`SELECT value FROM cert_values WHERE value = 'transaction'`,
      savepointInsert: sql.command`INSERT INTO cert_values (value) VALUES (${"savepoint"})`,
      savepointVisible: sql.rows`SELECT value FROM cert_values WHERE value = 'savepoint'`,
    },
    prepared: {
      command: preparedCommand,
      rows: preparedRows,
      input: "prepared-input",
      factoryCalls: () => preparedCalls,
    },
    routines: {
      call,
      out: sql.call`SELECT ${sql.out("answer")}`,
      inout: sql.call`SELECT ${sql.inOut("answer", 1)}`,
      resultSets: call,
      cursor: call,
      returnValue: call,
    },
    fidelity: {
      largeExactInteger: sql.rows`SELECT CAST(${D1_EXACT_INTEGER} AS INTEGER) AS value`,
      exactDecimal: sql.rows`SELECT ${"12345678901234567890.123456789"} AS value`,
      temporal: sql.rows`SELECT ${"2026-09-14T12:34:56.789Z"} AS value`,
      injection: sql.rows`SELECT ${D1_INJECTION} AS value, (SELECT marker FROM cert_sentinel WHERE id = 1) AS sentinel`,
      expected: {
        largeExactInteger: { value: D1_EXACT_INTEGER },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14T12:34:56.789Z" },
        injection: { value: D1_INJECTION, sentinel: "untouched" },
      },
    },
    expected: {
      one: { value: "one" },
      many: [{ value: "one" }, { value: "two" }],
      special: {
        RES001: expectedObject("__proto__", "safe"),
        RES002: expectedObject("constructor", "safe"),
        RES003: expectedObject("prototype", "safe"),
        RES004: expectedObject("toString", "safe"),
        RES005: expectedObject("hasOwnProperty", "safe"),
        RES006: { value: "hello" },
        RES007: { value: "" },
        RES008: { value: null },
        RES009: { value: "안녕하세요" },
        RES010: { value: new Uint8Array([0, 255, 16]) },
        RES011: { value: "second" },
      },
      failureCode: undefined,
    },
  };
}

function probe(
  run: () => Promise<unknown>,
  feature: string,
  expectedCode: `BRAID_${string}`,
  sideEffects: () => number,
  expectedErrorFeature = feature,
): UnsupportedProbe {
  return {
    feature,
    expectedErrorFeature: expectedErrorFeature === feature ? undefined : expectedErrorFeature,
    expectedCode,
    run,
    sideEffects,
  };
}

export function createD1Target(
  database: D1DatabaseLike,
  sourceSha: string,
  options: D1CertificationTargetOptions,
): CertificationTarget {
  return {
    id: "d1-cloudflare-workerd-2026-07-30",
    sourceSha,
    measuredDriverVersion: options.measuredDriverVersion,
    measuredRuntimeVersion: options.measuredRuntimeVersion,
    expectedCapabilities,
    expectedTransactionOptions,
    createFixture: async (): Promise<CertificationFixture> => {
      const stats: D1Stats = { prepares: 0, batches: 0 };
      const binding: D1DatabaseLike = {
        prepare(text) {
          stats.prepares += 1;
          return database.prepare(text);
        },
        batch(statements) {
          stats.batches += 1;
          return database.batch(statements);
        },
      };
      const db = createD1Database(binding);
      await db.execute(sql.command`CREATE TABLE IF NOT EXISTS cert_values (value TEXT NOT NULL)`);
      await db.execute(
        sql.command`CREATE TABLE IF NOT EXISTS cert_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`,
      );
      await db.execute(sql.command`INSERT OR IGNORE INTO cert_sentinel (id, marker) VALUES (1, 'untouched')`);
      const queries = buildQueries(stats);
      const unsupported: NonNullable<CertificationFixture["unsupported"]> = {};
      const streamQuery = sql.rows`SELECT value FROM cert_values`;
      for (const id of ["SES001", "SES002", "SES003", "SES004", "SES005", "SES006", "SES008", "STRESS006"] as const)
        unsupported[id] = probe(
          () => db.session(async () => undefined),
          "session.pinned",
          "BRAID_SESSION_UNSUPPORTED",
          () => stats.prepares,
        );
      unsupported.SES007 = probe(
        async () => {
          for await (const row of db.stream(streamQuery)) void row;
        },
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        () => stats.prepares,
      );
      for (const id of [
        "TX001",
        "TX002",
        "TX003",
        "TX004",
        "TX005",
        "TX006",
        "TX007",
        "TX008",
        "TX009",
        "TX012",
        "STRESS002",
        "STRESS005",
      ] as const)
        unsupported[id] = probe(
          () => db.tx(async () => undefined),
          "transaction",
          "BRAID_TX_UNSUPPORTED",
          () => stats.prepares,
        );
      unsupported.BULK004 = probe(
        () => db.tx(async () => undefined),
        "transaction",
        "BRAID_TX_UNSUPPORTED",
        () => stats.prepares,
      );
      for (const id of ["TX010", "TX011", "TX013"] as const)
        unsupported[id] = {
          ...probe(
            () => db.tx(async () => undefined),
            "transaction.savepoint",
            "BRAID_TX_UNSUPPORTED",
            () => stats.prepares,
            "transaction",
          ),
          expectedErrorFeature: "transaction",
        };
      for (const id of [
        "STR001",
        "STR002",
        "STR003",
        "STR004",
        "STR005",
        "STR007",
        "STR008",
        "STR009",
        "STR011",
        "STRESS004",
      ] as const)
        unsupported[id] = probe(
          async () => {
            for await (const row of db.stream(streamQuery)) void row;
          },
          "statement.stream",
          "BRAID_STREAM_UNSUPPORTED",
          () => stats.prepares,
        );
      unsupported.STR006 = probe(
        async () => {
          const controller = new AbortController();
          for await (const row of db.stream(streamQuery, { signal: controller.signal })) void row;
        },
        "statement.cancel",
        "BRAID_CANCEL_UNSUPPORTED",
        () => stats.prepares,
      );
      unsupported.STR010 = unsupported.STR006;
      for (const id of ["PRE003", "PRE004", "PRE005", "PRE011"] as const)
        unsupported[id] = probe(
          async () => {
            for await (const row of db.stream(streamQuery)) void row;
          },
          "statement.stream",
          "BRAID_STREAM_UNSUPPORTED",
          () => stats.prepares,
        );
      unsupported.CALL001 = probe(
        () => db.call(queries.routines!.call),
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
      );
      unsupported.CALL002 = probe(
        () => db.call(queries.routines!.out!),
        "routine.out",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
        "routine.call",
      );
      unsupported.CALL003 = probe(
        () => db.call(queries.routines!.inout!),
        "routine.inout",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
        "routine.call",
      );
      unsupported.CALL004 = probe(
        () => db.call(queries.routines!.resultSets!),
        "routine.result-sets",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
        "routine.call",
      );
      unsupported.CALL005 = probe(
        () => db.call(queries.routines!.cursor!),
        "routine.out-cursor",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
        "routine.call",
      );
      unsupported.CALL006 = probe(
        () => db.call(queries.routines!.returnValue!),
        "routine.return-value",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
        "routine.call",
      );
      unsupported.CALL007 = probe(
        () => db.call(queries.routines!.call),
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
      );
      unsupported.PRE008 = probe(
        () => db.call(queries.routines!.call),
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        () => stats.prepares,
      );
      const options: Readonly<
        Record<
          string,
          { readonly value: Parameters<NonNullable<CertificationFixture["db"]["tx"]>>[0]; readonly feature: string }
        >
      > = {
        TX020: { value: { isolation: "read-uncommitted" }, feature: "transaction.isolation.read-uncommitted" },
        TX021: { value: { readOnly: true }, feature: "transaction.read-only" },
        TX022: {
          value: { isolation: "read-committed", readOnly: true },
          feature: "transaction.isolation.read-committed",
        },
        TX023: { value: { isolation: "read-committed" }, feature: "transaction.isolation.read-committed" },
        TX024: { value: { isolation: "repeatable-read" }, feature: "transaction.isolation.repeatable-read" },
        TX025: { value: { isolation: "serializable" }, feature: "transaction.isolation.serializable" },
        TX026: { value: { readOnly: false }, feature: "transaction.read-only" },
        TX027: {
          value: { isolation: "read-uncommitted", readOnly: true },
          feature: "transaction.isolation.read-uncommitted",
        },
        TX028: { value: { isolation: "serializable", readOnly: true }, feature: "transaction.isolation.serializable" },
        TX029: {
          value: { isolation: "read-uncommitted", readOnly: false },
          feature: "transaction.isolation.read-uncommitted",
        },
        TX030: {
          value: { isolation: "read-committed", readOnly: false },
          feature: "transaction.isolation.read-committed",
        },
        TX031: {
          value: { isolation: "repeatable-read", readOnly: true },
          feature: "transaction.isolation.repeatable-read",
        },
        TX032: {
          value: { isolation: "repeatable-read", readOnly: false },
          feature: "transaction.isolation.repeatable-read",
        },
        TX033: { value: { isolation: "serializable", readOnly: false }, feature: "transaction.isolation.serializable" },
      };
      for (const [id, option] of Object.entries(options))
        unsupported[id as CertificationCaseId] = probe(
          () => db.tx(option.value, async () => undefined),
          option.feature,
          "BRAID_TX_OPTION_UNSUPPORTED",
          () => stats.prepares,
        );
      const bulk: BulkConformanceFixture<unknown> = {
        db,
        inputs: [1, 2],
        factory: (input) => sql.command`INSERT INTO cert_values (value) VALUES (${String(input)})`,
        expected: { inputCount: 2, affectedRows: 2 },
        acquireCount: () => stats.batches,
        executeCount: () => stats.batches,
        middleFailure: async () => {
          await db.execute(sql.command`DELETE FROM cert_values`);
          let error: unknown;
          try {
            await db.bulk([1, 2], (input) =>
              input === 2
                ? sql.command`INSERT INTO cert_missing_bulk (value) VALUES (${input})`
                : sql.command`INSERT INTO cert_values (value) VALUES (${input})`,
            );
          } catch (caught) {
            error = caught;
          }
          if (error === undefined) throw new Error("D1 bulk middle-item failure was not observed.");
          const rows = await db.all(sql.rows<{ readonly value: number }>`SELECT value FROM cert_values`);
          if (rows.length !== 0 && rows.length !== 1)
            throw new Error(`D1 bulk middle-item durability was not prefix or atomic: ${rows.length} rows.`);
          const expectedRows = rows.length === 0 ? [] : rows;
          return {
            error,
            observedRows: rows,
            expectedRows,
            durability: rows.length === 0 ? ("atomic" as const) : ("prefix" as const),
          };
        },
      };
      const metrics = {
        snapshot: (): ResourceSnapshot => ({ borrowedLeases: 0, cleanupBalance: 0 }),
        sideEffects: () => stats.prepares,
        mutationSentinel: async () => {
          const row = await db.one(
            sql.rows<{ readonly marker: string }>`SELECT marker FROM cert_sentinel WHERE id = 1`,
          );
          return row.marker;
        },
        physicalSessionIds: () => ["cloudflare-d1"],
      };
      return {
        db,
        queries,
        bulk,
        metrics,
        reset: async () => {
          await db.execute(sql.command`DELETE FROM cert_values`);
          await db.execute(sql.command`UPDATE cert_sentinel SET marker = 'untouched' WHERE id = 1`);
        },
        unsupported,
        guarded: {
          "numeric.exact-integer": {
            prove: async () => {
              const row = (await db.one(sql.rows`SELECT CAST(${D1_EXACT_INTEGER} AS INTEGER) AS value`)) as {
                readonly value: unknown;
              };
              if (row.value !== D1_EXACT_INTEGER) throw new Error("D1 exact-integer guarded proof failed.");
              let error: unknown;
              try {
                await db.one(sql.rows`SELECT CAST(${9007199254740992} AS INTEGER) AS value`);
              } catch (caught) {
                error = caught;
              }
              if (!(error instanceof RangeError) || !error.message.includes("BRAID_INTEGER_UNSAFE")) {
                throw new Error("D1 exact-integer guard did not reject an unsafe integer.", { cause: error });
              }
            },
          },
          "numeric.approximate-float": {
            prove: async () => {
              const row = (await db.one(sql.rows`SELECT CAST(${1.5} AS REAL) AS value`)) as { readonly value: unknown };
              if (row.value !== 1.5) throw new Error("D1 approximate-float guarded proof failed.");
            },
          },
          "numeric.bind-exact": {
            prove: async () => {
              const row = (await db.one(sql.rows`SELECT ${D1_EXACT_INTEGER} AS value`)) as { readonly value: unknown };
              if (row.value !== D1_EXACT_INTEGER) throw new Error("D1 bind-exact guarded proof failed.");
            },
          },
        },
      };
    },
  };
}
