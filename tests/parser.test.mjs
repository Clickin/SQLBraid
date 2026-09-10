import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSql, resolveStatement } from '../dist/packages/ast/src/index.js';

const snapshot = {
  formatVersion: 1,
  dialect: 'postgres',
  dialectVersion: '16',
  server: {},
  namespaces: {},
  types: {},
  relations: {
    'public.users': {
      identity: 'public.users',
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', ordinal: 1, type: 'int8', tsType: 'bigint', nullable: false },
        { name: 'name', ordinal: 2, type: 'text', tsType: 'string', nullable: false },
      ],
    },
  },
  routines: {},
  metadata: {},
};

test('parses and resolves a basic select against snapshot metadata', () => {
  const parsed = parseSql('SELECT id, name FROM users WHERE id = $1');
  const semantic = resolveStatement(parsed, snapshot);
  assert.deepEqual(semantic.columns, [
    { name: 'id', type: 'bigint', nullable: false, source: 'public.users' },
    { name: 'name', type: 'string', nullable: false, source: 'public.users' },
  ]);
  assert.deepEqual(semantic.binds, [{ placeholder: 1, type: 'bigint', nullable: false, evidence: 'column:id' }]);
});

test('fails closed for unknown relations', () => {
  const semantic = resolveStatement(parseSql('SELECT id FROM missing'), snapshot);
  assert.equal(semantic.columns, 'unknown');
  assert.equal(semantic.diagnostics[0].code, 'SQL_RELATION');
});
