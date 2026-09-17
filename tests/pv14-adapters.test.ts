import assert from "node:assert/strict";
import { test } from "vitest";
import { createRenderedStatement, type Database, type ExecutableQuery, type ExecutionEvent } from "@sqlbraid/core";
import { createPgExecutor, createPgPoolDatabase, pgStatementBinding } from "@sqlbraid/postgres/pg";
import { createMysql2Executor, createMysql2PoolDatabase, mysql2StatementBinding } from "@sqlbraid/mysql/mysql2";
import {
  createNodeSqliteExecutor,
  createNodeSqliteDatabase,
  nodeSqliteStatementBinding,
} from "@sqlbraid/sqlite/node-sqlite";
import { createOracledbPoolDatabase, oracledbStatementBinding } from "@sqlbraid/oracle/oracledb";
import { createTediousPoolDatabase, tediousStatementBinding } from "@sqlbraid/mssql/tedious";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as sqlite } from "@sqlbraid/sqlite";
import { sql as oracle, oracleParameter } from "@sqlbraid/oracle";
import { sql as mssql } from "@sqlbraid/mssql";

type Fixture = {
  name: string;
  query: ExecutableQuery;
  create: (io: () => never, events: ExecutionEvent[]) => Database;
};

test("positional executors reject stale and forged descriptions before physical I/O", async () => {
  let ioCalls = 0;
  const io = () => {
    ioCalls += 1;
    throw new Error("unexpected physical I/O");
  };
  const executors = [
    createPgExecutor({ query: io, escapeIdentifier: io, escapeLiteral: io }),
    createMysql2Executor({ execute: io, beginTransaction: io, commit: io, rollback: io }),
    createNodeSqliteExecutor({ prepare: io }),
  ];
  for (const [index, dialectId] of ["postgres", "mysql", "sqlite"].entries()) {
    const executor = executors[index]!;
    const statement = createRenderedStatement({
      dialectId,
      resultKind: "rows",
      segments: ["SELECT ", ""],
      parameters: [{ value: 1 }],
    });
    const other = createRenderedStatement({ ...statement, segments: ["DELETE FROM important_data WHERE id = ", ""] });
    const binding = executor.statementBinding.describe(other, { dialectId, requestedReuse: "auto" });
    await assert.rejects(async () => executor.query(statement, binding), /BRAID_BINDING_IDENTITY/);
    await assert.rejects(
      async () => executor.query(statement, { ...binding, parameterizedSql: "DROP TABLE important_data" }),
      /BRAID_BINDING_IDENTITY/,
    );
  }
  assert.equal(ioCalls, 0);
});

const fixtures: Fixture[] = [
  {
    name: "pg unsupported hint",
    query: postgres`SELECT ${postgres.bind(1, { databaseType: "int" })}`,
    create: (io, events) =>
      createPgPoolDatabase(
        { connect: async () => io() },
        {
          observers: [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
        },
      ),
  },
  {
    name: "mysql2 unsupported hint",
    query: mysql`SELECT ${mysql.bind(1, { databaseType: "int" })}`,
    create: (io, events) =>
      createMysql2PoolDatabase(
        { getConnection: async () => io() },
        {
          observers: [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
        },
      ),
  },
  {
    name: "node:sqlite unsupported hint",
    query: sqlite`SELECT ${sqlite.bind(1, { databaseType: "int" })}`,
    create: (io, events) =>
      createNodeSqliteDatabase(
        { prepare: io },
        {
          observers: [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
        },
      ),
  },
  {
    name: "Oracle unsupported input facet",
    query: oracle`SELECT ${oracle.bind(1, oracleParameter.number(10, 2))} FROM dual`,
    create: (io, events) =>
      createOracledbPoolDatabase(
        { getConnection: async () => io() },
        {
          observers: [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
        },
      ),
  },
  {
    name: "Tedious inexact decimal",
    query: mssql`SELECT ${mssql.bind("1234567890123456", { databaseType: "decimal", precision: 38, scale: 4 })}`,
    create: (io, events) =>
      createTediousPoolDatabase(
        { acquire: async () => io() },
        {
          observers: [
            {
              onEvent(event) {
                events.push(event);
              },
            },
          ],
        },
      ),
  },
];

for (const fixture of fixtures) {
  test(`${fixture.name} fails materialization before physical acquisition`, async () => {
    let ioCalls = 0;
    const events: ExecutionEvent[] = [];
    const db = fixture.create(() => {
      ioCalls += 1;
      throw new Error("unexpected physical I/O");
    }, events);
    await assert.rejects(() => db.execute(fixture.query));
    assert.equal(ioCalls, 0);
    const failure = events.find((event) => event.type === "query:error");
    assert.ok(failure?.type === "query:error");
    assert.equal(failure.stage, "materialize");
    assert.equal(failure.executionStarted, false);
    assert.equal(failure.executionCompleted, false);
    assert.equal(
      events.some((event) => event.type === "query:result"),
      false,
    );
  });
}

for (const [dialectId, adapter, marker] of [
  ["postgres", pgStatementBinding, (index: number) => `$${index}`],
  ["mysql", mysql2StatementBinding, () => "?"],
  ["sqlite", nodeSqliteStatementBinding, () => "?"],
  ["oracle", oracledbStatementBinding, (index: number) => `:${index}`],
  ["mssql", tediousStatementBinding, (index: number) => `@p${index}`],
] as const) {
  test(`${dialectId} transport handles empty and 1000 ordered parameters without scanning source SQL`, () => {
    const context = { dialectId, requestedReuse: "auto" } as const;
    const empty = createRenderedStatement({ dialectId, resultKind: "rows", segments: ["SELECT 1"], parameters: [] });
    assert.equal(adapter.describe(empty, context).parameterizedSql, "SELECT 1");
    const parameters = Array.from({ length: 1000 }, (_, index) => ({ value: index, interpolation: index * 2 }));
    const segments = ["SELECT ", ...Array<string>(999).fill(", "), " /* $1 ? :1 @p1 */"];
    const statement = createRenderedStatement({ dialectId, resultKind: "rows", segments, parameters });
    const binding = adapter.describe(statement, context);
    assert.equal(
      binding.parameterizedSql,
      `SELECT ${parameters.map((_, index) => marker(index + 1)).join(", ")} /* $1 ? :1 @p1 */`,
    );
    assert.deepEqual(
      binding.bindings.map((parameter) => parameter.interpolation),
      parameters.map((parameter) => parameter.interpolation),
    );
    assert.equal(
      binding.literalizedSql({ values: "inline" }).text,
      `SELECT ${parameters.map((parameter) => parameter.value).join(", ")} /* $1 ? :1 @p1 */`,
    );
  });
}
