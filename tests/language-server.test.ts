import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { MetadataSnapshot } from '@sqlbraid/metadata';
import { createLanguageService } from '@sqlbraid/language-server';

const metadata = { format: 'sqlbraid-metadata', formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: { users: { identity: 'public.users', name: 'users', kind: 'table', columns: [{ name: 'id', ordinal: 1, type: 'int8', nullable: false }] } }, routines: {}, metadata: {} } as const satisfies MetadataSnapshot;
const source = `import { sql } from '@sqlbraid/template';
type UserRow = { id: bigint };
const rows = sql.rows<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table\`;
const command = sql.command\`SELECT proprietary_command()\`;
const call = sql.call<UserRow>\`SELECT proprietary_call()\`;
const unknown = sql\`SELECT id FROM users\`;`;

test('declared contract hover and diagnostics work without metadata', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.equal(service.diagnostics(source, 'fixture.ts').length, 0);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT'))?.contents ?? '', /RowQuery<UserRow>/);
  assert.equal(service.hover(source, 'fixture.ts', source.indexOf('proprietary_command'))?.contents, 'CommandQuery');
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('proprietary_call'))?.contents ?? '', /CallQuery<UserRow>/);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT id'))?.contents ?? '', /Query<unknown>/);
  assert.deepEqual(service.complete('us'), []);
});

test('completion is metadata-backed and reload replaces metadata', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.deepEqual(service.complete('us'), []);
  const withMetadata = createLanguageService({ moduleSpecifier: '@sqlbraid/template', metadata });
  assert.deepEqual(withMetadata.complete('us').map((item) => item.label), ['users']);
  assert.deepEqual(withMetadata.complete('id').map((item) => item.label), ['id']);
  assert.equal(withMetadata.complete('id')[0]?.detail, 'int8');
  const reloaded = service.reload(metadata);
  assert.deepEqual(reloaded.complete('us').map((item) => item.label), ['users']);
  assert.deepEqual(service.complete('us'), []);
  const replacement = { ...metadata, relations: {} } satisfies MetadataSnapshot;
  assert.deepEqual(reloaded.reload(replacement).complete('us'), []);
});

test('mapped rows hover exposes the Standard Schema output type', () => {
  const mappedSource = `import { sql } from '@sqlbraid/template';
type UserRow = { id: bigint };
declare const UserSchema: import('@sqlbraid/core').StandardSchemaV1<unknown, UserRow>;
const mapped = sql.rows(UserSchema)\`SELECT id FROM users\`;`;
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.match(service.hover(mappedSource, 'mapped-hover.ts', mappedSource.indexOf('SELECT'))?.contents ?? '', /RowQuery<UserRow>/u);
});
