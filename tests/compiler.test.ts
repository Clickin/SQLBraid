import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { checkProject, checkSource, checkSourceDetailed, createProjectContext, createVirtualOverlay, discoverQueries, emitSource } from '@sqlbraid/compiler';

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

test('recognizes SQLite adapter and facade module specifiers by default', () => {
  const result = discoverQueries([
    'import { sql as better } from "@sqlbraid/sqlite/better-sqlite3";',
    'import { sql as libsql } from "@sqlbraid/sqlite/libsql";',
    'import { sql as facadeBetter } from "sqlbraid/better-sqlite3";',
    'import { sql as facadeLibsql } from "sqlbraid/libsql";',
    'const first = better`SELECT 1`;',
    'const second = libsql`SELECT 2`;',
    'const third = facadeBetter`SELECT 3`;',
    'const fourth = facadeLibsql`SELECT 4`;',
  ].join('\n'), 'sqlite-adapters.ts', {});
  assert.deepEqual(result.queries.map((query) => query.tagName), ['better', 'libsql', 'facadeBetter', 'facadeLibsql']);
  assert.deepEqual(result.queries.map((query) => query.moduleSpecifier), [
    '@sqlbraid/sqlite/better-sqlite3',
    '@sqlbraid/sqlite/libsql',
    'sqlbraid/better-sqlite3',
    'sqlbraid/libsql',
  ]);
});

test('preserves source escapes separately from cooked template strings', () => {
  const escaped = "import { sql } from '@sqlbraid/template'; const value = true; const query = sql`SELECT E'line\\n' /*@braid if ${value}*/ AND id = ${1} /*@braid end*/`;";
  const result = discoverQueries(escaped, 'escaped.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].strings[0], "SELECT E'line\n' /*@braid if ");
  assert.equal(result.queries[0].rawStrings[0], "SELECT E'line\\n' /*@braid if ");
});

test('lowered native carriers retain raw source escapes', async () => {
  const escaped = "import { sql } from '@sqlbraid/template'; export const query = sql`SELECT E'line\\n' /*@braid if ${true}*/ AND id = ${1} /*@braid end*/`;";
  const emitted = emitSource(escaped, 'escaped-runtime.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.deepEqual(emitted.diagnostics, []);
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-escaped-runtime-'));
  try {
    const file = join(directory, 'escaped-runtime.mjs');
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ''));
    const module = await import(pathToFileURL(file).href);
    const nativeTemplate = module.query.render().nativeTemplate;
    assert.equal(nativeTemplate[0], "SELECT E'line\n'  AND id = ");
    assert.equal(nativeTemplate.raw[0], "SELECT E'line\\n'  AND id = ");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MariaDB tags preserve native hash comments while finding active directives', () => {
  const native = [
    "import { sql } from '@sqlbraid/mariadb';",
    'const query = sql.rows`SELECT 1 AS id',
    '# /*@braid otherwise*/ is a native comment',
    '/*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;',
  ].join('\n');
  const result = discoverQueries(native, 'mariadb.ts', {});
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].declaredResultKind, 'rows');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(createVirtualOverlay(native, 'mariadb.ts', {}).diagnostics, []);
});

test('virtual overlay preserves source and attaches declared query contract', () => {
  const overlay = createVirtualOverlay(source, 'fixture.ts', {
    moduleSpecifier: '@sqlbraid/template',
  });
  assert.equal(overlay.sourceText, source);
  assert.deepEqual(overlay.queryTypes[0], { range: overlay.queryTypes[0].range, rowType: 'UserRow', resultKind: 'rows' });
  assert.equal(overlay.diagnostics.length, 0);
});

test('detailed checking separates native, Braid, and lowering-only diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlbraid-diagnostic-provenance-'));
  try {
    const moduleSpecifier = './tag';
    const fileName = join(directory, 'fixture.ts');
    writeFileSync(join(directory, 'tag.ts'), 'export declare const sql: any;\n');
    const source = [
      `import { sql } from '${moduleSpecifier}';`,
      'const native: string = 123;',
      'const malformed = sql`SELECT 1 /*@braid otherwise*/`;',
      'const lowered = sql`SELECT 1 /*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;',
    ].join('\n');
    const result = checkSourceDetailed(source, fileName, { moduleSpecifier });
    assert.deepEqual(result.nativeTypeScriptDiagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
    assert.ok(result.braidDiagnostics.some((diagnostic) => diagnostic.code === 'BRAID_STRUCTURE'));
    assert.ok(result.overlayTypeScriptDiagnostics.some((diagnostic) => diagnostic.code === 'TS2322'));
    assert.ok(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === 'TS2307'));
    assert.ok(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === 'TS7006'));
    assert.equal(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === 'TS2322'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('detailed checking matches mapped diagnostics by source range, not repeated snippets', () => {
  const source = "import { sql } from '@sqlbraid/template'; /* string */ const comment = 'string'; const first: string = 1; const q=sql`SELECT 1 /*@braid if ${true}*/ WHERE value = ${1} /*@braid end*/`; const second: string = 2; class Base { x = 1; } class Child extends Base { query = sql`SELECT 1 /*@braid if ${true}*/ WHERE value = ${super.x} /*@braid end*/`; }";
  const result = checkSourceDetailed(source, join(tmpdir(), 'sqlbraid-repeated-diagnostic.ts'), options);
  const native = result.nativeTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === 'TS2322');
  const overlay = result.overlayTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === 'TS2322');
  assert.equal(native.length, 2);
  assert.deepEqual(overlay.map((diagnostic) => diagnostic.range), native.map((diagnostic) => diagnostic.range));
  assert.equal(result.nativeTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === 'TS2855').length, 1);
  assert.equal(result.overlayTypeScriptDiagnostics.filter((diagnostic) => diagnostic.code === 'TS2855').length, 1);
  assert.equal(result.overlayOnlyDiagnostics.some((diagnostic) => diagnostic.code === 'TS2855'), false);
});

test('discovers explicit rows, command, and call tag helpers', () => {
  const result = discoverQueries("import { sql as dbSql } from '@sqlbraid/template'; import type { RoutineCallResult } from '@sqlbraid/core'; type UserRow = { id: number }; type CallResult = RoutineCallResult<{ readonly ok: boolean }, readonly [{ readonly id: number }], number>; const contract = {}; const rows = dbSql.rows<UserRow>`SELECT id FROM users`; const command = dbSql.command`UPDATE users SET active = true`; const call = dbSql.call<CallResult>`CALL refresh_users()`; const contracted = dbSql.call(contract)`CALL refresh_users()`;", 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.deepEqual(result.queries.map((query) => ({ name: query.tagName, kind: query.declaredResultKind, type: query.declaredRowType })), [
    { name: 'dbSql.rows', kind: 'rows', type: 'UserRow' },
    { name: 'dbSql.command', kind: 'command', type: undefined },
    { name: 'dbSql.call', kind: 'call', type: 'CallResult' },
    { name: 'dbSql.call(contract)', kind: 'call', type: undefined },
  ]);
});

test('discovers mapped rows through direct, aliased, and namespace imports', () => {
  const mapped = `
    import { sql } from '@sqlbraid/template';
    import { sql as dbSql } from '@sqlbraid/template';
    import * as braid from '@sqlbraid/template';
    declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, { id: number }>;
    const direct = sql.rows(UserSchema)\`SELECT id FROM users\`;
    const alias = dbSql.rows(UserSchema)\`SELECT id FROM users\`;
    const namespace = braid.sql.rows(UserSchema)\`SELECT id FROM users\`;
    const unrelated = { rows: (_schema: unknown) => (_strings: TemplateStringsArray) => undefined };
    const ignored = unrelated.rows(UserSchema)\`SELECT id FROM users\`;
  `;
  const result = discoverQueries(mapped, 'mapped.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(result.queries.length, 3);
  for (const query of result.queries) {
    assert.equal(query.declaredResultKind, 'rows');
    assert.equal(query.mappedRow, true);
    assert.equal(query.resultSchemaExpression, 'UserSchema');
    const schemaRange = query.resultSchemaRange;
    assert.ok(schemaRange);
    assert.equal(mapped.slice(schemaRange.start, schemaRange.end), 'UserSchema');
  }
});

// Cold TypeScript programs exceed Vitest's default 5s on the Node floor CI runner.
test('checker discovers mapped rows through a re-export', () => {
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-mapped-project-'));
  try {
    writeFileSync(join(directory, 'bridge.ts'), "export { sql } from '@sqlbraid/template';\n");
    writeFileSync(join(directory, 'main.ts'), "import { sql } from './bridge.js'; declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, { id: number }>; export const query = sql.rows(UserSchema)`SELECT id FROM users`;\n");
    const projectFile = join(directory, 'tsconfig.json');
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, baseUrl: '.', paths: { '@sqlbraid/*': ['../packages/*/src/index.ts'] } }, include: ['*.ts'] }));
    const context = createProjectContext(projectFile);
    const sourceFile = context.program.getSourceFile(join(directory, 'main.ts'));
    assert.ok(sourceFile);
    const discovered = discoverQueries(sourceFile.text, sourceFile.fileName, { moduleSpecifier: '@sqlbraid/template', compilerOptions: context.compilerOptions, sourceFile, typeChecker: context.checker });
    assert.equal(discovered.queries.length, 1);
    assert.equal(discovered.queries[0].mappedRow, true);
    assert.equal(checkProject(projectFile, { moduleSpecifier: '@sqlbraid/template' }).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test('mapped rows use the Standard Schema output type for downstream checking', () => {
  const mapped = `
    import { sql } from '@sqlbraid/template';
    import type { Database } from '@sqlbraid/core';
    declare const db: Database;
    type UserRow = { id: number };
    declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, UserRow>;
    declare const user: { id: number } | null;
    const query = sql.rows(UserSchema)\`SELECT id FROM users /*@braid if \${user !== null}*/ WHERE id = \${user.id} /*@braid end*/\`;
    async function read() {
      const rows = await db.all(query);
      return rows[0].missing;
    }
  `;
  const diagnostics = checkSource(mapped, join(tmpdir(), 'sqlbraid-mapped-output.ts'), options);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['TS2339']);
});

test('mapped guarded lowering preserves the tag call and evaluates schema once', async () => {
  const source = `
    import { sql } from '@sqlbraid/template';
    export function build(getSchema, observe, enabled) {
      return sql.rows(getSchema())\`SELECT id FROM users /*@braid if \${observe('condition', enabled)}*/ WHERE id = \${observe('value', 1)} /*@braid end*/\`;
    }
  `;
  const emitted = emitSource(source, 'mapped-guarded.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(emitted.diagnostics.length, 0);
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-mapped-runtime-'));
  try {
    const file = join(directory, 'mapped-guarded.mjs');
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ''));
    const module = await import(pathToFileURL(file).href);
    const schema = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } };
    const events: string[] = [];
    const getSchema = () => { events.push('schema'); return schema; };
    const observe = (event: string, value: unknown) => { events.push(event); return value; };
    const query = module.build(getSchema, observe, true);
    assert.deepEqual(events, ['schema', 'condition', 'value']);
    assert.equal(query.resultSchema, schema);
    assert.deepEqual(query.render().parameters.map(({ value }: { readonly value: unknown }) => value), [1]);
    events.length = 0;
    const inactive = module.build(getSchema, observe, false);
    assert.deepEqual(events, ['schema', 'condition']);
    assert.equal(inactive.resultSchema, schema);
    assert.deepEqual(inactive.render().parameters, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('capture and guarded preserve tag contracts and reject cross-kind arguments', () => {
  const declarations = `
    import { sql, capture, guarded } from '@sqlbraid/template';
    import type { Query, RowQuery, CommandQuery, CommandResult, CallQuery, RoutineCallResult } from '@sqlbraid/core';
    type Row = { id: number };
    type CallResult = RoutineCallResult<{ readonly ok: boolean }, readonly [{ readonly id: number }], number>;
    const rows: RowQuery<Row> = capture(sql.rows<Row>, ['opaque'], () => {});
    const command: CommandQuery = capture<CommandResult, 'command'>(sql.command, ['opaque'], () => {});
    const call: CallQuery<CallResult> = guarded<CallResult, 'call'>(sql.call, ['opaque'], []);
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
}, 15_000);

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
  const declarations = "import {sql} from '@sqlbraid/template'; import type {RowQuery, CommandQuery, CallQuery, Query, RoutineCallResult} from '@sqlbraid/core'; type Row={score:number}; type CallResult=RoutineCallResult<{ok:boolean}, readonly [{id:number}]>; declare const user:{name:string}|null;";
  const queries = opaque.map((text, index) => `const q${index}: RowQuery<Row> = sql.rows<Row>\`${text}\`;`);
  const guarded = "const dynamic: RowQuery<Row> = sql.rows<Row>`SELECT proprietary_extension(foo, bar) /*@braid if ${user != null}*/ FROM vendor_relation WHERE name=${user.name} /*@braid end*/`;";
  const kinds = "const command:CommandQuery = sql.command`opaque /*@braid if ${true}*/ vendor_command() /*@braid end*/`; const call:CallQuery<CallResult> = sql.call<CallResult>`opaque /*@braid if ${true}*/ vendor_call() /*@braid end*/`; const unknown:Query<unknown,'unknown'> = sql`SELECT id FROM users`;";
  const input = [declarations, ...queries, guarded, kinds].join('\n');
  assert.deepEqual(checkSource(input, join(tmpdir(), 'sqlbraid-opaque.ts'), options), []);
  const overlay = createVirtualOverlay(input, 'sqlbraid-opaque.ts', options);
  assert.deepEqual(overlay.queryTypes.map(({ rowType, resultKind }) => [rowType, resultKind]), [
    ...Array.from({ length: 5 }, () => ['Row', 'rows']),
    ['import("@sqlbraid/core").CommandResult', 'command'],
    ['CallResult', 'call'],
    ['unknown', 'unknown'],
  ]);
});
