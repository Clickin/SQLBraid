import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createStatementBindingDescription,
  type CallQuery,
  type ExecutionOptions,
  type Database,
  type Query,
  type RoutineCallResult,
  type StandardSchemaV1,
} from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import { preparedShape } from '../packages/runtime/src/prepared-shape.js';
// @ts-expect-error Driver packages must not expose dialect-specific query aliases.
import type { PgQuery } from '@sqlbraid/postgres';
// @ts-expect-error Driver packages must not expose dialect-specific query aliases.
import type { MysqlQuery } from '@sqlbraid/mysql';
// @ts-expect-error Bun.SQL transport details must not expose a driver-specific query alias.
import type { BunQuery } from '@sqlbraid/bun-sql';

function schema<Output>(): StandardSchemaV1<unknown, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'pv15-contracts',
      validate: (value) => ({ value: value as Output }),
    },
  };
}

declare const db: Database;

async function routineContractResultTypeAssertions(): Promise<void> {
  const contracted = sql.call({ returnValue: schema<number>() })`CALL typed()`;
  const result = await db.call(contracted);
  const requiredNumber: number = result.returnValue;
  // @ts-expect-error a contracted number return value cannot be used as a string.
  const incompatibleReturn: string = result.returnValue;

  const bareQuery: CallQuery<RoutineCallResult> = sql.call`CALL bare()`;
  const bare = await db.call(bareQuery);
  const noReturnContract = await db.call(sql.call({
    resultSets: [schema<{ readonly id: number }>()] as const,
  })`CALL no_return()`);
  type AssertTrue<Value extends true> = Value;
  type BareReturnIsOptional = AssertTrue<{} extends Pick<typeof bare, 'returnValue'> ? true : false>;
  type NoReturnContractIsOptional = AssertTrue<{} extends Pick<typeof noReturnContract, 'returnValue'> ? true : false>;
  void requiredNumber;
  void incompatibleReturn;
  void bare;
  void noReturnContract;
}

async function publicSpiTypeAssertions(): Promise<void> {
  type User = { readonly id: number };
  type Payment = { readonly amount: number };
  type Dashboard = RoutineCallResult<
    { readonly generatedAt: Date },
    readonly [User, Payment],
    number
  >;

  // @ts-expect-error Query's second parameter is a result kind, never a dialect.
  type DialectGenericQuery = Query<User, 'postgres'>;

  const zeroInput = db.prepare('zero-input', () => sql.rows<User>`SELECT 1`);
  const inputFactory = db.prepare('input-row', (id: number) => sql.rows<User>`SELECT ${id}`);
  const undefinedInput = db.prepare('undefined-input', (_input: undefined) => sql.rows<User>`SELECT 1`);
  await undefinedInput.one(undefined, { signal: new AbortController().signal });
  // @ts-expect-error A required undefined input is not the zero-input options position.
  await undefinedInput.one({ signal: new AbortController().signal });
  // @ts-expect-error Optional/default parameters make input/options arity ambiguous.
  db.prepare('default-input', (id = 1) => sql.rows<User>`SELECT ${id}`);
  // @ts-expect-error Optional input parameters are not a fixed required input.
  db.prepare('optional-input', (id?: number) => sql.rows<User>`SELECT ${id ?? 1}`);
  // @ts-expect-error Rest parameters do not define one fixed application input.
  db.prepare('rest-input', (...ids: number[]) => sql.rows<User>`SELECT ${ids[0]}`);
  // @ts-expect-error Put multiple application fields in one input object.
  db.prepare('multiple-inputs', (id: number, name: string) => sql.rows<User>`SELECT ${id}, ${name}`);
  const commandFactory = db.prepare('command-input', (input: { readonly id: number; readonly name: string }) =>
    sql.command`UPDATE users SET name = ${input.name} WHERE id = ${input.id}`);
  const routineFactory = db.prepare('heterogeneous-call', () => sql.call({
    output: schema<{ readonly generatedAt: Date }>(),
    resultSets: [schema<User>(), schema<Payment>()] as const,
    returnValue: schema<number>(),
  })`CALL dashboard()`);

  const zeroRow: User = await zeroInput.one({ signal: new AbortController().signal });
  const zeroResult = await zeroInput.execute();
  const inputRows: readonly User[] = await inputFactory.all(7, { signal: new AbortController().signal });
  const maybeInput: User | undefined = await inputFactory.maybeOne(7);
  const command = await commandFactory.execute({ id: 1, name: 'Ada' });
  const dashboard: Dashboard = await routineFactory.call();
  const firstUser: User = dashboard.resultSets[0].rows[0]!;
  const secondPayment: Payment = dashboard.resultSets[1].rows[0]!;
  const generatedAt: Date = dashboard.output.generatedAt;
  const returnValue: number = dashboard.returnValue!;
  // @ts-expect-error Input factories require their input before execution options.
  await inputFactory.one({ signal: new AbortController().signal });
  // @ts-expect-error Command prepared handles expose execute, not row cardinality methods.
  await commandFactory.one();
  // @ts-expect-error Call prepared handles expose call, not execute.
  await routineFactory.execute();
  type AssertTrue<Value extends true> = Value;
  type AssertFalse<Value extends false> = Value;
  type HasTimeout = AssertFalse<'timeoutMs' extends keyof ExecutionOptions ? true : false>;
  // @ts-expect-error Generated keys require user-authored SQL, not execution rewriting.
  await db.execute(sql.command`INSERT INTO users DEFAULT VALUES`, { generatedKeys: true });
  type RowHandleHasStream = AssertTrue<'stream' extends keyof typeof inputFactory ? true : false>;
  type CommandHandleHasNoStream = AssertFalse<'stream' extends keyof typeof commandFactory ? true : false>;
  type CallHandleHasNoExecute = AssertFalse<'execute' extends keyof typeof routineFactory ? true : false>;
  void zeroRow;
  void zeroResult;
  void inputRows;
  void maybeInput;
  void command;
  void firstUser;
  void secondPayment;
  void generatedAt;
  void returnValue;
}

test('routine contracts infer heterogeneous result-set tuples and channels', () => {
  type User = { readonly id: number };
  type Payment = { readonly amount: number };
  type Expected = RoutineCallResult<
    { readonly generatedAt: Date },
    readonly [User, Payment],
    number
  >;
  const query = sql.call({
    output: schema<{ readonly generatedAt: Date }>(),
    resultSets: [schema<User>(), schema<Payment>()] as const,
    returnValue: schema<number>(),
  })`CALL dashboard(${sql.out('__proto__')}, ${sql.inOut('accountId', 7)})`;
  const typed: CallQuery<Expected> = query;
  const explicit: CallQuery<Expected> = sql.call<Expected>`CALL dashboard(${1}, ${2})`;
  const three: CallQuery<RoutineCallResult<
    Readonly<Record<string, unknown>>,
    readonly [User, Payment, { readonly total: number }]
  >> = sql.call({
    resultSets: [schema<User>(), schema<Payment>(), schema<{ readonly total: number }>()] as const,
  })`CALL summary()`;
  void three;
  // @ts-expect-error output schemas are part of the complete call result.
  const wrongOutput: CallQuery<RoutineCallResult<{ readonly generatedAt: string }, readonly [User, Payment], number>> = query;
  // @ts-expect-error result-set tuple positions remain heterogeneous.
  const wrongTuple: CallQuery<RoutineCallResult<{ readonly generatedAt: Date }, readonly [Payment, User], number>> = query;
  assert.equal(typed.resultKind, 'call');
  assert.equal(explicit.resultKind, 'call');
  void wrongOutput;
  void wrongTuple;
  assert.deepEqual(
    typed.render().parameters.map(({ direction, outputName, value }) => ({ direction, outputName, value })),
    [
      { direction: 'out', outputName: '__proto__', value: null },
      { direction: 'inout', outputName: 'accountId', value: 7 },
    ],
  );
});

test('routine procedure metadata is snapshotted and parameter-count checked', () => {
  const procedure = { name: 'dashboard', parameterNames: ['accountId', 'status'] };
  const query = sql.call({
    procedure,
  })`CALL dashboard(${sql.inOut('accountId', 7)}, ${sql.out('status')})`;
  const rendered = query.render();
  procedure.parameterNames[0] = 'mutated';
  assert.equal(rendered.routineProcedure?.parameterNames[0], 'accountId');

  assert.throws(
    () => sql.call({ procedure: { name: 'dashboard', parameterNames: ['only'] } })`CALL dashboard(${1}, ${2})`.render(),
    /parameterNames must match/u,
  );
});

test('OUT descriptors are legal for rows and calls, while output names remain unique', () => {
  assert.equal(sql.rows`SELECT ${sql.out('value')}`.render().resultKind, 'rows');
  assert.throws(
    () => sql.call`CALL work(${sql.out('value')}, ${sql.inOut('value', 1)})`.render(),
    /Duplicate routine outputName/u,
  );
});

test('prepared logical identity distinguishes routine direction, output name and cursor hint but not values', () => {
  const hint = { databaseType: 'refcursor' };
  const initial = sql.call`CALL work(${sql.inOut('cursor', 'portal', hint)})`;
  const identity = preparedShape(initial.resultKind, initial.render());
  const nextValue = sql.call`CALL work(${sql.inOut('cursor', 'another-portal', hint)})`;
  assert.equal(preparedShape(nextValue.resultKind, nextValue.render()), identity);
  const changedDirection = sql.call`CALL work(${sql.out('cursor', hint)})`;
  const changedName = sql.call`CALL work(${sql.inOut('other', 'portal', hint)})`;
  const changedHint = sql.call`CALL work(${sql.inOut('cursor', 'portal', { databaseType: 'text' })})`;
  for (const changed of [changedDirection, changedName, changedHint]) {
    assert.notEqual(preparedShape(changed.resultKind, changed.render()), identity);
  }
});

test('statement binding preserves routine metadata and enforces dialect identity', () => {
  const rendered = sql.call`CALL work(${sql.inOut('value', 1)})`.render();
  const binding = createStatementBindingDescription(rendered, {
    dialectId: 'postgres',
    requestedReuse: 'auto',
    transactionScoped: true,
  }, {
    adapterId: 'pv15-test',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'driver' },
  });
  assert.throws(
    () => createStatementBindingDescription(rendered, {
      dialectId: 'mysql',
      requestedReuse: 'auto',
    }, {
      adapterId: 'pv15-test',
      transport: 'text-positional',
      placeholder: (index) => `?${index}`,
      reuse: { effective: 'simple', owner: 'driver' },
    }),
    /does not match rendered statement dialect/u,
  );
});

test('literalized complete only tracks truncation', () => {
  const rendered = sql`SELECT ${'secret'}`.render();
  const binding = createStatementBindingDescription(rendered, {
    dialectId: 'postgres',
    requestedReuse: 'auto',
  }, {
    adapterId: 'pv15-test',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'driver' },
  });
  assert.equal(binding.literalizedSql().complete, true);
  assert.equal(binding.literalizedSql({ values: 'redacted' }).complete, true);
  assert.equal(binding.literalizedSql({ values: 'inline', maxValueLength: 3 }).complete, false);
});
