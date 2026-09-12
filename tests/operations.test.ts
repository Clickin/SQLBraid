import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createManifest, createManifestFromEvidence, fingerprintQuery } from '@sqlbraid/operations';
import { sql } from '@sqlbraid/postgres';

test('manifest carries portable identity and declared result contract without SQL inference', () => {
  const query = sql`SELECT * FROM users WHERE id = ${123}`;
  const manifest = createManifest(query, { source: 'src/query.ts', resultType: '{ id: bigint }' });
  assert.equal(JSON.stringify(manifest).includes('123'), false);
  assert.equal(fingerprintQuery(query), manifest.fingerprint);
  assert.equal(manifest.resultKind, 'unknown');
  assert.equal(manifest.source, 'src/query.ts');
  assert.equal(manifest.resultType, '{ id: bigint }');
  assert.equal('operation' in manifest, false);
  assert.equal('readOnly' in manifest, false);
});

test('manifest preserves declared result kinds for opaque SQL', () => {
  const queries = [
    sql.rows<{ id: number }>`OPAQUE vendor_rows()`,
    sql.command`SELECT proprietary_command()`,
    sql.call<{ id: number }>`SELECT proprietary_call()`,
    sql`SELECT id FROM users`,
  ];
  assert.deepEqual(queries.map((query) => createManifest(query).resultKind), ['rows', 'command', 'call', 'unknown']);
  assert.deepEqual(queries.map((query) => Object.keys(createManifest(query))), queries.map(() => ['fingerprint', 'templateFamilyFingerprint', 'resultKind']));
});

test('evidence manifest omits non-portable source paths', () => {
  assert.deepEqual(createManifestFromEvidence({
    fingerprint: 'fingerprint',
    templateFamilyFingerprint: 'template',
    variantFingerprint: 'variant',
    resultKind: 'rows',
    source: '/workspace/query.ts',
    resultType: 'Row',
  }), {
    fingerprint: 'fingerprint',
    templateFamilyFingerprint: 'template',
    variantFingerprint: 'variant',
    resultKind: 'rows',
    resultType: 'Row',
  });
});

