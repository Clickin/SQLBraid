import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { QueryExecutor, RenderedQuery, RoutineCallResult } from '@sqlbraid/core';
import { createDatabase } from '@sqlbraid/runtime';
import { sql } from '@sqlbraid/postgres';

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
