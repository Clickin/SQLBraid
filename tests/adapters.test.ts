import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPgDatabase } from '@sqlbraid/postgres/pg';
import { createMysql2Database } from '@sqlbraid/mysql/mysql2';
import { createNodeSqliteDatabase } from '@sqlbraid/sqlite/node-sqlite';
import { sql } from '@sqlbraid/postgres';
import { sql as mysqlSql } from '@sqlbraid/mysql';
import { sql as sqliteSql } from '@sqlbraid/sqlite';

test('postgres adapter preserves plain rows and rendered binds', async () => {
  let request;
  const db = createPgDatabase({ async query(config) { request = config; return { rows: [{ id: 1 }] }; } });
  assert.deepEqual(await db.all(sql.rows`SELECT ${1}`), [{ id: 1 }]);
  assert.deepEqual(request, { text: 'SELECT $1', values: [1] });
});

test('mysql2 adapter uses positional placeholders', async () => {
  let request;
  const db = createMysql2Database({ async execute(text, values) { request = { text, values }; return [[{ ok: 1 }], []]; } });
  assert.deepEqual(await db.all(mysqlSql.rows`SELECT ${1}`), [{ ok: 1 }]);
  assert.deepEqual(request, { text: 'SELECT ?', values: [1] });
});

test('node sqlite adapter distinguishes row and command statements', async () => {
  const db = createNodeSqliteDatabase({ prepare(text) { return { all: () => [{ id: 1 }], run: () => ({ changes: 1 }) }; } });
  assert.deepEqual(await db.all(sqliteSql.rows`SELECT 1`), [{ id: 1 }]);
  assert.equal((await db.execute(sqliteSql`UPDATE users SET ok = ${true}`)).rowCount, 1);
});
