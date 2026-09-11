import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sql } from '../packages/template/dist/index.js';
import { createDatabase, DatabaseCardinalityError } from '../packages/runtime/dist/index.js';

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

test('same-tick root transactions serialize their executor ownership', async () => {
  const calls: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { rows: [] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  });
  const first = db.transaction(async (tx) => { await tx.execute(sql`SELECT 1`); await gate; });
  const second = db.transaction(async (tx) => { await tx.execute(sql`SELECT 2`); });
  const tick = Promise.withResolvers<void>();
  setImmediate(tick.resolve);
  await tick.promise;
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT', 'BEGIN', 'SELECT 2', 'COMMIT']);
});

test('root handle use from its transaction callback fails before queueing', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { rows: [] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  });
  await assert.rejects(() => db.transaction(async () => db.execute(sql`SELECT 1`)), (error) => error.code === 'BRAID_TX_SCOPE');
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK']);
});

test('nested rollback releases its savepoint and preserves the parent scope', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { rows: [] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    async savepoint(name) { calls.push(`SAVEPOINT ${name}`); },
    async rollbackTo(name) { calls.push(`ROLLBACK TO ${name}`); },
    async releaseSavepoint(name) { calls.push(`RELEASE ${name}`); },
  });
  await db.transaction(async (tx) => {
    await assert.rejects(() => tx.transaction(async () => { throw new Error('nested failure'); }), /nested failure/);
    await tx.execute(sql`SELECT 2`);
  });
  assert.equal(calls.filter((entry) => entry.startsWith('RELEASE ')).length, 1);
  assert.equal(calls.at(-2), 'SELECT 2');
  assert.equal(calls.at(-1), 'COMMIT');
});

test('transaction cleanup failure is not reported as success', async () => {
  const db = createDatabase({
    async query() { return { rows: [] }; },
    async begin() {},
    async commit() {},
    async rollback() { throw new Error('rollback failed'); },
  });
  await assert.rejects(() => db.transaction(async () => { throw new Error('statement failed'); }), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test('transaction context does not poison later detached root work', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { rows: [] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  });
  let detached!: Promise<unknown>;
  await db.transaction(async () => {
    const ready = Promise.withResolvers<void>();
    detached = ready.promise.then(() => db.execute(sql`SELECT 3`));
    setImmediate(ready.resolve);
  });
  await detached;
  assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'SELECT 3']);
});
