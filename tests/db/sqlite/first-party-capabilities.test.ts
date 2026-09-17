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
import { transactionIntegrationTests } from "../../contracts/transaction.integration.js";
import { commandMetadataContract, commandMetadataTitle } from "../command-metadata.js";

const BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3") as new (
  filename: string,
) => BetterSqlite3DatabaseLike & { close(): void };

for (const transport of ["better-sqlite3", "libsql"] as const) {
  for (const contract of transactionIntegrationTests(
    transport,
    "direct",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), `sqlbraid-contract-${transport}-`));
      const filename = join(directory, "database.db");
      const native = transport === "better-sqlite3" ? new BetterSqlite3(filename) : undefined;
      const client = transport === "libsql" ? createClient({ url: `file:${filename}`, intMode: "string" }) : undefined;
      const db = native ? createBetterSqlite3Database(native) : createLibsqlDatabase(client!, { intMode: "string" });
      // A second native handle shares the file, never the writer's transaction-local state.
      const observer = new BetterSqlite3(filename);
      const observerDb = createBetterSqlite3Database(observer);
      await db.execute(sql.command`CREATE TABLE braid_contract_tx (id TEXT PRIMARY KEY)`);
      return {
        db,
        caughtStatementOutcome: "commit",
        streamQuery: sql.rows<{ id: string }>`SELECT id FROM braid_contract_tx ORDER BY id`,
        write: (tx, id) => tx.execute(sql.command`INSERT INTO braid_contract_tx (id) VALUES (${id})`),
        committedRows: async () =>
          (await observerDb.all(sql.rows<{ id: string }>`SELECT id FROM braid_contract_tx ORDER BY id`)).map(
            (row) => row.id,
          ),
        close: async () => {
          observer.close();
          native?.close();
          client?.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
    { stream: transport === "better-sqlite3" },
  ))
    test(contract.title, contract.run);
}

test(commandMetadataTitle("better-sqlite3"), async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-metadata-better-sqlite3-"));
  const filename = join(directory, "database.db");
  const native = new BetterSqlite3(filename);
  const db = createBetterSqlite3Database(native);
  const observer = new BetterSqlite3(filename);
  try {
    await db.execute(sql.command`CREATE TABLE braid_contract_metadata (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    const observerDb = createBetterSqlite3Database(observer);
    await commandMetadataContract(db, sql, () =>
      observerDb.all(sql.rows<{ id: string; name: string }>`SELECT id, name FROM braid_contract_metadata ORDER BY id`),
    );
  } finally {
    observer.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("[contract:libsql:metadata.affected-rows:integration] local commands omit unreliable IDs while explicit RETURNING stays exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-metadata-libsql-"));
  const filename = join(directory, "database.db");
  const client = createClient({ url: `file:${filename}`, intMode: "string" });
  const db = createLibsqlDatabase(client, { intMode: "string" });
  const observer = new BetterSqlite3(filename);
  try {
    await db.execute(sql.command`CREATE TABLE braid_contract_metadata (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    const observerDb = createBetterSqlite3Database(observer);
    const committedRows = () =>
      observerDb.all(sql.rows<{ id: string; name: string }>`SELECT id, name FROM braid_contract_metadata ORDER BY id`);
    const id = "9007199254740993";
    const maximum = "9223372036854775807";
    const insert = (value: string) =>
      sql.command`INSERT INTO braid_contract_metadata (id, name) VALUES (${value}, ${"before"})`;
    const inserted = await db.execute(insert(id));
    assert.deepEqual(inserted.command, { affectedRows: 1 });
    assert.deepEqual(await committedRows(), [{ id, name: "before" }]);

    const updated = await db.execute(
      sql.command`UPDATE braid_contract_metadata SET name = ${"after"} WHERE id = ${id}`,
    );
    assert.deepEqual(updated.command, { affectedRows: 1 });
    assert.deepEqual(await committedRows(), [{ id, name: "after" }]);
    const deleted = await db.execute(sql.command`DELETE FROM braid_contract_metadata WHERE id = ${id}`);
    assert.deepEqual(deleted.command, { affectedRows: 1 });
    assert.deepEqual(await committedRows(), []);

    const small = await db.execute(insert("7"));
    assert.deepEqual(small.command, { affectedRows: 1 });
    assert.deepEqual(await committedRows(), [{ id: "7", name: "before" }]);
    assert.deepEqual(await db.bulk([id, maximum], insert), { inputCount: 2, affectedRows: 2 });
    assert.deepEqual(await committedRows(), [
      { id: "7", name: "before" },
      { id, name: "before" },
      { id: maximum, name: "before" },
    ]);
    assert.deepEqual(
      await db.bulk(
        ["7", id],
        (value) => sql.command`UPDATE braid_contract_metadata SET name = ${"bulk"} WHERE id = ${value}`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );
    assert.deepEqual(await committedRows(), [
      { id: "7", name: "bulk" },
      { id, name: "bulk" },
      { id: maximum, name: "before" },
    ]);

    const returnedId = "9007199254740995";
    const returned = await db.one(
      sql.rows<{
        id: string;
      }>`INSERT INTO braid_contract_metadata (id, name) VALUES (${returnedId}, ${"returning"}) RETURNING id`,
    );
    assert.deepEqual(returned, { id: returnedId });
    assert.deepEqual(await committedRows(), [
      { id: "7", name: "bulk" },
      { id, name: "bulk" },
      { id: returnedId, name: "returning" },
      { id: maximum, name: "before" },
    ]);
  } finally {
    observer.close();
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
      observers: [
        {
          onEvent(event) {
            if (event.type === "query:ready") readyValues.push(event.values[0]);
          },
        },
      ],
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
    await db.bulk(
      [Uint8Array.of(1), new Uint8Array()],
      (value) => sql.command`INSERT INTO blobs (payload) VALUES (${value})`,
    );
    const streamed: number[][] = [];
    for await (const streamedRow of db.stream(
      sql.rows<{ readonly payload: Uint8Array }>`SELECT payload FROM blobs ORDER BY rowid`,
    )) {
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
    assert.deepEqual(await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM items ORDER BY rowid`), [
      { value: "outer" },
      { value: "nested" },
    ]);
  } finally {
    native.close();
  }
});

test("better-sqlite3.execution.bulk-stream", async () => {
  const native = new BetterSqlite3(":memory:");
  try {
    const db = createBetterSqlite3Database(native);
    await db.execute(sql.command`CREATE TABLE items (value INTEGER NOT NULL)`);
    assert.deepEqual(await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO items (value) VALUES (${value})`), {
      inputCount: 3,
      affectedRows: 3,
    });
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
    assert.deepEqual(await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM items ORDER BY rowid`), [
      { value: "outer" },
      { value: "nested" },
    ]);
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
    assert.deepEqual(await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO items (value) VALUES (${value})`), {
      inputCount: 3,
      affectedRows: 3,
    });
    await db.tx({ readOnly: false }, async (tx) => {
      await tx.execute(sql.command`INSERT INTO items (value) VALUES (${4})`);
    });
    assert.equal((await db.environment()).capabilities["transaction.read-only"]?.status, "unsupported");
    await assert.rejects(
      () => db.tx({ readOnly: true }, async () => undefined),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
