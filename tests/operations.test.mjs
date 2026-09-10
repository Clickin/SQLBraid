import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySemantics, createManifest, fingerprintQuery, validateRows, ResultValidationError } from '../dist/packages/operations/src/index.js';
import { sql } from '../dist/packages/postgres/src/index.js';

test('semantics fail closed for unknown statements and classify reads', () => {
  assert.equal(classifySemantics('SELECT id FROM users').operation, 'read');
  assert.equal(classifySemantics('UPDATE users SET active = $1').operation, 'write');
  assert.equal(classifySemantics('WITH x AS (...) SELECT * FROM x').operation, 'unknown');
});

test('manifest excludes bound values', () => {
  const query = sql`SELECT * FROM users WHERE id = ${123}`;
  const manifest = createManifest(query, { resultType: '{ id: bigint }' });
  assert.equal(manifest.operation, 'read');
  assert.equal(JSON.stringify(manifest).includes('123'), false);
  assert.equal(fingerprintQuery(query), manifest.fingerprint);
});

test('standard schema validation returns normalized rows or issues', async () => {
  const query = sql`SELECT 1`;
  const schema = { '~standard': { validate(value) { return typeof value === 'object' ? value : { issues: ['not-object'] }; } } };
  assert.deepEqual(await validateRows(query, [{ id: 1 }], schema), [{ id: 1 }]);
  await assert.rejects(() => validateRows(query, [1], schema), ResultValidationError);
});
