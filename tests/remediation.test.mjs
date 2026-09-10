import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { parseSql, resolveStatement, lexSql } from '../dist/packages/ast/src/index.js';
import { checkSource, discoverQueries, emitSource } from '../dist/packages/compiler/src/index.js';
import { classifySemantics, fingerprintQuery, templateFamilyFingerprint, validateRows, ResultValidationError } from '../dist/packages/operations/src/index.js';
import { createPgDatabase } from '../dist/packages/postgres/src/pg.js';
import { createPostgresInspector } from '../dist/packages/postgres/src/inspector.js';
import { createNodeSqliteDatabase } from '../dist/packages/sqlite/src/node-sqlite.js';
import { createSqliteInspector } from '../dist/packages/sqlite/src/inspector.js';
import { createMysqlInspector } from '../dist/packages/mysql/src/inspector.js';
import { createSqlTag } from '../dist/packages/template/src/index.js';
import { sql as postgres } from '../dist/packages/postgres/src/index.js';
import { sql as sqlite } from '../dist/packages/sqlite/src/index.js';
import { startStdioLanguageServer } from '../dist/packages/language-server/src/server.js';

const snapshot = {
  formatVersion: 1,
  dialect: 'postgres',
  dialectVersion: '16',
  server: {},
  namespaces: {},
  types: {},
  relations: {
    'public.users': {
      identity: 'public.users', name: 'users', kind: 'table',
      columns: [
        { name: 'id', ordinal: 0, type: 'int4', tsType: 'number', nullable: false },
        { name: 'name', ordinal: 1, type: 'text', tsType: 'string', nullable: false },
      ],
    },
  },
  routines: {},
  metadata: {},
};

const compilerOptions = {
  baseUrl: process.cwd(),
  paths: { '@sqlbraid/*': ['packages/*/src/index.ts'] },
};

function templateStrings(values) {
  const strings = [...values];
  strings.raw = [...values];
  return strings;
}

test('template scanner preserves marker text in SQL lexical regions', () => {
  assert.equal(postgres`SELECT '/*@braid where*/ x /*@braid end*/' AS marker`.render().text, "SELECT '/*@braid where*/ x /*@braid end*/' AS marker");
  assert.equal(postgres`SELECT $$ /*@braid where*/ $$ AS marker`.render().text, 'SELECT $$ /*@braid where*/ $$ AS marker');
  assert.equal(postgres`SELECT '\u00000\u0000' AS marker`.render().text, "SELECT '\u00000\u0000' AS marker");
  assert.equal(postgres`-- /*@braid end*/\nSELECT 1`.render().text, '-- /*@braid end*/\nSELECT 1');
  const parsed = discoverQueries("import {sql} from '@sqlbraid/template'; const q=sql`SELECT '${name}'`;", 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(parsed.diagnostics[0].code, 'BRAID_HOLE_CONTEXT');
});

test('trim rejects empty SET, omits comment-only WHERE, and preserves line comment LF', () => {
  const emptySet = postgres`UPDATE users /*@braid set*/ /*@braid if ${false}*/ name = ${'Ada'}, /*@braid end*/ /*@braid end*/ WHERE id = ${1}`;
  assert.throws(() => emptySet.render(), (error) => error.code === 'BRAID_EMPTY_SET');
  const comments = postgres`SELECT id FROM users /*@braid where*/ /* explanation */ /*@braid end*/`.render();
  assert.equal(comments.text, 'SELECT id FROM users /* explanation */');
  const line = postgres`SELECT id FROM users /*@braid where*/ AND id = ${1} -- condition\n/*@braid end*/ ORDER BY id`.render();
  assert.match(line.text, /-- condition\n\s*ORDER BY id/);
  assert.equal(postgres`SELECT/*@braid if ${false}*/ DISTINCT /*@braid end*/id FROM users`.render().text, 'SELECT id FROM users');
});

test('structural inputs are captured and bounded', () => {
  const ids = [1];
  const query = postgres`SELECT id FROM users WHERE id IN (${postgres.list(ids)})`;
  ids.push(2);
  assert.deepEqual(query.render().values, [1]);
  assert.equal(Object.isFrozen(query.ir), true);
  assert.equal(Object.isFrozen(query.ir.nodes), true);
  assert.throws(() => postgres.list([]), (error) => error.code === 'BRAID_EMPTY_LIST');
  assert.throws(() => createSqlTag({ limits: { maxSqlBytes: 20 } })`SELECT '가나다라마'`.render(), (error) => error.code === 'BRAID_SQL_LIMIT');
  const limited = createSqlTag({ limits: { maxStructuralItems: 1 } });
  assert.throws(() => limited`SELECT ${limited.join([limited.fragment`1`, limited.fragment`2`], limited.fragment`, `)}`.render(), (error) => error.code === 'BRAID_STRUCTURE_LIMIT');
});

test('AST consumes SQL and preserves qualified scope and bind ordinals', () => {
  const qualified = resolveStatement(parseSql('SELECT u.id AS "userId" FROM users u WHERE u.id = $1'), snapshot);
  assert.deepEqual(qualified.columns, [{ name: 'userId', type: 'number', nullable: false, source: 'public.users' }]);
  assert.deepEqual(qualified.binds, [{ placeholder: 1, type: 'number', nullable: false, evidence: 'column:id' }]);
  const missingJoin = resolveStatement(parseSql('SELECT id FROM users JOIN definitely_missing ON true'), snapshot);
  assert.equal(missingJoin.columns, 'unknown');
  assert.ok(missingJoin.diagnostics.some((diagnostic) => diagnostic.code === 'SQL_RELATION'));
  const placeholders = resolveStatement(parseSql('SELECT ? AS value FROM users WHERE id = ?'), snapshot);
  assert.deepEqual(placeholders.binds.map((bind) => bind.placeholder), [1, 2]);
  const routines = { ...snapshot, routines: { f: [
    { name: 'f', identity: 'public.f(int)', kind: 'procedure', arguments: [{ mode: 'in', type: 'int4', tsType: 'number' }], result: { kind: 'void' } },
    { name: 'f', identity: 'public.f(text)', kind: 'procedure', arguments: [{ mode: 'in', type: 'text', tsType: 'string' }], result: { kind: 'void' } },
  ] } };
  const ambiguous = resolveStatement(parseSql('CALL f($1)'), routines);
  assert.equal(ambiguous.columns, 'unknown');
  assert.ok(ambiguous.diagnostics.some((diagnostic) => diagnostic.code === 'SQL_ROUTINE_AMBIGUOUS'));
  assert.ok(resolveStatement(parseSql('CALL f($1, $2)'), routines).diagnostics.some((diagnostic) => diagnostic.code === 'SQL_ROUTINE_ARITY'));
  assert.equal(parseSql("SELECT 'unterminated FROM users").diagnostics[0].code, 'SQL_LEX');
  assert.equal(parseSql('SELECT (((((id))))) FROM users', { maxNestingDepth: 1 }).diagnostics[0].code, 'SQL_LEX');
  assert.equal(lexSql('SELECT id FROM users WHERE id=$1').find((token) => token.kind === 'placeholder').text, '$1');
});

test('operations use conservative semantics, shape identity, and Standard Schema envelopes', async () => {
  assert.equal(classifySemantics('SELECT id FROM users').operation, 'read');
  assert.equal(classifySemantics('SELECT nextval(\'s\')').operation, 'unknown');
  assert.equal(classifySemantics('SELECT id FROM users FOR NO KEY UPDATE').readOnly, false);
  assert.equal(classifySemantics('EXPLAIN ANALYZE DELETE FROM users').operation, 'unknown');
  assert.equal(classifySemantics('PRAGMA foreign_keys = OFF').operation, 'session');
  const a = postgres`SELECT ${postgres.ident('id')} FROM users`;
  const b = postgres`SELECT ${postgres.ident('name')} FROM users`;
  assert.notEqual(fingerprintQuery(a), fingerprintQuery(b));
  assert.equal(templateFamilyFingerprint(a), templateFamilyFingerprint(b));
  const schema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: { ...value, mapped: true } }; } } };
  assert.deepEqual(await validateRows(postgres`SELECT 1`, [{ id: 1 }], schema), [{ id: 1, mapped: true }]);
  const failing = { '~standard': { version: 1, vendor: 'test', validate() { return { issues: ['bad'] }; } } };
  await assert.rejects(() => validateRows(postgres`SELECT 1`, [{ id: 1 }], failing), ResultValidationError);
});

test('compiler discovers symbols, checks downstream row types, and lowers guarded evaluation', () => {
  const options = { moduleSpecifier: '@sqlbraid/template', snapshot, compilerOptions };
  const discovered = discoverQueries("import {sql} from '@sqlbraid/template'; function f(sql) { return sql`bad`; } import * as braid from '@sqlbraid/template'; const q=braid.sql`SELECT id FROM users`;", 'fixture.ts', options);
  assert.equal(discovered.queries.length, 1);
  const source = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; const user: {name:string}|null = null; const q=sql`SELECT id FROM users /*@braid where*/ /*@braid if ${user != null}*/ AND name = ${user.name} /*@braid end*/ /*@braid end*/`; async function f(){ const rows=await db.all(q); return rows[0].missing; }";
  const diagnostics = checkSource(source, join(tmpdir(), 'sqlbraid-consumer.ts'), options);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'TS2339'));
  const commandSource = "import {sql} from '@sqlbraid/template'; import type {Database} from '@sqlbraid/core'; declare const db: Database; const q=sql`UPDATE users SET name = 'Ada'`; db.all(q);";
  assert.ok(checkSource(commandSource, join(tmpdir(), 'sqlbraid-command.ts'), options).some((diagnostic) => diagnostic.code === 'TS2345'));
  const contractSource = "import {sql} from '@sqlbraid/template'; const q=sql<{id:string}>`SELECT id FROM users`;";
  assert.ok(checkSource(contractSource, join(tmpdir(), 'sqlbraid-contract.ts'), options).some((diagnostic) => diagnostic.code === 'BRAID_CONTRACT_TYPE'));
  const emitted = emitSource(source.replace('return rows[0].missing;', 'return rows[0].id;'), 'consumer.ts', options).outputText;
  assert.match(emitted, /__sqlbraidCapture\(/);
  assert.equal(emitted.includes('user\.name'), true);
});

test('emitted guarded JavaScript evaluates only the active branch', async () => {
  const source = "import {sql} from '@sqlbraid/template'; export function build(user, sideEffect){ return sql`SELECT id FROM users /*@braid where*/ /*@braid if ${user != null}*/ AND name = ${user.name} AND value = ${sideEffect()} /*@braid end*/ /*@braid end*/`; }";
  const emitted = emitSource(source, 'guarded-runtime.ts', { moduleSpecifier: '@sqlbraid/template' }).outputText;
  const directory = mkdtempSync(join(process.cwd(), '.sqlbraid-runtime-'));
  try {
    const file = join(directory, 'guarded-runtime.mjs');
    writeFileSync(file, emitted);
    const module = await import(pathToFileURL(file).href);
    let calls = 0;
    const inactive = module.build(null, () => { calls += 1; return 7; }).render();
    assert.equal(calls, 0);
    assert.deepEqual(inactive.values, []);
    const active = module.build({ name: 'Ada' }, () => { calls += 1; return 7; }).render();
    assert.equal(calls, 1);
    assert.deepEqual(active.values, ['Ada', 7]);
    assert.deepEqual(module.build({ name: 'Ada' }, () => { calls += 1; return 8; }).render(), module.build({ name: 'Ada' }, () => 8).render());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('adapters preserve command and returning result kinds', async () => {
  let pgRequest;
  const pg = createPgDatabase({
    async query(config) { pgRequest = config; return { rows: [{ id: '7' }], fields: [{ name: 'id', dataTypeID: 20 }], rowCount: 1 }; },
  });
  assert.deepEqual(await pg.all(postgres`SELECT ${1}`), [{ id: 7n }]);
  assert.deepEqual(pgRequest, { text: 'SELECT $1', values: [1] });
  const fake = {
    prepare(text) {
      return {
        columns: () => text.includes('RETURNING') || text.includes('SELECT') ? [{ name: 'id' }] : [],
        all: () => [{ id: 1 }],
        run: () => ({ changes: 1, lastInsertRowid: 2 }),
      };
    },
  };
  const db = createNodeSqliteDatabase(fake);
  assert.deepEqual(await db.all(sqlite`/* comment */ SELECT id FROM users`), [{ id: 1 }]);
  assert.deepEqual(await db.all(sqlite`INSERT INTO users VALUES (2, 'Bob') RETURNING id`), [{ id: 1 }]);
});

test('stdio language server answers initialize and document diagnostics', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  startStdioLanguageServer({ moduleSpecifier: '@sqlbraid/template', snapshot }, { input, output });
  const messages = [];
  output.on('data', (chunk) => messages.push(chunk.toString()));
  const send = (message) => {
    const body = JSON.stringify(message);
    input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const initialized = once(output, 'data');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await initialized;
  const opened = once(output, 'data');
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///fixture.ts', languageId: 'typescript', version: 1, text: "import {sql} from '@sqlbraid/template'; const q=sql`SELECT id FROM users`;" } } });
  await opened;
  assert.match(messages.join(''), /textDocument\/publishDiagnostics/);
  input.end();
});

test('root execution waits until the transaction scope closes', async () => {
  const log = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = createPgDatabase({
    async query(config) { log.push(config.text); return { rows: [] }; },
  });
  const transaction = db.transaction(async (tx) => { await tx.execute(postgres`SELECT 'inside'`); await gate; });
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
    native.exec('CREATE TABLE ordinary(id INTEGER, payload TEXT); CREATE TABLE strict_table(id INTEGER) STRICT;');
    const snapshot = await createSqliteInspector(native).inspect();
    assert.equal(snapshot.dialect, 'sqlite');
    assert.equal(snapshot.relations['main.strict_table'].strict, true);
    assert.equal(snapshot.relations['main.ordinary'].columns[0].tsType, undefined);
    assert.ok(Array.isArray(snapshot.server.capabilities.compileOptions));
  } finally {
    native.close();
  }
});

test('MySQL inspector rejects MariaDB as a different product', async () => {
  const connection = { async execute() { return [[{ version: '10.11.0-MariaDB', product: 'MariaDB' }], []]; } };
  await assert.rejects(() => createMysqlInspector(connection).inspect(), /MYSQL_PRODUCT_UNSUPPORTED/);
});

test('PostgreSQL inspector records relation and routine metadata', async () => {
  const responses = [
    { rows: [{ version: '16.4' }] },
    { rows: [{ table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' }] },
    { rows: [{ table_schema: 'public', table_name: 'users', ordinal_position: '1', column_name: 'id', data_type: 'integer', udt_schema: 'pg_catalog', udt_name: 'int4', is_nullable: 'NO' }] },
    { rows: [{ routine_schema: 'public', routine_name: 'ping', routine_type: 'FUNCTION', data_type: 'text', specific_name: 'ping_1' }] },
  ];
  let index = 0;
  const snapshot = await createPostgresInspector({ async query() { return responses[index++]; } }).inspect();
  assert.equal(snapshot.relations['public.users'].columns[0].tsType, 'number');
  assert.equal(snapshot.routines.ping[0].result.kind, 'scalar');
});

test('prepared queries reject shape drift and streams honor adapter capability', async () => {
  let second = false;
  const db = (await import('../dist/packages/runtime/src/index.js')).createDatabase({
    async query(rendered) { return { rows: [{ text: rendered.text }] }; },
    async *stream(rendered) { yield { text: rendered.text }; },
  });
  const prepared = db.prepare('users', () => second ? postgres`SELECT name` : postgres`SELECT id`);
  assert.deepEqual(await prepared.all(), [{ text: 'SELECT id' }]);
  second = true;
  await assert.rejects(() => prepared.all(), /BRAID_PREPARED_SHAPE/);
  assert.throws(() => db.prepare('users', () => postgres`SELECT id`), /BRAID_PREPARED_NAME/);
  const values = [];
  for await (const value of db.stream(postgres`SELECT id`)) values.push(value);
  assert.deepEqual(values, [{ text: 'SELECT id' }]);
});
