import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sql as postgres } from '@sqlbraid/postgres';
import { sql as mysql } from '@sqlbraid/mysql';
import { sql as sqlite } from '@sqlbraid/sqlite';

test('dialects own placeholder and identifier rendering', () => {
  assert.deepEqual(postgres`SELECT ${1}, ${2}`.render(), { text: 'SELECT $1, $2', values: [1, 2] , variantFingerprint: '' });
  assert.deepEqual(mysql`SELECT ${1}, ${2}`.render(), { text: 'SELECT ?, ?', values: [1, 2], variantFingerprint: '' });
  assert.deepEqual(sqlite`SELECT ${1}`.render(), { text: 'SELECT ?', values: [1], variantFingerprint: '' });
  assert.equal(mysql`SELECT ${mysql.ident('a`b')}`.render().text, 'SELECT `a``b`');
});
