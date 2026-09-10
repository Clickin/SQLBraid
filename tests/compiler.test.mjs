import assert from 'node:assert/strict';
import test from 'node:test';
import { createVirtualOverlay, discoverQueries } from '../dist/packages/compiler/src/index.js';

const source = `import { sql as dbSql } from '@sqlbraid/template';\nconst name: string | null = 'Ada';\nconst query = dbSql\`SELECT id FROM users /*@braid where*/ /*@braid if \${name != null}*/ AND name = \${name} /*@braid end*/ /*@braid end*/\`;`;

test('discovers aliased SQL tags by import identity', () => {
  const result = discoverQueries(source, 'fixture.ts', { moduleSpecifier: '@sqlbraid/template' });
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].bindings.length, 2);
  assert.equal(result.queries[0].bindings[1].expression, 'name');
});

test('virtual overlay preserves source and attaches inferred query contract', () => {
  const overlay = createVirtualOverlay(source, 'fixture.ts', {
    moduleSpecifier: '@sqlbraid/template',
    analyze: (query) => ({ rowType: '{ id: bigint }', bindingTypes: query.bindings.map((_, index) => index === 1 ? 'string' : 'boolean') }),
  });
  assert.equal(overlay.sourceText, source);
  assert.deepEqual(overlay.queryTypes[0], { range: overlay.queryTypes[0].range, rowType: '{ id: bigint }', bindingTypes: ['boolean', 'string'] });
  assert.equal(overlay.diagnostics.length, 0);
});
