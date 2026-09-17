import { Buffer } from "node:buffer";
import type {
  CommandQuery,
  CallQuery,
  EnvironmentCapability,
  RowQuery,
  SqlTag,
  TransactionOptions,
} from "@sqlbraid/core";
import { assertSavepointName } from "@sqlbraid/core/driver";
import { createBunSqlDatabase, type BunSqlClient, type BunSqlDialect, type BunSqlReservedClient } from "@sqlbraid/bun-sql";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type {
  CertificationCaseId,
  CertificationFixture,
  CertificationTarget,
  TransactionOptionKey,
  UnsupportedProbe,
} from "../types.js";

export interface BunCertificationTargetOptions {
  readonly dialect: BunSqlDialect;
  readonly sourceSha: string;
  readonly tag: SqlTag;
  readonly createClient: () => BunSqlClient;
}

interface Counters {
  borrowed: number;
  cleanupBalance: number;
  sideEffects: number;
  failRollbackNative: boolean;
  nativeRollbackClosed: boolean;
  rollbackError?: unknown;
}

/** Independent contract: this is intentionally not read from environment(). */
import { BUN_EXPECTED_CAPABILITIES, BUN_EXPECTED_GUARDED_CASES, BUN_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

export const expectedCapabilities = BUN_EXPECTED_CAPABILITIES;
export const expectedTransactionOptions = BUN_EXPECTED_TRANSACTION_OPTIONS;
export const expectedGuardedCases = BUN_EXPECTED_GUARDED_CASES;

function instrument(
  client: BunSqlClient,
  counters: Counters,
  leased = false,
  configureReserved?: (reserved: BunSqlClient) => Promise<void>,
): BunSqlClient {
  const wrapped = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    counters.sideEffects += 1;
    return client(strings, ...values);
  }) as BunSqlClient;
  wrapped.unsafe = async <T = unknown>(text: string, values: readonly unknown[] = []) => {
    counters.sideEffects += 1;
    if (counters.failRollbackNative && /^\s*ROLLBACK\b/iu.test(text)) {
      counters.failRollbackNative = false;
      counters.nativeRollbackClosed = true;
      try {
        await client.close?.({ timeout: 0 });
      } catch {
        // Continue to the native rollback call so the driver supplies the fault.
      }
      try {
        return await client.unsafe<T>(text, values);
      } catch (error) {
        counters.rollbackError = error;
        throw error;
      }
    }
    return client.unsafe<T>(text, values);
  };
  Object.defineProperty(wrapped, "options", { value: client.options });
  if (client.close) {
    wrapped.close = async (options) => {
      await client.close!(options);
      if (leased) {
        counters.borrowed -= 1;
        counters.cleanupBalance -= 1;
      }
    };
  }
  if (client.reserve !== undefined) {
    wrapped.reserve = async () => {
      counters.sideEffects += 1;
      counters.borrowed += 1;
      counters.cleanupBalance += 1;
      try {
        const reserved = await client.reserve!();
        await configureReserved?.(reserved);
        const wrappedReserved = instrument(reserved, counters, true) as BunSqlReservedClient;
        const release = reserved.release.bind(reserved);
        wrappedReserved.release = async () => {
          await release();
          counters.borrowed -= 1;
          counters.cleanupBalance -= 1;
        };
        return wrappedReserved;
      } catch (error) {
        counters.borrowed -= 1;
        counters.cleanupBalance -= 1;
        throw error;
      }
    };
  }
  return wrapped;
}

function quoteIdentifier(dialect: BunSqlDialect, identifier: string): string {
  assertSavepointName(identifier);
  const quote = dialect === "mysql" || dialect === "mariadb" ? "`" : '"';
  return `${quote}${identifier}${quote}`;
}

function makeProbe(feature: string, run: () => Promise<unknown>, sideEffects: () => number, expectedCode: `BRAID_${string}`, expectedErrorFeature?: string): UnsupportedProbe {
  return { feature, expectedErrorFeature, expectedCode, run, sideEffects };
}

function nativeFailureCode(dialect: BunSqlDialect): string {
  if (dialect === "postgres") return "ERR_POSTGRES_SERVER_ERROR";
  if (dialect === "mysql" || dialect === "mariadb") return "ERR_MYSQL_SERVER_ERROR";
  return "SQLITE_ERROR";
}

function exactIntegerSql(dialect: BunSqlDialect): string {
  if (dialect === "postgres") return "SELECT CAST(9007199254740993 AS BIGINT) AS value";
  if (dialect === "mysql" || dialect === "mariadb") return "SELECT CAST(9007199254740993 AS SIGNED) AS value";
  return "SELECT CAST(9007199254740993 AS INTEGER) AS value";
}

function exactIntegerBindSql(dialect: BunSqlDialect): string {
  if (dialect === "postgres") return "SELECT CAST($1 AS BIGINT) AS value";
  if (dialect === "mysql" || dialect === "mariadb") return "SELECT CAST(? AS SIGNED) AS value";
  return "SELECT CAST(? AS INTEGER) AS value";
}

function exactIntegerQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(9007199254740993 AS BIGINT) AS value`;
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT CAST(9007199254740993 AS SIGNED) AS value`;
  return tag.rows`SELECT CAST(9007199254740993 AS INTEGER) AS value`;
}

function exactIntegerBindQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(${"9007199254740993"} AS BIGINT) AS value`;
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT CAST(${"9007199254740993"} AS SIGNED) AS value`;
  return tag.rows`SELECT CAST(${"9007199254740993"} AS INTEGER) AS value`;
}

function approximateFloatQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(1.5 AS DOUBLE PRECISION) AS value`;
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT CAST(1.5 AS DOUBLE) AS value`;
  return tag.rows`SELECT CAST(1.5 AS REAL) AS value`;
}

function approximateSpecialQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") {
    return tag.rows`SELECT CAST(${Number.NaN} AS DOUBLE PRECISION) AS nan, CAST(${Number.POSITIVE_INFINITY} AS DOUBLE PRECISION) AS pos_inf, CAST(${Number.NEGATIVE_INFINITY} AS DOUBLE PRECISION) AS neg_inf`;
  }
  if (dialect === "sqlite") return tag.rows`SELECT 1e999 AS pos_inf, -1e999 AS neg_inf`;
  return tag.rows`SELECT CAST(${Number.NaN} AS DOUBLE) AS nan, CAST(${Number.POSITIVE_INFINITY} AS DOUBLE) AS pos_inf, CAST(${Number.NEGATIVE_INFINITY} AS DOUBLE) AS neg_inf`;
}

function temporalQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(${"2026-09-14 12:34:56.789123"} AS TIMESTAMP) AS value`;
  return tag.rows`SELECT CAST(${"2026-09-14 12:34:56.789123"} AS DATETIME(6)) AS value`;
}

function timezoneQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(${"2026-09-14 12:34:56.789+05:30"} AS TIMESTAMPTZ) AS value`;
  return tag.rows`SELECT TIMESTAMP '2026-09-14 12:34:56.789' AS value`;
}

const temporalWallClockIso = new Date(2026, 8, 14, 12, 34, 56, 789).toISOString();
const temporalExpectedIso = (dialect: BunSqlDialect): string => dialect === "postgres"
  ? "2026-09-14T12:34:56.789Z"
  : temporalWallClockIso;

function assertExactDate(value: unknown, expectedIso: string, feature: string): asserts value is Date {
  if (!(value instanceof Date) || value.toISOString() !== expectedIso) {
    throw new Error(`Bun.SQL ${feature} profile changed: expected ${expectedIso}, got ${String(value)}.`);
  }
}

function exactDecimalQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT CAST('12345678901234567890.123456789' AS DECIMAL(30, 9)) AS value`;
  return tag.rows`SELECT CAST('12345678901234567890.123456789' AS NUMERIC) AS value`;
}

function exactDecimalBindQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT CAST(CAST(${"12345678901234567890.123456789"} AS NUMERIC) AS TEXT) AS value`;
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT CAST(CAST(${"12345678901234567890.123456789"} AS DECIMAL(30, 9)) AS CHAR) AS value`;
  // SQLite has no exact decimal type; the authored text contract preserves its digits.
  return tag.rows`SELECT CAST(${"12345678901234567890.123456789"} AS TEXT) AS value`;
}

function jsonQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") return tag.rows`SELECT '{"value": 1}'::jsonb AS value`;
  if (dialect === "mysql" || dialect === "mariadb") return tag.rows`SELECT JSON_OBJECT('value', 1) AS value`;
  return tag.rows`SELECT json_object('value', 1) AS value`;
}

async function nativeRow(client: BunSqlClient, sql: string, values: readonly unknown[] = []): Promise<Record<string, unknown>> {
  const rows = await client.unsafe<readonly Record<string, unknown>[]>(sql, values);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0] === undefined) throw new Error("Bun.SQL native proof did not return exactly one row.");
  return rows[0];
}

function optionKey(options: TransactionOptions): TransactionOptionKey {
  if (options.isolation !== undefined && options.readOnly !== undefined) return `combination:${options.isolation}+${options.readOnly ? "readOnly" : "readWrite"}` as TransactionOptionKey;
  if (options.isolation !== undefined) return `isolation:${options.isolation}` as TransactionOptionKey;
  return `readOnly:${options.readOnly === true ? "true" : "false"}`;
}

function optionFor(id: string): TransactionOptions {
  const options: Record<string, TransactionOptions> = {
    TX020: { isolation: "read-uncommitted" }, TX021: { readOnly: true }, TX022: { isolation: "read-committed", readOnly: true }, TX023: { isolation: "read-committed" }, TX024: { isolation: "repeatable-read" }, TX026: { readOnly: false }, TX027: { isolation: "read-uncommitted", readOnly: true }, TX028: { isolation: "serializable", readOnly: true }, TX029: { isolation: "read-uncommitted", readOnly: false }, TX030: { isolation: "read-committed", readOnly: false }, TX031: { isolation: "repeatable-read", readOnly: true }, TX032: { isolation: "repeatable-read", readOnly: false }, TX033: { isolation: "serializable", readOnly: false },
  };
  const selected = options[id];
  if (selected === undefined) throw new Error(`Unknown transaction option case ${id}.`);
  return selected;
}

function settingQuery(tag: SqlTag, dialect: BunSqlDialect): RowQuery<unknown> {
  if (dialect === "postgres") {
    return tag.rows`SELECT lower(current_setting('transaction_isolation')) AS value, current_setting('transaction_read_only') = 'on' AS read_only`;
  }
  return tag.rows`SELECT lower(replace(CAST(@@transaction_isolation AS CHAR), '-', ' ')) AS value, @@transaction_read_only <> 0 AS read_only`;
}

function expectedIsolation(dialect: BunSqlDialect, isolation: TransactionOptions["isolation"]): string {
  if (isolation === undefined) throw new Error("Bun.SQL transaction option proof requires an isolation level.");
  if (dialect === "postgres" && isolation === "read-uncommitted") return "read committed";
  return isolation.replaceAll("-", " ");
}

function nativeErrorHas(error: unknown, key: "errno" | "code", expected: number | string): boolean {
  if (error !== null && typeof error === "object") {
    if ((error as Record<string, unknown>)[key] === expected) return true;
    if (error instanceof AggregateError && error.errors.some((entry) => nativeErrorHas(entry, key, expected))) return true;
    if ("cause" in error && nativeErrorHas(error.cause, key, expected)) return true;
  }
  return false;
}

async function proveTransactionOption(
  db: CertificationFixture["db"],
  createClient: () => BunSqlClient,
  tag: SqlTag,
  dialect: BunSqlDialect,
  options: TransactionOptions,
  queries: CertificationFixture["queries"],
  visibleCount: RowQuery<unknown>,
  reset: () => Promise<void>,
): Promise<void> {
  if (dialect === "postgres") {
    const settings = await db.tx(options, async (tx) => tx.one(settingQuery(tag, dialect))) as {
      readonly value?: unknown;
      readonly read_only?: unknown;
    };
    const isolation = expectedIsolation(dialect, options.isolation);
    const postgresReadUncommittedAlias = options.isolation === "read-uncommitted"
      && (settings.value === "read committed" || settings.value === "read uncommitted");
    if (settings.value !== isolation && !postgresReadUncommittedAlias) {
      throw new Error(`Bun.SQL ${optionKey(options)} observed isolation=${String(settings.value)} instead of ${isolation}.`);
    }
    if (options.readOnly !== undefined && settings.read_only !== options.readOnly) {
      throw new Error(`Bun.SQL ${optionKey(options)} observed read_only=${String(settings.read_only)} instead of ${String(options.readOnly)}.`);
    }
    return;
  }
  const otherClient = createClient();
  const otherDb = createBunSqlDatabase(otherClient, { dialect });
  let observedCount = "";
  let observedBefore = "";
  let observedError: unknown;
  try {
    if (queries.transaction === undefined) throw new Error("Bun.SQL isolation proof requires transaction queries.");
    if (options.isolation === "serializable") {
      await otherDb.tx(async (writer) => {
        await writer.execute(queries.transaction!.insert);
        try {
          await db.tx(options, async (reader) => {
            await reader.one(visibleCount);
          });
        } catch (error) {
          observedError = error;
        }
        throw new Error("cert-isolation-rollback");
      }).catch((error) => {
        if (!(error instanceof Error) || error.message !== "cert-isolation-rollback") throw error;
      });
    } else {
      if (options.isolation === "read-uncommitted") {
        await otherDb.tx(async (writer) => {
          await writer.execute(queries.transaction!.insert);
          try {
            const row = await db.tx(options, (mainTx) => mainTx.one(visibleCount));
            observedCount = String((row as { readonly count?: unknown }).count);
          } catch (error) {
            observedError = error;
          }
          throw new Error("cert-isolation-rollback");
        }).catch((error) => {
          if (!(error instanceof Error) || error.message !== "cert-isolation-rollback") throw error;
        });
      } else {
        const ready = Promise.withResolvers<void>();
        const continueReading = Promise.withResolvers<void>();
        const reader = db.tx(options, async (tx) => {
          const first = await tx.one(visibleCount);
          observedBefore = String((first as { readonly count?: unknown }).count);
          ready.resolve();
          await continueReading.promise;
          const second = await tx.one(visibleCount);
          observedCount = String((second as { readonly count?: unknown }).count);
        });
        await ready.promise;
        await otherDb.tx(async (writer) => { await writer.execute(queries.transaction!.insert); });
        continueReading.resolve();
        await reader;
        await reset();
        if (observedBefore !== "0") throw new Error(`Bun.SQL ${optionKey(options)} baseline count=${observedBefore} was not empty.`);
        return;
      }
    }
  } finally {
    await otherClient.close?.();
  }
  if (options.isolation === "serializable") {
    if (!(observedError instanceof Error)
      || (observedError as { readonly code?: unknown }).code !== nativeFailureCode(dialect)
      || !nativeErrorHas(observedError, "errno", 1205)) {
      throw new Error(`Bun.SQL ${optionKey(options)} did not enforce serializable locking.`);
    }
    return;
  }
  const expectedCount = options.isolation === "read-uncommitted" ? "1" : "0";
  if (observedCount !== expectedCount) {
    throw new Error(`Bun.SQL ${optionKey(options)} observed count=${observedCount} instead of ${expectedCount}.`);
  }
}

async function createFixture(options: BunCertificationTargetOptions): Promise<CertificationFixture> {
  const { dialect, tag } = options;
  const counters: Counters = {
    borrowed: 0,
    cleanupBalance: 0,
    sideEffects: 0,
    failRollbackNative: false,
    nativeRollbackClosed: false,
  };
  const configureReserved = dialect === "mysql" || dialect === "mariadb"
    ? async (reserved: BunSqlClient): Promise<void> => {
      await reserved.unsafe("SET SESSION innodb_lock_wait_timeout = 1", []);
    }
    : undefined;
  const client = instrument(options.createClient(), counters, false, configureReserved);
  const table = `braid_cert_${dialect}_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const sentinelTable = `${table}_sentinel`;
  const sentinelValue = `sentinel-${table}`;
  assertSavepointName(table);
  assertSavepointName(sentinelTable);
  const tableSql = tag.raw(quoteIdentifier(dialect, table));
  const missingSql = tag.raw(quoteIdentifier(dialect, `${table}_missing`));
  const idColumn = dialect === "postgres"
    ? "id SERIAL PRIMARY KEY"
    : dialect === "mysql" || dialect === "mariadb"
      ? "id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY"
      : "id INTEGER PRIMARY KEY";
  await client.unsafe(`CREATE TABLE ${quoteIdentifier(dialect, table)} (${idColumn}, value TEXT CHECK (value <> 'middle-failure'))`, []);
  await client.unsafe(`CREATE TABLE ${quoteIdentifier(dialect, sentinelTable)} (id INTEGER PRIMARY KEY, value TEXT, marker INTEGER NOT NULL)`, []);
  await client.unsafe(`INSERT INTO ${quoteIdentifier(dialect, sentinelTable)} (id, value, marker) VALUES (1, '${sentinelValue.replaceAll("'", "''")}', 7)`, []);
  counters.sideEffects = 0;
  const rawDb = createBunSqlDatabase(client, { dialect });
  let bulkExecutions = 0;
  const db = new Proxy(rawDb, {
    get(target, property, receiver) {
      if (property === "bulk") {
        return (inputs: readonly unknown[], factory: (input: unknown, index: number) => CommandQuery) => {
          if (inputs.length > 0) bulkExecutions += 1;
          return target.bulk(inputs, factory);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const reset = async (): Promise<void> => {
    await client.unsafe(`DELETE FROM ${quoteIdentifier(dialect, table)}`, []);
    counters.sideEffects = 0;
  };
  const expectedOne = { value: "one" };
  const expectedMany = [{ value: "one" }, { value: "two" }];
  const emptyResultError = dialect === "mysql" || dialect === "mariadb"
    ? { feature: "result.rows", code: "BRAID_RESULT_KIND_AMBIGUOUS" } as const
    : undefined;
  const special: Record<string, RowQuery<unknown>> = {
    RES001: tag.rows`SELECT ${"safe"} AS ${tag.ident("__proto__")}`,
    RES002: tag.rows`SELECT ${"safe"} AS ${tag.ident("constructor")}`,
    RES003: tag.rows`SELECT ${"safe"} AS ${tag.ident("prototype")}`,
    RES004: tag.rows`SELECT ${"safe"} AS ${tag.ident("toString")}`,
    RES005: tag.rows`SELECT ${"safe"} AS ${tag.ident("hasOwnProperty")}`,
    RES006: tag.rows`SELECT ${"hello"} AS value_text`,
    RES007: tag.rows`SELECT ${""} AS value_empty`,
    RES008: tag.rows`SELECT ${null} AS value_null`,
    RES009: tag.rows`SELECT ${"안녕하세요"} AS value_unicode`,
    RES010: tag.rows`SELECT ${dialect === "postgres" ? tag.raw("decode('00ff10', 'hex')") : dialect === "sqlite" ? tag.raw("X'00ff10'") : tag.raw("UNHEX('00ff10')")} AS value_binary`,
    RES011: tag.rows`SELECT ${"second"} AS value`,
  };
  const expectedSpecial: Record<string, unknown> = {
    RES001: Object.fromEntries([["__proto__", "safe"]]),
    RES002: Object.fromEntries([["constructor", "safe"]]),
    RES003: Object.fromEntries([["prototype", "safe"]]),
    RES004: Object.fromEntries([["toString", "safe"]]),
    RES005: Object.fromEntries([["hasOwnProperty", "safe"]]),
    RES006: { value_text: "hello" }, RES007: { value_empty: "" }, RES008: { value_null: null }, RES009: { value_unicode: "안녕하세요" }, RES010: { value_binary: dialect === "postgres" ? Buffer.from([0, 255, 16]) : new Uint8Array([0, 255, 16]) }, RES011: { value: "second" },
  };
  let preparedCalls = 0;
  const queries = {
    zero: tag.rows`SELECT ${"zero"} AS value WHERE 1 = 0`,
    one: tag.rows`SELECT ${"one"} AS value`,
    many: tag.rows`SELECT ${"one"} AS value UNION ALL SELECT ${"two"} AS value`,
    command: tag.command`INSERT INTO ${tableSql} (value) VALUES (${"command"})`,
    identity: dialect === "postgres" ? tag.rows<{ readonly id: string }>`SELECT CAST(pg_backend_pid() AS TEXT) AS id` : dialect === "mysql" || dialect === "mariadb" ? tag.rows<{ readonly id: string }>`SELECT CAST(CONNECTION_ID() AS CHAR) AS id` : tag.rows<{ readonly id: string }>`SELECT 'bun-sqlite-direct' AS id`,
    failure: tag.rows`SELECT * FROM ${missingSql}`,
    stream: tag.rows`SELECT ${"stream-one"} AS value UNION ALL SELECT ${"stream-two"} AS value`,
    special,
    transaction: {
      insert: tag.command`INSERT INTO ${tableSql} (value) VALUES ('transaction')`,
      visible: tag.rows`SELECT value FROM ${tableSql} ORDER BY id`,
      savepointInsert: tag.command`INSERT INTO ${tableSql} (value) VALUES ('savepoint')`,
      savepointVisible: tag.rows`SELECT value FROM ${tableSql} ORDER BY id`,
    },
    prepared: {
      command: (input: unknown): CommandQuery => { preparedCalls += 1; return tag.command`INSERT INTO ${tableSql} (value) VALUES (${input})`; },
      rows: (input: unknown): RowQuery<unknown> => { preparedCalls += 1; return tag.rows`SELECT ${input} AS value UNION ALL SELECT 'two' AS value`; },
      input: "one",
      factoryCalls: () => preparedCalls,
    },
    routines: {
      call: tag.call`CALL braid_cert_missing()`,
      out: tag.call`CALL braid_cert_missing(${tag.out("answer")})`,
      inout: tag.call`CALL braid_cert_missing(${tag.inOut("answer", 1)})`,
      resultSets: tag.call`CALL braid_cert_missing()`,
      cursor: tag.call`CALL braid_cert_missing()`,
      returnValue: tag.call`CALL braid_cert_missing()`,
    },
    fidelity: {
      largeExactInteger: exactIntegerBindQuery(tag, dialect),
      exactDecimal: exactDecimalBindQuery(tag, dialect),
      temporal: dialect === "sqlite" ? tag.rows`SELECT ${"2026-09-14T12:34:56.789Z"} AS value` : temporalQuery(tag, dialect),
      injection: tag.rows`SELECT ${`'; UPDATE ${quoteIdentifier(dialect, sentinelTable)} SET marker = 999 WHERE id = 1; -- `} AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740993" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: dialect === "sqlite" ? "2026-09-14T12:34:56.789Z" : new Date(temporalWallClockIso) },
        injection: { value: `'; UPDATE ${quoteIdentifier(dialect, sentinelTable)} SET marker = 999 WHERE id = 1; -- ` },
      },
    },
    expected: {
      one: expectedOne,
      many: expectedMany,
      special: expectedSpecial,
      specialErrors: dialect === "mysql" || dialect === "mariadb" ? { RES010: { code: "BRAID_RESULT_EXACTNESS" } } : undefined,
      commandAffectedRows: 1,
      failureCode: nativeFailureCode(dialect),
      emptyResultError,
    },
  };
  const transactionVisibleCount = tag.rows`SELECT CAST(COUNT(*) AS CHAR) AS count FROM ${tableSql}`;
  const unsupported: Partial<Record<CertificationCaseId, UnsupportedProbe>> = {};
  const streamIds: readonly CertificationCaseId[] = ["PRE003", "PRE004", "PRE005", "PRE011", "SES007", "STR001", "STR002", "STR003", "STR004", "STR005", "STR007", "STR008", "STR009", "STR011", "STRESS004"];
  for (const id of streamIds) {
    unsupported[id] = makeProbe("statement.stream", async () => {
      const stream = db.stream(queries.stream);
      await stream[Symbol.asyncIterator]().next();
    }, () => counters.sideEffects, "BRAID_STREAM_UNSUPPORTED");
  }
  unsupported.STR006 = makeProbe("statement.cancel", () => db.execute(queries.one, { signal: new AbortController().signal }), () => counters.sideEffects, "BRAID_CANCEL_UNSUPPORTED");
  unsupported.STR010 = makeProbe("statement.cancel", () => db.execute(queries.one, { signal: new AbortController().signal }), () => counters.sideEffects, "BRAID_CANCEL_UNSUPPORTED");
  const routineCases: readonly [CertificationCaseId, string, CallQuery][] = [
    ["CALL001", "routine.call", queries.routines.call], ["CALL002", "routine.out", queries.routines.out], ["CALL003", "routine.inout", queries.routines.inout], ["CALL004", "routine.result-sets", queries.routines.resultSets], ["CALL005", "routine.out-cursor", queries.routines.cursor], ["CALL006", "routine.return-value", queries.routines.returnValue],
  ];
  for (const [id, feature, query] of routineCases) unsupported[id] = makeProbe(feature, () => db.call(query), () => counters.sideEffects, "BRAID_CALL_UNSUPPORTED", "routine.call");
  unsupported.PRE008 = makeProbe("routine.call", () => db.call(queries.routines.call), () => counters.sideEffects, "BRAID_CALL_UNSUPPORTED", "routine.call");
  unsupported.CALL007 = makeProbe("routine.call", () => db.call(queries.routines.call), () => counters.sideEffects, "BRAID_CALL_UNSUPPORTED", "routine.call");
  if (dialect === "sqlite") {
    const optionCases: readonly CertificationCaseId[] = ["TX020", "TX021", "TX022", "TX023", "TX024", "TX026", "TX027", "TX028", "TX029", "TX030", "TX031", "TX032", "TX033"];
    for (const id of optionCases) {
      const transactionOptions = optionFor(id);
      const rejectionFeature = transactionOptions.readOnly !== undefined && transactionOptions.isolation === "serializable"
        ? "transaction.read-only"
        : transactionOptions.isolation === undefined ? "transaction.read-only" : `transaction.isolation.${transactionOptions.isolation}`;
      unsupported[id] = makeProbe(rejectionFeature, () => db.tx(transactionOptions, async (tx) => { await tx.one(queries.identity); }), () => counters.sideEffects, "BRAID_TX_OPTION_UNSUPPORTED");
    }
  }
  const bulkValues: unknown[][] = [];
  const approximateSpecialProof = async (): Promise<void> => {
    if (dialect === "postgres") {
      const value = await db.one(approximateSpecialQuery(tag, dialect));
      const row = value as { readonly nan?: unknown; readonly pos_inf?: unknown; readonly neg_inf?: unknown };
      if (!Number.isNaN(row.nan) || row.pos_inf !== Infinity || row.neg_inf !== -Infinity) throw new Error("Bun.SQL PostgreSQL special-float guard failed.");
      return;
    }
    if (dialect === "sqlite") {
      const value = await db.one(approximateSpecialQuery(tag, dialect));
      const row = value as { readonly pos_inf?: unknown; readonly neg_inf?: unknown };
      if (row.pos_inf !== Infinity || row.neg_inf !== -Infinity) throw new Error("Bun.SQL SQLite special-float guard failed.");
      return;
    }
    let value: Record<string, unknown>;
    try {
      value = await nativeRow(client, "SELECT CAST(? AS DOUBLE) AS nan, CAST(? AS DOUBLE) AS pos_inf, CAST(? AS DOUBLE) AS neg_inf", [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    } catch (error) {
      if (dialect !== "mysql" || !(error instanceof Error) || (error as { readonly code?: unknown }).code !== "ERR_MYSQL_SERVER_ERROR") throw error;
      return;
    }
    if (value.nan !== null || typeof value.pos_inf !== "number" || typeof value.neg_inf !== "number"
      || !Number.isFinite(value.pos_inf) || !Number.isFinite(value.neg_inf)) {
      throw new Error(`Bun.SQL ${dialect} special-float lossiness profile changed.`);
    }
  };
  const guarded: NonNullable<CertificationFixture["guarded"]> = {
    "numeric.exact-integer": { prove: async () => {
      const raw = await nativeRow(client, exactIntegerSql(dialect));
      if (raw.value !== 9007199254740993n) throw new Error("Bun.SQL exact-integer native width guard failed.");
      const value = await db.one(exactIntegerQuery(tag, dialect));
      if ((value as { readonly value?: unknown }).value !== "9007199254740993") throw new Error("Bun.SQL exact-integer canonical guard failed.");
    } },
    "numeric.approximate-float": { prove: async () => {
      const value = await db.one(approximateFloatQuery(tag, dialect));
      if (!Object.is((value as { readonly value?: unknown }).value, 1.5)) throw new Error("Bun.SQL float guard failed.");
    } },
    "numeric.bind-exact": { prove: async () => {
      const raw = await nativeRow(client, exactIntegerBindSql(dialect), ["9007199254740993"]);
      if (raw.value !== 9007199254740993n) throw new Error("Bun.SQL exact bind native width guard failed.");
      const value = await db.one(exactIntegerBindQuery(tag, dialect));
      if ((value as { readonly value?: unknown }).value !== "9007199254740993") throw new Error("Bun.SQL exact bind canonical guard failed.");
    } },
    ...(dialect === "postgres" || dialect === "sqlite" ? { "numeric.approximate-special": { prove: approximateSpecialProof } } : {}),
    "numeric.command-metadata": { prove: async () => {
      const result = await db.execute(queries.command);
      if (!Number.isSafeInteger(result.command.affectedRows)) throw new Error("Bun.SQL command-count guard failed.");
      await reset();
    } },
    ...(dialect !== "postgres" ? {
      "result.rows": { prove: async () => { const result = await db.all(queries.one); if (result.length !== 1) throw new Error("Bun.SQL row-kind proof did not return one row."); } },
      "result.command": { prove: async () => { const result = await db.execute(queries.command); if (result.kind !== "command" || result.command.affectedRows !== 1) throw new Error("Bun.SQL command-kind proof did not return one affected row."); await reset(); } },
    } : {}),
    "metadata.command-safe": { prove: async () => { const result = await db.execute(queries.command); if (!Number.isSafeInteger(result.command.affectedRows)) throw new Error("Bun.SQL command metadata was not safe."); await reset(); } },
    "execution.bulk-fidelity": { prove: async () => { const result = await db.bulk(["proof-one", "proof-two"], (input) => tag.command`INSERT INTO ${tableSql} (value) VALUES (${input})`); if (result.inputCount !== 2 || result.affectedRows !== 2) throw new Error("Bun.SQL bulk fidelity proof failed."); await reset(); } },
  };
  if (dialect === "postgres" || dialect === "mysql") {
    guarded["data.json-parsed"] = { prove: async () => {
      const row = await db.one(tag.rows`SELECT ${tag.raw(dialect === "postgres" ? "'{\"value\": 1}'::jsonb" : "JSON_OBJECT('value', 1)")} AS value`);
      if (row === null || typeof (row as { readonly value?: unknown }).value !== "object") throw new Error("Bun.SQL JSON parser guard failed.");
    } };
  }
  const representationUnsupported: NonNullable<CertificationFixture["representationUnsupported"]> = {};
  if (dialect === "mysql" || dialect === "mariadb" || dialect === "sqlite") {
    representationUnsupported["numeric.exact-decimal"] = { prove: async () => {
      let value: unknown;
      try {
        value = (await db.one(exactDecimalQuery(tag, dialect))) as { readonly value?: unknown };
      } catch (error) {
        if (!(error instanceof Error) || (error as { readonly code?: unknown }).code !== "BRAID_RESULT_EXACTNESS") throw error;
        return;
      }
      if (dialect === "sqlite") {
        if (typeof (value as { readonly value?: unknown }).value !== "number") throw new Error("Bun.SQL SQLite decimal representation changed.");
        return;
      }
      throw new Error("Bun.SQL decimal representation unexpectedly normalized.");
    } };
  }
  if (dialect === "mysql" || dialect === "mariadb" || dialect === "sqlite") {
    representationUnsupported["data.json-parsed"] = { prove: async () => {
      const row = await db.one(jsonQuery(tag, dialect));
      if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error(`Bun.SQL ${dialect} JSON representation changed.`);
    } };
  }
  if (dialect === "postgres" || dialect === "mysql" || dialect === "mariadb") {
    representationUnsupported["data.json-lossless-text"] = { prove: async () => {
      const row = await db.one(jsonQuery(tag, dialect));
      if ((row as { readonly value?: unknown }).value === null || typeof (row as { readonly value?: unknown }).value !== "object") {
        throw new Error(`Bun.SQL ${dialect} JSON parser representation changed.`);
      }
    } };
    representationUnsupported["data.temporal-lossless"] = { prove: async () => {
      const row = await db.one(temporalQuery(tag, dialect));
      assertExactDate((row as { readonly value?: unknown }).value, temporalExpectedIso(dialect), `${dialect} temporal`);
    } };
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    representationUnsupported["data.binary"] = { prove: async () => {
      try {
        await db.one(queries.special.RES010!);
      } catch (error) {
        if (error instanceof Error && (error as { readonly code?: unknown }).code === "BRAID_RESULT_EXACTNESS") return;
        throw error;
      }
      throw new Error(`Bun.SQL ${dialect} binary representation unexpectedly normalized.`);
    } };
    representationUnsupported["numeric.approximate-special"] = { prove: approximateSpecialProof };
  }
  const nativeReturningUnsupported = async (operation: "insert" | "update" | "delete"): Promise<void> => {
    const statements = {
      insert: `INSERT INTO ${quoteIdentifier(dialect, table)} (value) VALUES (?) RETURNING id`,
      update: `UPDATE ${quoteIdentifier(dialect, table)} SET value = ? WHERE id = 1 RETURNING id`,
      delete: `DELETE FROM ${quoteIdentifier(dialect, table)} WHERE id = ? RETURNING id`,
    };
    try {
      await client.unsafe(statements[operation], [`native-${operation}`]);
    } catch (error) {
      if (error instanceof Error && (error as { readonly code?: unknown }).code === "ERR_MYSQL_SYNTAX_ERROR") return;
      throw error;
    }
    throw new Error(`Bun.SQL ${dialect} unexpectedly accepted ${operation.toUpperCase()} RETURNING.`);
  };
  if (dialect === "mysql") {
    representationUnsupported["dml.insert-returning"] = { prove: () => nativeReturningUnsupported("insert") };
    representationUnsupported["dml.update-returning"] = { prove: () => nativeReturningUnsupported("update") };
    representationUnsupported["dml.delete-returning"] = { prove: () => nativeReturningUnsupported("delete") };
  } else if (dialect === "mariadb") {
    representationUnsupported["dml.update-returning"] = { prove: () => nativeReturningUnsupported("update") };
  }
  if (dialect === "sqlite") {
    representationUnsupported["data.temporal-native"] = { prove: async () => {
      const row = await db.one(tag.rows`SELECT datetime('2026-09-14 12:34:56.789') AS value`);
      if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error("Bun.SQL SQLite temporal representation changed.");
    } };
    representationUnsupported["data.timezone"] = { prove: async () => {
      const row = await db.one(tag.rows`SELECT '2026-09-14 12:34:56.789+05:30' AS value`);
      if (typeof (row as { readonly value?: unknown }).value !== "string") throw new Error("Bun.SQL SQLite timezone representation changed.");
    } };
  }
  if (dialect !== "sqlite") {
    guarded["data.temporal-native"] = { prove: async () => {
      const row = await db.one(temporalQuery(tag, dialect));
      assertExactDate((row as { readonly value?: unknown }).value, temporalExpectedIso(dialect), "temporal");
    } };
    guarded["data.timezone"] = { prove: async () => {
      const row = await db.one(timezoneQuery(tag, dialect));
      const value = (row as { readonly value?: unknown }).value;
      assertExactDate(value, dialect === "postgres" ? "2026-09-14T07:04:56.789Z" : temporalWallClockIso, `${dialect} timezone`);
    } };
  }
  if (dialect === "postgres" || dialect === "mysql" || dialect === "mariadb") {
    for (const isolation of ["read-uncommitted", "read-committed", "repeatable-read", "serializable"] as const) {
      guarded[`transaction.isolation.${isolation}`] = { prove: () => proveTransactionOption(db, options.createClient, tag, dialect, { isolation }, queries, transactionVisibleCount, reset) };
    }
    guarded["transaction.read-only"] = { prove: async () => {
      if (dialect === "postgres") {
        const settings = await db.tx({ readOnly: true }, async (tx) => tx.one(settingQuery(tag, dialect))) as { readonly read_only?: unknown };
        if (settings.read_only !== true) throw new Error("Bun.SQL PostgreSQL read-only setting was not active inside the transaction.");
      }
      let caught: unknown;
      try { await db.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.insert); }); } catch (error) { caught = error; }
      if (!(caught instanceof Error) || (caught as { readonly code?: unknown }).code !== nativeFailureCode(dialect)
        || (dialect !== "postgres" && !nativeErrorHas(caught, "errno", 1792))) {
        throw new Error("Bun.SQL read-only transaction did not reject the write with the native error.");
      }
    } };
  }
  const mutationSentinel = async (): Promise<unknown> => {
    const rows = await client.unsafe<readonly Record<string, unknown>[]>(`SELECT id, value, marker FROM ${quoteIdentifier(dialect, sentinelTable)} ORDER BY id`, []);
    if (!Array.isArray(rows) || rows.length !== 1 || String(rows[0]?.id) !== "1" || rows[0]?.value !== sentinelValue || Number(rows[0]?.marker) !== 7) {
      throw new Error("Bun.SQL injection mutation sentinel changed.");
    }
    return { id: "1", value: sentinelValue, marker: 7 };
  };
  const transactionCleanup = async (): Promise<void> => {
    const primary = new Error("cert-transaction-primary");
    const peer = dialect === "sqlite" ? undefined : await client.reserve!();
    const identitySql = dialect === "postgres"
      ? "SELECT pg_backend_pid()::text AS id"
      : "SELECT CAST(CONNECTION_ID() AS CHAR) AS id";
    counters.failRollbackNative = true;
    counters.rollbackError = undefined;
    let caught: unknown;
    try {
      const before = peer === undefined ? undefined
        : (await peer.unsafe<readonly { readonly id: string }[]>(identitySql))[0]?.id;
      try {
        await db.tx(async () => { throw primary; });
      } catch (error) {
        caught = error;
      }
      if (peer !== undefined) {
        const after = (await peer.unsafe<readonly { readonly id: string }[]>(identitySql))[0]?.id;
        if (before === undefined || !/^\d+$/u.test(before) || after !== before) {
          throw new Error("Bun.SQL discarded another reservation's physical session.");
        }
      }
    } finally {
      await peer?.release();
    }
    const contains = (value: unknown, predicate: (candidate: unknown) => boolean): boolean => {
      if (predicate(value)) return true;
      if (value instanceof AggregateError) return value.errors.some((error) => contains(error, predicate));
      if (value instanceof Error && "cause" in value) return contains(value.cause, predicate);
      return false;
    };
    if (!(caught instanceof AggregateError)
      || !contains(caught, (error) => error === primary)
      || counters.rollbackError === undefined
      || !contains(caught, (error) => error === counters.rollbackError)) {
      throw new Error("Bun.SQL transaction cleanup did not preserve primary and cleanup errors.");
    }
    if (counters.borrowed !== 0 || counters.cleanupBalance !== 0) {
      throw new Error(`Bun.SQL transaction cleanup leaked resources: borrowed=${counters.borrowed}, balance=${counters.cleanupBalance}.`);
    }
  };
  const readOnlyWrite = async (): Promise<void> => {
    if (!queries.transaction) throw new Error("Bun.SQL read-only proof requires transaction queries.");
    await reset();
    await db.tx(async (tx) => { await tx.execute(queries.transaction!.insert); });
    const committed = await db.all(queries.transaction.visible);
    if (committed.length !== 1) throw new Error("Bun.SQL read-write transaction did not commit its write.");
    let caught: unknown;
    try {
      await db.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.insert); });
    } catch (error) {
      caught = error;
    }
    if (dialect === "sqlite") {
      if ((caught as { readonly code?: unknown }).code !== "BRAID_TX_OPTION_UNSUPPORTED"
        || (caught as { readonly feature?: unknown }).feature !== "transaction.read-only") {
        throw new Error("Bun.SQL SQLite read-only transaction did not reject with its public unsupported contract.");
      }
    } else if (!(caught instanceof Error)
      || (caught as { readonly code?: unknown }).code !== nativeFailureCode(dialect)
      || (dialect !== "postgres" && !nativeErrorHas(caught, "errno", 1792))) {
      throw new Error("Bun.SQL read-only transaction did not reject the write with the native error.");
    }
    const visible = await db.all(queries.transaction.visible);
    if (visible.length !== 1) throw new Error("Bun.SQL read-only transaction changed committed state.");
    await reset();
  };
  const metrics = {
    snapshot: () => ({ borrowedLeases: counters.borrowed, cleanupBalance: counters.cleanupBalance }),
    sideEffects: () => counters.sideEffects,
    mutationSentinel,
    transactionCleanup,
    readOnlyWrite,
  } as CertificationFixture["metrics"];
  const fixture: CertificationFixture = {
    db,
    queries,
    metrics,
    representationUnsupported,
    reset,
    unsupported,
    guarded,
    bulk: {
      db,
      inputs: ["bulk-one", "bulk-two"],
      factory: (input: unknown) => {
        bulkValues.push([input]);
        return tag.command`INSERT INTO ${tableSql} (value) VALUES (${input})`;
      },
      expected: { inputCount: 2, affectedRows: 2 },
      acquireCount: () => bulkExecutions,
      executeCount: () => bulkExecutions,
      middleFailure: async () => {
        await reset();
        let error: unknown;
        try {
          await db.bulk(["middle-one", "middle-failure", "middle-three"], (input) => {
            return tag.command`INSERT INTO ${tableSql} (value) VALUES (${input})`;
          });
        } catch (caught) {
          error = caught;
        }
        if (error === undefined) throw new Error("Bun.SQL bulk middle-item failure did not reject.");
        const observedRows = (await db.all(queries.transaction!.visible)).map((row) => (row as { readonly value?: unknown }).value);
        const expectedRows = ["middle-one"];
        if (JSON.stringify(observedRows) !== JSON.stringify(expectedRows)) throw new Error("Bun.SQL bulk middle-item durability changed.");
        return { error, observedRows, expectedRows, durability: "prefix" as const };
      },
      values: () => bulkValues,
    } as BulkConformanceFixture<unknown>,
    close: async () => {
      if (counters.nativeRollbackClosed && dialect === "sqlite") {
        await client.close?.();
        return;
      }
      try { await client.unsafe(`DROP TABLE ${quoteIdentifier(dialect, table)}`, []); }
      finally {
        try { await client.unsafe(`DROP TABLE ${quoteIdentifier(dialect, sentinelTable)}`, []); }
        // Bun 1.3.14 treats a zero pool-close timeout as graceful, even after native disconnects.
        finally { await client.close?.({ timeout: 1 }); }
      }
    },
  };
  return fixture;
}

export function createBunSqlCertificationTarget(options: BunCertificationTargetOptions): CertificationTarget {
  return {
    id: `bun-sql-${options.dialect}`,
    sourceSha: options.sourceSha,
    expectedCapabilities: expectedCapabilities(options.dialect),
    expectedTransactionOptions: expectedTransactionOptions(options.dialect),
    expectedGuardedCases: expectedGuardedCases(options.dialect),
    createFixture: () => createFixture(options),
  };
}
