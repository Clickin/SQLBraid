import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createStatementBindingDescription,
  type CallQuery,
  type Database,
  type RoutineCallResult,
  type StandardSchemaV1,
} from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import { preparedShape } from '../packages/runtime/src/prepared-shape.js';

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
