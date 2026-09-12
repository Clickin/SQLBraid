import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('CLI checks, manifests, and builds opaque declared queries without a snapshot', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sqlbraid-cli-'));
  try {
    const file = join(directory, 'query.ts');
    await writeFile(file, `import { sql } from '@sqlbraid/template';
      type Row = { id: number };
      export function build(user: Row | null) {
        return [
          sql.rows<Row>\`SELECT custom_company_function(id) /*@braid if \${user != null}*/ WHERE id=\${user.id} /*@braid end*/\`,
          sql.command\`SELECT proprietary_command() /*@braid if \${user != null}*/ WITH ARGUMENT \${user.id} /*@braid end*/\`,
          sql.call<Row>\`SELECT proprietary_call() /*@braid if \${user != null}*/ WITH ARGUMENT \${user.id} /*@braid end*/\`,
          sql\`SELECT id FROM users\`,
        ];
      }
    `);
    const check = await exec(process.execPath, ['packages/cli/dist/index.js', 'check', '--file', file, '--json']);
    assert.deepEqual(JSON.parse(check.stdout), []);
    const manifest = await exec(process.execPath, ['packages/cli/dist/index.js', 'manifest', '--file', file]);
    const entries: { resultKind: string; resultType?: string }[] = JSON.parse(manifest.stdout);
    assert.deepEqual(entries.map((entry) => entry.resultKind), ['rows', 'command', 'call', 'unknown']);
    assert.deepEqual(entries.map((entry) => entry.resultType), ['Row', 'import("@sqlbraid/core").CommandResult', 'Row', undefined]);
    const output = join(directory, 'generated', 'renamed.mjs');
    await exec(process.execPath, ['packages/cli/dist/index.js', 'build', '--file', file, '--out-file', output]);
    const { build } = await import(pathToFileURL(output).href);
    const inactive = build(null);
    assert.deepEqual(inactive.map((query: { resultKind: string }) => query.resultKind), ['rows', 'command', 'call', 'unknown']);
    const active = build({ id: 7 });
    assert.deepEqual(active[0].render().values, [7]);
    assert.deepEqual(inactive[0].render().values, []);
    await assert.rejects(
      exec(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval', `import { build } from ${JSON.stringify(pathToFileURL(output).href)}; build({ get id() { throw new Error('source-map-probe'); } });`]),
      (error: unknown) => error instanceof Error && error.message.includes(`${file}:`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
