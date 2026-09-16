import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { validateRuntimeFloor } from '../scripts/validate-runtime-floor.mjs';

const root = resolve(import.meta.dirname, '..');
const runtimePackages = ['core', 'template', 'runtime', 'operations', 'postgres', 'mysql', 'mariadb', 'sqlite', 'oracle', 'mssql', 'sqlbraid'];

test('runtime floor rejects emitted Node-newer APIs in an executable fixture', async () => {
  const directory = await mkdtemp(join(root, '.sqlbraid-runtime-floor-'));
  try {
    await writeFile(join(directory, 'tsconfig.runtime-floor.json'), await readFile(join(root, 'tsconfig.runtime-floor.json')));
    for (const packageName of runtimePackages) {
      const packageRoot = join(directory, 'packages', packageName);
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, engines: { node: '>=16.20.2' } }));
      await writeFile(join(packageRoot, 'dist', 'fixture.js'), 'export const supported = Promise.resolve(1);\n');
    }
    await validateRuntimeFloor({ root: directory, checkDist: true });
    await writeFile(join(directory, 'packages', 'runtime', 'dist', 'fixture.js'), 'export const unsupported = Promise.withResolvers();\n');
    await assert.rejects(validateRuntimeFloor({ root: directory, checkDist: true }), /RUNTIME_FLOOR_API.*Promise\.withResolvers/u);
    await writeFile(join(directory, 'packages', 'runtime', 'dist', 'fixture.js'), 'export const unsupported = [1].toSorted();\n');
    await assert.rejects(validateRuntimeFloor({ root: directory, checkDist: true }), /RUNTIME_FLOOR_API.*ES2023 copying array method/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
