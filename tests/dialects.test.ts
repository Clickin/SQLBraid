import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sql as postgres } from '@sqlbraid/postgres';
import { sql as mysql } from '@sqlbraid/mysql';
import { sql as sqlite } from '@sqlbraid/sqlite';

test('dialects own placeholder and identifier rendering', () => {
  const pg = postgres`SELECT ${1}, ${2}`.render();
  assert.equal(pg.text, 'SELECT $1, $2');
  assert.deepEqual(pg.values, [1, 2]);
  const my = mysql`SELECT ${1}, ${2}`.render();
  assert.equal(my.text, 'SELECT ?, ?');
  assert.deepEqual(my.values, [1, 2]);
  const sq = sqlite`SELECT ${1}`.render();
  assert.equal(sq.text, 'SELECT ?');
  assert.deepEqual(sq.values, [1]);
  assert.equal(mysql`SELECT ${mysql.ident('a`b')}`.render().text, 'SELECT `a``b`');
});
