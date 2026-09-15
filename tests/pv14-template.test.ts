import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createParameterTypeHint, createStatementBindingDescription } from '@sqlbraid/core';
import { capture, createSqlTag, sql } from '@sqlbraid/template';

test('renders immutable logical segments and atomic parameter records', () => {
  const hint = createParameterTypeHint({ databaseType: 'INTEGER', length: 8 });
  const rendered = sql`SELECT ${'Ada'}, ${sql.bind(7, hint)}`.render();

  assert.deepEqual(rendered.segments, ['SELECT ', ', ', '']);
  assert.deepEqual(rendered.parameters.map(({ value, interpolation, hint: parameterHint }) => ({ value, interpolation, hint: parameterHint })), [
    { value: 'Ada', interpolation: 0, hint: undefined },
    { value: 7, interpolation: 1, hint },
  ]);
  assert.equal(rendered.dialectId, 'postgres');
  assert.equal(rendered.segments.length, rendered.parameters.length + 1);
  assert.equal(Object.isFrozen(rendered), true);
  assert.equal(Object.isFrozen(rendered.segments), true);
  assert.equal(Object.isFrozen(rendered.parameters), true);
  assert.equal(Object.isFrozen(rendered.parameters[1]), true);
  assert.equal(Object.isFrozen(rendered.parameters[1].hint), true);
});

test('plain queries retain the original native template carrier', () => {
  let original: TemplateStringsArray | undefined;
  const captureTemplate = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    original = strings;
    return sql(strings, ...values);
  };
  const query = captureTemplate`SELECT ${1}, ${'quoted value'}`;
  const first = query.render();
  const second = query.render();

  assert.equal(first.nativeTemplate, original);
  assert.equal(second.nativeTemplate, original);
  assert.deepEqual(first.nativeTemplate, ['SELECT ', ', ', '']);
  assert.notEqual(first.nativeTemplate?.raw, first.nativeTemplate);
  assert.equal(Object.isFrozen(first.nativeTemplate), true);
  assert.equal(Object.isFrozen(first.nativeTemplate?.raw), true);
});

test('plain native queries validate cooked and raw SQL lexical contexts', () => {
  const slash = String.fromCharCode(92);
  const strings = [`SELECT 1 -- comment\n `, ''] as string[] & { raw?: readonly string[] };
  Object.defineProperty(strings, 'raw', {
    configurable: false,
    enumerable: false,
    value: Object.freeze([`SELECT 1 -- comment${slash}${slash}n `, '']),
    writable: false,
  });
  Object.freeze(strings);
  assert.throws(
    () => sql(strings as unknown as TemplateStringsArray, 1),
    /Interpolation inside a SQL literal or comment is unsupported/u,
  );
});

test('preparsed direct row tags preserve the declared result kind', () => {
  const source = sql`SELECT /*@braid if ${true}*/ id /*@braid end*/`;
  const captured = capture(sql.rows, ['SELECT /*@braid if ', '*/ id /*@braid end*/'], (values) => {
    values[0] = true;
  }, source.ir);

  assert.equal(captured.resultKind, 'rows');
  assert.deepEqual(captured.render().parameters, []);
});

test('structural native templates are synthesized and reused by shape', () => {
  const query = sql`SELECT /*@braid if ${true}*/ ${'value'} /*@braid end*/`;
  const first = query.render();
  const second = query.render();

  assert.equal(first.nativeTemplate, second.nativeTemplate);
  assert.deepEqual(first.nativeTemplate, ['SELECT  ', ' ']);
  assert.deepEqual(first.nativeTemplate?.raw, ['SELECT  ', ' ']);
  assert.notEqual(first.nativeTemplate?.raw, first.nativeTemplate);
  assert.equal(Object.isFrozen(first.nativeTemplate), true);
  assert.equal(Object.isFrozen(first.nativeTemplate?.raw), true);
  assert.equal(first.nativeTemplate?.length, first.parameters.length + 1);
});

test('keeps structural helpers out of parameters and preserves trim/directive behavior', () => {
  const tag = createSqlTag();
  const query = tag`UPDATE ${tag.ident('users')} /*@braid set*/ /*@braid if ${true}*/ ${tag.ident('name')} = ${'Ada'}, /*@braid end*/ /*@braid if ${false}*/ ${tag.ident('ignored')} = ${'nope'}, /*@braid end*/ /*@braid end*/ /*@braid where*/ /*@braid if ${true}*/ AND ${tag.ident('id')} IN (${tag.list([1, 2])}) /*@braid end*/ /*@braid end*/`;
  const rendered = query.render();

  assert.equal(rendered.segments.length, rendered.parameters.length + 1);
  assert.deepEqual(rendered.parameters.map((parameter) => parameter.value), ['Ada', 1, 2]);
  assert.match(rendered.segments[0], /^UPDATE "users" SET "name" = $/u);
  assert.match(rendered.segments.at(-1) ?? '', /\)$/u);
  assert.ok(rendered.segments.every((segment) => !/[?$]\d+|:\d+|@p\d+/u.test(segment)));
});

test('does not treat placeholder-looking SQL text as a parameter boundary', () => {
  const rendered = sql`SELECT '$1', '?', ':1', '@p1' /* $2 ? :2 @p2 */, ${42}`.render();
  assert.equal(rendered.segments[0], "SELECT '$1', '?', ':1', '@p1' /* $2 ? :2 @p2 */, ");
  assert.equal(rendered.parameters[0].value, 42);
  assert.equal(rendered.segments.length, 2);
});

test('enforces logical parameter limits before any transport is selected', () => {
  const limited = createSqlTag({ limits: { maxBindCount: 1 } });
  assert.throws(() => limited`SELECT ${1}, ${2}`.render(), /maxBindCount/u);
});

test('supports quoted dialect profiles without exposing driver placeholders', () => {
  const oracle = createSqlTag({
    dialect: {
      id: 'oracle',
      quoteIdentifier: (value) => `"${value.replaceAll('"', '""')}"`,
      lexicalProfile: { lineCommentPrefixes: ['--'], supportsOracleQQuotes: true },
    },
  });
  const sqlServer = createSqlTag({
    dialect: {
      id: 'mssql',
      quoteIdentifier: (value) => `[${value.replaceAll(']', ']]')}]`,
      lexicalProfile: { lineCommentPrefixes: ['--'], supportsBracketIdentifiers: true },
    },
  });
  const oracleStrings = ["SELECT q'[literal ", "]', ", ""];
  const sqlServerStrings = ['SELECT [literal ', '], ', ''];
  assert.throws(() => oracle(oracleStrings as unknown as TemplateStringsArray, 1), /Interpolation inside/u);
  assert.throws(() => sqlServer(sqlServerStrings as unknown as TemplateStringsArray, 1), /Interpolation inside/u);
  const oracleRendered = oracle`SELECT q'[literal]', ${1}`.render();
  const sqlServerRendered = sqlServer`SELECT [literal], ${1}`.render();
  assert.equal(oracleRendered.parameters.length, 1);
  assert.equal(sqlServerRendered.parameters.length, 1);
});

function generatedStatement(lines: number, binds: number) {
  const filler = Math.max(0, lines - binds - 1);
  const strings = Array.from({ length: binds + 1 }, (_, index) => index === 0
    ? `SELECT '$1', ? /* ${lines} lines */\n${'-- static SQL\n'.repeat(filler)}`
    : `  AND c${index} = $${index} ? :${index} @p${index}\n`);
  return capture(sql, strings, (values) => {
    for (let index = 0; index < binds; index += 1) values[index] = index;
  }).render();
}

test('renders MyBatis-scale logical statements without bind loss or reordering', () => {
  const small = generatedStatement(3_000, 200);
  assert.equal(small.parameters.length, 200);
  assert.equal(small.segments.length, 201);
  assert.ok(small.segments.join('').split('\n').length - 1 >= 3_000);
  assert.equal(small.parameters[0].value, 0);
  assert.equal(small.parameters[199].value, 199);
  assert.match(small.segments[0], /\$1/);
  const smallDescription = createStatementBindingDescription(small, { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'large-fixture',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'sqlbraid' },
  });
  const smallParameterized = smallDescription.parameterizedSql;
  assert.equal(smallParameterized, small.segments.map((segment, index) => `${segment}${index < small.parameters.length ? `$${index + 1}` : ''}`).join(''));
  const smallLiteralized = smallDescription.literalizedSql({ values: 'inline' }).text;
  assert.equal(smallLiteralized, small.segments.map((segment, index) => `${segment}${index < small.parameters.length ? String(small.parameters[index].value) : ''}`).join(''));

  const large = generatedStatement(10_000, 1_000);
  assert.equal(large.parameters.length, 1_000);
  assert.equal(large.segments.length, 1_001);
  assert.ok(large.segments.join('').split('\n').length - 1 >= 10_000);
  assert.equal(large.parameters[0].value, 0);
  assert.equal(large.parameters[999].value, 999);
  const largeDescription = createStatementBindingDescription(large, { dialectId: 'postgres', requestedReuse: 'auto' }, {
    adapterId: 'large-fixture',
    transport: 'text-positional',
    placeholder: (index) => `$${index}`,
    reuse: { effective: 'simple', owner: 'sqlbraid' },
  });
  assert.equal(largeDescription.parameterizedSql, large.segments.map((segment, index) => `${segment}${index < large.parameters.length ? `$${index + 1}` : ''}`).join(''));
  assert.equal(largeDescription.literalizedSql({ values: 'inline' }).text, large.segments.map((segment, index) => `${segment}${index < large.parameters.length ? String(large.parameters[index].value) : ''}`).join(''));
});
