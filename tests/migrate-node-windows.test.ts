import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "vitest";
import { generateManifestModule } from "../packages/migrate/src/node.js";
import { relativeSpecifier } from "../packages/migrate/src/sources.js";

test("manifest import specifiers use forward slashes relative to a Windows output file", () => {
  assert.equal(relativeSpecifier("C:\\proj\\migrations", "C:\\proj\\migrations\\V1__ts.ts", win32), "./V1__ts.ts");
  assert.equal(
    relativeSpecifier("C:\\proj\\src", "C:\\proj\\migrations\\2026\\V2__ts.ts", win32),
    "../migrations/2026/V2__ts.ts",
  );
  assert.equal(relativeSpecifier("c:\\proj\\src", "C:\\Proj\\migrations\\V3__ts.ts", win32), "../migrations/V3__ts.ts");
  assert.throws(() => relativeSpecifier("C:\\proj\\src", "D:\\proj\\migrations\\V1__ts.ts", win32), {
    code: "BRAID_MIGRATE_SOURCE",
  });
});

test("generated manifests import TypeScript lazily relative to the output file", async () => {
  const path = await mkdtemp(join(tmpdir(), "sqlbraid-migrations-specifier-"));
  try {
    await mkdir(join(path, "migrations", "nested"), { recursive: true });
    await writeFile(join(path, "migrations", "nested", "V1__ts.ts"), "export default async () => {};");
    const outfile = join(path, "src", "migrations.mjs");
    const code = await generateManifestModule(join(path, "migrations"), { dialects: ["sqlite"], outfile });
    assert.ok(code.includes('async () => (await import("../migrations/nested/V1__ts.ts")).default'), code);
    assert.ok(!/^\s*import\s/mu.test(code), "TypeScript migrations must not use static imports");
    const local = await generateManifestModule(join(path, "migrations"), { dialects: ["sqlite"] });
    assert.ok(local.includes('import("./nested/V1__ts.ts")'), local);
    assert.equal(
      await readFile(join(path, "migrations", "nested", "V1__ts.ts"), "utf8"),
      "export default async () => {};",
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
