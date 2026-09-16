import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { MetadataSnapshot } from '@sqlbraid/metadata';
import { createLanguageService } from '@sqlbraid/language-server';
import { createWorkspace } from '@sqlbraid/tooling';

const metadata = { format: 'sqlbraid-metadata', formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: { users: { identity: 'public.users', name: 'users', kind: 'table', columns: [{ name: 'id', ordinal: 1, type: 'int8', nullable: false }] } }, routines: {}, metadata: {} } as const satisfies MetadataSnapshot;
const source = `import { sql } from '@sqlbraid/template';
import type { RoutineCallResult } from '@sqlbraid/core';
type UserRow = { id: bigint };
type CallResult = RoutineCallResult<{ ok: boolean }, readonly [{ id: bigint }]>;
const rows = sql.rows<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table\`;
const command = sql.command\`SELECT proprietary_command()\`;
const call = sql.call<CallResult>\`SELECT proprietary_call()\`;
const unknown = sql\`SELECT id FROM users\`;`;

test('declared contract hover and diagnostics work without metadata', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.equal(service.diagnostics(source, 'fixture.ts').length, 0);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT'))?.contents ?? '', /RowQuery<UserRow>/);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('proprietary_command'))?.contents ?? '', /^CommandQuery/u);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('proprietary_call'))?.contents ?? '', /CallQuery<CallResult>/);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT id'))?.contents ?? '', /Query<unknown>/);
  assert.deepEqual(service.complete(source, 'fixture.ts', source.indexOf('SELECT')), []);
});

test('completion is metadata-backed and reload replaces metadata', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  const relationSource = "import { sql } from '@sqlbraid/template'; const query = sql.rows<{}>`SELECT * FROM us`;";
  const columnSource = "import { sql } from '@sqlbraid/template'; const query = sql.rows<{}>`SELECT id FROM users`;";
  assert.deepEqual(service.complete(relationSource, 'relation.ts', relationSource.indexOf('us`') + 2), []);
  const withMetadata = createLanguageService({ moduleSpecifier: '@sqlbraid/template', metadata });
  assert.deepEqual(withMetadata.complete(relationSource, 'relation.ts', relationSource.indexOf('us`') + 2).map((item) => item.label), ['users']);
  assert.deepEqual(withMetadata.complete(columnSource, 'column.ts', columnSource.indexOf('id FROM') + 2).map((item) => item.label), ['id']);
  assert.equal(withMetadata.complete(columnSource, 'column.ts', columnSource.indexOf('id FROM') + 2)[0]?.detail, 'int8');
  const reloaded = service.reload(metadata);
  assert.deepEqual(reloaded.complete(relationSource, 'relation.ts', relationSource.indexOf('us`') + 2).map((item) => item.label), ['users']);
  assert.deepEqual(service.complete(relationSource, 'relation.ts', relationSource.indexOf('us`') + 2), []);
  const replacement = { ...metadata, relations: {} } satisfies MetadataSnapshot;
  assert.deepEqual(reloaded.reload(replacement).complete(relationSource, 'relation.ts', relationSource.indexOf('us`') + 2), []);
});

test('mapped rows hover exposes the Standard Schema output type', () => {
  const mappedSource = `import { sql } from '@sqlbraid/template';
type UserRow = { id: bigint };
declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, UserRow>;
const mapped = sql.rows(UserSchema)\`SELECT id FROM users\`;`;
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.match(service.hover(mappedSource, 'mapped-hover.ts', mappedSource.indexOf('SELECT'))?.contents ?? '', /RowQuery<UserRow>/u);
});

test('canonical facade hover uses catalog dialects and MariaDB comment boundaries', () => {
  const service = createLanguageService({});
  const facades = new Map([
    ['sqlbraid/pg', 'postgres'],
    ['sqlbraid/mysql2', 'mysql'],
    ['sqlbraid/mariadb', 'mariadb'],
    ['sqlbraid/node-sqlite', 'sqlite'],
    ['sqlbraid/better-sqlite3', 'sqlite'],
    ['sqlbraid/libsql', 'sqlite'],
    ['sqlbraid/sqlite-wasm', 'sqlite'],
    ['sqlbraid/d1', 'sqlite'],
    ['sqlbraid/oracledb', 'oracle'],
    ['sqlbraid/tedious', 'mssql'],
    ['sqlbraid/postgres', 'postgres'],
    ['sqlbraid/mysql', 'mysql'],
    ['sqlbraid/sqlite', 'sqlite'],
  ] as const);
  for (const [moduleSpecifier, dialect] of facades) {
    const source = `import { sql } from '${moduleSpecifier}'; const query = sql.rows\`SELECT 1\`;`;
    assert.match(service.hover(source, `${dialect}.ts`, source.indexOf('SELECT'))?.contents ?? '', new RegExp(`^RowQuery<unknown>\\ndialect: ${dialect}$`, 'mu'));
  }
  const mariadb = `import { sql } from 'sqlbraid/mariadb'; const query = sql.rows\`SELECT 1 # not SQL FROM users\nFROM users\`;`;
  assert.equal(service.hover(mariadb, 'mariadb.ts', mariadb.indexOf('not SQL')), undefined);
});

test('workspace discovery follows aliased facade re-exports through the project checker', async () => {
  const root = await mkdtemp(join(process.cwd(), '.sqlbraid-alias-tooling-'));
  const sourcePath = join(root, 'query.ts');
  try {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        baseUrl: '.',
        paths: { 'sqlbraid/*': [join(process.cwd(), 'packages/sqlbraid/src/*.ts')] },
      },
      include: ['**/*.ts'],
    }));
    await writeFile(join(root, 'alias.ts'), 'export { sql } from "sqlbraid/sqlite";\n');
    const source = 'import { sql } from "./alias.js";\nexport const query = sql.rows`SELECT 1`;\n';
    await writeFile(sourcePath, source);
    const workspace = createWorkspace({ rootPath: root });
    try {
      workspace.setDocument(sourcePath, source, 1);
      const service = await workspace.service();
      assert.deepEqual(service.documentSymbols(source, sourcePath).map((symbol) => symbol.name), ['sql.rows']);
      assert.match(service.hover(source, sourcePath, source.indexOf('SELECT'))?.contents ?? '', /dialect: sqlite/u);
      const edited = source.replace('SELECT 1', 'SELECT 2');
      workspace.setDocument(sourcePath, edited, 2);
      const editedService = await workspace.service();
      assert.deepEqual(editedService.documentSymbols(edited, sourcePath).map((symbol) => symbol.name), ['sql.rows']);
      assert.match(editedService.hover(edited, sourcePath, edited.indexOf('SELECT'))?.contents ?? '', /dialect: sqlite/u);
    } finally {
      workspace.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('facade-only metadata defaults cover every navigation surface', async () => {
  const root = await mkdtemp(join(process.cwd(), '.sqlbraid-facade-tooling-'));
  const metadataPath = join(root, 'metadata.json');
  const configPath = join(root, 'sqlbraid.config.mjs');
  const sourcePath = join(root, 'query.ts');
  const snapshot = {
    format: 'sqlbraid-metadata',
    formatVersion: 1,
    dialect: 'sqlite',
    dialectVersion: '3',
    server: {},
    namespaces: { main: { name: 'main', kind: 'attached' } },
    types: {},
    relations: {
      'main.users': {
        identity: 'main.users',
        name: 'users',
        namespace: 'main',
        kind: 'table',
        columns: [{ name: 'id', ordinal: 0, type: 'INTEGER', nullable: false }],
      },
    },
    routines: {
      'main.calculate_fee': [{
        name: 'calculate_fee',
        schema: 'main',
        identity: 'main.calculate_fee',
        kind: 'function',
        arguments: [{ name: 'amount', mode: 'in', type: 'INTEGER' }],
        argumentsComplete: true,
        result: { kind: 'scalar', type: 'INTEGER', nullable: false },
      }],
    },
    metadata: { introspectionScope: 'main', completeness: 'partial' },
  } as const satisfies MetadataSnapshot;
  const source = [
    'import { sql } from "sqlbraid/sqlite";',
    'type UserRow = { id: number };',
    'export const query = sql.rows<UserRow>`SELECT calculate_fee(1) AS id FROM main.users`;',
  ].join('\n');
  try {
    await writeFile(metadataPath, JSON.stringify(snapshot));
    await writeFile(configPath, `export default ${JSON.stringify({
      codegen: {
        targets: [{
          name: 'sqlite',
          metadata: './metadata.json',
          outFile: './generated.ts',
          typePolicy: {
            id: 'sqlite-test',
            hash: 'sqlite-test-v1',
            mappings: [{ databaseType: 'INTEGER', inputType: 'number', outputType: 'number', nullable: false }],
          },
        }],
      },
    })};\n`);
    await writeFile(sourcePath, source);

    // No moduleSpecifier/moduleSpecifiers are supplied: the workspace catalog
    // must discover the canonical facade and carry metadata into the service.
    const workspace = createWorkspace({ rootPath: root });
    try {
      workspace.setDocument(sourcePath, source, 1);
      const service = await workspace.service();
      assert.deepEqual(service.diagnostics(source, sourcePath), []);
      const relationOffset = source.indexOf('main.users') + 'main.'.length;
      assert.equal(service.complete(source.replace('main.users', 'main.'), sourcePath, source.indexOf('main.users') + 'main.'.length).map((item) => item.label).join(','), 'users');
      assert.match(service.hover(source, sourcePath, relationOffset)?.contents ?? '', /^Relation main\.users/m);
      assert.ok(service.definition(source, sourcePath, relationOffset)?.uri.endsWith('/metadata.json'));
      assert.equal((await service.references(source, sourcePath, relationOffset)).length, 1);
      assert.deepEqual(service.documentSymbols(source, sourcePath).map((symbol) => symbol.name), ['sql.rows']);
      assert.equal(service.workspaceSymbols('users').some((symbol) => symbol.name === 'users'), true);
      const signature = service.signatureHelp(source, sourcePath, source.indexOf('calculate_fee(') + 'calculate_fee('.length);
      assert.deepEqual(signature?.parameters, ['amount: INTEGER']);
      assert.equal(signature?.activeParameter, 0);
    } finally {
      workspace.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
