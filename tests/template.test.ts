import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CallQuery, CommandQuery, Query, RowQuery } from '@sqlbraid/core';
import { capture, sql } from '@sqlbraid/template';

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
