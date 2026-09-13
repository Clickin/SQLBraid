import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createRenderedStatement,
  createStatementBindingDescription,
  parameterizedSql,
  type ParameterTransportKind,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
} from '@sqlbraid/core';
import { createSqlTag, sql } from '@sqlbraid/template';
import { createDatabase } from '@sqlbraid/runtime';

function logicalStatement(values: readonly unknown[] = ['O\'Reilly', null, true]): RenderedStatement {
  const segments: string[] = values.map((_, index) => index === 0 ? 'SELECT ' : ', ');
  segments.push('');
  return createRenderedStatement({
    dialectId: 'postgres',
    segments,
    parameters: values.map((value, interpolation) => ({ value, interpolation })),
    resultKind: 'rows',
  });
}

function conformanceCase(
  name: string,
  adapter: StatementBindingAdapter,
  context: StatementBindingContext,
  expectedTransport: ParameterTransportKind,
  expectedSql: string | undefined,
  execute?: (statement: RenderedStatement, description: ReturnType<StatementBindingAdapter['describe']>) => void,
): void {
  test(`${name} preserves value-only bindings and transport order`, () => {
    const statement = logicalStatement([1, 2, 3]);
    const description = adapter.describe(statement, context);
    assert.equal(description.adapterId, adapter.id);
    assert.equal(description.dialectId, context.dialectId);
    assert.equal(description.transport, expectedTransport);
    assert.equal(description.parameterizedSql, expectedSql);
    assert.deepEqual(description.bindings.map((binding) => binding.index), [1, 2, 3]);
    assert.deepEqual(description.bindings.map((binding) => binding.interpolation), [0, 1, 2]);
    assert.equal(Object.isFrozen(description), true);
    assert.equal(Object.isFrozen(description.bindings), true);
    assert.equal(Object.isFrozen(description.reuse), true);
    execute?.(statement, description);
  });
}

const polyglotAdapter: StatementBindingAdapter = {
  id: 'polyglot-test-driver',
  describe(statement, context) {
    const placeholder = context.dialectId === 'postgres' ? (index: number) => `$${index}` : context.dialectId === 'mysql' ? () => '?' : undefined;
    return createStatementBindingDescription(statement, context, {
      adapterId: 'polyglot-test-driver',
      transport: placeholder === undefined ? 'native-value-template' : 'text-positional',
      ...(placeholder === undefined ? {} : { placeholder }),
      reuse: { effective: context.requestedReuse === 'simple' ? 'simple' : 'reuse', owner: 'driver', capacity: 16 },
    });
  },
};

const executeFixture = (statement: RenderedStatement, description: ReturnType<StatementBindingAdapter['describe']>) => {
  assert.equal(statement.parameters.length, description.bindings.length);
  assert.equal(statement.segments.length, statement.parameters.length + 1);
};

conformanceCase('positional PostgreSQL', polyglotAdapter, { dialectId: 'postgres', requestedReuse: 'auto' }, 'text-positional', 'SELECT $1, $2, $3', executeFixture);
conformanceCase('positional MySQL', polyglotAdapter, { dialectId: 'mysql', requestedReuse: 'simple' }, 'text-positional', 'SELECT ?, ?, ?', executeFixture);
conformanceCase('native SQLite profile', polyglotAdapter, { dialectId: 'sqlite', requestedReuse: 'reuse' }, 'native-value-template', undefined, executeFixture);

test('parameterizedSql interleaves logical segments directly with one-based placeholders', () => {
  const statement = logicalStatement([1, 2]);
  assert.equal(parameterizedSql(statement, (index) => `@p${index}`), 'SELECT @p1, @p2');
});

test('literalizedSql is lazy, cached, redacted by default, and dialect-aware', () => {
  const statement = logicalStatement(["O'Reilly", null, true]);
  const description = createStatementBindingDescription(statement, { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'diagnostic',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'sqlbraid' },
  });
  const first = description.literalizedSql();
  assert.equal(first.text, 'SELECT [REDACTED], [REDACTED], [REDACTED]');
  assert.equal(first.redactedParameters, 3);
  assert.equal(description.literalizedSql(), first);
  const inlineOptions = { values: 'inline' as const };
  const inline = description.literalizedSql(inlineOptions);
  assert.equal(inline.text, "SELECT 'O''Reilly', NULL, TRUE");
  assert.equal(description.literalizedSql(inlineOptions), inline);
  assert.equal(Object.isFrozen(inline), true);
});

test('literalizedSql supports custom redaction, truncation, binary summaries, and safe object fallback', () => {
  let toStringCalls = 0;
  const unsupported = {
    get [Symbol.toStringTag](): string {
      toStringCalls += 1;
      return 'DoNotInspect';
    },
    toString(): string {
      toStringCalls += 1;
      throw new Error('custom toString must not run');
    },
  };
  const statement = logicalStatement(["abcdefghi", new Uint8Array([0, 1, 255]), unsupported]);
  const description = createStatementBindingDescription(statement, { dialectId: 'sqlite', requestedReuse: 'auto' }, {
    adapterId: 'diagnostic',
    transport: 'text-positional',
    placeholder: () => '?',
    reuse: { effective: 'simple', owner: 'driver' },
  });
  const result = description.literalizedSql({ values: 'inline', binary: 'summary', redact: (_, index) => index === 0 });
  assert.equal(result.redactedParameters, 1);
  assert.equal(result.truncatedParameters, 0);
  const truncated = description.literalizedSql({ values: 'inline', maxValueLength: 8, binary: 'summary', redact: (_, index) => index === 0 });
  assert.ok(truncated.truncatedParameters > 0);
  assert.equal(truncated.complete, false);
  assert.match(result.text, /\[REDACTED\]/u);
  assert.match(result.text, /binary 3 bytes/u);
  assert.match(result.text, /unsupported object/u);
  assert.equal(toStringCalls, 0);
  assert.match(description.literalizedSql({ values: 'inline', binary: 'full' }).text, /X'0001ff'/u);
});

test('literalizedSql snapshots mutable policies and does not cache stateful redactors', () => {
  const date = new Date('2026-01-02T03:04:05.000Z');
  Object.defineProperty(date, 'toISOString', { value: () => { throw new Error('overridden Date method must not run'); } });
  const statement = logicalStatement([date, 'secret']);
  const description = createStatementBindingDescription(statement, { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'diagnostic',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'sqlbraid' },
  });
  const mutable: { values: 'inline' | 'redacted' } = { values: 'inline' };
  const inline = description.literalizedSql(mutable);
  mutable.values = 'redacted';
  const redacted = description.literalizedSql(mutable);
  assert.notEqual(inline, redacted);
  assert.match(inline.text, /\[date 2026-01-02T03:04:05\.000Z\]/u);
  assert.match(redacted.text, /\[REDACTED\]/u);

  let redact = true;
  const policy = { values: 'inline' as const, redact: () => redact };
  const first = description.literalizedSql(policy);
  redact = false;
  const second = description.literalizedSql(policy);
  assert.notEqual(first.text, second.text);
  assert.notEqual(first, second);
});

test('literalizedSql rejects invalid policies before invoking formatters', () => {
  let formatterCalls = 0;
  const description = createStatementBindingDescription(logicalStatement([1]), { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'diagnostic',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'sqlbraid' },
    formatLiteral: () => {
      formatterCalls += 1;
      return '1';
    },
  });
  assert.throws(() => description.literalizedSql({ values: 'mask' as unknown as 'inline' }), /values/u);
  assert.throws(() => description.literalizedSql({ binary: 'hex' as unknown as 'summary', values: 'inline' }), /binary/u);
  assert.throws(() => description.literalizedSql({ maxValueLength: Number.POSITIVE_INFINITY, values: 'inline' }), /maxValueLength/u);
  assert.throws(() => description.literalizedSql({ redact: 1 as unknown as () => boolean, values: 'inline' }), /redact/u);
  assert.equal(formatterCalls, 0);
});

test('custom literal formatting receives zero-based callback indices without rewriting source text', () => {
  const indexes: number[] = [];
  const statement = createRenderedStatement({
    dialectId: 'postgres',
    segments: ["SELECT '$1', ? /* :1 @p1 */, ", ' /* $2 */'],
    parameters: [{ value: 7, interpolation: 4 }],
    resultKind: 'command',
  });
  const description = createStatementBindingDescription(statement, { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'custom',
    transport: 'text-named',
    placeholder: (index) => `:v${index}`,
    reuse: { effective: 'simple', owner: 'server' },
    formatLiteral: (parameter, index) => {
      indexes.push(index);
      return `<${String(parameter.value)}>`;
    },
  });
  assert.equal(description.parameterizedSql, "SELECT '$1', ? /* :1 @p1 */, :v1 /* $2 */");
  assert.equal(description.literalizedSql({ values: 'inline' }).text, "SELECT '$1', ? /* :1 @p1 */, <7> /* $2 */");
  assert.deepEqual(indexes, [0]);
});

test('one native transport executes multiple dialects but rejects structural values before native invocation', async () => {
  let structuralInvocations = 0;
  let nativeInvocations = 0;
  const nativeStructural = {
    sql: 'DROP TABLE important_data',
    executeStructure(): void {
      structuralInvocations += 1;
    },
    toString(): string {
      structuralInvocations += 1;
      throw new Error('native structural value must not be stringified');
    },
  };
  const nativeTag = (_strings: readonly string[], ...values: readonly unknown[]) => {
    nativeInvocations += 1;
    return values.map((value) => {
      if (value === nativeStructural) {
        nativeStructural.executeStructure();
        return nativeStructural.sql;
      }
      return value;
    });
  };
  const effectiveDialects: string[] = [];
  const adapter: StatementBindingAdapter = {
    id: 'safe-native',
    describe(statement, context) {
      if (statement.parameters.some(({ value }) => value !== null && typeof value === 'object')) {
        throw new TypeError('Native transport accepts scalar values only.');
      }
      effectiveDialects.push(context.dialectId);
      return createStatementBindingDescription(statement, context, {
        adapterId: 'safe-native',
        transport: 'native-value-template',
        reuse: { effective: 'simple', owner: 'driver' },
      });
    },
  };
  const db = createDatabase({
    statementBinding: adapter,
    async query<Row>(statement: RenderedStatement) {
      const values = nativeTag(statement.segments, ...statement.parameters.map(({ value }) => value));
      return { kind: 'rows' as const, rows: values.map((value) => ({ value })) as unknown as readonly Row[] };
    },
  });
  for (const dialectId of ['postgres', 'mysql', 'sqlite']) {
    const tag = createSqlTag({ dialect: { id: dialectId, quoteIdentifier: (value) => `"${value.replaceAll('"', '""')}"` } });
    assert.deepEqual(await db.all(tag.rows`SELECT ${dialectId}`), [{ value: dialectId }]);
    const before = nativeInvocations;
    await assert.rejects(() => db.all(tag.rows`SELECT ${nativeStructural}`), /scalar values only/);
    assert.equal(nativeInvocations, before);
  }
  assert.deepEqual(effectiveDialects, ['postgres', 'mysql', 'sqlite']);
  assert.equal(nativeInvocations, 3);
  assert.equal(structuralInvocations, 0);
});

test('createRenderedStatement rejects malformed shape and snapshots records without freezing application values', () => {
  const applicationValue = { mutable: true };
  assert.throws(() => createRenderedStatement({ dialectId: 'x', segments: Array<string>(1), parameters: [], resultKind: 'unknown' }), /array of strings/u);
  assert.throws(() => createRenderedStatement({ dialectId: 'x', segments: ['', ''], parameters: Array(1), resultKind: 'unknown' }), /parameter records/u);
  assert.throws(() => createRenderedStatement({ dialectId: 'x', segments: ['only'], parameters: [{ value: 1 }], resultKind: 'unknown' }), /invariant/u);
  const statement = createRenderedStatement({ dialectId: 'x', segments: ['', ''], parameters: [{ value: applicationValue }], resultKind: 'unknown' });
  assert.equal(Object.isFrozen(statement.parameters[0]), true);
  assert.equal(Object.isFrozen(applicationValue), false);
  applicationValue.mutable = false;
  assert.equal(statement.parameters[0].value, applicationValue);
});
