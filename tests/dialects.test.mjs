import assert from 'node:assert/strict';
import test from 'node:test';
import { sql as postgres } from '../dist/packages/postgres/src/index.js';
import { sql as mysql } from '../dist/packages/mysql/src/index.js';
import { sql as sqlite } from '../dist/packages/sqlite/src/index.js';

test('dialects own placeholder and identifier rendering', () => {
  assert.deepEqual(postgres`SELECT ${1}, ${2}`.render(), { text: 'SELECT $1, $2', values: [1, 2] , variantFingerprint: '' });
  assert.deepEqual(mysql`SELECT ${1}, ${2}`.render(), { text: 'SELECT ?, ?', values: [1, 2], variantFingerprint: '' });
  assert.deepEqual(sqlite`SELECT ${1}`.render(), { text: 'SELECT ?', values: [1], variantFingerprint: '' });
  assert.equal(mysql`SELECT ${mysql.ident('a`b')}`.render().text, 'SELECT `a``b`');
});
