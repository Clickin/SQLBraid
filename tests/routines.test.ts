import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { QueryExecutor, RenderedQuery, RoutineCallResult } from '@sqlbraid/core';
import type { SchemaSnapshot } from '@sqlbraid/schema';
import { parseSql, resolveStatement } from '@sqlbraid/ast';
import { createDatabase } from '@sqlbraid/runtime';
import { sql } from '@sqlbraid/postgres';

test('routine resolver keeps opaque result sets unknown', () => {
  const snapshot = { formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: {}, routines: { 'public.open_cursor': [{ name: 'open_cursor', identity: 'public.open_cursor', kind: 'procedure', arguments: [{ mode: 'in', type: 'int8', tsType: 'bigint' }], result: { kind: 'opaque' } }] }, metadata: {} } as const satisfies SchemaSnapshot;
  const semantic = resolveStatement(parseSql('CALL open_cursor($1)'), snapshot);
  assert.equal(semantic.columns, 'unknown');
  assert.deepEqual(semantic.binds, [{ placeholder: 1, type: 'bigint', evidence: 'routine:public.open_cursor' }]);
});

test('routine database call preserves output and result-set shape', async () => {
  const executor: QueryExecutor = {
    async query<Row>() { return { rows: [] as readonly Row[] }; },
    async call<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>> {
      assert.equal(rendered.text, 'CALL do_work($1)');
      return { output: { ok: true }, resultSets: [{ rows: [{ id: 1 }] as unknown as readonly Row[] }, { rows: 'unknown' }] };
    },
  };
  const db = createDatabase(executor);
  const query = sql.call`CALL do_work(${1})`;
  assert.deepEqual(await db.call(query), { output: { ok: true }, resultSets: [{ rows: [{ id: 1 }] }, { rows: 'unknown' }] });
});
