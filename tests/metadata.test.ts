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

test('snapshot identity preserves prototype-named relation map keys', () => {
  const named = { ...snapshot, relations: { ['__proto__']: snapshot.relations['public.users'] } };
  assert.notEqual(hashSnapshot(named), hashSnapshot({ ...snapshot, relations: {} }));
  assert.ok(Object.hasOwn(JSON.parse(canonicalizeSnapshot(named)).relations, '__proto__'));
});

test('metadata package has no speculative migration API', () => {
  assert.equal('migrateSnapshot' in metadata, false);
});

test('JSON snapshots reject malformed optional codegen facts at their exact paths', () => {
  const column = snapshot.relations['public.users'].columns[0];
  const cases: readonly ['column' | 'type' | 'argument' | 'result' | 'relation', unknown, string][] = [
    ...['nullabilityEvidence', 'defaultExpression', 'charset', 'collation'].map((field): ['column', unknown, string] => ['column', 1, field]),
    ...['generated', 'identity', 'insertable', 'updatable'].map((field): ['column', unknown, string] => ['column', 'false', field]),
    ['type', false, 'elementType'], ['type', 1, 'baseType'], ['type', ['ok', 1], 'values'],
    ['argument', 1, 'name'], ['argument', 'false', 'nullable'], ['argument', 1, 'hasDefault'],
    ['result', 'true', 'nullable'],
    ['relation', 1, 'namespace'], ['relation', 'true', 'strict'],
  ];
  for (const [target, value, field] of cases) {
    const candidate = {
      ...snapshot,
      types: { t: { identity: 't', name: 't', kind: 'scalar', ...(target === 'type' ? { [field]: value } : {}) } },
      relations: { users: { ...snapshot.relations['public.users'], ...(target === 'relation' ? { [field]: value } : {}), columns: [{ ...column, ...(target === 'column' ? { [field]: value } : {}) }] } },
      routines: { f: [{ identity: 'f()', name: 'f', kind: 'function', arguments: [{ mode: 'in', type: 't', ...(target === 'argument' ? { [field]: value } : {}) }], result: { kind: 'scalar', type: 't', ...(target === 'result' ? { [field]: value } : {}) } }] },
    };
    const prefix = { column: 'relations.users.columns[0]', type: 'types.t', argument: 'routines.f[0].arguments[0]', result: 'routines.f[0].result', relation: 'relations.users' }[target];
    assert.throws(() => metadata.parseSnapshotJson(JSON.stringify(candidate)), (error: unknown) =>
      error instanceof metadata.SnapshotValidationError && error.diagnostics.some((diagnostic) => diagnostic.path === `${prefix}.${field}`));
  }
});

test('JSON snapshots preserve valid false and empty optional facts', () => {
  const column = {
    ...snapshot.relations['public.users'].columns[0],
    nullabilityEvidence: '', defaultExpression: '', charset: '', collation: '',
    generated: false, identity: false, insertable: false, updatable: false,
  };
  const candidate = { ...snapshot, relations: { users: { ...snapshot.relations['public.users'], columns: [column] } } };
  assert.deepEqual(metadata.parseSnapshotJson(JSON.stringify(candidate)), candidate);
});
