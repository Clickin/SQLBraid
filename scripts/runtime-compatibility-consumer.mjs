import assert from "node:assert/strict";

const { sql } = await import("@sqlbraid/sqlite");
const rendered = sql`SELECT ${1} AS value`.render();
assert.deepEqual(rendered.segments, ["SELECT ", " AS value"]);
assert.equal(rendered.parameters[0].value, 1);
const facade = await import("sqlbraid");
assert.equal(typeof facade.createDatabase, "function");
const packageNames = JSON.parse(process.env.SQLBRAID_COMPAT_PACKAGES ?? "[]");
for (const packageName of packageNames) {
  const loaded = await import(packageName);
  assert.ok(loaded && typeof loaded === "object", `compatibility root did not import: ${packageName}`);
}
const helpers = await import("sqlbraid/compiled");
assert.equal(typeof helpers.capture, "function");
assert.equal(typeof helpers.assertDirectiveCondition, "function");

if (process.env.SQLBRAID_COMPAT_DRIVER === "better-sqlite3") await smokeBetterSqlite3();
if (process.env.SQLBRAID_COMPAT_DRIVER === "@libsql/client") await smokeLibsql();

async function smokeBetterSqlite3() {
  const loaded = await import("better-sqlite3");
  const BetterSqlite3 = loaded.default ?? loaded;
  const { createBetterSqlite3Database } = await import("@sqlbraid/sqlite/better-sqlite3");
  const native = new BetterSqlite3(":memory:");
  const db = createBetterSqlite3Database(native);
  try {
    await db.execute(sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`);
    await db.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`);
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
        throw new Error("compatibility rollback");
      }),
      /compatibility rollback/u,
    );
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  } finally {
    native.close();
  }
}

async function smokeLibsql() {
  const loaded = await import("@libsql/client");
  const createClient = loaded.createClient ?? loaded.default?.createClient;
  if (typeof createClient !== "function") throw new Error("@libsql/client does not export createClient.");
  const { createLibsqlDatabase } = await import("@sqlbraid/sqlite/libsql");
  const client = createClient({ url: `file:${process.cwd()}/compatibility.db`, intMode: "string" });
  const db = createLibsqlDatabase(client, { intMode: "string" });
  await db.execute(sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`);
  await db.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`);
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
      throw new Error("compatibility rollback");
    }),
    /compatibility rollback/u,
  );
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [{ exact: "9223372036854775807", real_value: 1.5 }]);
  client.close?.();
}
