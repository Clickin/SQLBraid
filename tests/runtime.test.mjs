import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from '../dist/packages/template/src/index.js';
import { createDatabase, DatabaseCardinalityError } from '../dist/packages/runtime/src/index.js';

function executorFor(rows) {
  const calls = [];
  return {
    calls,
    async query(rendered) { calls.push(rendered); return { rows }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  };
}

test('runtime normalizes query execution to plain rows and enforces cardinality', async () => {
  const executor = executorFor([{ id: 1 }]);
  const db = createDatabase(executor);
  assert.deepEqual(await db.all(sql`SELECT 1`), [{ id: 1 }]);
  assert.deepEqual(await db.one(sql`SELECT 1`), { id: 1 });
  assert.deepEqual(await db.maybeOne(sql`SELECT 1`), { id: 1 });
  const many = createDatabase(executorFor([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => many.maybeOne(sql`SELECT 1`), DatabaseCardinalityError);
});

test('transactions commit and rollback through the adapter seam', async () => {
  const executor = executorFor([]);
  const db = createDatabase(executor);
  await db.transaction(async (tx) => { await tx.execute(sql`UPDATE users SET ok = ${true}`); });
  assert.deepEqual(executor.calls.map((value) => typeof value === 'string' ? value : value.values), ['BEGIN', [true], 'COMMIT']);
  await assert.rejects(() => db.transaction(async () => { throw new Error('boom'); }));
  assert.equal(executor.calls.at(-1), 'ROLLBACK');
});
