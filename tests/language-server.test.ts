import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SchemaSnapshot } from '@sqlbraid/schema';
import { createLanguageService } from '@sqlbraid/language-server';

const snapshot = { formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: { users: { identity: 'public.users', name: 'users', kind: 'table', columns: [{ name: 'id', ordinal: 1, type: 'int8', tsType: 'bigint', nullable: false }] } }, routines: {}, metadata: {} } as const satisfies SchemaSnapshot;
const source = `import { sql } from '@sqlbraid/template';
type UserRow = { id: bigint };
const rows = sql.rows<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table\`;
const command = sql.command\`SELECT proprietary_command()\`;
const call = sql.call<UserRow>\`SELECT proprietary_call()\`;
const unknown = sql\`SELECT id FROM users\`;`;

test('declared contract hover and diagnostics work without a snapshot', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' });
  assert.equal(service.diagnostics(source, 'fixture.ts').length, 0);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT'))?.contents ?? '', /Query<UserRow>/);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('proprietary_command'))?.contents ?? '', /CommandQuery</);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('proprietary_call'))?.contents ?? '', /CallQuery<UserRow>/);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT id'))?.contents ?? '', /Query<unknown>/);
  assert.deepEqual(service.complete('us'), []);
});

test('completion is snapshot-backed', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template' }).reload(snapshot);
  assert.deepEqual(service.complete('us').map((item) => item.label), ['users']);
  assert.deepEqual(service.complete('id').map((item) => item.label), ['id']);
});
