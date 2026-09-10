import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSql, resolveStatement } from '../dist/packages/ast/src/index.js';
import { createDatabase } from '../dist/packages/runtime/src/index.js';
import { sql } from '../dist/packages/postgres/src/index.js';

test('routine resolver keeps opaque result sets unknown', () => {
  const snapshot = { formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: {}, routines: { 'public.open_cursor': [{ name: 'open_cursor', identity: 'public.open_cursor', kind: 'procedure', arguments: [{ mode: 'in', type: 'int8', tsType: 'bigint' }], result: { kind: 'opaque' } }] }, metadata: {} };
  const semantic = resolveStatement(parseSql('CALL open_cursor($1)'), snapshot);
  assert.equal(semantic.columns, 'unknown');
  assert.deepEqual(semantic.binds, [{ placeholder: 1, type: 'bigint', evidence: 'routine:public.open_cursor' }]);
});

test('routine database call preserves output and result-set shape', async () => {
  const db = createDatabase({
    async query() { return { rows: [] }; },
    async call(rendered) { assert.equal(rendered.text, 'CALL do_work($1)'); return { output: { ok: true }, resultSets: [{ rows: [{ id: 1 }] }, { rows: 'unknown' }] }; },
  });
  assert.deepEqual(await db.call(sql`CALL do_work(${1})`), { output: { ok: true }, resultSets: [{ rows: [{ id: 1 }] }, { rows: 'unknown' }] });
});
