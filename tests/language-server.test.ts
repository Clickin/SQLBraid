import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SchemaSnapshot } from '@sqlbraid/schema';
import { createLanguageService } from '@sqlbraid/language-server';

const snapshot = { formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: { users: { identity: 'public.users', name: 'users', kind: 'table', columns: [{ name: 'id', ordinal: 1, type: 'int8', tsType: 'bigint', nullable: false }] } }, routines: {}, metadata: {} } as const satisfies SchemaSnapshot;
const source = `import { sql } from '@sqlbraid/template';\ntype UserRow = { id: bigint };\nconst q = sql<UserRow>\`SELECT custom_company_function(id) AS id FROM vendor_table\`;`;

test('language service shares compiler discovery for hover and diagnostics', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template', snapshot });
  assert.equal(service.diagnostics(source, 'fixture.ts').length, 0);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT'))?.contents ?? '', /Query<UserRow>/);
});

test('completion is snapshot-backed', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template', snapshot });
  assert.deepEqual(service.complete('us').map((item) => item.label), ['users']);
  assert.deepEqual(service.complete('id').map((item) => item.label), ['id']);
});
