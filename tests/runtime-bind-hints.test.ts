import assert from "node:assert/strict";
import { test } from "vitest";
import type { ParameterTypeHint, QueryExecutor, QueryResultKind, RenderedQuery } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { createPgExecutor } from "@sqlbraid/postgres/pg";
import { createMysql2Executor } from "@sqlbraid/mysql/mysql2";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/template";

const hint = { databaseType: "INT", length: 11 } as const;
const otherHint = { databaseType: "VARCHAR", length: 32 } as const;

function rendered(resultKind: QueryResultKind = "rows", value = 1): RenderedQuery {
  return { text: "SELECT ?", values: [value], parameterHints: [hint], resultKind };
}

function hintedQuery(value: number, parameterHint: ParameterTypeHint = hint) {
  const base = sql.rows`SELECT ${value}`;
  return {
    ...base,
    render() {
      return { ...base.render(), parameterHints: [parameterHint] };
    },
  };
}

function noRowsExecutor(values: unknown[]): QueryExecutor {
  return {
    async query<Row>(query: RenderedQuery) {
      values.push(...query.values);
      return { kind: "rows", rows: [] as readonly Row[] };
    },
  };
}

test("query:ready exposes immutable parameter hints and adapters receive them", async () => {
  const events: Array<{ readonly type: string; readonly parameterHints?: readonly unknown[] }> = [];
  let received: RenderedQuery | undefined;
  const db = createDatabase({
    async query<Row>(query: RenderedQuery) {
      received = query;
      return { kind: "rows", rows: [] as readonly Row[] };
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });

  await db.execute(hintedQuery(1));

  assert.deepEqual(received?.parameterHints, [hint]);
  const ready = events.find((event) => event.type === "query:ready");
  assert.ok(ready?.parameterHints);
  assert.deepEqual(ready.parameterHints, [hint]);
  assert.equal(Object.isFrozen(ready.parameterHints), true);
  assert.equal(Object.isFrozen(ready.parameterHints[0]), true);
});

test("prepared queries treat hint metadata as shape but ignore values", async () => {
  let value = 1;
  let parameterHint: ParameterTypeHint = hint;
  const values: unknown[] = [];
  const db = createDatabase(noRowsExecutor(values));
  const prepared = db.prepare("hint-shape", () => hintedQuery(value, parameterHint));

  await prepared.execute();
  value = 2;
  await prepared.execute();
  assert.deepEqual(values, [1, 2]);

  parameterHint = otherHint;
  await assert.rejects(() => prepared.execute(), /BRAID_PREPARED_SHAPE/);
  assert.deepEqual(values, [1, 2]);
});

test("legacy adapters reject explicit hints before driver I/O", async () => {
  let pgCalls = 0;
  const pg = createPgExecutor({
    async query() { pgCalls += 1; return { rows: [] }; },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  });
  await assert.rejects(() => pg.query(rendered()), /BRAID_BIND_HINT_UNSUPPORTED/);
  await assert.rejects(() => pg.call!(rendered("call")), /BRAID_BIND_HINT_UNSUPPORTED/);
  assert.equal(pgCalls, 0);

  let mysqlCalls = 0;
  const mysql = createMysql2Executor({
    async execute() { mysqlCalls += 1; return [[], []] as const; },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  });
  await assert.rejects(() => mysql.query(rendered()), /BRAID_BIND_HINT_UNSUPPORTED/);
  await assert.rejects(() => mysql.call!(rendered("call")), /BRAID_BIND_HINT_UNSUPPORTED/);
  assert.equal(mysqlCalls, 0);

  let sqliteCalls = 0;
  const sqlite = createNodeSqliteExecutor({
    prepare() {
      sqliteCalls += 1;
      return { columns: () => [], all: () => [], run: () => ({ changes: 0 }) };
    },
  });
  await assert.rejects(() => sqlite.query(rendered()), /BRAID_BIND_HINT_UNSUPPORTED/);
  await assert.rejects(() => sqlite.call!(rendered("call")), /BRAID_BIND_HINT_UNSUPPORTED/);
  await assert.rejects(async () => {
    for await (const _row of sqlite.stream!(rendered())) void _row;
  }, /BRAID_BIND_HINT_UNSUPPORTED/);
  assert.equal(sqliteCalls, 0);
});
