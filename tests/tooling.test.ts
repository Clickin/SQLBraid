import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLanguageService } from '@sqlbraid/tooling';
import type { CodegenResult } from '@sqlbraid/codegen';
import type { MetadataSnapshot } from '@sqlbraid/metadata';
import { normalizeIdentifier } from '../packages/tooling/src/service.js';

const users = {
  identity: 'public.users',
  name: 'users',
  namespace: 'public',
  kind: 'table',
  columns: [
    { name: 'id', ordinal: 1, type: 'int8', nullable: false, identity: true, insertable: true, updatable: true },
    { name: 'name', ordinal: 2, type: 'text', nullable: true, insertable: true, updatable: true },
  ],
} as const;
const feeRoutine = {
  name: 'calculate_fee',
  schema: 'public',
  identity: 'public.calculate_fee',
  kind: 'function',
  arguments: [{ name: 'amount', mode: 'in', type: 'numeric' }],
  argumentsComplete: false,
  result: { kind: 'scalar', type: 'numeric', nullable: false },
} as const;
const metadata = {
  format: 'sqlbraid-metadata',
  formatVersion: 1,
  dialect: 'postgres',
  dialectVersion: '16',
  server: {},
  namespaces: { public: { name: 'public', kind: 'schema' } },
  types: {},
  relations: { 'public.users': users },
  routines: { 'public.calculate_fee': [feeRoutine] },
  metadata: { completeness: 'partial', introspectionScope: 'public' },
} as const satisfies MetadataSnapshot;

const generatedSource = [
  '// Generated',
  'export interface UsersRow {',
  '  "id": number;',
  '  "name": string | null;',
  '}',
  'export interface UsersInsert { "name"?: string | null; }',
  'export interface UsersUpdate { "name"?: string | null; }',
  '',
].join('\n');
const generation = {
  source: generatedSource,
  models: [{ relationIdentity: 'public.users', modelName: 'Users', rowName: 'UsersRow', insertName: 'UsersInsert', updateName: 'UsersUpdate' }],
  diagnostics: [],
  metadataHash: 'metadata-hash',
  typePolicyId: 'postgres',
  typePolicyHash: 'policy-hash',
  optionsHash: 'options-hash',
} as const satisfies CodegenResult;
const target = {
  name: 'database',
  metadata,
  metadataPath: 'metadata.json',
  metadataSource: JSON.stringify(metadata, null, 2),
  outFile: 'generated.ts',
  generatedSource,
  generation,
} as const;

const queryA = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{ id: bigint }>`SELECT u.id FROM public.users u`;";


test('completion is scoped to static SQL and does not pollute TypeScript', () => {
  const ordinary = 'const ordinary = { users: true };\nordinary.us';
  const sql = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`SELECT * FROM us`;";
  const interpolation = "import { sql } from '@sqlbraid/postgres';\nconst ordinary = { id: 1 };\nconst query = sql.rows<{}>`SELECT * FROM users WHERE id = ${ordinary.}`;";
  const escaped = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`SELECT * FROM us\\u0072s`;";
  const service = createLanguageService({ metadata });
  assert.deepEqual(service.complete(ordinary, 'ordinary.ts', ordinary.length), []);
  const sqlOffset = sql.indexOf('us`') + 2;
  assert.deepEqual(service.complete(sql, 'sql.ts', sqlOffset).map((item) => item.label), ['users']);
  const qualified = sql.replace('FROM us', 'FROM public.');
  assert.deepEqual(service.complete(qualified, 'qualified.ts', qualified.indexOf('public.') + 'public.'.length).map((item) => item.label), ['users']);
  assert.deepEqual(service.complete(interpolation, 'interpolation.ts', interpolation.indexOf('ordinary.') + 'ordinary.'.length), []);
  assert.deepEqual(service.complete(interpolation, 'interpolation.ts', interpolation.indexOf('${')), []);
  assert.deepEqual(service.complete(escaped, 'escaped.ts', escaped.indexOf('\\u0072s') + '\\u0072s'.length), []);
  const commented = "import { sql } from '@sqlbraid/postgres'; const q = sql`SELECT 1 -- users`;";
  assert.deepEqual(service.complete(commented, 'comment.ts', commented.indexOf('`;')), []);
});

test('open-world SQL remains legal and incomplete routine evidence is explicit', () => {
  const source = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`WITH users AS (SELECT 1 AS id) SELECT custom_company_function(id), jsonb_path_query(payload, '$.x') FROM vendor_table`;";
  const service = createLanguageService({ metadata });
  assert.deepEqual(service.diagnostics(source, 'open-world.ts'), []);
  const routineSource = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`SELECT public.calculate_fee(id) FROM public.users`;";
  const hover = service.hover(routineSource, 'routine.ts', routineSource.indexOf('calculate_fee'));
  assert.match(hover?.contents ?? '', /known arguments: .*incomplete/u);
  const qualifiedElsewhere = routineSource.replace('public.calculate_fee', 'other.calculate_fee');
  assert.doesNotMatch(service.hover(qualifiedElsewhere, 'routine-other.ts', qualifiedElsewhere.indexOf('calculate_fee'))?.contents ?? '', /^Routine /u);
  assert.equal(service.signatureHelp(routineSource, 'routine.ts', routineSource.indexOf('calculate_fee(') + 'calculate_fee('.length), undefined);
  assert.equal(service.complete(routineSource, 'routine.ts', routineSource.indexOf('calculate_fee') + 3).some((item) => item.label === 'calculate_fee'), true);
});

test.each([
  ['postgres', "SELECT jsonb_path_query(payload, '$.x'), extension_distance(point), id::vendor_type FROM session_temp"],
  ['mysql', 'SELECT JSON_EXTRACT(payload, "$.x"), company_udf(id) FROM temporary_orders'],
  ['sqlite', 'WITH active AS (SELECT runtime_udf(id) AS value FROM temp.session_data) SELECT value FROM active'],
] as const)('metadata omissions leave %s built-ins, extensions, UDFs, temp objects and CTEs opaque', (dialect, sqlText) => {
  const service = createLanguageService({ metadata: { ...metadata, dialect, routines: {} } });
  const source = `import { sql } from '@sqlbraid/${dialect}';\nconst query = sql.rows<{}>\`${sqlText}\`;`;
  assert.deepEqual(service.diagnostics(source, `${dialect}-opaque.ts`), []);
});

test('generated current output wins navigation and stale output falls back to metadata JSON', () => {
  const current = createLanguageService({ metadata, targets: [target] });
  const currentOffset = queryA.indexOf('public.users') + 'public.'.length;
  const currentDefinition = current.definition(queryA, 'query.ts', currentOffset);
  assert.match(currentDefinition?.uri ?? '', /generated\.ts/u);
  assert.deepEqual(current.workspaceSymbols('UsersRow').map((symbol) => symbol.name), ['UsersRow']);
  assert.equal(current.hover(queryA, 'query.ts', queryA.indexOf('users'))?.contents.includes('UsersRow'), true);

  const staleTarget = { ...target, generatedSource: '// stale output\n' };
  const stale = createLanguageService({ metadata, targets: [staleTarget] });
  const staleDefinition = stale.definition(queryA, 'query.ts', currentOffset);
  assert.match(staleDefinition?.uri ?? '', /metadata\.json/u);
  assert.ok((staleDefinition?.range.start.line ?? 0) > 0);
});

test('references require positive relation and column evidence and exclude CTE shadowing', async () => {
  const sourceB = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`WITH users AS (SELECT 1 AS id) SELECT id FROM users`;";
  const service = createLanguageService({ metadata, sources: [{ fileName: 'b.ts', sourceText: sourceB }] });
  const references = await service.references(queryA, 'a.ts', queryA.indexOf('users'));
  assert.equal(references.length, 1);
  assert.match(references[0]?.uri ?? '', /a\.ts/u);
  const qualifiedColumn = await service.references(queryA, 'a.ts', queryA.indexOf('u.id') + 2);
  assert.equal(qualifiedColumn.length, 1);
  assert.equal((await service.references(sourceB, 'b.ts', sourceB.indexOf('users`'))).length, 0);
});

test('identifier folding is deterministic while quoted identifiers preserve case', () => {
  const snapshot = {
    ...metadata,
    relations: {
      'public.i': { ...users, identity: 'public.i', name: 'i' },
    },
  } as const satisfies MetadataSnapshot;
  const json = JSON.stringify(snapshot);
  const service = createLanguageService({ targets: [{ name: 'db', metadata: snapshot, metadataPath: 'metadata.json', metadataSource: json }] });
  const source = 'import { sql } from "@sqlbraid/postgres"; const q = sql`SELECT * FROM PUBLIC.I`;';
  assert.equal(normalizeIdentifier('I'), 'i');
  assert.ok(service.definition(source, 'folding.ts', source.indexOf('PUBLIC.I'))?.uri.endsWith('/metadata.json'));
  assert.equal(service.hover(source, 'folding.ts', source.indexOf('PUBLIC.I'))?.contents.startsWith('Relation public.i'), true);
  const quoted = source.replace('PUBLIC.I', '"I"');
  assert.doesNotMatch(service.hover(quoted, 'quoted-case.ts', quoted.indexOf('"I"'))?.contents ?? '', /^Relation public.i/u);
});

test('quoted qualified names preserve dotted metadata segments for navigation', () => {
  const snapshot = {
    ...metadata,
    relations: {
      'a\\.b.c': { ...users, identity: 'a\\.b.c', name: 'c', namespace: 'a.b' },
      'a.b\\.c': { ...users, identity: 'a.b\\.c', name: 'b.c', namespace: 'a' },
    },
  } as const satisfies MetadataSnapshot;
  const service = createLanguageService({ metadata: snapshot });
  const source = 'import { sql } from "@sqlbraid/postgres"; const q = sql`SELECT * FROM "a.b"."c"`;';
  const offset = source.indexOf('"c"');
  assert.equal(service.hover(source, 'quoted-qualified.ts', offset)?.contents.split('\n')[0], 'Relation a\\.b.c');
  assert.ok(service.definition(source, 'quoted-qualified.ts', offset));
  const other = source.replace('"a.b"."c"', '"a"."b.c"');
  const otherOffset = other.indexOf('"b.c"');
  assert.equal(service.hover(other, 'quoted-qualified-other.ts', otherOffset)?.contents.split('\n')[0], 'Relation a.b\\.c');
});

test('Oracle package routines resolve each quoted identity segment', () => {
  const snapshot = {
    ...metadata,
    dialect: 'oracle',
    relations: {},
    routines: {
      PROC: [{
        name: 'PROC',
        schema: 'APP',
        packageName: 'PKG',
        identity: 'APP.PKG.PROC',
        kind: 'function',
        arguments: [],
        argumentsComplete: true,
        result: { kind: 'scalar', type: 'NUMBER' },
      }],
    },
  } as const satisfies MetadataSnapshot;
  const service = createLanguageService({ metadata: snapshot });
  const source = 'import { sql } from "@sqlbraid/oracle"; const q = sql`SELECT "APP"."PKG"."PROC"() FROM dual`;';
  const offset = source.indexOf('"PROC"');
  assert.match(service.hover(source, 'oracle-package.ts', offset)?.contents ?? '', /^Routine APP\.PKG\.PROC/u);
});

test('references exceed the analysis cache bound and honor cancellation', async () => {
  const source = 'import { sql } from "@sqlbraid/postgres"; const q = sql`SELECT id FROM public.users`;';
  const sources = Array.from({ length: 260 }, (_, index) => ({
    fileName: `reference-${index}.ts`,
    sourceText: source,
  }));
  const service = createLanguageService({ metadata, sources, maxEntries: 1 });
  assert.equal((await service.references(source, 'query.ts', source.indexOf('public.users'))).length, 261);
  let checks = 0;
  const cancellation = { get isCancellationRequested(): boolean { checks += 1; return checks > 2; } };
  assert.deepEqual(await service.references(source, 'query.ts', source.indexOf('public.users'), cancellation), []);
});

test('ambiguous SQL aliases and omitted sources never become positive column references', async () => {
  const service = createLanguageService({ metadata, targets: [target] });
  for (const [module, sqlText, selected] of [
    ['postgres', 'WITH users (id) AS (SELECT 1) SELECT id FROM users', 'users'],
    ['postgres', 'SELECT id AS name FROM public.users', 'name'],
    ['postgres', 'SELECT id name FROM public.users', 'name'],
    ['postgres', 'SELECT id FROM public.users, unknown_orders', 'id'],
    ['postgres', 'SELECT id() FROM public.users', 'id'],
    ['mysql', 'SELECT "id" FROM public.users', '"id"'],
  ] as const) {
    const source = `import { sql } from '@sqlbraid/${module}'; const q = sql\`${sqlText}\`;`;
    const offset = source.lastIndexOf(selected);
    assert.equal(service.definition(source, 'ambiguous.ts', offset), undefined, sqlText);
    assert.deepEqual(await service.references(source, 'ambiguous.ts', offset), [], sqlText);
  }
});

test('JSON navigation uses decoded identities rather than relation map keys or folded names', () => {
  const snapshot = { ...metadata, relations: { arbitraryKey: { ...users, columns: [
    { name: 'ID', ordinal: 1, type: 'int8', nullable: false },
    { name: 'id', ordinal: 2, type: 'int8', nullable: false },
  ] } } };
  const json = JSON.stringify(snapshot, null, 2);
  const service = createLanguageService({ targets: [{ name: 'db', metadata: snapshot, metadataPath: 'metadata.json', metadataSource: json }] });
  const source = 'import { sql } from "@sqlbraid/postgres"; const q = sql`SELECT "ID" FROM public.users`;';
  assert.ok(service.definition(source, 'quoted.ts', source.indexOf('users'))?.uri.endsWith('/metadata.json'));
  const column = service.definition(source, 'quoted.ts', source.indexOf('"ID"'));
  assert.ok(column);
  const lines = json.split('\n');
  const start = lines.slice(0, column.range.start.line).reduce((sum, line) => sum + line.length + 1, 0) + column.range.start.character;
  const end = lines.slice(0, column.range.end.line).reduce((sum, line) => sum + line.length + 1, 0) + column.range.end.character;
  assert.equal(JSON.parse(json.slice(start, end)).name, 'ID');
});

test('query symbols and complete routine signature evidence stay bounded', () => {
  const completeRoutine = { ...feeRoutine, argumentsComplete: true } as const;
  const completeMetadata = { ...metadata, routines: { 'public.calculate_fee': [completeRoutine] } } as const satisfies MetadataSnapshot;
  const source = "import { sql } from '@sqlbraid/postgres';\nconst query = sql.rows<{}>`SELECT public.calculate_fee(id) FROM public.users`;";
  const service = createLanguageService({ metadata: completeMetadata, maxEntries: 2 });
  assert.equal(service.documentSymbols(source, 'symbols.ts').length, 1);
  const signature = service.signatureHelp(source, 'symbols.ts', source.indexOf('calculate_fee(') + 'calculate_fee('.length);
  assert.equal(signature?.parameters.length, 1);
  assert.equal(signature?.activeParameter, 0);
  assert.equal(service.signatureHelp(source, 'symbols.ts', source.indexOf(' FROM')), undefined);
});
