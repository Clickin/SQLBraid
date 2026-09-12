import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CallQuery, CommandQuery, Query, RowQuery, StandardSchemaV1 } from '@sqlbraid/core';
import { capture, guarded, sql } from '@sqlbraid/template';

function hasCode(code: string): (error: unknown) => boolean {
  return (error): error is { readonly code: string } => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

test('renders dynamic where and binds active values in order', () => {
  const name = 'Ada';
  const minimumId = 7;
  const query = sql`
    SELECT id, name
    FROM users
    /*@braid where*/
      /*@braid if ${name != null}*/ AND name = ${name} /*@braid end*/
      /*@braid if ${minimumId != null}*/ AND id >= ${minimumId} /*@braid end*/
    /*@braid end*/
  `;
  const rendered = query.render();
  assert.match(rendered.text, /WHERE/);
  assert.deepEqual(rendered.values, ['Ada', 7]);
  assert.doesNotMatch(rendered.text, /@braid/);
});

test('preserves ordinary comments and quotes explicit identifiers', () => {
  const query = sql`/* @braid not-a-directive */ SELECT ${sql.ident('users.name')} FROM ${sql.ident('users')}`;
  const rendered = query.render();
  assert.match(rendered.text, /\/\* @braid not-a-directive \*\//);
  assert.equal(rendered.text, '/* @braid not-a-directive */ SELECT "users"."name" FROM "users"');
  assert.deepEqual(rendered.values, []);
});

test('trims the final assignment comma and rejects ambiguous empty lists', () => {
  const patch = { email: 'a@example.com', status: undefined };
  const query = sql`UPDATE users /*@braid set*/ /*@braid if ${patch.email !== undefined}*/ email = ${patch.email}, /*@braid end*/ /*@braid if ${patch.status !== undefined}*/ status = ${patch.status}, /*@braid end*/ /*@braid end*/ WHERE id = ${1}`;
  assert.match(query.render().text, /SET\s+email = \$1\s+WHERE/);
  assert.throws(() => sql.list([]), hasCode('BRAID_EMPTY_LIST'));
});

test('choose selects the first true branch and nested fragments preserve bind order', () => {
  const id = 3;
  const email = 'ada@example.com';
  const query = sql`
    SELECT * FROM users
    /*@braid choose*/
      /*@braid when ${false}*/ AND id = ${1}
      /*@braid when ${true}*/ AND email = ${email}
      /*@braid otherwise*/ AND active = ${true}
    /*@braid end*/
    AND id = ${id}
  `;
  const rendered = query.render();
  assert.deepEqual(rendered.values, [email, id]);
  assert.match(rendered.text, /email = \$1/);
  assert.doesNotMatch(rendered.text, /active =/);
});

test('fragment and join are explicit structural composition', () => {
  const values = [1, 2];
  const fragment = sql.join(values.map((value) => sql.fragment`(${value})`), sql.fragment`, `);
  const rendered = sql`INSERT INTO users(id) VALUES ${fragment}`.render();
  assert.equal(rendered.text, 'INSERT INTO users(id) VALUES ($1), ($2)');
  assert.deepEqual(rendered.values, values);
});

test('query tags expose declared result kinds', () => {
  type UserRow = { readonly id: number };
  const rows: RowQuery<UserRow> = sql.rows<UserRow>`SELECT id FROM users`;
  const command: CommandQuery = sql.command`UPDATE users SET active = ${true}`;
  const call: CallQuery<UserRow> = sql.call<UserRow>`CALL refresh_users()`;
  const untyped: Query<unknown, 'unknown'> = sql`SELECT 1`;
  const captured: RowQuery<UserRow> = capture<UserRow, 'rows'>(sql.rows, ['SELECT ', ''], (values) => { values[0] = 1; });
  assert.equal(rows.resultKind, 'rows');
  assert.equal(command.resultKind, 'command');
  assert.equal(call.resultKind, 'call');
  assert.equal(untyped.resultKind, 'unknown');
  assert.equal(captured.resultKind, 'rows');
});

test('schema-bound rows retain the mapper reference and render normally', () => {
  type MappedRow = { readonly id: number; readonly label: string };
  const schema: StandardSchemaV1<unknown, MappedRow> = {
    '~standard': {
      version: 1,
      vendor: 'template-tests',
      validate: (value) => ({ value: { id: (value as { id: number }).id, label: 'mapped' } }),
    },
  };
  const mappedRows = sql.rows(schema);
  const first: RowQuery<MappedRow> = mappedRows`SELECT id FROM users`;
  const second: RowQuery<MappedRow> = mappedRows`SELECT id FROM users`;
  const otherSchema: StandardSchemaV1<unknown, MappedRow> = {
    '~standard': { version: 1, vendor: 'other-tests', validate: schema['~standard'].validate },
  };
  const other = sql.rows(otherSchema)`SELECT id FROM users`;
  assert.equal(first.resultSchema, schema);
  assert.equal(second.resultSchema, schema);
  assert.equal(other.resultSchema, otherSchema);
  const firstRendered = first.render();
  const secondRendered = second.render();
  assert.equal(firstRendered.text, 'SELECT id FROM users');
  assert.equal(firstRendered.variantFingerprint, secondRendered.variantFingerprint);
  assert.deepEqual(firstRendered, other.render());
  assert.equal(Object.hasOwn(firstRendered, 'resultSchema'), false);
  assert.equal(firstRendered.resultKind, 'rows');
});

test('schema-bound rows compose with capture and guarded without losing the mapper', () => {
  type MappedRow = { readonly id: number };
  const schema: StandardSchemaV1<unknown, MappedRow> = {
    '~standard': { version: 1, vendor: 'template-tests', validate: (value) => ({ value: value as MappedRow }) },
  };
  const mappedRows = sql.rows(schema);
  const captured = capture(mappedRows, ['SELECT ', ''], (values) => { values[0] = 1; });
  const guardedQuery = guarded(mappedRows, ['SELECT ', ''], [() => 1]);
  assert.equal(captured.resultSchema, schema);
  assert.equal(guardedQuery.resultSchema, schema);
  assert.deepEqual(captured.render().values, [1]);
  assert.deepEqual(guardedQuery.render().values, [1]);
});

test('schema-bound rows reject invalid Standard Schema shapes before query creation', () => {
  assert.throws(() => sql.rows(null as never), TypeError);
  assert.throws(() => sql.rows({} as never), TypeError);
  assert.throws(() => sql.rows([] as never), TypeError);
  assert.throws(() => sql.rows({ '~standard': { version: 2, validate: () => ({ value: 1 }) } } as never), TypeError);
  assert.throws(() => sql.rows({ '~standard': { version: 1, validate: 'nope' } } as never), TypeError);
});
