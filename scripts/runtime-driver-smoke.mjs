import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { createConnection, createPool } from "mysql2/promise";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql as postgres } from "@sqlbraid/postgres";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { sql as mysql } from "@sqlbraid/mysql";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql as sqlite } from "@sqlbraid/sqlite";

function runtimeName() {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

function testName(prefix) {
  return `braid_runtime_smoke_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`.replaceAll("-", "_");
}

function schema(map) {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-runtime-smoke",
      async validate(value) {
        return { value: await map(value) };
      },
    },
  };
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function assertScopeRejection(operation) {
  await assert.rejects(operation, (error) => errorCode(error) === "BRAID_TX_SCOPE");
}

async function withTimeout(promise, message, milliseconds = 2_000) {
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => timeout.reject(new Error(message)), milliseconds);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function assertEventDurations(events) {
  for (const event of events) {
    if (!["query:result", "query:mapped", "query:error", "stream:end", "transaction"].includes(event.type)) continue;
    if ("durationMs" in event && event.durationMs !== undefined) {
      assert.equal(typeof event.durationMs, "number", `${event.type} durationMs must be numeric`);
    }
    assert.equal("duration" in event, false, `${event.type} must not expose duration`);
  }
}

function assertObserverContent(events, placeholder, boundValue) {
  const ready = events.find((event) => event.type === "query:ready" && event.values[0] === boundValue);
  assert.ok(ready, "observer must receive query SQL");
  assert.equal(ready.sql, `SELECT ${placeholder}`);
  assert.deepEqual(ready.values, [boundValue], "observer must receive query binds");
  assert.equal(ready.execution.transport, "text-positional", "observer must receive binding transport metadata");
  assert.equal(typeof ready.literalizedSql, "function", "observer must expose diagnostic SQL literalization");
  assert.equal(ready.declaredKind, "unknown");
  assert.ok(events.some((event) => event.type === "query:result" && event.actualKind === "rows"), "observer must receive row result");
  assert.ok(events.some((event) => event.type === "query:mapped" && event.queryMapped), "observer must receive mapper result");
  assert.ok(events.some((event) => event.type === "transaction" && event.phase === "begin" && event.status === "completed"), "observer must receive transaction begin");
  assert.ok(events.some((event) => event.type === "transaction" && event.phase === "commit" && event.status === "completed"), "observer must receive transaction commit");
  assertEventDurations(events);
}

async function streamingSmoke(db, tag) {
  const integerRow = schema((value) => ({ id: Number(value.id) }));
  const query = tag.rows(integerRow)`SELECT 1 AS id UNION ALL SELECT 2 AS id UNION ALL SELECT 3 AS id`;
  let sum = 0;
  for await (const row of db.stream(query, { schema: schema((value) => ({ id: value.id * 2 })) })) sum += row.id;
  assert.equal(sum, 12, "stream maps every row");
  for await (const row of db.stream(query)) {
    assert.equal(row.id, 1);
    break;
  }
  assert.deepEqual(await db.one(tag.rows(integerRow)`SELECT 4 AS id`), { id: 4 }, "break leaves a reusable connection");
  const failure = new Error("stream mapper failed");
  await assert.rejects(async () => {
    for await (const row of db.stream(query, { schema: schema(() => { throw failure; }) })) void row;
  }, (error) => error === failure || error.cause === failure);
  assert.deepEqual(await db.one(tag.rows(integerRow)`SELECT 5 AS id`), { id: 5 }, "mapping failure cleans up before reuse");
  await assert.rejects(async () => {
    for await (const row of db.stream(query)) {
      void row;
      throw failure;
    }
  }, (error) => error === failure);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    for await (const row of db.stream(query, { signal: controller.signal })) void row;
  }, (error) => error === controller.signal.reason);
  const activeController = new AbortController();
  const abortFailure = new Error("active stream aborted");
  await assert.rejects(async () => {
    for await (const row of db.stream(query, { signal: activeController.signal })) {
      void row;
      activeController.abort(abortFailure);
    }
  }, (error) => error === abortFailure || error.cause === abortFailure);
  assert.deepEqual(await db.one(tag.rows(integerRow)`SELECT 6 AS id`), { id: 6 }, "abort leaves a reusable pool");
  await db.tx(async (tx) => {
    let count = 0;
    for await (const row of tx.stream(query)) count += row.id;
    assert.equal(count, 6);
  });
}

export async function runPostgresSmoke(url) {
  if (typeof url !== "string" || url.length === 0) throw new TypeError("PostgreSQL smoke requires a connection URL.");

  const directTable = testName("pg_direct");
  const directIdentifier = postgres.ident(directTable);
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const db = createPgDatabase(client);

    const table = await db.execute(postgres.command`CREATE TEMP TABLE ${directIdentifier} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      amount NUMERIC(12, 3) NOT NULL,
      big_value BIGINT NOT NULL
    )`);
    assert.equal(table.kind, "command");

    const inserted = await db.execute(postgres.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
      VALUES (${1}, ${"Ada"}, ${"12.340"}, ${"9007199254740993"})`);
    assert.equal(inserted.kind, "command");
    assert.equal(inserted.command.affectedRows, 1);

    const normalized = await db.one(postgres.rows`SELECT id, name, amount, big_value FROM ${directIdentifier} WHERE id = ${1}`);
    assert.deepEqual(normalized, {
      id: 1,
      name: "Ada",
      amount: "12.340",
      big_value: 9007199254740993n,
    });

    const command = await db.execute(postgres.command`UPDATE ${directIdentifier} SET name = ${"Grace"} WHERE id = ${1}`);
    assert.equal(command.kind, "command");
    assert.equal(command.command.affectedRows, 1);
    assert.deepEqual((await db.one(postgres.rows`SELECT name FROM ${directIdentifier} WHERE id = ${1}`)), { name: "Grace" });

    await assert.rejects(
      () => db.execute(postgres.command`SELECT id FROM ${directIdentifier}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(postgres.rows`UPDATE ${directIdentifier} SET name = ${"Dora"} WHERE id = ${999}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const queryMapper = schema((value) => ({ id: value.id + 10 }));
    assert.deepEqual(
      await db.all(postgres.rows(queryMapper)`SELECT id FROM ${directIdentifier} WHERE id = ${1}`),
      [{ id: 11 }],
    );
    const executionMapper = schema((value) => ({ label: value.name.toUpperCase() }));
    assert.deepEqual(
      await db.all(postgres.rows`SELECT name FROM ${directIdentifier} WHERE id = ${1}`, { schema: executionMapper }),
      [{ label: "GRACE" }],
    );

    const returning = await db.execute(postgres.rows`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
      VALUES (${2}, ${"Bob"}, ${"1.250"}, ${"2"}) RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: 2 }]);

    await db.tx(async (tx) => {
      await tx.execute(postgres.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
        VALUES (${3}, ${"Committed"}, ${"2.000"}, ${"3"})`);
      await assert.rejects(
        tx.tx(async (nested) => {
          await nested.execute(postgres.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
            VALUES (${4}, ${"Nested"}, ${"3.000"}, ${"4"})`);
          await assertScopeRejection(tx.execute(postgres`SELECT ${1}`));
          throw new Error("nested PostgreSQL rollback");
        }),
        /nested PostgreSQL rollback/,
      );
      assert.deepEqual(
        (await tx.all(postgres.rows`SELECT id FROM ${directIdentifier} ORDER BY id`)).map(({ id }) => id),
        [1, 2, 3],
      );
    });
    await assertScopeRejection(db.tx(async () => db.execute(postgres`SELECT ${1}`)));
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(postgres.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
          VALUES (${5}, ${"Rolled back"}, ${"4.000"}, ${"5"})`);
        throw new Error("outer PostgreSQL rollback");
      }),
      /outer PostgreSQL rollback/,
    );
    assert.deepEqual(
      (await db.all(postgres.rows`SELECT id FROM ${directIdentifier} ORDER BY id`)).map(({ id }) => id),
      [1, 2, 3],
    );
  } finally {
    await client.end();
  }

  const poolTable = testName("pg_pool");
  const poolIdentifier = postgres.ident(poolTable);
  const pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 0 });
  const singlePool = new Pool({ connectionString: url, max: 1 });
  try {
    const events = [];
    const db = createPgPoolDatabase(pool, { observers: [{ onEvent(event) { events.push(event); } }] });
    await streamingSmoke(db, postgres);

    const concurrent = await Promise.all([
      db.one(postgres.rows`SELECT pg_backend_pid() AS pid, pg_sleep(0.15) AS pause`),
      db.one(postgres.rows`SELECT pg_backend_pid() AS pid, pg_sleep(0.15) AS pause`),
    ]);
    assert.equal(new Set(concurrent.map(({ pid }) => pid)).size, 2);

    await db.execute(postgres.command`CREATE TABLE ${poolIdentifier} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )`);
    await db.execute(postgres.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${1}, ${"initial"})`);

    const pinned = [];
    await db.tx(async (tx) => {
      pinned.push((await tx.one(postgres.rows`SELECT pg_backend_pid() AS pid`)).pid);
      await assert.rejects(
        tx.tx(async (nested) => {
          pinned.push((await nested.one(postgres.rows`SELECT pg_backend_pid() AS pid`)).pid);
          await nested.execute(postgres.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${2}, ${"nested"})`);
          await assertScopeRejection(tx.execute(postgres`SELECT ${1}`));
          throw new Error("nested pooled PostgreSQL rollback");
        }),
        /nested pooled PostgreSQL rollback/,
      );
      pinned.push((await tx.one(postgres.rows`SELECT pg_backend_pid() AS pid`)).pid);
      await tx.execute(postgres.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${3}, ${"committed"})`);
    });
    assert.equal(new Set(pinned).size, 1);
    assert.deepEqual(await db.all(postgres.rows`SELECT id, name FROM ${poolIdentifier} ORDER BY id`), [
      { id: 1, name: "initial" },
      { id: 3, name: "committed" },
    ]);

    await assertScopeRejection(db.tx(async () => db.execute(postgres`SELECT ${1}`)));
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(postgres.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${4}, ${"rolled"})`);
        throw new Error("outer pooled PostgreSQL rollback");
      }),
      /outer pooled PostgreSQL rollback/,
    );
    assert.deepEqual(
      await db.all(postgres.rows`SELECT id FROM ${poolIdentifier} ORDER BY id`),
      [{ id: 1 }, { id: 3 }],
    );

    const singleDb = createPgPoolDatabase(singlePool, { observers: [{ onEvent(event) { events.push(event); } }] });
    const mapper = schema(async (value) => {
      await singleDb.execute(postgres`SELECT ${2}`);
      return { value: value.value + 1 };
    });
    const mappedQuery = postgres.rows(mapper)`SELECT ${1}::integer AS value`;
    const operation = (async () => {
      assert.deepEqual((await singleDb.execute(mappedQuery)).rows, [{ value: 2 }]);
      const prepared = singleDb.prepare("runtime-smoke-postgres-mapped", () => mappedQuery);
      assert.deepEqual((await prepared.execute()).rows, [{ value: 2 }]);
      const [batched] = await singleDb.batch([mappedQuery]);
      assert.deepEqual(batched.rows, [{ value: 2 }]);
    })();
    operation.catch(() => undefined);
    await withTimeout(operation, "PostgreSQL max-one mapper re-entry timed out");

    await db.execute(postgres`SELECT ${"observer-secret"}`);
    await db.tx(async (tx) => { await tx.execute(postgres`SELECT ${1}`); });
    await assert.rejects(db.execute(postgres`SELECT * FROM ${postgres.ident(testName("pg_missing"))}`));
    assertObserverContent(events, "$1", "observer-secret");
    assert.ok(events.some((event) => event.type === "query:error" && event.stage === "driver" && event.executionStarted), "observer must receive driver errors");
    assert.equal(pool.idleCount, pool.totalCount);
    assert.ok(pool.totalCount > 0);
  } finally {
    try {
      await pool.query(`DROP TABLE IF EXISTS "${poolTable.replaceAll('"', '""')}"`);
    } finally {
      await Promise.all([pool.end(), singlePool.end()]);
    }
  }

  return {
    supported: true,
    runtime: runtimeName(),
    adapter: "postgres/pg",
    checks: ["direct-bind", "result-kind", "type-policy", "schema", "pool-concurrency", "transaction-pinning", "nested-savepoint", "rollback", "root-escape", "observer-events", "max-one-mapper-reentry"],
  };
}

export async function runMysqlSmoke(url) {
  if (typeof url !== "string" || url.length === 0) throw new TypeError("MySQL smoke requires a connection URL.");

  const directTable = testName("mysql_direct");
  const directIdentifier = mysql.ident(directTable);
  let client;
  try {
    client = await createConnection({ uri: url, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: true });
    const db = createMysql2Database(client);
    const table = await db.execute(mysql.command`CREATE TEMPORARY TABLE ${directIdentifier} (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      amount DECIMAL(12, 3) NOT NULL,
      big_value BIGINT NOT NULL
    )`);
    assert.equal(table.kind, "command");

    const inserted = await db.execute(mysql.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
      VALUES (${1}, ${"Ada"}, ${"12.340"}, ${"9007199254740993"})`);
    assert.equal(inserted.kind, "command");
    assert.equal(inserted.command.affectedRows, 1);

    const normalized = await db.one(mysql.rows`SELECT id, name, amount, big_value FROM ${directIdentifier} WHERE id = ${1}`);
    assert.deepEqual(normalized, {
      id: 1,
      name: "Ada",
      amount: "12.34",
      big_value: "9007199254740993",
    });

    const command = await db.execute(mysql.command`UPDATE ${directIdentifier} SET name = ${"Grace"} WHERE id = ${1}`);
    assert.equal(command.kind, "command");
    assert.equal(command.command.affectedRows, 1);
    assert.deepEqual((await db.one(mysql.rows`SELECT name FROM ${directIdentifier} WHERE id = ${1}`)), { name: "Grace" });

    await assert.rejects(
      () => db.execute(mysql.command`SELECT id FROM ${directIdentifier}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(mysql.rows`UPDATE ${directIdentifier} SET name = ${"Dora"} WHERE id = ${999}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const queryMapper = schema((value) => ({ id: value.id + 10 }));
    assert.deepEqual(
      await db.all(mysql.rows(queryMapper)`SELECT id FROM ${directIdentifier} WHERE id = ${1}`),
      [{ id: 11 }],
    );
    const executionMapper = schema((value) => ({ label: value.name.toUpperCase() }));
    assert.deepEqual(
      await db.all(mysql.rows`SELECT name FROM ${directIdentifier} WHERE id = ${1}`, { schema: executionMapper }),
      [{ label: "GRACE" }],
    );

    await db.tx(async (tx) => {
      await tx.execute(mysql.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
        VALUES (${2}, ${"Committed"}, ${"2.000"}, ${"3"})`);
      await assert.rejects(
        tx.tx(async (nested) => {
          await nested.execute(mysql.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
            VALUES (${3}, ${"Nested"}, ${"3.000"}, ${"4"})`);
          await assertScopeRejection(tx.execute(mysql`SELECT ${1}`));
          throw new Error("nested MySQL rollback");
        }),
        /nested MySQL rollback/,
      );
      assert.deepEqual(
        (await tx.all(mysql.rows`SELECT id FROM ${directIdentifier} ORDER BY id`)).map(({ id }) => id),
        [1, 2],
      );
    });
    await assertScopeRejection(db.tx(async () => db.execute(mysql`SELECT ${1}`)));
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(mysql.command`INSERT INTO ${directIdentifier} (id, name, amount, big_value)
          VALUES (${4}, ${"Rolled back"}, ${"4.000"}, ${"5"})`);
        throw new Error("outer MySQL rollback");
      }),
      /outer MySQL rollback/,
    );
    assert.deepEqual(
      (await db.all(mysql.rows`SELECT id FROM ${directIdentifier} ORDER BY id`)).map(({ id }) => id),
      [1, 2],
    );
  } finally {
    if (client) await client.end();
  }

  const poolTable = testName("mysql_pool");
  const poolIdentifier = mysql.ident(poolTable);
  const pool = createPool({ uri: url, connectionLimit: 2, idleTimeout: 0, supportBigNumbers: true, bigNumberStrings: true });
  const singlePool = createPool({ uri: url, connectionLimit: 1 });
  try {
    const events = [];
    const db = createMysql2PoolDatabase(pool, { observers: [{ onEvent(event) { events.push(event); } }] });
    await streamingSmoke(db, mysql);

    const concurrent = await Promise.all([
      db.one(mysql.rows`SELECT CONNECTION_ID() AS connectionId, SLEEP(0.15) AS pause`),
      db.one(mysql.rows`SELECT CONNECTION_ID() AS connectionId, SLEEP(0.15) AS pause`),
    ]);
    assert.equal(new Set(concurrent.map(({ connectionId }) => String(connectionId))).size, 2);

    await db.execute(mysql.command`CREATE TABLE ${poolIdentifier} (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB`);
    await db.execute(mysql.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${1}, ${"initial"})`);

    const pinned = [];
    await db.tx(async (tx) => {
      pinned.push(String((await tx.one(mysql.rows`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
      await assert.rejects(
        tx.tx(async (nested) => {
          pinned.push(String((await nested.one(mysql.rows`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
          await nested.execute(mysql.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${2}, ${"nested"})`);
          await assertScopeRejection(tx.execute(mysql`SELECT ${1}`));
          throw new Error("nested pooled MySQL rollback");
        }),
        /nested pooled MySQL rollback/,
      );
      pinned.push(String((await tx.one(mysql.rows`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
      await tx.execute(mysql.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${3}, ${"committed"})`);
    });
    assert.equal(new Set(pinned).size, 1);
    assert.deepEqual(await db.all(mysql.rows`SELECT id, name FROM ${poolIdentifier} ORDER BY id`), [
      { id: 1, name: "initial" },
      { id: 3, name: "committed" },
    ]);

    await assertScopeRejection(db.tx(async () => db.execute(mysql`SELECT ${1}`)));
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(mysql.command`INSERT INTO ${poolIdentifier} (id, name) VALUES (${4}, ${"rolled"})`);
        throw new Error("outer pooled MySQL rollback");
      }),
      /outer pooled MySQL rollback/,
    );
    assert.deepEqual(
      await db.all(mysql.rows`SELECT id FROM ${poolIdentifier} ORDER BY id`),
      [{ id: 1 }, { id: 3 }],
    );

    const singleDb = createMysql2PoolDatabase(singlePool, { observers: [{ onEvent(event) { events.push(event); } }] });
    const mapper = schema(async (value) => {
      await singleDb.execute(mysql`SELECT ${2}`);
      return { value: value.value + 1 };
    });
    const mappedQuery = mysql.rows(mapper)`SELECT ${1} AS value`;
    const operation = (async () => {
      assert.deepEqual((await singleDb.execute(mappedQuery)).rows, [{ value: 2 }]);
      const prepared = singleDb.prepare("runtime-smoke-mysql-mapped", () => mappedQuery);
      assert.deepEqual((await prepared.execute()).rows, [{ value: 2 }]);
      const [batched] = await singleDb.batch([mappedQuery]);
      assert.deepEqual(batched.rows, [{ value: 2 }]);
    })();
    operation.catch(() => undefined);
    await withTimeout(operation, "MySQL max-one mapper re-entry timed out");

    await db.execute(mysql`SELECT ${"observer-secret"}`);
    await db.tx(async (tx) => { await tx.execute(mysql`SELECT ${1}`); });
    await assert.rejects(db.execute(mysql`SELECT * FROM ${mysql.ident(testName("mysql_missing"))}`));
    assertObserverContent(events, "?", "observer-secret");
    assert.ok(events.some((event) => event.type === "query:error" && event.stage === "driver" && event.executionStarted), "observer must receive driver errors");
  } finally {
    try {
      await pool.query(`DROP TABLE IF EXISTS \`${poolTable.replaceAll("`", "``")}\``);
    } finally {
      await Promise.all([pool.end(), singlePool.end()]);
    }
  }

  return {
    supported: true,
    runtime: runtimeName(),
    adapter: "mysql/mysql2",
    checks: ["direct-bind", "result-kind", "type-policy", "schema", "pool-concurrency", "transaction-pinning", "nested-savepoint", "rollback", "root-escape", "observer-events", "max-one-mapper-reentry"],
  };
}

export async function runSqliteSmoke() {
  let module;
  try {
    module = await import("node:sqlite");
  } catch (error) {
    if (error?.code !== "ERR_UNKNOWN_BUILTIN_MODULE" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return {
      supported: false,
      runtime: runtimeName(),
      adapter: "sqlite/node:sqlite",
      reason: `node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof module.DatabaseSync !== "function") {
    return {
      supported: false,
      runtime: runtimeName(),
      adapter: "sqlite/node:sqlite",
      reason: "node:sqlite does not expose DatabaseSync.",
    };
  }

  const probe = new module.DatabaseSync(":memory:");
  try {
    if (typeof probe.prepare !== "function") {
      return {
        supported: false,
        runtime: runtimeName(),
        adapter: "sqlite/node:sqlite",
        reason: "node:sqlite DatabaseSync does not expose prepare().",
      };
    }
    const statement = probe.prepare("SELECT 1 AS value");
    if (typeof statement.columns !== "function") {
      return {
        supported: false,
        runtime: runtimeName(),
        adapter: "sqlite/node:sqlite",
        reason: "node:sqlite statements do not expose columns(), required by SQLBraid.",
      };
    }
    const columns = statement.columns();
    assert.ok(Array.isArray(columns), "node:sqlite columns() must return an array");
  } finally {
    probe.close();
  }

  const tableName = testName("sqlite");
  const tableIdentifier = sqlite.ident(tableName);
  const native = new module.DatabaseSync(":memory:");
  const events = [];
  try {
    const db = createNodeSqliteDatabase(native, { observers: [{ onEvent(event) { events.push(event); } }] });
    const table = await db.execute(sqlite.command`CREATE TABLE ${tableIdentifier} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      amount REAL NOT NULL
    )`);
    assert.equal(table.kind, "command");

    const inserted = await db.execute(sqlite.command`INSERT INTO ${tableIdentifier} (id, name, amount)
      VALUES (${1}, ${"Ada"}, ${12.34})`);
    assert.equal(inserted.kind, "command");
    assert.equal(inserted.command.affectedRows, 1);

    assert.deepEqual(
      await db.one(sqlite.rows`SELECT id, name, amount FROM ${tableIdentifier} WHERE id = ${1}`),
      { id: 1, name: "Ada", amount: 12.34 },
    );
    assert.deepEqual(
      await db.one(sqlite.rows`SELECT CAST(${1.5} AS REAL) AS amount`),
      { amount: 1.5 },
      "SQLite result normalization must preserve native numeric values",
    );

    const command = await db.execute(sqlite.command`UPDATE ${tableIdentifier} SET name = ${"Grace"} WHERE id = ${1}`);
    assert.equal(command.kind, "command");
    assert.equal(command.command.affectedRows, 1);
    await assert.rejects(
      () => db.execute(sqlite.command`SELECT id FROM ${tableIdentifier}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sqlite.rows`UPDATE ${tableIdentifier} SET name = ${"Dora"} WHERE id = ${999}`),
      (error) => errorCode(error) === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const queryMapper = schema((value) => ({ id: value.id + 10 }));
    assert.deepEqual(
      await db.all(sqlite.rows(queryMapper)`SELECT id FROM ${tableIdentifier} WHERE id = ${1}`),
      [{ id: 11 }],
    );
    const executionMapper = schema((value) => ({ label: value.name.toUpperCase() }));
    assert.deepEqual(
      await db.all(sqlite.rows`SELECT name FROM ${tableIdentifier} WHERE id = ${1}`, { schema: executionMapper }),
      [{ label: "GRACE" }],
    );

    const returning = await db.execute(sqlite.rows`INSERT INTO ${tableIdentifier} (id, name, amount)
      VALUES (${2}, ${"Bob"}, ${3.45}) RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: 2 }]);

    await db.tx(async (tx) => {
      await tx.execute(sqlite.command`INSERT INTO ${tableIdentifier} (id, name, amount) VALUES (${3}, ${"Committed"}, ${4.56})`);
      await assert.rejects(
        tx.tx(async (nested) => {
          await nested.execute(sqlite.command`INSERT INTO ${tableIdentifier} (id, name, amount) VALUES (${4}, ${"Nested"}, ${5.67})`);
          await assertScopeRejection(tx.execute(sqlite`SELECT ${1}`));
          throw new Error("nested SQLite rollback");
        }),
        /nested SQLite rollback/,
      );
      assert.deepEqual(
        (await tx.all(sqlite.rows`SELECT id FROM ${tableIdentifier} ORDER BY id`)).map(({ id }) => id),
        [1, 2, 3],
      );
    });
    await assertScopeRejection(db.tx(async () => db.execute(sqlite`SELECT ${1}`)));
    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(sqlite.command`INSERT INTO ${tableIdentifier} (id, name, amount) VALUES (${5}, ${"Rolled"}, ${6.78})`);
        throw new Error("outer SQLite rollback");
      }),
      /outer SQLite rollback/,
    );
    assert.deepEqual(
      (await db.all(sqlite.rows`SELECT id FROM ${tableIdentifier} ORDER BY id`)).map(({ id }) => id),
      [1, 2, 3],
    );

    const streamed = [];
    for await (const row of db.stream(sqlite.rows`SELECT id FROM ${tableIdentifier} ORDER BY id`)) streamed.push(row.id);
    assert.deepEqual(streamed, [1, 2, 3]);
    for await (const row of db.stream(sqlite.rows`SELECT id FROM ${tableIdentifier} ORDER BY id`)) {
      assert.equal(row.id, 1);
      break;
    }
    assert.deepEqual(await db.one(sqlite.rows`SELECT COUNT(*) AS count FROM ${tableIdentifier}`), { count: 3 });

    await db.execute(sqlite`SELECT ${"observer-secret"}`);
    await db.tx(async (tx) => { await tx.execute(sqlite`SELECT ${1}`); });
    await assert.rejects(db.execute(sqlite`SELECT * FROM ${sqlite.ident(testName("sqlite_missing"))}`));
    assertObserverContent(events, "?", "observer-secret");
    assert.ok(events.some((event) => event.type === "query:error" && event.stage === "driver" && event.executionStarted), "observer must receive driver errors");
  } finally {
    native.close();
  }

  return {
    supported: true,
    runtime: runtimeName(),
    adapter: "sqlite/node:sqlite",
    checks: ["direct-bind", "rows", "commands", "result-kind", "normalization", "schema", "returning", "transaction-rollback", "root-escape", "observer-events"],
  };
}
