import assert from "node:assert/strict";
import { runMysqlSmoke, runPostgresSmoke, runSqliteSmoke } from "./runtime-driver-smoke.mjs";

const observationsDirectory = Deno.env.get("SQLBRAID_DENO_OBSERVATIONS_DIR");
if (!observationsDirectory) throw new Error("SQLBRAID_DENO_OBSERVATIONS_DIR is required.");
assert.equal(Deno.version.deno, "2.9.3");

function normalizeDatabaseVersion(result) {
  const raw = String(result.database.version);
  if (result.driver.id === "pg") {
    const match = /^PostgreSQL\s+(\d+(?:\.\d+){1,2})/u.exec(raw);
    assert.ok(match, `Unable to parse PostgreSQL version probe: ${raw}`);
    assert.equal(match[1], Deno.env.get("SQLBRAID_POSTGRES_VERSION"));
    return { version: match[1], versionRaw: raw };
  }
  if (result.driver.id === "mysql2") {
    const match = /^(\d+(?:\.\d+){2})/u.exec(raw);
    assert.ok(match, `Unable to parse MySQL version probe: ${raw}`);
    assert.equal(match[1], Deno.env.get("SQLBRAID_MYSQL_VERSION"));
    return { version: match[1], versionRaw: raw };
  }
  return { version: raw, versionRaw: raw };
}

async function installedVersion(packageName, expected) {
  const packageUrl = new URL(`./node_modules/${packageName}/package.json`, import.meta.url);
  const version = JSON.parse(await Deno.readTextFile(packageUrl)).version;
  assert.equal(version, expected, `${packageName} packed version changed`);
  return version;
}

async function record(testId, result) {
  assert.equal(result.supported, true);
  assert.ok(result.database && result.driver && result.runtime && result.typePolicy);
  const driverVersion = result.driver.id === "pg"
    ? await installedVersion("pg", Deno.env.get("SQLBRAID_PG_VERSION"))
    : result.driver.id === "mysql2"
      ? await installedVersion("mysql2", Deno.env.get("SQLBRAID_MYSQL2_VERSION"))
      : result.runtime.version;
  const databaseVersion = normalizeDatabaseVersion(result);
  const database = {
    ...result.database,
    ...databaseVersion,
    ...(result.driver.id === "pg" ? { edition: Deno.env.get("SQLBRAID_POSTGRES_EDITION") } : {}),
    ...(result.driver.id === "mysql2" ? { edition: Deno.env.get("SQLBRAID_MYSQL_EDITION") } : {}),
    ...(result.driver.id === "node-sqlite" ? { edition: "Deno bundled SQLite" } : {}),
  };
  const observation = {
    testIds: [testId],
    targetId: [database.product, result.driver.id, result.runtime.id, result.runtime.version.replaceAll(".", "-")].join("-"),
    database,
    driver: { ...result.driver, version: driverVersion },
    runtime: result.runtime,
    typePolicy: result.typePolicy,
    checks: result.checks ?? [],
  };
  await Deno.mkdir(observationsDirectory, { recursive: true });
  await Deno.writeTextFile(`${observationsDirectory}/${testId}.json`, `${JSON.stringify(observation, null, 2)}\n`);
}

Deno.test("deno-postgres.data.profile", async () => {
  const result = await runPostgresSmoke(Deno.env.get("SQLBRAID_POSTGRES_URL"));
  assert.equal(result.profile, "pg-lossless-text");
  await record("deno-postgres.data.profile", result);
});

Deno.test("deno-mysql.data.profile", async () => {
  const result = await runMysqlSmoke(Deno.env.get("SQLBRAID_MYSQL_URL"));
  assert.equal(result.profile, "mysql2-lossless-text");
  await record("deno-mysql.data.profile", result);
});

Deno.test("deno-sqlite.data.profile", async () => {
  const result = await runSqliteSmoke();
  assert.equal(result.profile, "sqlite-exact-string");
  await record("deno-sqlite.data.profile", result);
});
