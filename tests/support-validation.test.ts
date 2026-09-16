import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    const policySource = join(root, "packages", directory, "src/type-policy.ts");
    try {
      await access(policySource);
      await mkdir(join(destination, "packages", directory, "src"), { recursive: true });
      await cp(policySource, join(destination, "packages", directory, "src/type-policy.ts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(join(destination, "packages/core/src"), { recursive: true });
  await cp(join(root, "packages/core/src/index.ts"), join(destination, "packages/core/src/index.ts"));
  await cp(join(root, "packages/core/src/authoring-modules.ts"), join(destination, "packages/core/src/authoring-modules.ts"));
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

test("support validation rejects claims without schema, locale, package, CI or real test evidence", { timeout: 30_000 }, async () => {
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
    ["SUPPORT_REPRESENTATION_MISMATCH", async (directory) => mutateJson<{ capabilities: Record<string, { driverRawRepresentations: string[] }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["numeric.exact-decimal"]!.driverRawRepresentations = ["number"]; })],
    ["SUPPORT_NUMERIC_FIDELITY", async (directory) => mutateJson<{ numeric: Record<string, { representation: string }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.numeric["exact-decimal"]!.representation = "number"; })],
    ["SUPPORT_NUMERIC_FIDELITY", async (directory) => mutateJson<{ capabilities: Record<string, { representation: string }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["numeric.exact-decimal"]!.representation = "number"; })],
    ["SUPPORT_UNSUPPORTED_SUCCESS", async (directory) => mutateJson<{ capabilities: Record<string, { testIds: string[] }> }>(join(directory, "support/targets/mssql.json"), (v) => { v.capabilities["numeric.exact-decimal"]!.testIds = ["mssql.numeric.exact-integer"]; })],
    ["SUPPORT_SCHEMA", async (directory) => mutateJson<{ capabilities: Record<string, { canonical?: string }> }>(join(directory, "support/targets/postgres.json"), (v) => { v.capabilities["numeric.exact-decimal"]!.canonical = "string"; })],
    ["SUPPORT_PROFILE_MISMATCH", async (directory) => mutateJson<{ driver: { requiredOptions: { jsonStrings: boolean } } }>(join(directory, "support/targets/mysql.json"), (v) => { v.driver.requiredOptions.jsonStrings = false; })],
    ["SUPPORT_PROFILE_MISMATCH", async (directory) => mutateJson<{ profiles: Record<string, { requiredOptions: { dateStrings: boolean } }> }>(join(directory, "support/profiles.json"), (v) => { v.profiles["mariadb-lossless-text"]!.requiredOptions.dateStrings = false; })],
    ["SUPPORT_PROFILE_MISMATCH", async (directory) => {
      await mutateJson<{ profiles: Record<string, { requiredOptions: { jsonStrings: boolean } }> }>(join(directory, "support/profiles.json"), (v) => { v.profiles["mysql2-lossless-text"]!.requiredOptions.jsonStrings = false; });
      await mutateJson<{ driver: { requiredOptions: { jsonStrings: boolean } } }>(join(directory, "support/targets/mysql.json"), (v) => { v.driver.requiredOptions.jsonStrings = false; });
    }],
    ["SUPPORT_TYPE_POLICY_MISMATCH", async (directory) => mutateJson<{ typePolicy: { hash: string } }>(join(directory, "support/targets/mysql.json"), (v) => { v.typePolicy.hash = "mismatched-policy-hash"; })],
    ["SUPPORT_PROFILE_FIXTURE", async (directory) => mutateJson<{ profiles: Record<string, { fixtureTestIds: string[] }> }>(join(directory, "support/profiles.json"), (v) => { v.profiles["mysql2-native"]!.fixtureTestIds = []; })],
    ["SUPPORT_CAPABILITY_ALTERNATE_PROFILE", async (directory) => mutateJson<{ capabilities: Record<string, { conditionCode?: string }> }>(join(directory, "support/targets/mysql.json"), (v) => { v.capabilities["data.json-lossless-text"]!.conditionCode = "mysql2.json-strings"; })],
    ["SUPPORT_REPRESENTATION_MISMATCH", async (directory) => mutateJson<{ driver: { driverRawRepresentations: { integer: string } } }>(join(directory, "support/targets/mysql.json"), (v) => { v.driver.driverRawRepresentations.integer = "object"; })],
    ["SUPPORT_REPRESENTATION_MISMATCH", async (directory) => mutateJson<{ fixtures: Record<string, { driverRawRepresentations: { json: string } }> }>(join(directory, "support/profiles.json"), (v) => { v.fixtures["mysql.data.json-lossless-text"]!.driverRawRepresentations.json = "object"; })],
  ];
  for (const [code, mutate] of mutations) {
    const directory = await copyDataset();
    try {
      await mutate(directory);
      await assert.rejects(() => validateSupport({ root: directory }), { code });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("capability references enumerate the complete machine-readable vocabulary", async () => {
  const catalog = JSON.parse(await readFile(join(root, "support/capabilities.json"), "utf8")) as { capabilities: readonly { id: string }[] };
  const documents = [
    "website/src/content/docs/reference/support.mdx",
    "website/src/content/docs/ko/reference/support.mdx",
    "docs/SQLBraid_0.1.0_release_notes.md",
  ];
  for (const document of documents) {
    const source = await readFile(join(root, document), "utf8");
    const vocabulary = source.match(/```text\n([\s\S]*?)```/u)?.[1] ?? "";
    for (const capability of catalog.capabilities) assert.ok(vocabulary.includes(capability.id), `${document} omits ${capability.id}`);
  }
});
