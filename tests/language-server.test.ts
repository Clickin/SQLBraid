import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLanguageService } from '../packages/language-server/dist/index.js';

const snapshot = { formatVersion: 1, dialect: 'postgres', dialectVersion: '16', server: {}, namespaces: {}, types: {}, relations: { users: { identity: 'public.users', name: 'users', kind: 'table', columns: [{ name: 'id', ordinal: 1, type: 'int8', tsType: 'bigint', nullable: false }] } }, routines: {}, metadata: {} };
const source = `import { sql } from '@sqlbraid/template';\nconst q = sql\`SELECT id FROM users\`;`;

test('language service shares compiler discovery for hover and diagnostics', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template', snapshot, analyze: () => ({ rowType: '{ id: bigint }' }) });
  assert.equal(service.diagnostics(source, 'fixture.ts').length, 0);
  assert.match(service.hover(source, 'fixture.ts', source.indexOf('SELECT'))?.contents ?? '', /Query<\{ id: bigint \}>/);
});

test('completion is snapshot-backed', () => {
  const service = createLanguageService({ moduleSpecifier: '@sqlbraid/template', snapshot });
  assert.deepEqual(service.complete('us').map((item) => item.label), ['users']);
  assert.deepEqual(service.complete('id').map((item) => item.label), ['id']);
});
