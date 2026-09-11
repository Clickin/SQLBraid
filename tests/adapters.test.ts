import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPgDatabase } from '../packages/postgres/dist/pg.js';
import { createMysql2Database } from '../packages/mysql/dist/mysql2.js';
import { createNodeSqliteDatabase } from '../packages/sqlite/dist/node-sqlite.js';
import { sql } from '../packages/postgres/dist/index.js';
import { sql as mysqlSql } from '../packages/mysql/dist/index.js';
import { sql as sqliteSql } from '../packages/sqlite/dist/index.js';

test('postgres adapter preserves plain rows and rendered binds', async () => {
  let request;
  const db = createPgDatabase({ async query(config) { request = config; return { rows: [{ id: 1 }] }; } });
  assert.deepEqual(await db.all(sql`SELECT ${1}`), [{ id: 1 }]);
  assert.deepEqual(request, { text: 'SELECT $1', values: [1] });
});

test('mysql2 adapter uses positional placeholders', async () => {
  let request;
  const db = createMysql2Database({ async execute(text, values) { request = { text, values }; return [[{ ok: 1 }], {}]; } });
  assert.deepEqual(await db.all(mysqlSql`SELECT ${1}`), [{ ok: 1 }]);
  assert.deepEqual(request, { text: 'SELECT ?', values: [1] });
});

test('node sqlite adapter distinguishes row and command statements', async () => {
  const db = createNodeSqliteDatabase({ prepare(text) { return { all: () => [{ id: 1 }], run: () => ({ changes: 1 }) }; } });
  assert.deepEqual(await db.all(sqliteSql`SELECT 1`), [{ id: 1 }]);
  assert.equal((await db.execute(sqliteSql`UPDATE users SET ok = ${true}`)).rowCount, 1);
});
