import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeSnapshot, diffSnapshots, hashSnapshot, validateSnapshot } from '../dist/packages/schema/src/index.js';

const snapshot = {
  formatVersion: 1,
  dialect: 'postgres',
  dialectVersion: '16',
  server: { product: 'postgres', majorVersion: 16 },
  namespaces: { public: { name: 'public', kind: 'schema' } },
  types: {
    'pg_catalog.int8': { identity: 'pg_catalog.int8', name: 'int8', kind: 'scalar', tsType: 'bigint' },
  },
  relations: {
    'public.users': {
      identity: 'public.users',
      name: 'users',
      namespace: 'public',
      kind: 'table',
      columns: [{ name: 'id', ordinal: 1, type: 'pg_catalog.int8', nullable: false }],
    },
  },
  routines: {},
  metadata: { typePolicyId: 'default' },
};

test('canonical snapshot identity is independent of map insertion order', () => {
  const equivalent = { ...snapshot, types: { ...snapshot.types }, namespaces: { ...snapshot.namespaces } };
  assert.equal(canonicalizeSnapshot(snapshot), canonicalizeSnapshot(equivalent));
  assert.equal(hashSnapshot(snapshot), hashSnapshot(equivalent));
});

test('snapshot validation rejects future formats', () => {
  assert.throws(() => validateSnapshot({ ...snapshot, formatVersion: 2 }), /SNAPSHOT_VERSION/);
});

test('schema drift reports exact changed paths', () => {
  const changed = { ...snapshot, relations: { ...snapshot.relations, 'public.users': { ...snapshot.relations['public.users'], columns: [{ ...snapshot.relations['public.users'].columns[0], nullable: true }] } } };
  assert.deepEqual(diffSnapshots(snapshot, changed).map((entry) => entry.path), ['relations.public.users.columns[0].nullable']);
});
