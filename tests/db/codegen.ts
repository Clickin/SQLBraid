import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function assertCompilesGeneratedSource(source: string, label: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `sqlbraid-${label}-`));
  try {
    await writeFile(join(directory, "models.ts"), source);
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["models.ts"],
    }));
    await exec(process.execPath, [
      join(process.cwd(), "node_modules/typescript/bin/tsc"),
      "--project",
      join(directory, "tsconfig.json"),
      "--pretty",
      "false",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface GeneratedProperty {
  readonly optional: boolean;
  readonly type: string;
}

export function generatedProperty(source: string, interfaceName: string, propertyName: string): GeneratedProperty | undefined {
  const body = interfaceBody(source, interfaceName);
  for (const line of body.split("\n")) {
    const match = /^\s*(?:readonly\s+)?(?:"((?:\\.|[^"])*)"|([A-Za-z_$][\w$]*))(\?)?:\s*(.+);\s*$/u.exec(line);
    if (!match) continue;
    const name = match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`) as string;
    if (name !== propertyName) continue;
    return {
      optional: match[3] !== undefined,
      type: match[4].replaceAll(/[()]/gu, "").replaceAll(/\s+/gu, " ").trim(),
    };
  }
  return undefined;
}

export function assertGeneratedProperty(
  source: string,
  interfaceName: string,
  propertyName: string,
  type: string,
  optional: boolean,
): void {
  assert.deepEqual(generatedProperty(source, interfaceName, propertyName), { optional, type }, `${interfaceName}.${propertyName}`);
}

export function assertGeneratedPropertyAbsent(source: string, interfaceName: string, propertyName: string): void {
  assert.equal(generatedProperty(source, interfaceName, propertyName), undefined, `${interfaceName}.${propertyName}`);
}

function interfaceBody(source: string, interfaceName: string): string {
  const match = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`, "u").exec(source);
  assert.ok(match, `missing generated interface ${interfaceName}`);
  return match[1]!;
}
