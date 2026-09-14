import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";
import { validateSupport } from "../scripts/validate-support.mjs";

const root = resolve(import.meta.dirname, "..");
async function copyDataset(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), "sqlbraid-support-"));
  await cp(join(root, "support"), join(destination, "support"), { recursive: true });
  await cp(join(root, ".github/workflows"), join(destination, ".github/workflows"), { recursive: true });
  await cp(join(root, "package.json"), join(destination, "package.json"));
  for (const directory of await readdir(join(root, "packages"))) {
    await mkdir(join(destination, "packages", directory), { recursive: true });
    await cp(join(root, "packages", directory, "package.json"), join(destination, "packages", directory, "package.json"));
  }
  const registry = JSON.parse(await readFile(join(root, "support/test-registry.json"), "utf8")) as Record<string, { file: string }>;
  for (const file of new Set(Object.values(registry).map((entry) => entry.file))) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(root, file), join(destination, file));
  }
  return destination;
}
async function mutateJson<T>(path: string, mutate: (value: T) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as T;
  mutate(value);
  await writeFile(path, JSON.stringify(value));
}

test("support validation rejects claims without schema, locale, package, CI or real test evidence", async () => {
  const mutations: readonly [string, (directory: string) => Promise<void>][] = [
    ["SUPPORT_DUPLICATE_ID", async (directory) => mutateJson<{ capabilities: { id: string }[] }>(join(directory, "support/capabilities.json"), (v) => { v.capabilities.push(v.capabilities[0]!); })],
    ["SUPPORT_LABEL_MISSING_KO", async (directory) => mutateJson<{ capabilities: { labels: { ko?: string } }[] }>(join(directory, "support/capabilities.json"), (v) => { delete v.capabilities[0]!.labels.ko; })],
    ["SUPPORT_SCHEMA", async (directory) => mutateJson<Record<string, unknown>>(join(directory, "support/targets/postgres.json"), (v) => { v.unrecognized = true; })],
    ["SUPPORT_TARGET_MISSING_PACKAGE", async (directory) => mutateJson<{ driver: { package: string } }>(join(directory, "support/targets/postgres.json"), (v) => { v.driver.package = "@sqlbraid/postgres/nonexistent"; })],
    ["SUPPORT_TARGET_MISSING_CI", async (directory) => mutateJson<{ ci: { workflow: string } }>(join(directory, "support/targets/postgres.json"), (v) => { v.ci.workflow = ".github/workflows/missing.yml"; })],
    ["SUPPORT_TARGET_MISSING_TEST", async (directory) => {
      const file = join(directory, "tests/db/postgres/capabilities.test.ts");
      const source = await readFile(file, "utf8");
      await writeFile(file, source.replace('test("postgres.sql.native-transparency"', 'test.skip("postgres.sql.native-transparency"'));
    }],
    ["SUPPORT_TARGET_MISSING_TEST", async (directory) => {
      const file = join(directory, "tests/db/postgres/capabilities.test.ts");
      const source = (await readFile(file, "utf8"))
        .replace('import { inject, test } from "vitest";', 'import { describe, inject, test } from "vitest";')
        .replace('test("postgres.sql.native-transparency"', 'test("unregistered-active-copy"');
      await writeFile(file, `${source}\ndescribe.skip("inactive suite", () => { test("postgres.sql.native-transparency", () => {}); });\n`);
    }],
    ["SUPPORT_UNKNOWN_TEST", async (directory) => mutateJson<{ capabilities: Record<string, { testIds: string[] }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["sql.native-transparency"]!.testIds = ["postgres.sql.unknown"]; })],
    ["SUPPORT_CAPABILITY_MISSING_CONDITION", async (directory) => mutateJson<{ capabilities: Record<string, { status: string; conditionCode?: string }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["sql.native-transparency"]!.status = "guarded"; })],
    ["SUPPORT_TARGET_NOT_ZERO_COST", async (directory) => mutateJson<{ status: string; reproducibility: { zeroCost: boolean } }>(join(directory, "support/targets/postgres.json"), (v) => { v.status = "official"; v.reproducibility.zeroCost = false; })],
    ["SUPPORT_TARGET_MISSING_EVIDENCE", async (directory) => mutateJson<{ status: string; evidence: { status: string } }>(join(directory, "support/targets/postgres.json"), (v) => { v.status = "official"; v.evidence.status = "pending"; })],
    ["SUPPORT_TARGET_UNKNOWN_VERSION", async (directory) => mutateJson<{ status: string; database: { version?: string } }>(join(directory, "support/targets/postgres.json"), (v) => { v.status = "official"; delete v.database.version; })],
    ["SUPPORT_NUMERIC_FIDELITY", async (directory) => mutateJson<{ capabilities: Record<string, { rawRepresentations: string[] }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["numeric.exact-decimal"]!.rawRepresentations = ["number"]; })],
  ];
  for (const [code, mutate] of mutations) {
    const directory = await copyDataset();
    try {
      await mutate(directory);
      await assert.rejects(() => validateSupport({ root: directory }), { code });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
