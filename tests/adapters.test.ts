import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseResultKindError } from '@sqlbraid/runtime';
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
  const db = createNodeSqliteDatabase({ prepare(text) { return { columns: () => text.startsWith('SELECT') ? [{ name: 'id' }] : [], all: () => [{ id: 1 }], run: () => ({ changes: 1 }) }; } });
  assert.deepEqual(await db.all(sqliteSql.rows`SELECT 1`), [{ id: 1 }]);
  assert.equal((await db.execute(sqliteSql`UPDATE users SET ok = ${true}`)).rowCount, 1);
});

function isKindError(error: unknown, declaredKind: 'rows' | 'command', actualKind: 'rows' | 'command'): boolean {
  return error instanceof DatabaseResultKindError
    && error.code === 'BRAID_RESULT_KIND'
    && error.declaredKind === declaredKind
    && error.actualKind === actualKind;
}

test('postgres reports actual result kinds independently of declarations', async () => {
  const db = createPgDatabase({
    async query(config) {
      const text = typeof config === 'string' ? config : config.text;
      if (text.startsWith('SELECT')) return { rows: [{ id: 1 }], fields: [{ name: 'id', dataTypeID: 23 }], rowCount: 1, command: 'SELECT' };
      return { rows: [], rowCount: 1, command: 'UPDATE' };
    },
  });
  assert.equal((await db.execute(sql.rows`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(sql`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(sql.command`UPDATE users SET ok = true`)).kind, 'command');
  assert.equal((await db.execute(sql`UPDATE users SET ok = true`)).kind, 'command');
  await assert.rejects(() => db.execute(sql.command`SELECT 1`), (error) => isKindError(error, 'command', 'rows'));
  await assert.rejects(() => db.execute(sql.rows`UPDATE users SET ok = true`), (error) => isKindError(error, 'rows', 'command'));
});

test('mysql2 reports actual result kinds independently of declarations', async () => {
  const db = createMysql2Database({
    async execute(text) {
      if (text.startsWith('SELECT')) return [[{ id: 1 }], [{ name: 'id', type: 3 }]];
      return [{ affectedRows: 1, insertId: 2 }, []];
    },
  });
  assert.equal((await db.execute(mysqlSql.rows`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(mysqlSql`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(mysqlSql.command`UPDATE users SET ok = true`)).kind, 'command');
  assert.equal((await db.execute(mysqlSql`UPDATE users SET ok = true`)).kind, 'command');
  await assert.rejects(() => db.execute(mysqlSql.command`SELECT 1`), (error) => isKindError(error, 'command', 'rows'));
  await assert.rejects(() => db.execute(mysqlSql.rows`UPDATE users SET ok = true`), (error) => isKindError(error, 'rows', 'command'));
});

test('node sqlite reports actual result kinds from columns metadata', async () => {
  const db = createNodeSqliteDatabase({
    prepare(text) {
      const rows = text.startsWith('SELECT');
      return {
        columns: () => rows ? [{ name: 'id' }] : [],
        all: () => [{ id: 1 }],
        run: () => ({ changes: 1 }),
      };
    },
  });
  assert.equal((await db.execute(sqliteSql.rows`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(sqliteSql`SELECT 1`)).kind, 'rows');
  assert.equal((await db.execute(sqliteSql.command`UPDATE users SET ok = ${true}`)).kind, 'command');
  assert.equal((await db.execute(sqliteSql`UPDATE users SET ok = ${true}`)).kind, 'command');
  await assert.rejects(() => db.execute(sqliteSql.command`SELECT 1`), (error) => isKindError(error, 'command', 'rows'));
  await assert.rejects(() => db.execute(sqliteSql.rows`UPDATE users SET ok = ${true}`), (error) => isKindError(error, 'rows', 'command'));
});
