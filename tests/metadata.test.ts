import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as metadata from '@sqlbraid/metadata';
import { canonicalizeSnapshot, diffSnapshots, hashSnapshot, validateSnapshot, type MetadataSnapshot } from '@sqlbraid/metadata';

const snapshot = {
  format: 'sqlbraid-metadata',
  formatVersion: 1,
  dialect: 'postgres',
  dialectVersion: '16',
  server: { product: 'postgres', majorVersion: 16 },
  namespaces: {
    public: { name: 'public', kind: 'schema' },
    app: { name: 'app', kind: 'schema' },
  },
  types: {
    'pg_catalog.int8': { identity: 'pg_catalog.int8', name: 'int8', kind: 'scalar' },
    'pg_catalog.text': { identity: 'pg_catalog.text', name: 'text', kind: 'scalar' },
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
  metadata: {},
} as const satisfies MetadataSnapshot;

test('canonical snapshot identity is independent of map insertion order', () => {
  const equivalent: MetadataSnapshot = {
    ...snapshot,
    types: {
      'pg_catalog.text': snapshot.types['pg_catalog.text'],
      'pg_catalog.int8': snapshot.types['pg_catalog.int8'],
    },
    namespaces: {
      app: snapshot.namespaces.app,
      public: snapshot.namespaces.public,
    },
  };
  assert.equal(canonicalizeSnapshot(snapshot), canonicalizeSnapshot(equivalent));
  assert.equal(hashSnapshot(snapshot), hashSnapshot(equivalent));
});

test('snapshot validation requires the metadata format discriminator', () => {
  const { format: _format, ...legacySnapshot } = snapshot;
  assert.throws(() => validateSnapshot(legacySnapshot), /SNAPSHOT_FORMAT/);
});

test('snapshot validation rejects future format versions', () => {
  assert.throws(() => validateSnapshot({ ...snapshot, formatVersion: 2 }), /SNAPSHOT_VERSION/);
});

test('snapshot validation rejects unsupported values', () => {
  assert.throws(() => validateSnapshot({ ...snapshot, metadata: { captured: BigInt(1) } }), /SNAPSHOT_VALUE/);
});

test('metadata drift reports exact changed database fact paths', () => {
  const changed = {
    ...snapshot,
    relations: {
      ...snapshot.relations,
      'public.users': {
        ...snapshot.relations['public.users'],
        columns: [{ ...snapshot.relations['public.users'].columns[0], nullable: true }],
      },
    },
  };
  assert.deepEqual(diffSnapshots(snapshot, changed).map((entry) => entry.path), ['relations.public.users.columns[0].nullable']);
});

test('semantic identity ignores observation timestamps', () => {
  const later = { ...snapshot, metadata: { generatedAt: 'later' } };
  assert.equal(hashSnapshot(snapshot), hashSnapshot(later));
  assert.deepEqual(diffSnapshots(snapshot, later), []);
});

test('metadata package has no speculative migration API', () => {
  assert.equal('migrateSnapshot' in metadata, false);
});
