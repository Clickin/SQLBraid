import assert from "node:assert/strict";
import { test } from "vitest";
import { ResultExactnessError, UnsupportedFeatureError } from "@sqlbraid/core";
import { sql as mariadb } from "@sqlbraid/mariadb";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as sqlite } from "@sqlbraid/sqlite";
import {
  createBunSqlDatabase,
  createBunSqlProvider,
  type BunSqlClient,
  type BunSqlReservedClient,
} from "@sqlbraid/bun-sql";

type Log = { readonly text: string; readonly values: readonly unknown[]; readonly lease: number };

function immediateQuery<T>(value: T): PromiseLike<T> {
  return Promise.resolve(value);
}

function fakeClient(logs: Log[], releaseCounts: { count: number }): BunSqlClient {
  let leaseSequence = 0;
  const makeReserved = (): BunSqlReservedClient => {
    const lease = ++leaseSequence;
    const client: BunSqlReservedClient = {
      unsafe<T = unknown>(text: string, values: readonly unknown[] = []): PromiseLike<T> {
        logs.push({ text, values, lease });
        const rows = text.startsWith("SELECT")
          ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : values[0] ?? 1 }]
          : text.startsWith("SHOW")
            ? [{ value: lease }]
            : [];
        const result = Object.assign(rows, {
          command: text.startsWith("SELECT") || text.startsWith("SHOW") ? "SELECT" : "UPDATE",
          count: rows.length,
          lastInsertRowid: null,
          affectedRows: rows.length,
        });
        return immediateQuery(result as T);
      },
      release(): void { releaseCounts.count += 1; },
      options: { prepare: true },
    };
    return client;
  };
  const client: BunSqlClient = {
    unsafe<T = unknown>(text: string, values: readonly unknown[] = []): PromiseLike<T> {
      logs.push({ text, values, lease: 0 });
      const rows = text.startsWith("SELECT")
        ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : values[0] ?? 1 }]
        : [];
      return immediateQuery(Object.assign(rows, {
        command: text.startsWith("SELECT") ? "SELECT" : "UPDATE",
        count: rows.length,
        lastInsertRowid: null,
        affectedRows: rows.length,
      }) as T);
    },
    reserve: async () => makeReserved(),
    options: { prepare: true },
  };
  return client;
}

test("Bun.SQL transport keeps user-selected dialects independent", async () => {
  const logs: Log[] = [];
  const releaseCounts = { count: 0 };
  const client = fakeClient(logs, releaseCounts);
  const db = createBunSqlDatabase(client, { dialect: "postgres" });

  const row = await db.one(postgres.rows<{ value: string }>`SELECT CAST(${7} AS TEXT)`);
  assert.deepEqual(row, { value: "7" });
  assert.equal(logs.at(-1)?.text, "SELECT CAST($1 AS TEXT)");
  assert.deepEqual(logs.at(-1)?.values, [7]);
  await assert.rejects(
    () => db.one(postgres.rows<{ value: number }>`SELECT ${7}`),
    (error: unknown) => error instanceof ResultExactnessError,
  );

  const beforeMismatch = logs.length;
  await assert.rejects(
    () => db.one(mysql.rows<{ value: number }>`SELECT ${7}`),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_DIALECT_MISMATCH",
  );
  assert.equal(logs.length, beforeMismatch, "dialect mismatch must fail before Bun.SQL I/O");
});

test("Bun.SQL rejects ambiguous MySQL byte carriers without decoding PostgreSQL binary", async () => {
  const bytes = new TextEncoder().encode("12345678901234567890.123456789");
  const client = fakeClient([], { count: 0 });
  const mysqlDb = createBunSqlDatabase(client, { dialect: "mysql" });
  await assert.rejects(
    mysqlDb.one(mysql.rows`SELECT ${bytes}`),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  const postgresDb = createBunSqlDatabase(client, { dialect: "postgres" });
  assert.deepEqual(await postgresDb.one(postgres.rows`SELECT ${bytes}`), { value: bytes });
});

test("Bun.SQL reserved connections pin sessions and transactions", async () => {
  const logs: Log[] = [];
  const releaseCounts = { count: 0 };
  const db = createBunSqlDatabase(fakeClient(logs, releaseCounts), { dialect: "mysql" });

  await db.session(async (session) => {
    await session.one(mysql.rows<{ value: string }>`SELECT CAST(${11} AS CHAR)`);
    await session.one(mysql.rows<{ value: string }>`SELECT CAST(${12} AS CHAR)`);
    await session.tx(async (tx) => {
      await tx.execute(mysql.command`UPDATE values SET value = ${13}`);
    });
  });

  assert.equal(new Set(logs.filter((entry) => entry.lease > 0).map((entry) => entry.lease)).size, 1);
  assert.equal(releaseCounts.count, 1);
  assert.ok(logs.some((entry) => entry.text.startsWith("START TRANSACTION")));
  assert.ok(logs.some((entry) => entry.text === "COMMIT"));
  assert.ok(logs.some((entry) => entry.text === "SELECT CAST(? AS CHAR)" && entry.values[0] === 11));
});

test("Bun.SQL quarantines discard requests without a scoped discard primitive", async () => {
  const releaseCounts = { count: 0 };
  const provider = createBunSqlProvider(fakeClient([], releaseCounts), { dialect: "mysql" });
  const lease = await provider.acquire();
  await assert.rejects(
    async () => lease.release({ discard: true }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.code === "BRAID_RESOURCE_CLEANUP"
      && error.feature === "resource.discard",
  );
  await assert.rejects(
    async () => lease.release(),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "resource.discard",
  );
  assert.equal(releaseCounts.count, 0);
});

test("Bun.SQL exposes explicit unsupported streaming and routine paths", async () => {
  const logs: Log[] = [];
  const db = createBunSqlDatabase(fakeClient(logs, { count: 0 }), { dialect: "mariadb" });
  const stream = db.stream(mariadb.rows<{ value: number }>`SELECT 1`);
  await assert.rejects(
    async () => { for await (const _row of stream) { /* unreachable */ } },
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_STREAM_UNSUPPORTED",
  );
  await assert.rejects(
    () => db.call(mariadb.call`CALL work()`),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_CALL_UNSUPPORTED",
  );
  assert.equal(logs.length, 0, "unsupported operations must fail before statement I/O");
});


test("Bun.SQL SQLite uses one direct physical client and advertises canonical capabilities", async () => {
  const logs: Log[] = [];
  const db = createBunSqlDatabase(fakeClient(logs, { count: 0 }), { dialect: "sqlite" });
  const environment = await db.environment();
  assert.equal(environment.driver.id, "bun-sql");
  assert.equal(environment.capabilities["statement.prepare"]?.status, "guaranteed");
  assert.equal(environment.capabilities["statement.cancel"]?.status, "unsupported");
  assert.equal(environment.capabilities["statement.stream"]?.status, "unsupported");
  assert.equal(environment.capabilities["routine.result-sets"]?.status, "unsupported");
  assert.equal("execution.stream" in environment.capabilities, false);
  await db.execute(sqlite.command`CREATE TABLE t (value INTEGER)`);
  await db.tx({ isolation: "serializable" }, async (tx) => {
    await tx.execute(sqlite.command`INSERT INTO t (value) VALUES (${1})`);
  });
  assert.equal(environment.capabilities["transaction.isolation.serializable"]?.status, "guaranteed");
  assert.ok(logs.some((entry) => entry.text === "BEGIN"));
  await assert.rejects(
    () => db.tx({ foo: true } as never, async () => undefined),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
});
