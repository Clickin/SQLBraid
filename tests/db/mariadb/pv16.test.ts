import assert from "node:assert/strict";
import mariadb, { type Pool } from "mariadb";
import { inject, test } from "vitest";
import { createMariaDbDatabase, createMariaDbPoolDatabase } from "@sqlbraid/mariadb/mariadb";
import { MARIADB_LOSSLESS_TEXT, sql } from "@sqlbraid/mariadb";
import { runStreamingConformance } from "../../streaming-conformance.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  await pool.end();
}

function createTestPool(): Pool {
  const uri = new URL(inject("mariadb").connectionUri);
  return mariadb.createPool({
    ...MARIADB_LOSSLESS_TEXT.connectionOptions,
    host: uri.hostname,
    port: Number(uri.port || 3306),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    connectionLimit: 1,
    idleTimeout: 0,
    decimalAsNumber: false,
    insertIdAsNumber: false,
    autoJsonMap: false,
    dateStrings: true,
    timezone: "Z",
  });
}

function createTestConnection() {
  const uri = new URL(inject("mariadb").connectionUri);
  return mariadb.createConnection({
    ...MARIADB_LOSSLESS_TEXT.connectionOptions,
    host: uri.hostname,
    port: Number(uri.port || 3306),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    decimalAsNumber: false,
    insertIdAsNumber: false,
    autoJsonMap: false,
    dateStrings: true,
    timezone: "Z",
  });
}

test("MariaDB Connector returning DML preserves rows and command metadata", async () => {
  const connection = await createTestConnection();
  const db = createMariaDbDatabase(connection);
  try {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_mariadb_returning");
    await connection.query(`
      CREATE TABLE braid_pv16_mariadb_returning (
        id INT NOT NULL PRIMARY KEY,
        label VARCHAR(255) NOT NULL
      )
    `);
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_mariadb_ids (id BIGINT AUTO_INCREMENT PRIMARY KEY)");
    const inserted = await db.execute(sql.command`INSERT INTO braid_pv17_mariadb_ids VALUES (NULL)`);
    assert.equal(inserted.command.insertId, "1");
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string; readonly label: string }>`
        INSERT INTO braid_pv16_mariadb_returning (id, label)
        VALUES (1, ${"inserted"})
        RETURNING id, label
      `),
      [{ id: "1", label: "inserted" }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string }>`
        DELETE FROM braid_pv16_mariadb_returning
        WHERE id = 1
        RETURNING id
      `),
      [{ id: "1" }],
    );
    await connection.query("INSERT INTO braid_pv16_mariadb_returning (id, label) VALUES (2, 'old')");
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string; readonly label: string }>`
        REPLACE INTO braid_pv16_mariadb_returning (id, label)
        VALUES (2, ${"replaced"})
        RETURNING id, label
      `),
      [{ id: "2", label: "replaced" }],
    );
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string; readonly label: string }>`
        INSERT INTO braid_pv16_mariadb_returning (id, label)
        VALUES (2, ${"upserted"})
        ON DUPLICATE KEY UPDATE label = VALUES(label)
        RETURNING id, label
      `),
      [{ id: "2", label: "upserted" }],
    );
    const command = await db.execute(sql.command`DELETE FROM braid_pv16_mariadb_returning`);
    assert.equal(command.kind, "command");
    assert.equal(command.command.affectedRows, 1);
    assert.deepEqual(command.rows, []);
  } finally {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_mariadb_returning").catch(() => undefined);
    await connection.end();
  }
});

test("MariaDB Connector pool supports native bulk and transaction savepoints", async () => {
  const pool = createTestPool();
  const db = createMariaDbPoolDatabase(pool);
  try {
    await pool.query("DROP TABLE IF EXISTS braid_pv16_mariadb_bulk");
    await pool.query("CREATE TABLE braid_pv16_mariadb_bulk (id BIGINT PRIMARY KEY, label VARCHAR(255) NOT NULL)");
    const values = [{ id: "9007199254740993", label: "one" }, { id: "9007199254740994", label: "two" }, { id: "9007199254740995", label: "three" }] as const;
    assert.deepEqual(
      await db.bulk(values, (value) => sql.command`
        INSERT INTO braid_pv16_mariadb_bulk (id, label)
        VALUES (${value.id}, ${value.label})
      `),
      { inputCount: 3, affectedRows: 3 },
    );
    await db.tx(async (tx) => {
      await tx.execute(sql`INSERT INTO braid_pv16_mariadb_bulk (id, label) VALUES (4, 'outer')`);
      await assert.rejects(
        tx.tx(async (nested) => {
          await nested.execute(sql`INSERT INTO braid_pv16_mariadb_bulk (id, label) VALUES (5, 'nested')`);
          throw new Error("rollback savepoint");
        }),
        /rollback savepoint/u,
      );
    });
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv16_mariadb_bulk ORDER BY id`),
      [{ id: "4" }, { id: "9007199254740993" }, { id: "9007199254740994" }, { id: "9007199254740995" }],
    );
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv16_mariadb_bulk").catch(() => undefined);
    await endPool(pool);
  }
});

test("MariaDB Connector queryStream satisfies shared stream lifecycle", async () => {
  await runStreamingConformance(async () => {
    const pool = createTestPool();
    await pool.query("DROP TABLE IF EXISTS braid_pv16_mariadb_stream");
    await pool.query("CREATE TABLE braid_pv16_mariadb_stream (id INT PRIMARY KEY, label VARCHAR(255) NOT NULL)");
    await pool.query("INSERT INTO braid_pv16_mariadb_stream VALUES (1, 'one'), (2, 'two')");
    const db = createMariaDbPoolDatabase(pool);
    return {
      db,
      query: sql.rows<{ readonly id: string; readonly label: string }>`
        SELECT id, label FROM braid_pv16_mariadb_stream ORDER BY id
      `,
      expected: [{ id: "1", label: "one" }, { id: "2", label: "two" }],
      close: async () => {
        await pool.query("DROP TABLE IF EXISTS braid_pv16_mariadb_stream").catch(() => undefined);
        await endPool(pool);
      },
    };
  });
});
