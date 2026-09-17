import assert from "node:assert/strict";
import { test } from "vitest";
import type { RenderedBulk } from "@sqlbraid/core";
import type { Mysql2ConnectionLike, Mysql2PreparedStatementLike } from "@sqlbraid/mysql/mysql2";
import { createMysql2Executor, createMysql2PoolDatabase, mysql2StatementBinding } from "@sqlbraid/mysql/mysql2";
import type { PgClientLike, PgResultLike } from "@sqlbraid/postgres/pg";
import { createPgExecutor, pgStatementBinding } from "@sqlbraid/postgres/pg";
import { sql as mysqlSql } from "@sqlbraid/mysql";
import { sql as pgSql } from "@sqlbraid/postgres";
import { createTediousExecutor, createTediousStatementBinding, type TediousConnectionLike, type TediousRequestLike } from "@sqlbraid/mssql/tedious";
import { sql as mssqlSql } from "@sqlbraid/mssql";

const context = (dialectId: string) => ({ dialectId, requestedReuse: "auto" as const });

function completeTediousRequest(request: TediousRequestLike, error?: unknown, rowCount?: number): void {
  (request as unknown as { callback(error?: unknown, rowCount?: number): void }).callback(error, rowCount);
}

test("PostgreSQL bulk uses one named prepared statement sequentially", async () => {
  const calls: { readonly name?: string; readonly values: readonly unknown[] }[] = [];
  const client: PgClientLike = {
    escapeIdentifier: (value) => value,
    escapeLiteral: (value) => value,
    async query(configOrText: unknown, values?: readonly unknown[]): Promise<PgResultLike> {
      if (typeof configOrText === "object") {
        const config = configOrText as { readonly name?: string; readonly text: string; readonly values: readonly unknown[] };
        calls.push({ name: config.name, values: config.values });
      } else calls.push({ values: values ?? [] });
      return { rows: [], rowCount: 1, fields: [] };
    },
  };
  const statement = pgSql.command`UPDATE account SET amount = ${1} WHERE id = ${2}`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1, 10], [2, 20], [3, 30]] };
  const binding = pgStatementBinding.describeBulk!(bulk, context("postgres"));
  const result = await createPgExecutor(client).bulk!(bulk, binding);
  assert.deepEqual(result, { inputCount: 3, affectedRows: 3, executionMode: "prepared-loop" });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.name, calls[1]?.name);
  assert.deepEqual(calls.map((call) => call.values), [[1, 10], [2, 20], [3, 30]]);
});

test("PostgreSQL bulk bounds prepared names and evicts only its own statement", async () => {
  const calls: { readonly name?: string; readonly text: string }[] = [];
  const deallocations: string[] = [];
  const registry = {
    parsedStatements: { sqlbraid_bulk_0: "SELECT unrelated_application_statement" } as Record<string, string>,
    submittedNamedStatements: {} as Record<string, string>,
  };
  const client = {
    connection: registry,
    escapeIdentifier: (value: string) => value,
    escapeLiteral: (value: string) => value,
    async query(configOrText: unknown, _values?: readonly unknown[]): Promise<PgResultLike> {
      if (typeof configOrText === "object" && configOrText !== null) {
        const config = configOrText as { readonly name?: string; readonly text: string; readonly values: readonly unknown[] };
        if (config.text.startsWith("DEALLOCATE ")) {
          deallocations.push(config.text);
          const name = config.text.slice('DEALLOCATE "'.length, -1);
          delete registry.parsedStatements[name];
          delete registry.submittedNamedStatements[name];
        } else {
          calls.push({ name: config.name, text: config.text });
        }
      } else {
        calls.push({ text: String(configOrText) });
      }
      return { rows: [], rowCount: 1, fields: [] };
    },
  } as unknown as PgClientLike;
  const executor = createPgExecutor(client);
  const first = pgSql.command`UPDATE account SET amount = ${1} WHERE id = ${2}`.render();
  const second = pgSql.command`DELETE FROM account WHERE id = ${1}`.render();
  const firstBulk: RenderedBulk = { statement: first, parameterSets: [[1, 10]] };
  const secondBulk: RenderedBulk = { statement: second, parameterSets: [[10]] };
  const thirdBulk: RenderedBulk = { statement: first, parameterSets: [[2, 20]] };
  await executor.bulk!(firstBulk, pgStatementBinding.describeBulk!(firstBulk, context("postgres")));
  await executor.bulk!(secondBulk, pgStatementBinding.describeBulk!(secondBulk, context("postgres")));
  await executor.bulk!(thirdBulk, pgStatementBinding.describeBulk!(thirdBulk, context("postgres")));

  const activeSqlBraidNames = Object.keys(registry.parsedStatements).filter((name) => name.startsWith("sqlbraid_bulk_") && name !== "sqlbraid_bulk_0");
  assert.equal(activeSqlBraidNames.length, 1);
  assert.equal(registry.parsedStatements.sqlbraid_bulk_0, "SELECT unrelated_application_statement");
  assert.equal(deallocations.length, 2);
  assert.ok(deallocations.every((sql) => !sql.includes("unrelated_application_statement")));
  assert.equal(new Set(calls.map((call) => call.name)).size, 1);
  assert.deepEqual(calls.map((call) => call.text), [
    "UPDATE account SET amount = $1 WHERE id = $2",
    "DELETE FROM account WHERE id = $1",
    "UPDATE account SET amount = $1 WHERE id = $2",
  ]);
});

test("MySQL bulk prepares once, executes sequentially, and closes", async () => {
  const events: string[] = [];
  const prepared: Mysql2PreparedStatementLike = {
    async execute(values) {
      events.push(`execute:${String(values?.[0])}`);
      return [{ affectedRows: 1 }, undefined];
    },
    async close() { events.push("close"); },
  };
  const connection: Mysql2ConnectionLike = {
    async execute() { throw new Error("bulk must not use connection.execute"); },
    async prepare(text) { events.push(`prepare:${text}`); return prepared; },
    async unprepare() { await prepared.close(); },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
  const statement = mysqlSql.command`UPDATE account SET amount = ${1} WHERE id = ${2}`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1, 10], [2, 20]] };
  const binding = mysql2StatementBinding.describeBulk!(bulk, context("mysql"));
  const result = await createMysql2Executor(connection).bulk!(bulk, binding);
  assert.deepEqual(result, { inputCount: 2, affectedRows: 2, executionMode: "prepared-loop" });
  assert.equal(events.filter((event) => event.startsWith("prepare:")).length, 1);
  assert.deepEqual(events.slice(1), ["execute:1", "execute:2", "close"]);
});

test("MySQL bulk preflights every native bind value before acquiring", async () => {
  let acquireCalls = 0;
  const db = createMysql2PoolDatabase({
    async getConnection() {
      acquireCalls += 1;
      throw new Error("bulk acquisition must not run");
    },
  });
  await assert.rejects(
    () => db.bulk([1, () => 1], (value) => mysqlSql.command`UPDATE account SET amount = ${value}`),
    /BRAID_BIND_VALUE_UNSUPPORTED/u,
  );
  const invalidDate = new Date(Number.NaN);
  await assert.rejects(
    () => db.bulk([1, invalidDate], (value) => mysqlSql.command`UPDATE account SET amount = ${value}`),
    /BRAID_BIND_VALUE_UNSUPPORTED/u,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    () => db.bulk([1, circular], (value) => mysqlSql.command`UPDATE account SET amount = ${value}`),
    /BRAID_BIND_VALUE_UNSUPPORTED/u,
  );
  assert.equal(acquireCalls, 0);
});

test("MySQL bulk omits affectedRows when native headers do not report it", async () => {
  const prepared: Mysql2PreparedStatementLike = {
    async execute() { return [{}, undefined]; },
    async close() {},
  };
  const connection: Mysql2ConnectionLike = {
    async execute() { throw new Error("bulk must not use connection.execute"); },
    async prepare() { return prepared; },
    async unprepare() { await prepared.close(); },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
  const statement = mysqlSql.command`UPDATE account SET amount = ${1}`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1]] };
  const binding = mysql2StatementBinding.describeBulk!(bulk, context("mysql"));
  const result = await createMysql2Executor(connection).bulk!(bulk, binding);
  assert.deepEqual(result, { inputCount: 1, executionMode: "prepared-loop" });
});

test("SQL Server bulk rejects later rows whose inferred type changes", () => {
  const statement = mssqlSql.command`UPDATE account SET amount = ${1} WHERE id = ${2}`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1, 10], ["bad", 20]] };
  const binding = createTediousStatementBinding();
  assert.throws(
    () => binding.describeBulk!(bulk, context("mssql")),
    /BRAID_BULK_SHAPE: SQL Server bulk parameter 1 changed inferred type/u,
  );
});

test("SQL Server native bulk propagates callback errors before executing later rows and unprepares", async () => {
  const events: string[] = [];
  const constraintError = new Error("Violation of PRIMARY KEY constraint.");
  const connection: TediousConnectionLike = {
    execSql() { throw new Error("bulk must use prepare/execute/unprepare"); },
    prepare(request) {
      events.push("prepare");
      (request as unknown as { preparing: boolean }).preparing = true;
      completeTediousRequest(request);
    },
    execute(request, parameters) {
      const id = parameters.p1;
      events.push(`execute:${String(id)}`);
      if (id === 2) {
        Object.assign(request, { error: constraintError });
        completeTediousRequest(request, constraintError);
      }
      else completeTediousRequest(request, undefined, 1);
    },
    unprepare(request) {
      events.push("unprepare");
      completeTediousRequest(request, Reflect.get(request, "error"));
    },
    beginTransaction() {},
    commitTransaction() {},
    rollbackTransaction() {},
    saveTransaction() {},
  };
  const statement = mssqlSql.command`INSERT INTO account (id, amount) VALUES (${1}, ${2})`.render();
  const bulk: RenderedBulk = { statement, parameterSets: [[1, 10], [2, 20], [3, 30]] };
  const executor = createTediousExecutor(connection);
  const binding = executor.statementBinding.describeBulk!(bulk, context("mssql"));

  await assert.rejects(
    async () => executor.bulk!(bulk, binding),
    (error) => error === constraintError,
  );
  assert.deepEqual(events, ["prepare", "execute:1", "execute:2", "unprepare"]);
});
