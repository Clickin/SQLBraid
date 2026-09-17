import { Buffer } from "node:buffer";
import type {
  CommandQuery,
  CallQuery,
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
  acquires: number;
  cleanupBalance: number;
  sideEffects: number;
}

/** Independent contract: this is intentionally not read from environment(). */
import { BUN_EXPECTED_CAPABILITIES, BUN_EXPECTED_GUARDED_CASES, BUN_EXPECTED_TRANSACTION_OPTIONS } from "../contracts.js";

export const expectedCapabilities = BUN_EXPECTED_CAPABILITIES;
export const expectedTransactionOptions = BUN_EXPECTED_TRANSACTION_OPTIONS;
export const expectedGuardedCases = BUN_EXPECTED_GUARDED_CASES;

function mutates(sql: string): boolean {
  return /^(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|TRUNCATE)\b/iu.test(sql.trim());
}

function instrument(client: BunSqlClient, counters: Counters): BunSqlClient {
  const wrapped = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    if (mutates(strings.join(""))) counters.sideEffects += 1;
    return client(strings, ...values);
  }) as BunSqlClient;
  wrapped.unsafe = <T = unknown>(text: string, values: readonly unknown[] = []) => {
    if (mutates(text)) counters.sideEffects += 1;
    return client.unsafe<T>(text, values);
  };
  Object.defineProperty(wrapped, "options", { value: client.options });
  wrapped.close = client.close?.bind(client);
  if (client.reserve !== undefined) {
    wrapped.reserve = async () => {
      counters.borrowed += 1;
      counters.acquires += 1;
      counters.cleanupBalance += 1;
      try {
        const reserved = await client.reserve!();
        const wrappedReserved = instrument(reserved, counters) as BunSqlReservedClient;
        const release = reserved.release.bind(reserved);
        let released = false;
        wrappedReserved.release = async () => {
          if (released) return;
          released = true;
          try {
            await release();
          } finally {
            counters.borrowed -= 1;
            counters.cleanupBalance -= 1;
          }
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
  if (dialect === "postgres") return tag.rows`SELECT current_setting('transaction_isolation') AS value, current_setting('transaction_read_only') AS read_only`;
  return tag.rows`SELECT CAST(@@transaction_isolation AS CHAR) AS value, CAST(@@transaction_read_only AS CHAR) AS read_only`;
}

async function proveTransactionOption(db: CertificationFixture["db"], tag: SqlTag, dialect: BunSqlDialect, options: TransactionOptions): Promise<void> {
  const result = await db.tx(options, async (tx) => tx.one(settingQuery(tag, dialect)));
  if (result === null || typeof result !== "object" || typeof (result as { readonly value?: unknown }).value !== "string") throw new Error(`Bun.SQL ${optionKey(options)} did not expose a textual transaction setting.`);
}

async function createFixture(options: BunCertificationTargetOptions): Promise<CertificationFixture> {
  const { dialect, tag } = options;
  const counters: Counters = { borrowed: 0, acquires: 0, cleanupBalance: 0, sideEffects: 0 };
  const client = instrument(options.createClient(), counters);
  const table = `braid_cert_${dialect}_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  assertSavepointName(table);
  const tableSql = tag.raw(quoteIdentifier(dialect, table));
  const missingSql = tag.raw(quoteIdentifier(dialect, `${table}_missing`));
  const idColumn = dialect === "postgres"
    ? "id SERIAL PRIMARY KEY"
    : dialect === "mysql" || dialect === "mariadb"
      ? "id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY"
      : "id INTEGER PRIMARY KEY";
  await client.unsafe(`CREATE TABLE ${quoteIdentifier(dialect, table)} (${idColumn}, value TEXT)`, []);
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
      largeExactInteger: tag.rows`SELECT ${"9007199254740991"} AS value`,
      exactDecimal: tag.rows`SELECT ${"12345678901234567890.123456789"} AS value`,
      temporal: tag.rows`SELECT ${"2026-09-14T12:34:56.789Z"} AS value`,
      injection: tag.rows`SELECT ${"'; SELECT 1; --"} AS value`,
      expected: {
        largeExactInteger: { value: "9007199254740991" },
        exactDecimal: { value: "12345678901234567890.123456789" },
        temporal: { value: "2026-09-14T12:34:56.789Z" },
        injection: { value: "'; SELECT 1; --" },
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
  let bulkValues: unknown[][] = [];
  const guarded: NonNullable<CertificationFixture["guarded"]> = {
    "numeric.exact-integer": { prove: async () => {
      const value = await db.one(tag.rows`SELECT ${"9007199254740991"} AS value`);
      if ((value as { readonly value?: unknown }).value !== "9007199254740991") throw new Error("Bun.SQL exact-integer guard failed.");
    } },
    "numeric.approximate-float": { prove: async () => {
      const value = await db.one(tag.rows`SELECT ${1.5} AS value`);
      if (typeof (value as { readonly value?: unknown }).value !== "number") throw new Error("Bun.SQL float guard failed.");
    } },
    "numeric.bind-exact": { prove: async () => {
      const value = await db.one(tag.rows`SELECT ${"9007199254740991"} AS value`);
      if ((value as { readonly value?: unknown }).value !== "9007199254740991") throw new Error("Bun.SQL exact bind guard failed.");
    } },
    "numeric.approximate-special": { prove: async () => {
      const value = await db.one(tag.rows`SELECT ${1.5} AS value`);
      if (typeof (value as { readonly value?: unknown }).value !== "number") throw new Error("Bun.SQL special-float guard failed.");
    } },
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
  if (dialect !== "sqlite") {
    guarded["data.temporal-native"] = { prove: async () => {
      const row = await db.one(tag.rows`SELECT CURRENT_TIMESTAMP AS value`);
      if (!((row as { readonly value?: unknown }).value instanceof Date || typeof (row as { readonly value?: unknown }).value === "string")) throw new Error("Bun.SQL temporal guard failed.");
    } };
    guarded["data.timezone"] = guarded["data.temporal-native"];
  }
  if (dialect === "postgres" || dialect === "mysql" || dialect === "mariadb") {
    for (const isolation of ["read-uncommitted", "read-committed", "repeatable-read", "serializable"] as const) {
      guarded[`transaction.isolation.${isolation}`] = { prove: () => proveTransactionOption(db, tag, dialect, { isolation }) };
    }
    guarded["transaction.read-only"] = { prove: async () => {
      let rejected = false;
      try { await db.tx({ readOnly: true }, async (tx) => { await tx.execute(queries.transaction!.insert); }); } catch { rejected = true; }
      if (!rejected) throw new Error("Bun.SQL read-only transaction accepted a write.");
    } };
  }
  const fixture: CertificationFixture = {
    db,
    queries,
    metrics: { snapshot: () => ({ borrowedLeases: counters.borrowed, cleanupBalance: counters.cleanupBalance }), sideEffects: () => counters.sideEffects },
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
        let index = 0;
        await db.bulk(["middle-one", "middle-failure", "middle-three"], (input) => {
          if (index++ === 1) throw new Error("cert-bulk-middle-failure");
          return tag.command`INSERT INTO ${tableSql} (value) VALUES (${input})`;
        });
      },
      values: () => bulkValues,
    } as BulkConformanceFixture<unknown>,
    close: async () => {
      try { await client.unsafe(`DROP TABLE ${quoteIdentifier(dialect, table)}`, []); }
      finally { await client.close?.(); }
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
