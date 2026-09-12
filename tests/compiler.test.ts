import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { checkSource, createVirtualOverlay, discoverQueries } from '@sqlbraid/compiler';

const source = `import { sql as dbSql } from '@sqlbraid/template';\nconst name: string | null = 'Ada';\ntype UserRow = { id: bigint };\nconst query = dbSql.rows<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table /*@braid where*/ /*@braid if \${name != null}*/ AND name = \${name} /*@braid end*/ /*@braid end*/\`;`;
const options = {
  moduleSpecifier: '@sqlbraid/template',
  compilerOptions: { baseUrl: process.cwd(), paths: { '@sqlbraid/*': ['packages/*/src/index.ts'] } },
};

test('discovers aliased SQL tags by import identity', () => {
  const result = discoverQueries(source, 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].bindings.length, 2);
  assert.equal(result.queries[0].bindings[1].expression, 'name');
});

test('virtual overlay preserves source and attaches declared query contract', () => {
  const overlay = createVirtualOverlay(source, 'fixture.ts', {
    moduleSpecifier: '@sqlbraid/template',
  });
  assert.equal(overlay.sourceText, source);
  assert.deepEqual(overlay.queryTypes[0], { range: overlay.queryTypes[0].range, rowType: 'UserRow', resultKind: 'rows' });
  assert.equal(overlay.diagnostics.length, 0);
});

test('discovers explicit rows, command, and call tag helpers', () => {
  const result = discoverQueries("import { sql as dbSql } from '@sqlbraid/template'; type UserRow = { id: number }; const rows = dbSql.rows<UserRow>`SELECT id FROM users`; const command = dbSql.command`UPDATE users SET active = true`; const call = dbSql.call<UserRow>`CALL refresh_users()`;", 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.deepEqual(result.queries.map((query) => ({ name: query.tagName, kind: query.declaredResultKind, type: query.declaredRowType })), [
    { name: 'dbSql.rows', kind: 'rows', type: 'UserRow' },
    { name: 'dbSql.command', kind: 'command', type: undefined },
    { name: 'dbSql.call', kind: 'call', type: 'UserRow' },
  ]);
});

test('capture and guarded preserve tag contracts and reject cross-kind arguments', () => {
  const declarations = `
    import { sql, capture, guarded } from '@sqlbraid/template';
    import type { Query, RowQuery, CommandQuery, CommandResult, CallQuery } from '@sqlbraid/core';
    type Row = { id: number };
    const rows: RowQuery<Row> = capture(sql.rows<Row>, ['opaque'], () => {});
    const command: CommandQuery = capture<CommandResult, 'command'>(sql.command, ['opaque'], () => {});
    const call: CallQuery<Row> = guarded(sql.call<Row>, ['opaque'], []);
    const unknown: Query<unknown, 'unknown'> = guarded(sql, ['opaque'], []);
    const inferredRows: RowQuery = capture(sql.rows, ['opaque'], () => {});
  `;
  assert.deepEqual(checkSource(declarations, join(tmpdir(), 'sqlbraid-capture-contracts.ts'), options), []);
  const invalid = `${declarations}
    capture<Row, 'rows'>(sql.command, ['opaque'], () => {});
    capture<Row, 'call'>(sql.rows, ['opaque'], () => {});
    guarded<Row, 'rows'>(sql.call, ['opaque'], []);
    guarded<Row, 'command'>(sql, ['opaque'], []);
  `;
  const diagnostics = checkSource(invalid, join(tmpdir(), 'sqlbraid-capture-mismatches.ts'), options);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['TS2345', 'TS2345', 'TS2345', 'TS2345']);
});

test('bare sql rejects generic row shorthand with or without guards', () => {
  const invalid = "import {sql} from '@sqlbraid/template'; type Row = {id:number}; const plain=sql<Row>`SELECT 1`; const dynamic=sql<Row>`SELECT 1 /*@braid if ${true}*/ WHERE id=${1} /*@braid end*/`;";
  const diagnostics = checkSource(invalid, join(tmpdir(), 'sqlbraid-no-shorthand.ts'), options);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'TS2558'));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'TS2635'));
});

test('opaque SQL needs no schema or local SQL grammar and keeps declared contracts', () => {
  const opaque = [
    'SELECT custom_company_function(account_id) AS score FROM reporting_view',
    "SELECT jsonb_path_query(payload, '$.items[*]') FROM events",
    'SELECT value @@ vendor_specific_operator(pattern) FROM custom_table',
    'SELECT proprietary_extension(foo, bar) FROM vendor_relation',
  ];
  const declarations = "import {sql} from '@sqlbraid/template'; import type {RowQuery, CommandQuery, CallQuery, Query} from '@sqlbraid/core'; type Row={score:number}; declare const user:{name:string}|null;";
  const queries = opaque.map((text, index) => `const q${index}: RowQuery<Row> = sql.rows<Row>\`${text}\`;`);
  const guarded = "const dynamic: RowQuery<Row> = sql.rows<Row>`SELECT proprietary_extension(foo, bar) /*@braid if ${user != null}*/ FROM vendor_relation WHERE name=${user.name} /*@braid end*/`;";
  const kinds = "const command:CommandQuery = sql.command`opaque /*@braid if ${true}*/ vendor_command() /*@braid end*/`; const call:CallQuery<Row> = sql.call<Row>`opaque /*@braid if ${true}*/ vendor_call() /*@braid end*/`; const unknown:Query<unknown,'unknown'> = sql`SELECT id FROM users`;";
  const input = [declarations, ...queries, guarded, kinds].join('\n');
  assert.deepEqual(checkSource(input, join(tmpdir(), 'sqlbraid-opaque.ts'), options), []);
  const overlay = createVirtualOverlay(input, 'sqlbraid-opaque.ts', options);
  assert.deepEqual(overlay.queryTypes.map(({ rowType, resultKind }) => [rowType, resultKind]), [
    ...Array.from({ length: 5 }, () => ['Row', 'rows']),
    ['import("@sqlbraid/core").CommandResult', 'command'],
    ['Row', 'call'],
    ['unknown', 'unknown'],
  ]);
});
