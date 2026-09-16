import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codegenOutputCollisionKey } from '../packages/cli/src/codegen-path.js';
import { createSqliteInspector } from '@sqlbraid/sqlite/inspector';

const exec = promisify(execFile);
const cliEntry = resolve(process.cwd(), 'packages/cli/dist/index.js');

test('CLI version matches the package manifest', async () => {
  const manifest = JSON.parse(await readFile(resolve(process.cwd(), 'packages/cli/package.json'), 'utf8')) as { version: string };
  const result = await exec(process.execPath, [cliEntry, '--version']);
  assert.equal(result.stdout.trim(), manifest.version);
});

function metadata(nullable = false) {
  return {
    format: 'sqlbraid-metadata',
    formatVersion: 1,
    dialect: 'postgres',
    dialectVersion: '16',
    server: {},
    namespaces: {},
    types: {},
    relations: {
      'public.users': {
        identity: 'public.users',
        name: 'users',
        namespace: 'public',
        kind: 'table',
        columns: [{ name: 'id', ordinal: 0, type: 'int4', nullable }],
      },
    },
    routines: {},
    metadata: {},
  };
}

// Several CLI processes create cold TypeScript programs; keep their integration budget separate.
test('CLI checks, manifests, and builds opaque declared queries without a snapshot', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const file = join(directory, 'query.ts');
    await writeFile(file, `import { sql } from '@sqlbraid/template';
      import type { RoutineCallResult } from '@sqlbraid/core';
      type Row = { id: number };
      type CallResult = RoutineCallResult<{ ok: boolean }, readonly [{ id: number }]>;
      export function build(user: Row | null) {
        return [
          sql.rows<Row>\`SELECT custom_company_function(id) /*@braid if \${user != null}*/ WHERE id=\${user.id} /*@braid end*/\`,
          sql.command\`SELECT proprietary_command() /*@braid if \${user != null}*/ WITH ARGUMENT \${user.id} /*@braid end*/\`,
          sql.call<CallResult>\`SELECT proprietary_call() /*@braid if \${user != null}*/ WITH ARGUMENT \${user.id} /*@braid end*/\`,
          sql\`SELECT id FROM users\`,
        ];
      }
    `);
    const check = await exec(process.execPath, ['packages/cli/dist/index.js', 'check', '--file', file, '--json']);
    assert.deepEqual(JSON.parse(check.stdout), []);
    const manifest = await exec(process.execPath, ['packages/cli/dist/index.js', 'manifest', '--file', file]);
    const entries: { resultKind: string; resultType?: string; [key: string]: unknown }[] = JSON.parse(manifest.stdout);
    assert.deepEqual(entries.map((entry) => entry.resultKind), ['rows', 'command', 'call', 'unknown']);
    assert.deepEqual(entries.map((entry) => entry.resultType), ['Row', 'import("@sqlbraid/core").CommandResult', 'CallResult', undefined]);
    assert.ok(entries.every((entry) => !('operation' in entry) && !('readOnly' in entry) && !('locking' in entry) && !('sessionAffine' in entry) && !('reason' in entry)));
    assert.ok(entries.every((entry) => typeof entry.fingerprint === 'string' && typeof entry.templateFamilyFingerprint === 'string' && typeof entry.source === 'string'));
    const output = join(directory, 'generated', 'renamed.mjs');
    await exec(process.execPath, ['packages/cli/dist/index.js', 'build', '--file', file, '--out-file', output]);
    const { build } = await import(pathToFileURL(output).href);
    const inactive = build(null);
    assert.deepEqual(inactive.map((query: { resultKind: string }) => query.resultKind), ['rows', 'command', 'call', 'unknown']);
    const active = build({ id: 7 });
    assert.deepEqual(active[0].render().parameters.map(({ value }: { readonly value: unknown }) => value), [7]);
    assert.deepEqual(inactive[0].render().parameters, []);
    await assert.rejects(
      exec(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval', `import { build } from ${JSON.stringify(pathToFileURL(output).href)}; build({ get id() { throw new Error('source-map-probe'); } });`]),
      (error: unknown) => error instanceof Error && error.message.includes(`${file}:`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI drift validates metadata snapshots and reports changed database facts', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const before = {
      format: 'sqlbraid-metadata',
      formatVersion: 1,
      dialect: 'postgres',
      dialectVersion: '16',
      server: {},
      namespaces: {},
      types: {},
      relations: {
        users: {
          identity: 'public.users',
          name: 'users',
          kind: 'table',
          columns: [{ name: 'id', ordinal: 1, type: 'int8', nullable: false }],
        },
      },
      routines: {},
      metadata: {},
    };
    const after = {
      ...before,
      relations: {
        ...before.relations,
        users: {
          ...before.relations.users,
          columns: [{ ...before.relations.users.columns[0], nullable: true }],
        },
      },
    };
    const beforeFile = join(directory, 'before.json');
    const afterFile = join(directory, 'after.json');
    await writeFile(beforeFile, JSON.stringify(before));
    await writeFile(afterFile, JSON.stringify(after));

    const unchanged = await exec(process.execPath, ['packages/cli/dist/index.js', 'drift', '--before', beforeFile, '--after', beforeFile]);
    assert.deepEqual(JSON.parse(unchanged.stdout), []);

    try {
      await exec(process.execPath, ['packages/cli/dist/index.js', 'drift', '--before', beforeFile, '--after', afterFile]);
      assert.fail('drift should exit non-zero when metadata changes');
    } catch (error) {
      const result = error as { readonly code?: number; readonly stdout?: string };
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout ?? ''), [{
        path: 'relations.users.columns[0].nullable',
        before: false,
        after: true,
      }]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI codegen resolves config-relative paths, preserves unchanged mtimes, and checks freshness', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const configDirectory = join(directory, 'config');
    const outputDirectory = join(directory, 'generated');
    const metadataFile = join(configDirectory, 'metadata.json');
    const outputFile = join(outputDirectory, 'database.ts');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(metadataFile, JSON.stringify(metadata()));
    await writeFile(join(configDirectory, 'sqlbraid.config.mjs'), [
      'import { defineConfig } from "@sqlbraid/cli/config";',
      'import { typePolicy } from "@sqlbraid/postgres";',
      'export default defineConfig({ codegen: { targets: [{ name: "main", metadata: "./metadata.json", outFile: "../generated/database.ts", typePolicy }] } });',
    ].join('\n'));

    const first = await exec(process.execPath, [cliEntry, 'codegen', '--config', join(configDirectory, 'sqlbraid.config.mjs'), '--json'], { cwd: process.cwd() });
    assert.equal(JSON.parse(first.stdout)[0].status, 'written');
    const firstMtime = (await stat(outputFile)).mtimeMs;
    const second = await exec(process.execPath, [cliEntry, 'codegen', '--config', join(configDirectory, 'sqlbraid.config.mjs'), '--json'], { cwd: process.cwd() });
    assert.equal(JSON.parse(second.stdout)[0].status, 'unchanged');
    assert.equal((await stat(outputFile)).mtimeMs, firstMtime);

    await writeFile(metadataFile, JSON.stringify(metadata(true)));
    await assert.rejects(
      exec(process.execPath, [cliEntry, 'codegen', '--config', join(configDirectory, 'sqlbraid.config.mjs'), '--check', '--json'], { cwd: process.cwd() }),
      (error: unknown) => (error as { code?: number; stdout?: string }).code === 1
        && JSON.parse((error as { stdout: string }).stdout)[0].status === 'stale',
    );
    assert.equal((await stat(outputFile)).mtimeMs, firstMtime);
    const current = await exec(process.execPath, [cliEntry, 'codegen', '--config', join(configDirectory, 'sqlbraid.config.mjs'), '--json'], { cwd: process.cwd() });
    assert.equal(JSON.parse(current.stdout)[0].status, 'written');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI codegen retains unavailable exact numeric evidence across the config worker', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata()));
    await writeFile(join(directory, 'sqlbraid.config.mjs'), `export default { codegen: { targets: [{
      name: "main", metadata: "./metadata.json", outFile: "./generated.ts",
      typePolicy: { id: "unavailable-exact", hash: "pv17", mappings: [{
        databaseType: "int4", inputType: "string", outputType: "unknown", nullable: false,
        numeric: { semantics: "exact-integer", representation: "string", fidelity: "unsupported" }
      }] }
    }] } };`);
    const result = await exec(process.execPath, [cliEntry, 'codegen', '--config', join(directory, 'sqlbraid.config.mjs'), '--json']);
    const reports = JSON.parse(result.stdout);
    assert.ok(reports[0].diagnostics.some((diagnostic: { code: string }) => diagnostic.code === 'CODEGEN_NUMERIC_FIDELITY_UNAVAILABLE'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI codegen discovers configs, selects repeated targets, and blocks error writes', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    await mkdir(join(directory, 'data'), { recursive: true });
    await writeFile(join(directory, 'data', 'metadata.json'), JSON.stringify(metadata()));
    await writeFile(join(directory, 'sqlbraid.config.mjs'), [
      'import { defineConfig } from "@sqlbraid/cli/config";',
      'import { typePolicy } from "@sqlbraid/postgres";',
      'export default defineConfig({ codegen: { targets: [',
      '{ name: "main", metadata: "./data/metadata.json", outFile: "./main.ts", typePolicy },',
      '{ name: "other", metadata: "./data/metadata.json", outFile: "./other.ts", typePolicy }',
      '] } });',
    ].join('\n'));
    const selected = await exec(process.execPath, [cliEntry, 'codegen', '--target', 'other', '--target', 'main', '--json'], { cwd: directory });
    assert.deepEqual(JSON.parse(selected.stdout).map((entry: { target: string }) => entry.target), ['main', 'other']);
    await assert.rejects(
      exec(process.execPath, [cliEntry, 'codegen', '--target', 'missing'], { cwd: directory }),
      (error: unknown) => (error as { code?: number }).code === 2,
    );

    await writeFile(join(directory, 'sqlbraid.config.mjs'), [
      'import { defineConfig } from "@sqlbraid/cli/config";',
      'import { typePolicy } from "@sqlbraid/postgres";',
      'export default defineConfig({ codegen: { targets: [',
      '{ name: "main", metadata: "./data/metadata.json", outFile: "./main.ts", typePolicy, naming: { relations: { "public.users": "1bad" } } },',
      '{ name: "other", metadata: "./data/metadata.json", outFile: "./other.ts", typePolicy }',
      '] } });',
    ].join('\n'));
    await writeFile(join(directory, 'main.ts'), 'preserve-main');
    await writeFile(join(directory, 'other.ts'), 'preserve-other');
    await assert.rejects(
      exec(process.execPath, [cliEntry, 'codegen', '--json'], { cwd: directory }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string };
        const entries = JSON.parse(result.stdout ?? '') as Array<{ target: string; status: string }>;
        return result.code === 1
          && entries.find((entry) => entry.target === 'main')?.status === 'error'
          && entries.find((entry) => entry.target === 'other')?.status === 'stale';
      },
    );
    assert.equal(await readFile(join(directory, 'main.ts'), 'utf8'), 'preserve-main');
    assert.equal(await readFile(join(directory, 'other.ts'), 'utf8'), 'preserve-other');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI codegen rejects case-folded output collisions on simulated Windows', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    await mkdir(join(directory, 'data'), { recursive: true });
    await writeFile(join(directory, 'data', 'metadata.json'), JSON.stringify(metadata()));
    await writeFile(join(directory, 'sqlbraid.config.mjs'), [
      'import { defineConfig } from "@sqlbraid/cli/config";',
      'import { typePolicy } from "@sqlbraid/postgres";',
      'export default defineConfig({ codegen: { targets: [',
      '{ name: "upper", metadata: "./data/metadata.json", outFile: "./Generated.ts", typePolicy },',
      '{ name: "lower", metadata: "./data/metadata.json", outFile: "./generated.ts", typePolicy }',
      '] } });',
    ].join('\n'));
    const preload = join(directory, 'win32.cjs');
    await writeFile(preload, 'Object.defineProperty(process, "platform", { value: "win32" });');
    await assert.rejects(
      exec(process.execPath, [cliEntry, 'codegen', '--json'], {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
      }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string };
        const entries = JSON.parse(result.stdout ?? '') as Array<{ target: string; status: string; diagnostics: Array<{ code: string }> }>;
        return result.code === 2
          && entries.every((entry) => entry.status === 'error')
          && entries.every((entry) => entry.diagnostics.some((diagnostic) => diagnostic.code === 'CODEGEN_OUTPUT_PATH_COLLISION'));
      },
    );
    await assert.rejects(readFile(join(directory, 'Generated.ts')));
    await assert.rejects(readFile(join(directory, 'generated.ts')));
    assert.equal(codegenOutputCollisionKey('/tmp/Generated.ts', 'win32'), codegenOutputCollisionKey('/tmp/generated.ts', 'win32'));
    assert.notEqual(codegenOutputCollisionKey('/tmp/Generated.ts', 'darwin'), codegenOutputCollisionKey('/tmp/generated.ts', 'darwin'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI inspect JSON discovers an ancestor SQLBraid config past nested projects', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const file = join(directory, 'src', 'nested', 'query.ts');
    await mkdir(join(directory, 'src', 'nested'), { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(directory, 'src', 'nested', 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(directory, 'src', 'nested', 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata()));
    await writeFile(join(directory, 'sqlbraid.config.mjs'), `export default ${JSON.stringify({
      codegen: {
        targets: [{
          name: 'nested',
          metadata: './metadata.json',
          outFile: './generated.ts',
          typePolicy: {
            id: 'nested-policy',
            hash: 'nested-policy-v1',
            mappings: [{ databaseType: 'int4', inputType: 'number', outputType: 'number', nullable: false }],
          },
        }],
      },
    })};\n`);
    await writeFile(file, 'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT 1`;\n');
    const column = (await readFile(file, 'utf8')).indexOf('sql`') + 1;
    const inspected = await exec(process.execPath, [
      cliEntry,
      'inspect',
      'query',
      '--file',
      file,
      '--line',
      '1',
      '--column',
      String(column),
      '--json',
    ], { cwd: directory });
    const result = JSON.parse(inspected.stdout) as { operation: string; resolved: boolean; provenance?: string; contents?: string };
    assert.equal(result.operation, 'query');
    assert.equal(result.resolved, true);
    assert.equal(result.provenance, 'sqlbraid');
    assert.match(result.contents ?? '', /target: nested/u);

    const diagnostics = await exec(process.execPath, [cliEntry, 'inspect', 'diagnostics', '--file', file, '--json'], { cwd: directory });
    const diagnosticResult = JSON.parse(diagnostics.stdout) as { operation: string; diagnostics: readonly unknown[] };
    assert.equal(diagnosticResult.operation, 'diagnostics');
    assert.deepEqual(diagnosticResult.diagnostics, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI inspect JSON consumes a facade query with metadata-backed defaults', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  const native = new DatabaseSync(':memory:');
  try {
    native.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
    const snapshot = await createSqliteInspector(native).inspect();
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(snapshot));
    await writeFile(join(directory, 'sqlbraid.config.mjs'), `export default ${JSON.stringify({
      codegen: {
        targets: [{
          name: 'sqlite',
          metadata: './metadata.json',
          outFile: './generated.ts',
          typePolicy: {
            id: 'sqlite-cli-test',
            hash: 'sqlite-cli-test-v1',
            mappings: [
              { databaseType: 'INTEGER', inputType: 'number', outputType: 'number', nullable: false },
              { databaseType: 'TEXT', inputType: 'string', outputType: 'string', nullable: true },
            ],
          },
        }],
      },
    })};\n`);
    const file = join(directory, 'query.ts');
    const source = 'import { sql } from "sqlbraid/sqlite"; export const query = sql`SELECT id FROM main.users`;';
    await writeFile(file, source);
    const relationColumn = source.indexOf('main.users') + 'main.'.length + 1;
    const inspected = await exec(process.execPath, [
      cliEntry,
      'inspect',
      'query',
      '--file',
      file,
      '--line',
      '1',
      '--column',
      String(relationColumn),
      '--json',
    ], { cwd: directory });
    const queryResult = JSON.parse(inspected.stdout) as { operation: string; resolved: boolean; contents?: string };
    assert.equal(queryResult.operation, 'query');
    assert.equal(queryResult.resolved, true);
    assert.match(queryResult.contents ?? '', /Relation main\.users/u);

    const symbols = await exec(process.execPath, [cliEntry, 'inspect', 'symbol', 'users', '--json'], { cwd: directory });
    const symbolResult = JSON.parse(symbols.stdout) as { operation: string; symbols: readonly { name: string; kind: string }[] };
    assert.equal(symbolResult.operation, 'symbol');
    assert.deepEqual(symbolResult.symbols.map((symbol) => [symbol.name, symbol.kind]), [['users', 'relation']]);

    const diagnostics = await exec(process.execPath, [cliEntry, 'inspect', 'diagnostics', '--file', file, '--json'], { cwd: directory });
    assert.deepEqual((JSON.parse(diagnostics.stdout) as { diagnostics: readonly unknown[] }).diagnostics, []);
  } finally {
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('programmatic inspector snapshots feed the CLI codegen recipe', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  const native = new DatabaseSync(':memory:');
  try {
    native.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;');
    const snapshot = await createSqliteInspector(native).inspect();
    const metadataPath = join(directory, 'metadata.json');
    const configPath = join(directory, 'sqlbraid.config.mjs');
    const outputPath = join(directory, 'generated.ts');
    await writeFile(metadataPath, JSON.stringify(snapshot));
    await writeFile(configPath, `export default ${JSON.stringify({
      codegen: {
        targets: [{
          name: 'sqlite',
          metadata: './metadata.json',
          outFile: './generated.ts',
          typePolicy: {
            id: 'sqlite-codegen-recipe',
            hash: 'sqlite-codegen-recipe-v1',
            mappings: [
              { databaseType: 'INTEGER', inputType: 'number', outputType: 'number', nullable: false },
              { databaseType: 'TEXT', inputType: 'string', outputType: 'string', nullable: true },
            ],
          },
        }],
      },
    })};\n`);
    const first = await exec(process.execPath, [cliEntry, 'codegen', '--config', configPath, '--json'], { cwd: directory });
    assert.equal(JSON.parse(first.stdout)[0].status, 'written');
    const generated = await readFile(outputPath, 'utf8');
    assert.match(generated, /UsersRow/u);
    assert.match(generated, /"id": number/u);
    const second = await exec(process.execPath, [cliEntry, 'codegen', '--config', configPath, '--check', '--json'], { cwd: directory });
    assert.equal(JSON.parse(second.stdout)[0].status, 'unchanged');
  } finally {
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('CLI facade prebuild executes lazy branch interpolation from generated output', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const file = join(directory, 'query.ts');
    const output = join(directory, 'generated.mjs');
    await mkdir(join(directory, 'node_modules'), { recursive: true });
    await symlink(resolve('packages/sqlbraid'), join(directory, 'node_modules', 'sqlbraid'), 'junction');
    await writeFile(file, `
      import { sql } from "sqlbraid/sqlite";
      export function run(include: boolean) {
        let calls = 0;
        const query = sql\`SELECT 1 /*@braid if \${include}*/ AND id = \${(() => { calls += 1; return 7; })()} /*@braid end*/\`;
        const rendered = query.render();
        return { calls, parameters: rendered.parameters.map(({ value }) => value) };
      }
    `);
    await exec(process.execPath, [cliEntry, 'build', '--file', file, '--out-file', output], { cwd: directory });
    const { run } = await import(pathToFileURL(output).href) as { run: (include: boolean) => { calls: number; parameters: unknown[] } };
    assert.deepEqual(run(false), { calls: 0, parameters: [] });
    assert.deepEqual(run(true), { calls: 1, parameters: [7] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
