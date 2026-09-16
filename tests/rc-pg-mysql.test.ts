import assert from "node:assert/strict";
import { test } from "vitest";
import {
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createMysql2Executor, type Mysql2ConnectionLike, type Mysql2FieldPayload } from "@sqlbraid/mysql/mysql2";
import { sql as mysql } from "@sqlbraid/mysql";
import { createPgExecutor, type PgClientLike, type PgResultLike } from "@sqlbraid/postgres/pg";
import { sql as postgres } from "@sqlbraid/postgres";

const canonicalCapabilities = [
  "session.pinned",
  "transaction",
  "transaction.savepoint",
  "transaction.read-only",
  "transaction.isolation.read-uncommitted",
  "transaction.isolation.read-committed",
  "transaction.isolation.repeatable-read",
  "transaction.isolation.serializable",
  "statement.prepare",
  "statement.cancel",
  "statement.stream",
  "statement.bulk",
  "routine.call",
  "routine.out",
  "routine.inout",
  "routine.return-value",
  "routine.result-sets",
  "routine.out-cursor",
] as const;

function pgMock(query: (value: unknown) => Promise<PgResultLike>): PgClientLike {
  return {
    query,
    escapeIdentifier: (value) => `"${value}"`,
    escapeLiteral: (value) => `'${value}'`,
  };
}

function mysqlMock(execute: (sql: string, values?: readonly unknown[]) => Promise<readonly [unknown, Mysql2FieldPayload | undefined]>): Mysql2ConnectionLike {
  return {
    execute,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
}

function mysqlQueryMock(
  execute: (sql: string, values?: readonly unknown[]) => Promise<readonly [unknown, Mysql2FieldPayload | undefined]>,
  query: (sql: string) => Promise<readonly [unknown, Mysql2FieldPayload | undefined]>,
): Mysql2ConnectionLike & { query(sql: string): Promise<readonly [unknown, Mysql2FieldPayload | undefined]> } {
  return { ...mysqlMock(execute), query };
}

function result(): { readonly rows: readonly unknown[]; readonly fields: readonly [] } {
  return { rows: [], fields: [] };
}

function errorCode(error: unknown): unknown {
  if (error instanceof Error && "code" in error) return error.code;
  return undefined;
}

test("RC pg and mysql adapters expose every canonical SPI capability", () => {
  const pg = createPgExecutor(pgMock(async () => result()));
  const mysqlExecutor = createMysql2Executor(mysqlMock(async () => [[], []]));
  for (const environment of [pg.environment!, mysqlExecutor.environment!]) {
    for (const capability of canonicalCapabilities) assert.ok(environment.capabilities[capability]);
  }
  assert.equal(pg.environment!.capabilities["routine.inout"]?.status, "unsupported");
  assert.equal(mysqlExecutor.environment!.capabilities["routine.out"]?.status, "unsupported");
  assert.equal(mysqlExecutor.environment!.capabilities["routine.inout"]?.status, "unsupported");
});

test("PostgreSQL transaction options lower on the pinned client and reject malformed values", async () => {
  const calls: string[] = [];
  const executor = createPgExecutor(pgMock(async (value) => {
    if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "string") calls.push(value.text);
    return result();
  }));
  await executor.begin!({ isolation: "serializable", readOnly: true });
  assert.deepEqual(calls, ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"]);
  await assert.rejects(
    async () => executor.begin!({ isolation: "invalid" as never }),
    (error: unknown) => error instanceof TypeError && errorCode(error) === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.deepEqual(calls, ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"]);
});

test("MySQL transaction options use same-connection control statements", async () => {
  const calls: string[] = [];
  const executor = createMysql2Executor(mysqlQueryMock(
    async (sql) => {
      calls.push(sql);
      return [[], []];
    },
    async (sql) => {
      calls.push(sql);
      return [[], []];
    },
  ));
  await executor.begin!({ isolation: "repeatable-read", readOnly: true });
  assert.deepEqual(calls, [
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "START TRANSACTION READ ONLY",
  ]);
  await assert.rejects(
    async () => executor.begin!({ readOnly: "yes" as never }),
    (error: unknown) => error instanceof TypeError && errorCode(error) === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.equal(calls.length, 2);
});

test("Already-aborted signals reject without physical I/O", async () => {
  let pgCalls = 0;
  let mysqlCalls = 0;
  const pg = createPgExecutor(pgMock(async () => {
    pgCalls += 1;
    return result();
  }));
  const mysqlExecutor = createMysql2Executor(mysqlMock(async () => {
    mysqlCalls += 1;
    return [[], []];
  }));
  const reason = new Error("already aborted");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(async () => pg.query(postgres`SELECT 1`.render(), undefined, { signal: controller.signal }), (error: unknown) => error === reason);
  await assert.rejects(async () => mysqlExecutor.query(mysql`SELECT 1`.render(), undefined, { signal: controller.signal }), (error: unknown) => error === reason);
  assert.equal(pgCalls, 0);
  assert.equal(mysqlCalls, 0);
});

test("Active cancellation without a physical destroy mechanism is unsupported before I/O", async () => {
  let pgCalls = 0;
  let mysqlCalls = 0;
  const pg = createPgExecutor(pgMock(async () => {
    pgCalls += 1;
    return result();
  }));
  const mysqlExecutor = createMysql2Executor(mysqlMock(async () => {
    mysqlCalls += 1;
    return [[], []];
  }));
  const pgController = new AbortController();
  const mysqlController = new AbortController();
  await assert.rejects(
    async () => pg.query(postgres`SELECT 1`.render(), undefined, { signal: pgController.signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  await assert.rejects(
    async () => mysqlExecutor.query(mysql`SELECT 1`.render(), undefined, { signal: mysqlController.signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(pgCalls, 0);
  assert.equal(mysqlCalls, 0);
});

test("Routine output limitations are explicit and happen before driver I/O", async () => {
  let pgCalls = 0;
  let mysqlCalls = 0;
  const pg = createPgExecutor(pgMock(async () => {
    pgCalls += 1;
    return result();
  }));
  const mysqlExecutor = createMysql2Executor(mysqlMock(async () => {
    mysqlCalls += 1;
    return [[], []];
  }));
  await assert.rejects(
    async () => pg.call(postgres.call`CALL routine(${postgres.inOut("value", 1)})`.render()),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "routine.inout" && error.code === "BRAID_CALL_OUT_UNSUPPORTED",
  );
  await assert.rejects(
    async () => mysqlExecutor.call(mysql.call`CALL routine(${mysql.out("value")})`.render()),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "routine.out" && error.code === "BRAID_CALL_OUT_UNSUPPORTED",
  );
  assert.equal(pgCalls, 0);
  assert.equal(mysqlCalls, 0);
});
