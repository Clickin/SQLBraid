import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createVirtualOverlay, discoverQueries } from '@sqlbraid/compiler';

const source = `import { sql as dbSql } from '@sqlbraid/template';\nconst name: string | null = 'Ada';\ntype UserRow = { id: bigint };\nconst query = dbSql<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table /*@braid where*/ /*@braid if \${name != null}*/ AND name = \${name} /*@braid end*/ /*@braid end*/\`;`;

test('discovers aliased SQL tags by import identity', () => {
  const result = discoverQueries(source, 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].bindings.length, 2);
  assert.equal(result.queries[0].bindings[1].expression, 'name');
});

test('virtual overlay preserves source and attaches declared query contract', () => {
  const overlay = createVirtualOverlay(source, 'fixture.ts', {
    moduleSpecifier: '@sqlbraid/template',
    analyze: (query) => ({ rowType: '{ id: bigint }', bindingTypes: query.bindings.map((_, index) => index === 1 ? 'string' : 'boolean') }),
  });
  assert.equal(overlay.sourceText, source);
  assert.deepEqual(overlay.queryTypes[0], { range: overlay.queryTypes[0].range, rowType: 'UserRow', bindingTypes: ['boolean', 'string'], resultKind: 'rows' });
  assert.equal(overlay.diagnostics.length, 0);
});

test('discovers explicit rows, command, and call tag helpers', () => {
  const result = discoverQueries("import { sql as dbSql } from '@sqlbraid/template'; type UserRow = { id: number }; const rows = dbSql.rows<UserRow>`SELECT id FROM users`; const command = dbSql.command`UPDATE users SET active = true`; const call = dbSql.call<UserRow>`CALL refresh_users()`;", 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.deepEqual(result.queries.map((query) => ({ name: query.tagName, kind: query.declaredResultKind, type: query.expectedType })), [
    { name: 'dbSql.rows', kind: 'rows', type: 'UserRow' },
    { name: 'dbSql.command', kind: 'command', type: undefined },
    { name: 'dbSql.call', kind: 'call', type: 'UserRow' },
  ]);
});
