import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('sqlbraid check and manifest operate on source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlbraid-'));
  const file = join(directory, 'query.ts');
  await writeFile(file, "import { sql } from '@sqlbraid/template'; const q = sql`SELECT 1`;\n");
  const check = await exec(process.execPath, ['packages/cli/dist/index.js', 'check', '--file', file]);
  assert.equal(check.stdout, '');
  const manifest = await exec(process.execPath, ['packages/cli/dist/index.js', 'manifest', '--file', file]);
  assert.match(manifest.stdout, /fingerprint/);
});
