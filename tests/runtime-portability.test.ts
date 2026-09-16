import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { auditRuntime } from "../scripts/audit-runtime.mjs";

test("runtime portability audit rejects a Node builtin in the OTel bridge", async () => {
  const root = await mkdtemp(join(import.meta.dirname, ".sqlbraid-runtime-audit-"));
  const packageNames = ["core", "template", "runtime", "postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql", "bun-sql", "opentelemetry"];
  try {
    for (const packageName of packageNames) {
      const packageRoot = join(root, packageName);
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: `@sqlbraid/${packageName}` }));
      await writeFile(join(packageRoot, "src", "index.ts"), "export const supported = true;\n");
    }
    await auditRuntime(root, "src");
    await writeFile(join(root, "opentelemetry", "src", "index.ts"), 'import "node:fs";\n');
    await assert.rejects(
      auditRuntime(root, "src"),
      /Unreviewed compatibility import: node:fs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
