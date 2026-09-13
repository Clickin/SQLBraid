import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createStatementBindingDescription } from '@sqlbraid/core';
import type {
  Database,
  DriverRoutineResult,
  QueryExecutor,
  RenderedStatement,
  StatementBindingAdapter,
  StandardSchemaV1,
} from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import {
  createDatabase,
  DatabaseCardinalityError,
  DatabaseResultKindError,
  DatabaseResultValidationError,
} from '@sqlbraid/runtime';

type User = { readonly id: number };
type MappedUser = { readonly id: number; readonly source: 'first' | 'second' };

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: 'runtime-validation-test',
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: 'runtime-validation-test',
      transport: 'text-positional',
      placeholder: (index) => `$${index}`,
      reuse: { effective: 'simple', owner: 'sqlbraid' },
    });
  },
})

function statementText(statement: RenderedStatement): string {
  return statement.segments.join('?');
}

function schema<Row>(
  validate: (value: unknown) => StandardSchemaV1.Result<Row> | Promise<StandardSchemaV1.Result<Row>>,
): StandardSchemaV1<unknown, Row> {
  return {
    '~standard': {
      version: 1,
      vendor: 'runtime-tests',
      validate,
    },
  } as StandardSchemaV1<unknown, Row>;
}

function rowsExecutor(rows: readonly unknown[]): QueryExecutor {
  return {
    statementBinding,
    async query<Row>(_rendered: RenderedStatement) {
      return { kind: 'rows' as const, rows: rows as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error('BRAID_STREAM_UNSUPPORTED'); },
    async call(): Promise<DriverRoutineResult> { throw new Error('BRAID_CALL_UNSUPPORTED'); },
  };
}

function validationFailure(message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message }] };
}

test('query-bound mapping is intrinsic to every row API', async () => {
  const mapper = schema<MappedUser>((value) => ({
    value: { ...(value as User), source: 'first' },
  }));
  const query = sql.rows(mapper)`SELECT users`;
  const db = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));

  assert.deepEqual((await db.execute(query)).rows, [
    { id: 1, source: 'first' },
    { id: 2, source: 'first' },
  ]);
  assert.deepEqual(await db.all(query), [
    { id: 1, source: 'first' },
    { id: 2, source: 'first' },
  ]);

  const one = createDatabase(rowsExecutor([{ id: 3 }]));
  assert.deepEqual(await one.one(query), { id: 3, source: 'first' });
  assert.deepEqual(await one.maybeOne(query), { id: 3, source: 'first' });

  const secondMapper = schema<MappedUser>((value) => ({
    value: { ...(value as User), source: 'second' },
  }));
  const batch = await one.batch([
    sql.rows(mapper)`SELECT first`,
    sql.rows(secondMapper)`SELECT second`,
  ] as const);
  assert.deepEqual(batch.map((result) => result.rows), [
    [{ id: 3, source: 'first' }],
    [{ id: 3, source: 'second' }],
  ]);
});

test('execution validation remains optional and supports asynchronous re-entry', async () => {
  const calls: number[] = [];
  const db = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));
  assert.deepEqual(await db.all(sql.rows<User>`SELECT users`), [{ id: 1 }, { id: 2 }]);
  const asynchronous = schema<User>(async (value) => {
    const id = (value as User).id;
    await db.execute(sql`SELECT lookup`);
    calls.push(id);
    return { value: { id: id + 10 } };
  });
  assert.deepEqual(await db.all(sql.rows<User>`SELECT users`, { schema: asynchronous }), [
    { id: 11 },
    { id: 12 },
  ]);
  assert.deepEqual(calls, [1, 2]);
});

test('query-bound and execution schemas compose in order', async () => {
  const calls: string[] = [];
  const querySchema = schema<User>((value) => {
    calls.push(`query:${(value as User).id}`);
    return { value: { id: (value as User).id + 10 } };
  });
  const executionSchema = schema<User>((value) => {
    calls.push(`execution:${(value as User).id}`);
    return { value: { id: (value as User).id * 2 } };
  });
  const db = createDatabase(rowsExecutor([{ id: 1 }]));

  assert.deepEqual(await db.all(sql.rows(querySchema)`SELECT user`, { schema: executionSchema }), [{ id: 22 }]);
  assert.deepEqual(await db.one(sql.rows(querySchema)`SELECT user`, { schema: executionSchema }), { id: 22 });
  assert.deepEqual(calls, ['query:1', 'execution:11', 'query:1', 'execution:11']);

  calls.length = 0;
  const failingExecution = schema<User>((value) => {
    calls.push(`execution:${(value as User).id}`);
    return (value as User).id === 12 ? validationFailure('second row failed') : { value: value as User };
  });
  const many = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));
  await assert.rejects(() => many.all(sql.rows(querySchema)`SELECT users`, { schema: failingExecution }), DatabaseResultValidationError);
  assert.deepEqual(calls, ['query:1', 'execution:11', 'query:2', 'execution:12']);
});

test('cardinality is checked before either mapper runs', async () => {
  let queryValidations = 0;
  let executionValidations = 0;
  const querySchema = schema<User>((value) => {
    queryValidations += 1;
    return { value: value as User };
  });
  const executionSchema = schema<User>((value) => {
    executionValidations += 1;
    return { value: value as User };
  });
  const many = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }]));

  await assert.rejects(() => many.one(sql.rows(querySchema)`SELECT users`, { schema: executionSchema }), DatabaseCardinalityError);
  await assert.rejects(() => many.maybeOne(sql.rows(querySchema)`SELECT users`, { schema: executionSchema }), DatabaseCardinalityError);
  assert.equal(queryValidations, 0);
  assert.equal(executionValidations, 0);

  const empty = createDatabase(rowsExecutor([]));
  assert.equal(await empty.maybeOne(sql.rows(querySchema)`SELECT user`, { schema: executionSchema }), undefined);
  assert.equal(queryValidations, 0);
  assert.equal(executionValidations, 0);
});

test('all and streaming map rows sequentially and close at the first failure', async () => {
  const calls: number[] = [];
  const db = createDatabase(rowsExecutor([{ id: 1 }, { id: 2 }, { id: 3 }]));
  const ordered = schema<User>(async (value) => {
    const id = (value as User).id;
    calls.push(id);
    await Promise.resolve();
    return id === 2 ? validationFailure('invalid id') : { value: { id: id + 10 } };
  });
  await assert.rejects(
    () => db.all(sql.rows(ordered)`SELECT users`),
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.code === 'BRAID_RESULT_VALIDATION'
      && error.stage === 'query'
      && error.rowIndex === 1
      && (error.issues[0] as { readonly message: string }).message === 'invalid id',
  );
  assert.deepEqual(calls, [1, 2]);

  let consumed = 0;
  let closed = false;
  const streaming = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: 'rows' as const, rows: [] as readonly Row[] };
    },
    async call(): Promise<DriverRoutineResult> { throw new Error('BRAID_CALL_UNSUPPORTED'); },
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
  const output: User[] = [];
  await assert.rejects(
    async () => {
      for await (const row of streaming.stream(sql.rows(ordered)`SELECT users`)) output.push(row);
    },
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.stage === 'query'
      && error.rowIndex === 1,
  );
  assert.deepEqual(output, [{ id: 11 }]);
  assert.equal(consumed, 2);
  assert.equal(closed, true);
});

test('stream composes execution schemas one row at a time', async () => {
  const calls: string[] = [];
  const querySchema = schema<User>((value) => {
    calls.push('query');
    return { value: { id: (value as User).id + 1 } };
  });
  const executionSchema = schema<User>((value) => {
    calls.push('execution');
    return { value: { id: (value as User).id * 2 } };
  });
  const db = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: 'rows' as const, rows: [] as readonly Row[] };
    },
    async call(): Promise<DriverRoutineResult> { throw new Error('BRAID_CALL_UNSUPPORTED'); },
    stream<Row>() {
      return (async function* () {
        yield { id: 1 } as Row;
        yield { id: 2 } as Row;
      })();
    },
  });
  const output: User[] = [];
  for await (const row of db.stream(sql.rows(querySchema)`SELECT users`, { schema: executionSchema })) output.push(row);
  assert.deepEqual(output, [{ id: 4 }, { id: 6 }]);
  assert.deepEqual(calls, ['query', 'execution', 'query', 'execution']);
});

test('prepared queries use the mapper from the current factory result', async () => {
  const first = schema<User>((value) => ({ value: { id: (value as User).id + 1 } }));
  const second = schema<User>((value) => ({ value: { id: (value as User).id + 2 } }));
  let useFirst = true;
  const db = createDatabase(rowsExecutor([{ id: 10 }]));
  const prepared = db.prepare('user', () => {
    const current = useFirst ? first : second;
    useFirst = false;
    return sql.rows(current)`SELECT user`;
  });

  assert.deepEqual((await prepared.execute()).rows, [{ id: 11 }]);
  assert.deepEqual((await prepared.execute()).rows, [{ id: 12 }]);
  assert.deepEqual(await prepared.all(), [{ id: 12 }]);
  assert.deepEqual(await prepared.one(), { id: 12 });
  assert.deepEqual(await prepared.maybeOne(), { id: 12 });
});

test('transaction-scoped row APIs preserve query-bound mapping', async () => {
  const mapper = schema<User>((value) => ({ value: { id: (value as User).id + 5 } }));
  const db = createDatabase({
    ...rowsExecutor([{ id: 7 }]),
    async begin() {},
    async commit() {},
    async rollback() {},
  });

  await db.tx(async (tx) => {
    assert.deepEqual((await tx.execute(sql.rows(mapper)`SELECT user`)).rows, [{ id: 12 }]);
    assert.deepEqual(await tx.all(sql.rows(mapper)`SELECT user`), [{ id: 12 }]);
    assert.deepEqual(await tx.one(sql.rows(mapper)`SELECT user`), { id: 12 });
    assert.deepEqual(await tx.maybeOne(sql.rows(mapper)`SELECT user`), { id: 12 });
  });
});

test('result kinds are asserted before mapping and unknown rows stay raw', async () => {
  let validations = 0;
  const mapper = schema<User>((value) => {
    validations += 1;
    return { value: value as User };
  });
  const db = createDatabase({
    statementBinding,
    async query<Row>(rendered: RenderedStatement) {
      if (statementText(rendered).includes('UPDATE')) {
        return { kind: 'command' as const, rows: [] as const, command: { affectedRows: 1 } };
      }
      return { kind: 'rows' as const, rows: [{ id: 1 }] as unknown as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error('BRAID_STREAM_UNSUPPORTED'); },
    async call(): Promise<DriverRoutineResult> { throw new Error('BRAID_CALL_UNSUPPORTED'); },
  });

  assert.deepEqual((await db.execute(sql`SELECT user`)).rows, [{ id: 1 }]);
  await assert.rejects(
    () => db.execute(sql.rows(mapper)`UPDATE users`),
    (error: unknown) => error instanceof DatabaseResultKindError
      && error.declaredKind === 'rows'
      && error.actualKind === 'command',
  );
  assert.equal(validations, 0);
  assert.deepEqual((await db.execute(sql.rows(mapper)`SELECT user`)).rows, [{ id: 1 }]);
  assert.equal(validations, 1);

  const malformed = createDatabase({
    statementBinding,
    async query() {
      return { rows: [] } as never;
    },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error('BRAID_STREAM_UNSUPPORTED'); },
    async call(): Promise<DriverRoutineResult> { throw new Error('BRAID_CALL_UNSUPPORTED'); },
  });
  await assert.rejects(() => malformed.execute(sql`SELECT malformed`), TypeError);
  await assert.rejects(() => malformed.batch([sql`SELECT malformed`]), TypeError);
});

test('validation failures identify query and execution stages', async () => {
  const queryFailure = schema<User>(() => validationFailure('query failure'));
  const executionFailure = schema<User>(() => validationFailure('execution failure'));
  const db = createDatabase(rowsExecutor([{ id: 1 }]));

  await assert.rejects(
    () => db.all(sql.rows(queryFailure)`SELECT user`, { schema: executionFailure }),
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.stage === 'query'
      && error.rowIndex === 0,
  );

  await assert.rejects(
    () => db.all(sql.rows(schema<User>((value) => ({ value: value as User })))`SELECT user`, { schema: executionFailure }),
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.stage === 'execution'
      && error.rowIndex === 0,
  );
});

test('validator exceptions propagate unchanged and malformed results are rejected', async () => {
  const db = createDatabase(rowsExecutor([{ id: 1 }]));
  const thrown = new Error('validator failed');
  const throwing = schema<User>(() => {
    throw thrown;
  });
  await assert.rejects(() => db.all(sql.rows(throwing)`SELECT user`), (error: unknown) => error === thrown);
  const rejecting = schema<User>(async () => {
    throw thrown;
  });
  await assert.rejects(() => db.all(sql.rows(rejecting)`SELECT user`), (error: unknown) => error === thrown);

  const malformedResult = schema<User>(() => ({ value: { id: 1 }, issues: [{ message: 'both' }] } as never));
  await assert.rejects(() => db.all(sql.rows(malformedResult)`SELECT user`), TypeError);
  const malformedExecution = schema<User>(() => ({ value: { id: 1 }, issues: [{ message: 'both' }] } as never));
  await assert.rejects(() => db.all(sql.rows(schema<User>((value) => ({ value: value as User })))`SELECT user`, { schema: malformedExecution }), TypeError);

  const malformedSchema = { '~standard': { version: 1, vendor: 'test' } };
  assert.throws(() => sql.rows(malformedSchema as unknown as StandardSchemaV1), TypeError);
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
