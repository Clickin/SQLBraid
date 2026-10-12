import assert from "node:assert/strict";

// The network drivers connect lazily. No database runs here, so these smokes prove that the installed driver
// objects pass the adapter checks, not that a query works.
const unreachable = "postgres://user:password@127.0.0.1:1/database";

const { sql } = await import("@sqlbraid/sqlite");
const rendered = sql`SELECT ${1} AS value`.render();
assert.deepEqual(rendered.segments, ["SELECT ", " AS value"]);
assert.equal(rendered.parameters[0].value, 1);
const facade = await import("sqlbraid");
assert.equal(typeof facade.createDatabase, "function");
const packageNames = JSON.parse(process.env.SQLBRAID_COMPAT_PACKAGES ?? "[]");
for (const packageName of packageNames) {
  // eslint-disable-next-line no-await-in-loop -- Import and assert each package in manifest order, stopping at the first incompatible root.
  const loaded = await import(packageName);
  assert.ok(loaded && typeof loaded === "object", `compatibility root did not import: ${packageName}`);
}
const helpers = await import("sqlbraid/compiled");
assert.equal(typeof helpers.capture, "function");
assert.equal(typeof helpers.assertDirectiveCondition, "function");

if (process.env.SQLBRAID_COMPAT_DRIVER === "better-sqlite3") await smokeBetterSqlite3();
if (process.env.SQLBRAID_COMPAT_DRIVER === "@libsql/client") await smokeLibsql();
if (process.env.SQLBRAID_COMPAT_DRIVER === "@electric-sql/pglite") await smokePglite();
if (process.env.SQLBRAID_COMPAT_DRIVER === "postgres") await smokePostgresJs();
if (process.env.SQLBRAID_COMPAT_DRIVER === "@neondatabase/serverless") await smokeNeon();

async function smokeBetterSqlite3() {
  const loaded = await import("better-sqlite3");
  const BetterSqlite3 = loaded.default ?? loaded;
  const { createBetterSqlite3Database } = await import("@sqlbraid/sqlite/better-sqlite3");
  const native = new BetterSqlite3(":memory:");
  const db = createBetterSqlite3Database(native);
  try {
    await db.execute(
      sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`,
    );
    await db.execute(
      sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`,
    );
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [
      { exact: "9223372036854775807", real_value: 1.5 },
    ]);
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
        throw new Error("compatibility rollback");
      }),
      /compatibility rollback/u,
    );
    assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [
      { exact: "9223372036854775807", real_value: 1.5 },
    ]);
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
  await db.execute(
    sql.command`CREATE TABLE values_table (id INTEGER PRIMARY KEY, exact INTEGER NOT NULL, real_value REAL NOT NULL)`,
  );
  await db.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"9223372036854775807"}, ${1.5})`);
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [
    { exact: "9223372036854775807", real_value: 1.5 },
  ]);
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO values_table (exact, real_value) VALUES (${"7"}, ${2.5})`);
      throw new Error("compatibility rollback");
    }),
    /compatibility rollback/u,
  );
  assert.deepEqual(await db.all(sql.rows`SELECT exact, real_value FROM values_table`), [
    { exact: "9223372036854775807", real_value: 1.5 },
  ]);
  client.close?.();
}

// PGlite runs in process, so this smoke executes real SQL.
async function smokePglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { sql: postgres } = await import("@sqlbraid/postgres");
  const { createPgliteDatabase } = await import("@sqlbraid/postgres/pglite");
  const pg = await PGlite.create();
  try {
    const db = createPgliteDatabase(pg);
    assert.equal((await db.environment()).driver.id, "pglite");
    await db.execute(postgres.command`CREATE TABLE values_table (id int PRIMARY KEY, exact int8 NOT NULL)`);
    await db.execute(postgres.command`INSERT INTO values_table VALUES (1, ${9223372036854775807n})`);
    assert.deepEqual(await db.all(postgres.rows`SELECT id, exact FROM values_table`), [
      { id: "1", exact: "9223372036854775807" },
    ]);
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(postgres.command`INSERT INTO values_table VALUES (2, 7)`);
        throw new Error("compatibility rollback");
      }),
      /compatibility rollback/u,
    );
    assert.deepEqual(await db.all(postgres.rows`SELECT id FROM values_table`), [{ id: "1" }]);
  } finally {
    await pg.close();
  }
}

async function smokePostgresJs() {
  const loaded = await import("postgres");
  const postgres = loaded.default ?? loaded;
  const { createPostgresJsProvider, postgresJsOptions } = await import("@sqlbraid/postgres/postgres-js");
  const client = postgres(unreachable, { max: 1, ...postgresJsOptions() });
  try {
    // The provider rejects a client whose parsers differ from the lossless text profile.
    const provider = createPostgresJsProvider(client);
    assert.equal(typeof provider.acquire, "function");
    assert.ok(provider.statementBinding);
    assert.throws(() => createPostgresJsProvider(postgres(unreachable, { max: 1 })), /fetch_types|postgresJsOptions/u);
  } finally {
    await client.end({ timeout: 0 });
  }
}

async function smokeNeon() {
  const { neon, Pool } = await import("@neondatabase/serverless");
  const { createNeonHttpExecutor } = await import("@sqlbraid/postgres/neon-http");
  const { createNeonPoolProvider } = await import("@sqlbraid/postgres/neon");
  assert.ok(createNeonHttpExecutor(neon(unreachable)).statementBinding);
  const pool = new Pool({ connectionString: unreachable });
  try {
    const provider = createNeonPoolProvider(pool);
    assert.equal(typeof provider.acquire, "function");
    assert.ok(provider.statementBinding);
  } finally {
    await pool.end();
  }
}
