import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BoundParameter, Dialect, ParameterTypeHint } from '@sqlbraid/core';
import { isBoundParameter } from '@sqlbraid/core';
import { capture, createSqlTag, guarded, sql } from '@sqlbraid/template';

function hasCode(code: string): (error: unknown) => boolean {
  return (error): error is { readonly code: string } => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

const integerHint: ParameterTypeHint<number> = { databaseType: 'INTEGER' };
const numberParameter: BoundParameter<number> = sql.bind(1, integerHint);
// @ts-expect-error A hint's explicit input type constrains the bound value.
sql.bind('not an integer', integerHint);

const oracleDialect: Dialect = {
  id: 'oracle-test',
  placeholder: (index) => `:${index}`,
  quoteIdentifier: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  lexicalProfile: {
    lineCommentPrefixes: ['--'],
    supportsNestedBlockComments: true,
    supportsOracleQQuotes: true,
    backslashEscapes: false,
  },
};

const bracketDialect: Dialect = {
  id: 'bracket-test',
  placeholder: (index) => `?`,
  quoteIdentifier: (identifier) => `[${identifier.replaceAll(']', ']]')}]`,
  lexicalProfile: {
    lineCommentPrefixes: ['--'],
    supportsBracketIdentifiers: true,
  },
};

test('bind wrappers are branded, frozen, and preserve ordinary values at the driver boundary', () => {
  const mutableHint = { databaseType: 'INTEGER', length: 8 };
  const immutableParameter = sql.bind(1, mutableHint);
  mutableHint.length = 16;
  assert.equal(immutableParameter.hint.length, 8);
  assert.equal(isBoundParameter(numberParameter), true);
  assert.equal(isBoundParameter({ value: 1, hint: integerHint }), false);
  assert.equal(Object.isFrozen(numberParameter), true);
  assert.equal(Object.isFrozen(numberParameter.hint), true);

  const query = sql`SELECT ${'Ada'}, ${numberParameter}, ${true}`;
  const rendered = query.render();
  assert.deepEqual(rendered.values, ['Ada', 1, true]);
  assert.deepEqual(rendered.parameterHints, [undefined, numberParameter.hint, undefined]);
  assert.equal(Object.isFrozen(rendered.parameterHints), true);
  assert.equal(Object.hasOwn(rendered, 'parameterHints'), true);
  assert.equal(Object.hasOwn(sql`SELECT ${1}`.render(), 'parameterHints'), false);
});

test('hints align through lists, nested fragments, and trim nodes', () => {
  const textHint: ParameterTypeHint<string> = { databaseType: 'VARCHAR', length: 80 };
  const list = sql.list([sql.bind(1, integerHint), 2]);
  const nested = sql.fragment`(${sql.bind('Ada', textHint)})`;
  const query = sql`SELECT ${nested} /*@braid where*/ /*@braid if ${true}*/ AND id IN (${list}) /*@braid end*/ /*@braid end*/`;
  const rendered = query.render();
  assert.deepEqual(rendered.values, ['Ada', 1, 2]);
  assert.deepEqual(rendered.parameterHints, [textHint, integerHint, undefined]);
  assert.match(rendered.text, /WHERE/);
});

test('hint descriptors reject malformed structural fields', () => {
  assert.throws(() => sql.bind(1, null as never), TypeError);
  assert.throws(() => sql.bind(1, [] as never), TypeError);
  assert.throws(() => sql.bind(1, { databaseType: ' ' } as never), TypeError);
  assert.throws(() => sql.bind(1, { databaseType: 'INT', length: -1 } as never), TypeError);
  assert.throws(() => sql.bind(1, { databaseType: 'INT', precision: Number.NaN } as never), TypeError);
  assert.throws(() => sql.bind(1, { databaseType: 'INT', scale: 1.5 } as never), TypeError);
  assert.equal(sql.bind(1, { databaseType: 'NUMBER', scale: -2 }).hint.scale, -2);
});

test('bound wrappers are rejected as directive conditions in normal and captured paths', () => {
  const condition = sql.bind(true, { databaseType: 'BIT' });
  assert.throws(() => sql`SELECT 1 /*@braid if ${condition}*/ AND 1 = 1 /*@braid end*/`.render(), hasCode('BRAID_BIND_HINT_CONTEXT'));
  assert.throws(() => guarded(sql, ['SELECT 1 /*@braid if ', '*/ AND 1 = 1 /*@braid end*/'], [() => condition]), hasCode('BRAID_BIND_HINT_CONTEXT'));
  const captured = capture(sql, ['SELECT 1 /*@braid if ', '*/ AND 1 = 1 /*@braid end*/'], (values) => { values[0] = condition; });
  assert.throws(() => captured.render(), hasCode('BRAID_BIND_HINT_CONTEXT'));
});

test('guarded capture remains lazy for inactive bind branches', () => {
  let evaluated = 0;
  const query = guarded(sql, ['SELECT 1 /*@braid if ', '*/ AND id = ', ' /*@braid end*/'], [() => false, () => { evaluated += 1; return sql.bind(1, integerHint); }]);
  assert.equal(evaluated, 0);
  assert.deepEqual(query.render().values, []);
});

test('Oracle q literals and configured bracket identifiers protect interpolations', () => {
  const oracle = createSqlTag({ dialect: oracleDialect });
  for (const literal of ["q'[/*@braid if nope*/]'", "q'{a ${not-a-hole}}'", "q'(a) b)'", "q'<a > b>'", "q'!a ! b!'"]) {
    const query = oracle([`SELECT ${literal}`] as unknown as TemplateStringsArray);
    assert.equal(query.render().text, `SELECT ${literal}`);
  }
  assert.throws(() => oracle`SELECT q'[${1}]'`, hasCode('BRAID_HOLE_CONTEXT'));
  const oracleEscapedQuote = oracle([`SELECT 'a\\' || `, ''] as unknown as TemplateStringsArray, 1);
  assert.deepEqual(oracleEscapedQuote.render().values, [1]);
  const bracketed = createSqlTag({ dialect: bracketDialect });
  assert.throws(() => bracketed`SELECT [${1}]`, hasCode('BRAID_HOLE_CONTEXT'));
});
