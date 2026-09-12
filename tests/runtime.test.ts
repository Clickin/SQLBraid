import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { QueryExecutor, RenderedQuery } from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import { createDatabase, DatabaseCardinalityError, DatabaseScopeError } from '@sqlbraid/runtime';

function executorFor(rows: readonly unknown[]): QueryExecutor & { readonly calls: readonly (RenderedQuery | string)[] } {
  const calls: (RenderedQuery | string)[] = [];
  return {
    calls,
    async query<Row>(rendered: RenderedQuery) { calls.push(rendered); return { kind: 'rows' as const, rows: rows as readonly Row[] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  };
}

test('database wrappers share ownership for the same executor object', async () => {
  const calls: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const executor = {
    async query<Row>(rendered: RenderedQuery) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  };
  const first = createDatabase(executor);
  const second = createDatabase(executor);
  const transaction = first.transaction(async (tx) => { await tx.execute(sql`SELECT 'inside'`); await gate; });
  await new Promise((resolve) => setImmediate(resolve));
  const outside = second.execute(sql`SELECT 'outside'`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['BEGIN', "SELECT 'inside'"]);
  release();
  await transaction;
  await outside;
  assert.deepEqual(calls, ['BEGIN', "SELECT 'inside'", 'COMMIT', "SELECT 'outside'"]);
});

test('runtime normalizes query execution to plain rows and enforces cardinality', async () => {
  const executor = executorFor([{ id: 1 }]);
  const db = createDatabase(executor);
  assert.deepEqual(await db.all(sql.rows`SELECT 1`), [{ id: 1 }]);
  assert.deepEqual(await db.one(sql.rows`SELECT 1`), { id: 1 });
  assert.deepEqual(await db.maybeOne(sql.rows`SELECT 1`), { id: 1 });
  const many = createDatabase(executorFor([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => many.maybeOne(sql.rows`SELECT 1`), DatabaseCardinalityError);
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
    async query(rendered) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] }; },
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
    async query(rendered) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  });
  await assert.rejects(() => db.transaction(async () => db.execute(sql`SELECT 1`)), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BRAID_TX_SCOPE');
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK']);
});

test('nested rollback releases its savepoint and preserves the parent scope', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] }; },
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
  const application = new Error('statement failed');
  const cleanup = new Error('rollback failed');
  const db = createDatabase({
    async query() { return { kind: 'rows' as const, rows: [] }; },
    async begin() {},
    async commit() {},
    async rollback() { throw cleanup; },
  });
  await assert.rejects(() => db.transaction(async () => { throw application; }), (error) => {
    return error instanceof AggregateError && error.errors[0] === application && error.errors[1] === cleanup && error.cause === application;
  });
  await assert.rejects(() => db.execute(sql`SELECT poisoned`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED' && error.cause instanceof AggregateError && error.cause.errors[0] === application && error.cause.errors[1] === cleanup);
  await assert.rejects(() => db.transaction(async () => undefined), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');
});

test('poisoned ownership rejects every wrapper sharing the physical resource', async () => {
  const ownershipKey = {};
  const makeExecutor = () => ({
    ownershipKey,
    async query<Row>() { return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() {},
    async commit() {},
    async rollback() { throw new Error('rollback failed'); },
  });
  const first = createDatabase(makeExecutor());
  const second = createDatabase(makeExecutor());
  await assert.rejects(() => first.transaction(async () => { throw new Error('application failed'); }), AggregateError);
  await assert.rejects(() => second.execute(sql`SELECT blocked`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');
});

test('successful transaction cleanup leaves physical ownership reusable', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query<Row>(rendered: RenderedQuery) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
  });
  await assert.rejects(() => db.transaction(async () => { throw new Error('application failed'); }));
  await db.execute(sql`SELECT after rollback`);
  await db.transaction(async () => undefined);
  await db.execute(sql`SELECT after commit`);
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'SELECT after rollback', 'BEGIN', 'COMMIT', 'SELECT after commit']);
});

test('nested rollback and release cleanup failures poison the parent ownership', async () => {
  const rollbackFailure = createDatabase({
    async query<Row>() { return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() {},
    async commit() {},
    async rollback() {},
    async savepoint() {},
    async rollbackTo() { throw new Error('rollback-to failed'); },
    async releaseSavepoint() {},
  });
  await assert.rejects(() => rollbackFailure.transaction(async (tx) => tx.transaction(async () => { throw new Error('nested application failed'); })), AggregateError);
  await assert.rejects(() => rollbackFailure.execute(sql`SELECT blocked`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');

  const releaseFailure = createDatabase({
    async query<Row>() { return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() {},
    async commit() {},
    async rollback() {},
    async savepoint() {},
    async rollbackTo() {},
    async releaseSavepoint() { throw new Error('release failed'); },
  });
  await assert.rejects(() => releaseFailure.transaction(async (tx) => tx.transaction(async () => undefined)), /release failed/);
  await assert.rejects(() => releaseFailure.execute(sql`SELECT blocked`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');
});

test('begin and commit failures conservatively poison the physical ownership', async () => {
  const beginFailure = createDatabase({
    async query<Row>() { return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() { throw new Error('begin uncertain'); },
    async commit() {},
    async rollback() {},
  });
  await assert.rejects(() => beginFailure.transaction(async () => undefined), /begin uncertain/);
  await assert.rejects(() => beginFailure.execute(sql`SELECT blocked`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');

  const commitFailure = createDatabase({
    async query<Row>() { return { kind: 'rows' as const, rows: [] as readonly Row[] }; },
    async begin() {},
    async commit() { throw new Error('commit uncertain'); },
    async rollback() { throw new Error('rollback must not recover commit uncertainty'); },
  });
  await assert.rejects(() => commitFailure.transaction(async () => undefined), /commit uncertain/);
  await assert.rejects(() => commitFailure.execute(sql`SELECT blocked`), (error) => error instanceof DatabaseScopeError && error.code === 'BRAID_CONNECTION_POISONED');
});

test('transaction context does not poison later detached root work', async () => {
  const calls: string[] = [];
  const db = createDatabase({
    async query(rendered) { calls.push(rendered.text); return { kind: 'rows' as const, rows: [] }; },
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
