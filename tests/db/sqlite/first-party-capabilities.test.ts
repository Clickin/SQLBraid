import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client/node";
import { test } from "vitest";
import {
  createBetterSqlite3Database,
  type BetterSqlite3DatabaseLike,
} from "../../../packages/sqlite/src/better-sqlite3.js";
import { createLibsqlDatabase } from "../../../packages/sqlite/src/libsql.js";
import { sql } from "@sqlbraid/sqlite";

const BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3") as new (
  filename: string,
) => BetterSqlite3DatabaseLike & { close(): void };

test("better-sqlite3.sql.native-transparency", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const db = createBetterSqlite3Database(native);
    const row = await db.one(sql.rows<{ readonly marker: string; readonly value: string }>`
      SELECT 'literal ? :1 $1' AS marker, ${"exact"} AS value
    `);
    assert.deepEqual(row, { marker: "literal ? :1 $1", value: "exact" });
  } finally {
    native.close();
  }
});

test("better-sqlite3.numeric.exact-integer", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const db = createBetterSqlite3Database(native);
    const row = await db.one(sql.rows<{ readonly value: string }>`
      SELECT ${9223372036854775807n} AS value
    `);
    assert.equal(row.value, "9223372036854775807");
  } finally {
    native.close();
  }
});

test("better-sqlite3.data.binary", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const readyValues: unknown[] = [];
    const db = createBetterSqlite3Database(native, {
      observers: [{
        onEvent(event) {
          if (event.type === "query:ready") readyValues.push(event.values[0]);
        },
      }],
    });
    const source = Uint8Array.from([9, 0, 255, 16, 8]);
    const payload = source.subarray(1, 4);
    await db.execute(sql.command`CREATE TABLE blobs (payload BLOB NOT NULL)`);
    await db.execute(sql.command`INSERT INTO blobs (payload) VALUES (${payload})`);
    assert.equal(readyValues.at(-1), payload);
    const row = await db.one(sql.rows<{ readonly payload: Uint8Array }>`
      SELECT payload FROM blobs
    `);
    assert.ok(row.payload instanceof Uint8Array);
    assert.deepEqual([...row.payload], [0, 255, 16]);
    await db.bulk([Uint8Array.of(1), new Uint8Array()], (value) => sql.command`INSERT INTO blobs (payload) VALUES (${value})`);
    const streamed: number[][] = [];
    for await (const streamedRow of db.stream(sql.rows<{ readonly payload: Uint8Array }>`SELECT payload FROM blobs ORDER BY rowid`)) {
      streamed.push([...streamedRow.payload]);
    }
    assert.deepEqual(streamed, [[0, 255, 16], [1], []]);
  } finally {
    native.close();
  }
});

test("better-sqlite3.execution.transaction", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const db = createBetterSqlite3Database(native);
    await db.execute(sql.command`CREATE TABLE items (value TEXT NOT NULL)`);
    await db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO items (value) VALUES (${"outer"})`);
      await tx.tx(async (nested) => {
        await nested.execute(sql.command`INSERT INTO items (value) VALUES (${"nested"})`);
      });
    });
    assert.deepEqual(
      await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM items ORDER BY rowid`),
      [{ value: "outer" }, { value: "nested" }],
    );
  } finally {
    native.close();
  }
});

test("better-sqlite3.execution.bulk-stream", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const db = createBetterSqlite3Database(native);
    await db.execute(sql.command`CREATE TABLE items (value INTEGER NOT NULL)`);
    assert.deepEqual(
      await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO items (value) VALUES (${value})`),
      { inputCount: 3, affectedRows: 3 },
    );
    const values: string[] = [];
    for await (const row of db.stream(sql.rows<{ readonly value: string }>`SELECT value FROM items ORDER BY value`)) {
      values.push(row.value);
      if (values.length === 2) break;
    }
    assert.deepEqual(values, ["1", "2"]);
    assert.equal((await db.one(sql.rows<{ readonly count: string }>`SELECT count(*) AS count FROM items`)).count, "3");
  } finally {
    native.close();
  }
});

test("libsql.sql.native-transparency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-libsql-"));
  const client = createClient({ url: `file:${join(directory, "database.db")}`, intMode: "string" });
  try {
    const db = createLibsqlDatabase(client, { intMode: "string" });
    const row = await db.one(sql.rows<{ readonly marker: string; readonly value: string }>`
      SELECT 'literal ? :1 $1' AS marker, ${"exact"} AS value
    `);
    assert.deepEqual(row, { marker: "literal ? :1 $1", value: "exact" });
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("libsql.numeric.exact-integer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-libsql-"));
  const client = createClient({ url: `file:${join(directory, "database.db")}`, intMode: "string" });
  try {
    const db = createLibsqlDatabase(client, { intMode: "string" });
    const row = await db.one(sql.rows<{ readonly value: string }>`
      SELECT ${9223372036854775807n} AS value
    `);
    assert.equal(row.value, "9223372036854775807");
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("libsql.data.binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-libsql-"));
  const client = createClient({ url: `file:${join(directory, "database.db")}`, intMode: "string" });
  try {
    const db = createLibsqlDatabase(client, { intMode: "string" });
    const source = Uint8Array.from([9, 0, 255, 16, 8]);
    const payload = source.subarray(1, 4);
    await db.execute(sql.command`CREATE TABLE blobs (payload BLOB NOT NULL)`);
    await db.execute(sql.command`INSERT INTO blobs (payload) VALUES (${payload})`);
    const row = await db.one(sql.rows<{ readonly payload: Uint8Array }>`
      SELECT payload FROM blobs
    `);
    assert.ok(row.payload instanceof Uint8Array);
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("libsql.execution.transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-libsql-"));
  const client = createClient({ url: `file:${join(directory, "database.db")}`, intMode: "string" });
  try {
    const db = createLibsqlDatabase(client, { intMode: "string" });
    await db.execute(sql.command`CREATE TABLE items (value TEXT NOT NULL)`);
    await db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO items (value) VALUES (${"outer"})`);
      await tx.tx(async (nested) => {
        await nested.execute(sql.command`INSERT INTO items (value) VALUES (${"nested"})`);
      });
    });
    assert.deepEqual(
      await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM items ORDER BY rowid`),
      [{ value: "outer" }, { value: "nested" }],
    );
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("libsql.execution.bulk-read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-libsql-"));
  const client = createClient({ url: `file:${join(directory, "database.db")}`, intMode: "string" });
  try {
    const db = createLibsqlDatabase(client, { intMode: "string" });
    await db.execute(sql.command`CREATE TABLE items (value INTEGER NOT NULL)`);
    assert.deepEqual(
      await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO items (value) VALUES (${value})`),
      { inputCount: 3, affectedRows: 3 },
    );
    await db.tx({ readOnly: false }, async (tx) => {
      await tx.execute(sql.command`INSERT INTO items (value) VALUES (${4})`);
    });
    assert.equal((await db.environment()).capabilities["transaction.read-only"]?.status, "guarded");
    await assert.rejects(
      () => db.tx({ readOnly: true }, async () => undefined),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
