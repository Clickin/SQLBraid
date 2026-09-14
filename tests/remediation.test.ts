import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import ts from 'typescript';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { createStatementBindingDescription, parameterizedSql } from '@sqlbraid/core';
import type { RenderedStatement, StatementBindingContext } from '@sqlbraid/core';
import { checkProject, checkSource, createProjectContext, createVirtualOverlay, discoverQueries, emitSource, sourcePosition } from '@sqlbraid/compiler';
import { fingerprintQuery, templateFamilyFingerprint } from '@sqlbraid/operations';
import { createPgDatabase } from '@sqlbraid/postgres/pg';
import { createPostgresInspector } from '@sqlbraid/postgres/inspector';
import { createNodeSqliteDatabase } from '@sqlbraid/sqlite/node-sqlite';
import { createSqliteInspector } from '@sqlbraid/sqlite/inspector';
import { createMysqlInspector } from '@sqlbraid/mysql/inspector';
import { createDatabase } from '@sqlbraid/runtime';
import { createSqlTag } from '@sqlbraid/template';
import { sql as postgres } from '@sqlbraid/postgres';
import { sql as sqlite } from '@sqlbraid/sqlite';

type PgQueryConfig = { readonly text: string; readonly values: readonly unknown[] };

const compilerOptions = {
  baseUrl: process.cwd(),
  paths: { '@sqlbraid/*': ['packages/*/src/index.ts'] },
};

function hasCode(code: string): (error: unknown) => boolean {
  return (error): error is { readonly code: string } => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

const testBinding = {
  id: 'remediation-test',
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    return createStatementBindingDescription(statement, context, {
      adapterId: 'remediation-test',
      transport: 'native-value-template',
      reuse: { effective: 'simple', owner: 'sqlbraid' },
    });
  },
} as const;

function postgresSql(statement: RenderedStatement): string {
  return parameterizedSql(statement, (index) => `$${index}`);
}

test('template scanner preserves marker text in SQL lexical regions', () => {
  assert.equal(postgres`SELECT '/*@braid where*/ x /*@braid end*/' AS marker`.render().segments.join(''), "SELECT '/*@braid where*/ x /*@braid end*/' AS marker");
  assert.equal(postgres`SELECT $$ /*@braid where*/ $$ AS marker`.render().segments.join(''), 'SELECT $$ /*@braid where*/ $$ AS marker');
  assert.equal(postgres`SELECT '\u00000\u0000' AS marker`.render().segments.join(''), "SELECT '\u00000\u0000' AS marker");
  assert.equal(postgres`-- /*@braid end*/\nSELECT 1`.render().segments.join(''), '-- /*@braid end*/\nSELECT 1');
  const parsed = discoverQueries("import {sql} from '@sqlbraid/template'; const q=sql`SELECT '${name}'`;", 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(parsed.diagnostics[0].code, 'BRAID_HOLE_CONTEXT');
});

test('trim rejects empty SET, omits comment-only WHERE, and preserves line comment LF', () => {
  const emptySet = postgres`UPDATE users /*@braid set*/ /*@braid if ${false}*/ name = ${'Ada'}, /*@braid end*/ /*@braid end*/ WHERE id = ${1}`;
  assert.throws(() => emptySet.render(), hasCode('BRAID_EMPTY_SET'));
  const comments = postgres`SELECT id FROM users /*@braid where*/ /* explanation */ /*@braid end*/`.render();
  assert.equal(comments.segments.join(''), 'SELECT id FROM users /* explanation */');
  const line = postgres`SELECT id FROM users /*@braid where*/ AND id = ${1} -- condition\n/*@braid end*/ ORDER BY id`.render();
  assert.match(postgresSql(line), /-- condition\n\s*ORDER BY id/);
  assert.equal(postgres`SELECT/*@braid if ${false}*/ DISTINCT /*@braid end*/id FROM users`.render().segments.join(''), 'SELECT id FROM users');
});

test('structural inputs are captured and bounded', () => {
  const ids = [1];
  const query = postgres`SELECT id FROM users WHERE id IN (${postgres.list(ids)})`;
  ids.push(2);
  assert.deepEqual(query.render().parameters.map(({ value }: { readonly value: unknown }) => value), [1]);
  assert.equal(Object.isFrozen(query.ir), true);
  assert.equal(Object.isFrozen(query.ir.nodes), true);
  assert.throws(() => postgres.list([]), hasCode('BRAID_EMPTY_LIST'));
  assert.throws(() => createSqlTag({ limits: { maxSqlBytes: 20 } })`SELECT '가나다라마'`.render(), hasCode('BRAID_SQL_LIMIT'));
  const limited = createSqlTag({ limits: { maxStructuralItems: 1 } });
  assert.throws(() => limited`SELECT ${limited.join([limited.fragment`1`, limited.fragment`2`], limited.fragment`, `)}`.render(), hasCode('BRAID_STRUCTURE_LIMIT'));
});

test('operations preserve shape identity', () => {
  const a = postgres`SELECT ${postgres.ident('id')} FROM users`;
  const b = postgres`SELECT ${postgres.ident('name')} FROM users`;
  assert.notEqual(fingerprintQuery(a), fingerprintQuery(b));
  assert.equal(templateFamilyFingerprint(a), templateFamilyFingerprint(b));
});

// These multi-program checks need a bounded integration timeout on the Node floor CI runner.
test('compiler discovers symbols, checks downstream row types, and lowers guarded evaluation', () => {
  const options = { moduleSpecifier: '@sqlbraid/template', compilerOptions };
  const discovered = discoverQueries("import {sql} from '@sqlbraid/template'; function f(sql) { return sql`bad`; } import * as braid from '@sqlbraid/template'; const q=braid.sql`SELECT id FROM users`;", 'fixture.ts', options);
  assert.equal(discovered.queries.length, 1);
  const source = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; type UserRow = { id: number; name: string }; declare const user: {name:string}|null; const q=sql.rows<UserRow>`SELECT custom_company_function(id) AS id, name FROM vendor_table /*@braid where*/ /*@braid if ${user != null}*/ AND name = ${user.name} /*@braid end*/ /*@braid end*/`; async function f(){ const rows=await db.all(q); return rows[0].missing; }";
  const diagnostics = checkSource(source, join(tmpdir(), 'sqlbraid-consumer.ts'), options);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ['TS2339']);
  const commandSource = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; const q=sql`UPDATE users SET name = 'Ada'`; db.all(q);";
  assert.ok(checkSource(commandSource, join(tmpdir(), 'sqlbraid-command.ts'), options).some((diagnostic) => diagnostic.code === 'TS2345'));
  const contractSource = "import {sql} from '@sqlbraid/template'; type UserRow = {id:string}; const q=sql.rows<UserRow>`SELECT opaque_vendor_function(id) AS id FROM vendor_table`;";
  assert.equal(checkSource(contractSource, join(tmpdir(), 'sqlbraid-contract.ts'), { moduleSpecifier: '@sqlbraid/template', compilerOptions }).length, 0);
  assert.deepEqual(checkSource(source.replace('return rows[0].missing;', 'return rows[0].id;'), join(tmpdir(), 'sqlbraid-consumer.ts'), options), []);
}, 15_000);

test('PV1 query contracts and explicit kinds are checked by TypeScript', () => {
  const options = { moduleSpecifier: '@sqlbraid/template', compilerOptions };
  const typed = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; type UserRow = {id:number}; const query = sql.rows<UserRow>`SELECT custom_company_function(id) AS id FROM vendor_table`; async function read(){ const rows = await db.all(query); return rows[0].missing; }";
  const typedDiagnostics = checkSource(typed, join(tmpdir(), 'sqlbraid-pv1-typed.ts'), options);
  assert.ok(typedDiagnostics.some((diagnostic) => diagnostic.code === 'TS2339'));

  const untyped = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; const query = sql`SELECT 1`; db.all(query);";
  assert.ok(checkSource(untyped, join(tmpdir(), 'sqlbraid-pv1-untyped.ts'), options).some((diagnostic) => diagnostic.code === 'TS2345'));

  const command = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; const query = sql.command`UPDATE users SET active = ${true}`; db.all(query); db.execute(query);";
  assert.ok(checkSource(command, join(tmpdir(), 'sqlbraid-pv1-command.ts'), options).some((diagnostic) => diagnostic.code === 'TS2345'));

  const rows = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; type UserRow = {id:number}; const query = sql.rows<UserRow>`SELECT custom_company_function(id) AS id FROM vendor_table`; db.all(query);";
  assert.equal(checkSource(rows, join(tmpdir(), 'sqlbraid-pv1-rows.ts'), options).length, 0);

  const call = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db:Database; const query = sql.call`CALL vendor_procedure()`; db.call(query);";
  assert.equal(checkSource(call, join(tmpdir(), 'sqlbraid-pv1-call.ts'), options).length, 0);
}, 15_000);

test('emitted guarded JavaScript evaluates only the active branch', async () => {
  const source = "import {sql} from '@sqlbraid/template'; export function build(user, sideEffect){ return sql`SELECT id FROM users /*@braid where*/ /*@braid if ${user != null}*/ AND name = ${user.name} AND value = ${sideEffect()} /*@braid end*/ /*@braid end*/`; }";
  const emitted = emitSource(source, 'guarded-runtime.ts', { moduleSpecifier: '@sqlbraid/template' }).outputText;
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-runtime-'));
  try {
    const file = join(directory, 'guarded-runtime.mjs');
    writeFileSync(file, emitted.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ""));
    const module = await import(pathToFileURL(file).href);
    let calls = 0;
    const inactive = module.build(null, () => { calls += 1; return 7; }).render();
    assert.equal(calls, 0);
    assert.deepEqual(inactive.parameters, []);
    const active = module.build({ name: 'Ada' }, () => { calls += 1; return 7; }).render();
    assert.equal(calls, 1);
    assert.deepEqual(active.parameters.map(({ value }: { readonly value: unknown }) => value), ['Ada', 7]);
    assert.deepEqual(module.build({ name: 'Ada' }, () => { calls += 1; return 8; }).render(), module.build({ name: 'Ada' }, () => 8).render());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('guarded bind checking uses real control-flow narrowing', () => {
  const safe = "import {sql} from '@sqlbraid/template'; declare const user: {name:string}|null; const q=sql`SELECT id /*@braid if ${user != null}*/ AND name=${user.name} /*@braid end*/`;";
  assert.equal(checkSource(safe, join(tmpdir(), 'sqlbraid-guard-safe.ts'), { moduleSpecifier: '@sqlbraid/template', compilerOptions }).some((diagnostic) => diagnostic.code === 'TS18047'), false);
});

test('unguarded nullable binds report diagnostics at their original source range', () => {
  const unsafe = "import {sql} from '@sqlbraid/template'; declare const enabled: boolean; declare const user: {name:string}|null; const q=sql`SELECT id /*@braid if ${enabled}*/ AND name=${user.name} /*@braid end*/`;";
  const diagnostics = checkSource(unsafe, join(tmpdir(), 'sqlbraid-guard-unsafe.ts'), { moduleSpecifier: '@sqlbraid/template', compilerOptions });
  const start = unsafe.indexOf('user.name');
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'TS18047' && diagnostic.range.start === start && diagnostic.range.end === start + 'user.name'.length));
});

test('project checking keeps one TypeScript program for re-exported tags and imported contracts', () => {
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-project-'));
  try {
    writeFileSync(join(directory, 'bar.ts'), "export { sql } from '@sqlbraid/template';\n");
    writeFileSync(join(directory, 'types.ts'), 'export type ImportedRow = { readonly id: number; name?: string | null }\n');
    writeFileSync(join(directory, 'main.ts'), "import {sql} from './bar.js'; import type {ImportedRow} from './types.js'; declare const user: {id:number}|null; export const imported=sql.rows<ImportedRow>`SELECT proprietary_extension(id) FROM users /*@braid if ${user != null}*/ WHERE id=${user.id} /*@braid end*/`;\n");
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, baseUrl: '.', paths: { '@sqlbraid/*': ['../packages/*/src/index.ts'] } }, include: ['*.ts'] }));
    const projectFile = join(directory, 'tsconfig.json');
    const context = createProjectContext(projectFile);
    assert.ok(context.fileNames.includes(join(directory, 'main.ts')));
    assert.ok(context.fileNames.includes(join(directory, 'bar.ts')));
    assert.ok(context.fileNames.includes(join(directory, 'types.ts')));
    const diagnostics = checkProject(projectFile, { moduleSpecifier: '@sqlbraid/template' });
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code.startsWith('TS') || diagnostic.code.startsWith('BRAID_')), false);
    writeFileSync(join(directory, 'wrong.ts'), "import {imported} from './main.js'; import type {Database} from '@sqlbraid/core'; declare const db:Database; async function read(){ return (await db.all(imported))[0].missing; }\n");
    const negative = checkProject(projectFile, { moduleSpecifier: '@sqlbraid/template' });
    assert.deepEqual(negative.map((diagnostic) => diagnostic.code), ['TS2339']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test('project checking preserves TSX, MTS, and CTS source identities', () => {
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-project-kinds-'));
  try {
    writeFileSync(join(directory, 'jsx.d.ts'), 'declare namespace JSX { interface IntrinsicElements { div: { children?: unknown } } }\n');
    writeFileSync(join(directory, 'view.tsx'), "import {sql} from '@sqlbraid/template'; export function View() { const q=sql`SELECT 1`; return <div>{String(q)}</div>; }\n");
    writeFileSync(join(directory, 'module.mts'), "import {sql} from '@sqlbraid/template'; export const q=sql`SELECT 1`;\n");
    writeFileSync(join(directory, 'module.cts'), "import {sql} from '@sqlbraid/template'; export const q=sql`SELECT 1`;\n");
    const projectFile = join(directory, 'tsconfig.json');
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', jsx: 'preserve', strict: true, baseUrl: '.', paths: { '@sqlbraid/*': ['../packages/*/src/index.ts'] } }, include: ['*.tsx', '*.mts', '*.cts', '*.d.ts'] }));
    const context = createProjectContext(projectFile);
    assert.ok(context.fileNames.includes(join(directory, 'view.tsx')));
    assert.ok(context.fileNames.includes(join(directory, 'module.mts')));
    assert.ok(context.fileNames.includes(join(directory, 'module.cts')));
    const diagnostics = checkProject(projectFile, { moduleSpecifier: '@sqlbraid/template' });
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code.startsWith('TS')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test('untyped dynamic SQL remains unknown without a declared contract', () => {
  const choose = "import {sql} from '@sqlbraid/template'; const q=sql`/*@braid choose*/ /*@braid when ${true}*/ SELECT id FROM users /*@braid when ${true}*/ SELECT missing FROM definitely_missing /*@braid otherwise*/ SELECT id FROM users /*@braid end*/`;";
  const chooseOverlay = createVirtualOverlay(choose, join(tmpdir(), 'sqlbraid-dynamic-choose.ts'), { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(chooseOverlay.queryTypes[0]?.rowType, 'unknown');
  assert.equal(chooseOverlay.queryTypes[0]?.resultKind, 'unknown');
  assert.deepEqual(checkSource(choose, join(tmpdir(), 'sqlbraid-dynamic-choose.ts'), { moduleSpecifier: '@sqlbraid/template', compilerOptions }), []);
});

test('emits directive prologues, preserves compiler options, and maps generated JS to original TS', () => {
  const source = '"use client";\nimport {sql} from "@sqlbraid/template";\nexport function build(user: {name: string} | null) { return sql`SELECT * /*@braid if ${user != null}*/ WHERE name = ${user.name} /*@braid end*/`; }\n';
  const emitted = emitSource(source, 'sqlbraid-source-map.ts', { moduleSpecifier: '@sqlbraid/template', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, sourceMap: true, inlineSources: true } });
  assert.equal(emitted.diagnostics.length, 0);
  assert.ok(emitted.outputText.trimStart().startsWith('"use client";'));
  assert.ok(emitted.outputText.indexOf('"use client"') < emitted.outputText.indexOf('capture'));
  const map = new TraceMap(JSON.parse(emitted.sourceMapText ?? '{}'));
  const generatedOffset = emitted.outputText.indexOf('user.name');
  assert.ok(generatedOffset >= 0);
  const generated = sourcePosition(emitted.outputText, generatedOffset);
  const original = originalPositionFor(map, { line: generated.line + 1, column: generated.character });
  const expected = sourcePosition(source, source.indexOf('user.name'));
  assert.equal(original.line, expected.line + 1);
  assert.equal(original.column, expected.character);

  const commonJs = emitSource('import {sql} from "@sqlbraid/template"; export const f = (value: number) => value + 1; export const q=sql`SELECT ${1}`;', 'sqlbraid-options.ts', { moduleSpecifier: '@sqlbraid/template', compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS, sourceMap: false } });
  assert.equal(commonJs.sourceMapText, undefined);
  assert.match(commonJs.outputText, /require\(["']@sqlbraid\/template["']\)/u);
  assert.doesNotMatch(commonJs.outputText, /=>/u);
});

test('AST lowering is hygienic and preserves side effects, this, choose order, and multiple queries', async () => {
  const source = "import {sql, capture as __sqlbraidCapture} from '@sqlbraid/template'; const __SQLBraidQuery='user'; export function build(enabled, values, next){ return sql`SELECT id /*@braid if ${enabled}*/ AND id=${values.value} AND next=${next()} /*@braid end*/`; } export class Builder { constructor(user){ this.user=user; } build(){ return sql`SELECT id /*@braid if ${this.user != null}*/ AND name=${this.user.name} /*@braid end*/`; } } export function choose(first, second){ return sql`SELECT 1 /*@braid choose*/ /*@braid when ${first()}*/ A /*@braid when ${second()}*/ B /*@braid otherwise*/ C /*@braid end*/`; } export function many(value){ return [sql`SELECT ${value}`, sql`SELECT ${value}`]; }";
  const emitted = emitSource(source, 'w03-hygiene.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(emitted.diagnostics.some((diagnostic) => diagnostic.code === 'BRAID_ASYNC_CONTEXT'), false);
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-hygiene-'));
  try {
    const file = join(directory, 'hygiene.mjs');
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ''));
    const module = await import(pathToFileURL(file).href);
    let getterCalls = 0;
    let nextCalls = 0;
    const inactive = module.build(false, { get value() { getterCalls += 1; return 7; } }, () => { nextCalls += 1; return 8; }).render();
    assert.deepEqual(inactive.parameters, []);
    assert.equal(getterCalls, 0);
    assert.equal(nextCalls, 0);
    const active = module.build(true, { get value() { getterCalls += 1; return 7; } }, () => { nextCalls += 1; return 8; }).render();
    assert.deepEqual(active.parameters.map(({ value }: { readonly value: unknown }) => value), [7, 8]);
    assert.equal(getterCalls, 1);
    assert.equal(nextCalls, 1);
    assert.deepEqual(new module.Builder({ name: 'Ada' }).build().render().parameters.map(({ value }: { readonly value: unknown }) => value), ['Ada']);
    let firstCalls = 0;
    let secondCalls = 0;
    assert.match(module.choose(() => { firstCalls += 1; return true; }, () => { secondCalls += 1; return true; }).render().segments.join(''), /A/);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
    assert.equal(module.many(3).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nested async functions and otherwise-only choose emit valid JavaScript', async () => {
  const source = "import {sql} from '@sqlbraid/template'; export function nested(){ return sql`SELECT 1 /*@braid if ${true}*/ AND fn=${async () => await Promise.resolve(1)} /*@braid end*/`; } export function otherwise(value){ return sql`SELECT 1 /*@braid choose*/ /*@braid otherwise*/ AND id=${value} /*@braid end*/`; }";
  const emitted = emitSource(source, 'w03-nested.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(emitted.diagnostics.some((diagnostic) => diagnostic.code === 'BRAID_ASYNC_CONTEXT'), false);
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-nested-'));
  try {
    const file = join(directory, 'nested.mjs');
    writeFileSync(file, emitted.outputText.replace(/\n\/\/#[^\n]*sourceMappingURL[^\n]*/u, ''));
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module.nested().render().parameters[0]?.value, 'function');
    assert.deepEqual(module.otherwise(7).render().parameters.map(({ value }: { readonly value: unknown }) => value), [7]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('adapters preserve command and returning result kinds', async () => {
  const pg = createPgDatabase({
    async query(configOrText: PgQueryConfig | string, values: readonly unknown[] = []) {
      return { rows: [{ id: '7' }], fields: [{ name: 'id', dataTypeID: 20 }], rowCount: 1 };
    },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  });
  assert.deepEqual(await pg.all(postgres.rows`SELECT ${1}`), [{ id: '7' }]);
  const fake = {
    prepare(text: string) {
      return {
        columns: () => text.includes('RETURNING') || text.includes('SELECT') ? [{ name: 'id', column: 'id', database: 'main', table: 'users', type: 'INTEGER' }] : [],
        all: () => [{ id: 1n }],
        setReadBigInts() {},
        run: () => ({ changes: 1, lastInsertRowid: 2 }),
      };
    },
  };
  const db = createNodeSqliteDatabase(fake);
  assert.deepEqual(await db.all(sqlite.rows`/* comment */ SELECT id FROM users`), [{ id: '1' }]);
  assert.deepEqual(await db.all(sqlite.rows`INSERT INTO users VALUES (2, 'Bob') RETURNING id`), [{ id: '1' }]);
});

test('root execution waits until the transaction scope closes', async () => {
  const log: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const db = createPgDatabase({
    async query(configOrText: PgQueryConfig | string, values: readonly unknown[] = []) {
      const config = typeof configOrText === 'string' ? { text: configOrText, values } : configOrText;
      log.push(config.text);
      return { rows: [] };
    },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  });
  const transaction = db.tx(async (tx) => { await tx.execute(postgres`SELECT 'inside'`); await gate; });
  await new Promise((resolve) => setImmediate(resolve));
  const outside = db.execute(postgres`SELECT 'outside'`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['BEGIN', "SELECT 'inside'"]);
  release();
  await transaction;
  await outside;
  assert.deepEqual(log, ['BEGIN', "SELECT 'inside'", 'COMMIT', "SELECT 'outside'"]);
});

test('SQLite inspector records strict and dynamic table evidence', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const native = new DatabaseSync(':memory:');
  try {
    native.exec('CREATE TABLE ordinary(id INTEGER, payload TEXT); CREATE TABLE strict_table(id INTEGER) STRICT; CREATE TABLE rowid_table(id INTEGER PRIMARY KEY, payload TEXT); CREATE TABLE desc_table(id INTEGER PRIMARY KEY DESC, payload TEXT); CREATE TABLE composite(a INTEGER, b INTEGER, PRIMARY KEY (a, b)); CREATE TABLE no_rowid(id INTEGER PRIMARY KEY, payload TEXT) WITHOUT ROWID;');
    const snapshot = await createSqliteInspector(native).inspect();
    assert.equal(snapshot.dialect, 'sqlite');
    assert.equal(snapshot.format, 'sqlbraid-metadata');
    assert.equal(snapshot.relations['main.strict_table']?.strict, true);
    assert.equal('tsType' in (snapshot.relations['main.ordinary']?.columns[0] ?? {}), false);
    assert.equal(snapshot.relations['main.rowid_table']?.columns[0]?.identity, true);
    assert.equal(snapshot.relations['main.rowid_table']?.columns[0]?.nullable, false);
    assert.equal(snapshot.relations['main.desc_table']?.columns[0]?.identity, undefined);
    assert.equal(snapshot.relations['main.composite']?.columns[0]?.identity, undefined);
    assert.equal(snapshot.relations['main.no_rowid']?.columns[0]?.identity, undefined);
    assert.ok(Array.isArray(snapshot.server.capabilities?.compileOptions));
  } finally {
    native.close();
  }
});

test('MySQL inspector rejects MariaDB as a different product', async () => {
  const connection = {
    async execute(_sql: string) { return [[{ version: '10.11.0-MariaDB', product: 'MariaDB' }], []] as const; },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
  await assert.rejects(() => createMysqlInspector(connection).inspect(), /MYSQL_PRODUCT_UNSUPPORTED/);
});

test('MySQL inspector separates primary-key, auto-increment, and generated facts', async () => {
  const responses = [
    [[{ version: '8.4.0', product: 'MySQL', sqlMode: '', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }], []],
    [[{ schema_name: 'app' }], []],
    [[{ table_schema: 'app', table_name: 'items', table_type: 'BASE TABLE' }], []],
    [[
      { table_schema: 'app', table_name: 'items', ordinal_position: '1', column_name: 'external_id', data_type: 'int', is_nullable: 'NO', column_key: 'PRI', extra: '' },
      { table_schema: 'app', table_name: 'items', ordinal_position: '2', column_name: 'id', data_type: 'int', is_nullable: 'NO', column_key: '', extra: 'auto_increment' },
      { table_schema: 'app', table_name: 'items', ordinal_position: '3', column_name: 'display_id', data_type: 'int', is_nullable: 'NO', column_key: '', extra: 'STORED GENERATED', generation_expression: '`external_id` + 1' },
    ], []],
    [[], []],
  ] as const;
  let index = 0;
  const snapshot = await createMysqlInspector({
    async execute() { return responses[index++]; },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  }).inspect();
  const columns = snapshot.relations['app.items'].columns;
  assert.equal(columns[0].identity, undefined);
  assert.equal(columns[1].identity, true);
  assert.equal(columns[2].generated, true);
  assert.equal(columns[2].insertable, false);
  assert.equal(columns[2].updatable, false);
  assert.equal('tsType' in columns[0], false);
});

test('PostgreSQL inspector records relation and routine metadata', async () => {
  const responses = [
    { rows: [{ version: '16.4' }] },
    { rows: [{ table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' }] },
    { rows: [
      { table_schema: 'public', table_name: 'users', ordinal_position: '1', column_name: 'id', data_type: 'integer', udt_schema: 'pg_catalog', udt_name: 'int4', is_nullable: 'NO', is_identity: 'YES', identity_generation: 'BY DEFAULT', is_generated: 'NEVER' },
      { table_schema: 'public', table_name: 'users', ordinal_position: '2', column_name: 'score', data_type: 'integer', udt_schema: 'pg_catalog', udt_name: 'int4', is_nullable: 'NO', is_identity: 'NO', is_generated: 'ALWAYS', generation_expression: '1 + 1' },
    ] },
    { rows: [{ routine_schema: 'public', routine_name: 'ping', routine_type: 'FUNCTION', data_type: 'text', specific_name: 'ping_1' }] },
  ];
  let index = 0;
  const snapshot = await createPostgresInspector({
    async query() { return responses[index++]; },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  }).inspect();
  assert.equal(snapshot.format, 'sqlbraid-metadata');
  assert.equal(snapshot.relations['public.users'].columns[0].type, 'pg_catalog.int4');
  assert.equal(snapshot.relations['public.users'].columns[0].identity, true);
  assert.equal(snapshot.relations['public.users'].columns[1].generated, true);
  assert.equal(snapshot.relations['public.users'].columns[1].insertable, false);
  assert.equal('tsType' in snapshot.relations['public.users'].columns[0], false);
  assert.equal(snapshot.routines.ping[0].result.kind, 'scalar');
});

test('prepared queries reject shape drift and streams honor adapter capability', async () => {
  let second = false;
  const db = createDatabase({
    statementBinding: testBinding,
    async query<Row>(rendered: RenderedStatement) { return { kind: 'rows' as const, rows: [{ text: postgresSql(rendered) }] as unknown as readonly Row[] }; },
    async *stream<Row>(rendered: RenderedStatement): AsyncIterable<Row> { yield { text: postgresSql(rendered) } as unknown as Row; },
    async call() { throw new Error('BRAID_CALL_UNSUPPORTED'); },
  });
  const prepared = db.prepare('users', () => second ? postgres.rows`SELECT name` : postgres.rows`SELECT id`);
  assert.deepEqual(await prepared.all(), [{ text: 'SELECT id' }]);
  second = true;
  await assert.rejects(() => prepared.all(), /BRAID_PREPARED_SHAPE/);
  assert.throws(() => db.prepare('users', () => postgres.rows`SELECT id`), /BRAID_PREPARED_NAME/);
  const values = [];
  for await (const value of db.stream(postgres.rows`SELECT id`)) values.push(value);
  assert.deepEqual(values, [{ text: 'SELECT id' }]);
});
