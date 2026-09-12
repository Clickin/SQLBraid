import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  Database,
  QueryExecutor,
  RenderedQuery,
  StandardSchemaFailure,
  StandardSchemaLike,
  StandardSchemaSuccess,
} from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import {
  createDatabase,
  DatabaseCardinalityError,
  DatabaseResultKindError,
  DatabaseResultValidationError,
} from '@sqlbraid/runtime';

type User = { readonly id: number };

function schema<Row>(
  validate: (value: unknown) => StandardSchemaSuccess<Row> | StandardSchemaFailure | Promise<StandardSchemaSuccess<Row> | StandardSchemaFailure>,
): StandardSchemaLike<Row> {
  return { '~standard': { version: 1, vendor: 'runtime-tests', validate } };
}

function rowsExecutor(rows: readonly unknown[]): QueryExecutor {
  return {
    async query<Row>(_rendered: RenderedQuery) {
      return { kind: 'rows' as const, rows: rows as readonly Row[] };
    },
  };
}

test('row APIs validate sequentially, preserve transforms, and skip disabled validation', async () => {
  const calls: unknown[] = [];
  const db = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));
  const userSchema = schema<User & { readonly normalized: true }>((value) => {
    calls.push(value);
    const row = value as User;
    return { value: { ...row, normalized: true } };
  });

  assert.deepEqual(await db.all(sql.rows<User>`SELECT users`, { schema: userSchema }), [
    { id: 1, normalized: true },
    { id: 2, normalized: true },
  ]);
  assert.deepEqual(calls, [{ id: 1 }, { id: 2 }]);

  calls.length = 0;
  assert.deepEqual(await db.all(sql.rows<User>`SELECT users`), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(calls, []);

  const asyncSchema = schema<User>(async (value) => {
    await Promise.resolve();
    return (value as User).id === 2 ? { issues: ['invalid id'] } : { value: value as User };
  });
  await assert.rejects(
    () => db.all(sql.rows<User>`SELECT users`, { schema: asyncSchema }),
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.code === 'BRAID_RESULT_VALIDATION'
      && error.rowIndex === 1
      && error.issues[0] === 'invalid id',
  );

  let active = false;
  const ordered: number[] = [];
  const asynchronous = schema<User>(async (value) => {
    assert.equal(active, false);
    active = true;
    const row = value as User;
    await db.execute(sql`SELECT lookup`);
    ordered.push(row.id);
    active = false;
    return { value: { id: row.id + 10 } };
  });
  assert.deepEqual(await db.all(sql.rows<User>`SELECT users`, { schema: asynchronous }), [{ id: 11 }, { id: 12 }]);
  assert.deepEqual(ordered, [1, 2]);
});

test('one and maybeOne enforce cardinality before validation', async () => {
  let validations = 0;
  const validating = schema<User>((value) => {
    validations += 1;
    return { value: value as User };
  });
  const many = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => many.one(sql.rows<User>`SELECT users`, { schema: validating }), DatabaseCardinalityError);
  await assert.rejects(() => many.maybeOne(sql.rows<User>`SELECT users`, { schema: validating }), DatabaseCardinalityError);
  assert.equal(validations, 0);

  const empty = createDatabase(rowsExecutor([]));
  assert.equal(await empty.maybeOne(sql.rows<User>`SELECT user`, { schema: validating }), undefined);
  assert.equal(validations, 0);

  const one = createDatabase(rowsExecutor([{ id: 7 }]));
  assert.deepEqual(await one.one(sql.rows<User>`SELECT user`, { schema: validating }), { id: 7 });
  assert.deepEqual(await one.maybeOne(sql.rows<User>`SELECT user`, { schema: validating }), { id: 7 });
  assert.equal(validations, 2);
});

test('stream validates immediately and closes the source at the first failure', async () => {
  let consumed = 0;
  let closed = false;
  const db = createDatabase({
    async query<Row>() {
      return { kind: 'rows' as const, rows: [] as readonly Row[] };
    },
    stream<Row>() {
      return (async function* () {
        try {
          for (const row of [{ id: 1 }, { id: 2 }, { id: 3 }]) {
            consumed += 1;
            yield row as Row;
          }
        } finally {
          closed = true;
        }
      })();
    },
  });
  const validating = schema<User>((value) => (value as User).id === 2 ? { issues: ['invalid'] } : { value: value as User });
  const output: User[] = [];
  await assert.rejects(
    async () => {
      for await (const row of db.stream(sql.rows<User>`SELECT users`, { schema: validating })) output.push(row);
    },
    (error: unknown) => error instanceof DatabaseResultValidationError && error.rowIndex === 1,
  );
  assert.deepEqual(output, [{ id: 1 }]);
  assert.equal(consumed, 2);
  assert.equal(closed, true);
});

test('transaction and prepared row APIs use the same validation behavior', async () => {
  const db = createDatabase({
    ...rowsExecutor([{ id: 3 }]),
    async begin() {},
    async commit() {},
    async rollback() {},
  });
  const validating = schema<User>((value) => ({ value: { ...(value as User), id: 4 } }));

  await db.transaction(async (tx) => {
    assert.deepEqual(await tx.all(sql.rows<User>`SELECT user`, { schema: validating }), [{ id: 4 }]);
  });

  const prepared = db.prepare('user', () => sql.rows<User>`SELECT user`);
  assert.equal((await prepared.execute()).kind, 'rows');
  assert.deepEqual(await prepared.all({ schema: validating }), [{ id: 4 }]);
  assert.deepEqual(await prepared.one({ schema: validating }), { id: 4 });
  assert.deepEqual(await prepared.maybeOne({ schema: validating }), { id: 4 });
});

test('result kinds are enforced centrally and malformed protocol results are rejected safely', async () => {
  let calls = 0;
  const db = createDatabase({
    async query<Row>(rendered: RenderedQuery) {
      calls += 1;
      if (rendered.text.includes('UPDATE')) {
        return { kind: 'command' as const, rows: [] as const, command: { affectedRows: 1 } };
      }
      return { kind: 'rows' as const, rows: [{ id: 1 }] as unknown as readonly Row[] };
    },
  });

  assert.deepEqual((await db.execute(sql.rows<User>`SELECT user`)).rows, [{ id: 1 }]);
  await assert.rejects(
    () => db.execute(sql.rows<User>`UPDATE users`),
    (error: unknown) => error instanceof DatabaseResultKindError
      && error.code === 'BRAID_RESULT_KIND'
      && error.declaredKind === 'rows'
      && error.actualKind === 'command',
  );
  assert.deepEqual((await db.execute(sql.command`UPDATE users`)).command, { affectedRows: 1 });
  assert.deepEqual((await db.execute(sql`UPDATE users`)).command, { affectedRows: 1 });
  const batch = await db.batch([sql.rows<User>`SELECT user`, sql.command`UPDATE users`]);
  assert.deepEqual(batch.map((result) => result.kind), ['rows', 'command']);
  await assert.rejects(() => db.batch([sql.command`SELECT user`, sql.command`UPDATE users`]), DatabaseResultKindError);

  const malformed = createDatabase({
    async query() {
      return { rows: [] } as never;
    },
  });
  await assert.rejects(
    () => malformed.execute(sql`SELECT malformed`),
    TypeError,
  );

  const callQuery = sql.call`CALL users()`;
  await assert.rejects(() => db.execute(callQuery as never), TypeError);
  await assert.rejects(() => db.batch([callQuery] as never), TypeError);
  assert.equal(calls, 7);
});

test('validator exceptions propagate unchanged and malformed validator outputs are safe', async () => {
  const db = createDatabase(rowsExecutor([{ id: 1 }]));
  const thrown = new Error('validator failed');
  const throwing = schema<User>(() => {
    throw thrown;
  });
  await assert.rejects(() => db.all(sql.rows<User>`SELECT user`, { schema: throwing }), (error: unknown) => error === thrown);
  const rejecting = schema<User>(async () => { throw thrown; });
  await assert.rejects(() => db.all(sql.rows<User>`SELECT user`, { schema: rejecting }), (error: unknown) => error === thrown);

  const malformed = schema<User>(() => ({ value: { id: 1 }, issues: ['both'] } as never));
  await assert.rejects(
    () => db.all(sql.rows<User>`SELECT user`, { schema: malformed }),
    TypeError,
  );
});

function typeOnlyCallMisuse(database: Database) {
  // @ts-expect-error CallQuery is intentionally excluded from execute.
  database.execute(sql.call`CALL users()`);
  // @ts-expect-error CallQuery is intentionally excluded from batch.
  database.batch([sql.call`CALL users()`]);
  const incompatible = schema<{ id: string }>(() => ({ value: { id: 'wrong' } }));
  // @ts-expect-error Schema output cannot widen the declared row type.
  database.all(sql.rows<User>`SELECT user`, { schema: incompatible });
  // @ts-expect-error Schema output must match for cardinality helpers too.
  database.one(sql.rows<User>`SELECT user`, { schema: incompatible });
  // @ts-expect-error Schema output must match for optional rows too.
  database.maybeOne(sql.rows<User>`SELECT user`, { schema: incompatible });
  // @ts-expect-error Streaming retains the declared row contract.
  database.stream(sql.rows<User>`SELECT user`, { schema: incompatible });
  // @ts-expect-error Prepared row validation retains the declared contract.
  database.prepare('typed', () => sql.rows<User>`SELECT user`).all({ schema: incompatible });
}

void typeOnlyCallMisuse;
