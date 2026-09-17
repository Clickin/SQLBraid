import assert from "node:assert/strict";
import { createPool, type Pool } from "mysql2/promise";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createMysql2PoolDatabase, createMysql2PoolProvider } from "@sqlbraid/mysql/mysql2";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";
import { runStreamingConformance } from "../../streaming-conformance.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  await pool.end();
}

function rowSchema<Output>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15-mysql",
      validate,
    },
  };
}

test("MySQL mysql2 reuses streaming conformance with row schemas and lease counters", async () => {
  const pool = createPool({
    uri: inject("mysql").connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  let releases = 0;
  const provider = createMysql2PoolProvider(pool, { streamHighWaterMark: 2 });
  const countedProvider = {
    ...provider,
    async acquire() {
      const lease = await provider.acquire();
      return {
        ...lease,
        async release(options?: Parameters<typeof lease.release>[0]) {
          await lease.release(options);
          releases += 1;
        },
      };
    },
  };
  try {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_conformance");
    await pool.query(
      "CREATE TABLE braid_pv15_conformance (id INT PRIMARY KEY, label VARCHAR(255) NOT NULL) ENGINE=InnoDB",
    );
    await pool.query("INSERT INTO braid_pv15_conformance (id, label) VALUES (1, 'one'), (2, 'two')");
    const schema = rowSchema<{ readonly id: string; readonly label: string }>((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("label" in value) ||
        typeof value.id !== "string" ||
        typeof value.label !== "string"
      )
        return { issues: [{ message: "invalid MySQL conformance row" }] };
      return { value: { id: value.id, label: value.label } };
    });
    const mapping = rowSchema<never>(() => ({ issues: [{ message: "query-bound mapper failed" }] }));
    await runStreamingConformance(() => {
      const releaseStart = releases;
      const db = createPooledDatabase(countedProvider);
      return {
        db,
        query: sql.rows(schema)`SELECT id, label FROM braid_pv15_conformance ORDER BY id`,
        expected: [
          { id: "1", label: "one" },
          { id: "2", label: "two" },
        ],
        mappingQuery: sql.rows(mapping)`SELECT id, label FROM braid_pv15_conformance ORDER BY id`,
        released: () => releases - releaseStart,
      };
    });
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_conformance").catch(() => undefined);
    await endPool(pool);
  }
});

test("MySQL transaction streaming pins its backend and keeps binds value-only", async () => {
  const pool = createPool({
    uri: inject("mysql").connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  const db = createMysql2PoolDatabase(pool, { streamHighWaterMark: 2 });
  try {
    const secret = "x'); DROP TABLE braid_pv15_bind; --";
    await db.tx(async (tx) => {
      const before = await tx.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
      const rows: { readonly connectionId: string; readonly value: string }[] = [];
      for await (const row of tx.stream(
        sql.rows<{
          readonly connectionId: string;
          readonly value: string;
        }>`SELECT CONNECTION_ID() AS connectionId, ${secret} AS value`,
      )) {
        rows.push(row);
      }
      const after = await tx.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
      assert.equal(after.connectionId, before.connectionId);
      assert.deepEqual(rows, [{ connectionId: before.connectionId, value: secret }]);
    });
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
    await assert.rejects(
      async () => {
        for await (const _row of db.stream(sql.rows`SET @braid_pv15_stream_kind = 7`)) {
          assert.fail("a command header must not escape as a row");
        }
      },
      { name: "DatabaseResultKindError", code: "BRAID_RESULT_KIND", declaredKind: "rows", actualKind: "command" },
    );
    assert.deepEqual(
      await db.one(sql.rows<{ readonly value: string }>`SELECT @braid_pv15_stream_kind AS value`),
      { value: "7" },
      "result-kind mismatch is post-execution and the drained connection remains reusable",
    );
  } finally {
    await endPool(pool);
  }
});

test("MySQL prepared Execute.stream handles 100k rows and drains on break", async () => {
  const pool = createPool({
    uri: inject("mysql").connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  const db = createMysql2PoolDatabase(pool, { streamHighWaterMark: 8 });
  try {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_stream");
    await pool.query("CREATE TABLE braid_pv15_stream (id INT PRIMARY KEY) ENGINE=InnoDB");
    await pool.query(`
      INSERT INTO braid_pv15_stream (id)
      SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000 + e.n * 10000 + 1
      FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
      CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
      CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
      CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d
      CROSS JOIN (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e
    `);
    const query = sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv15_stream ORDER BY id`;
    let count = 0;
    for await (const row of db.stream(query)) {
      count += 1;
      assert.equal(typeof row.id, "string");
    }
    assert.equal(count, 100_000);
    for await (const row of db.stream(query)) {
      assert.equal(typeof row.id, "string");
      break;
    }
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_stream").catch(() => undefined);
    await endPool(pool);
  }
});

test("MySQL streaming rejects multiple result sets and drains before reusing the same connection", async () => {
  const pool = createPool({
    uri: inject("mysql").connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  const db = createMysql2PoolDatabase(pool, { streamHighWaterMark: 2 });
  try {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_stream_multi");
    await pool.query(`
      CREATE PROCEDURE braid_pv15_stream_multi()
      BEGIN
        SELECT 1 AS USER_ID, 'Ada' AS NAME;
        SELECT 10 AS PAYMENT_ID, 12.5 AS AMOUNT;
      END
    `);
    const before = await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
    await assert.rejects(async () => {
      for await (const row of db.stream(sql.rows<Record<string, unknown>>`CALL braid_pv15_stream_multi()`)) {
        assert.equal("PAYMENT_ID" in row, false, "second-result rows must never escape");
        assert.deepEqual(row, { USER_ID: "1", NAME: "Ada" });
      }
    }, /BRAID_RESULT_SETS_UNSUPPORTED/u);
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
    const after = await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
    assert.equal(after.connectionId, before.connectionId, "a safely drained connection is reused, not replaced");
  } finally {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_stream_multi").catch(() => undefined);
    await endPool(pool);
  }
});

test("MySQL materialized queries reject multiple sets, reuse the connection and keep CALL metadata independent", async () => {
  const pool = createPool({
    uri: inject("mysql").connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  const db = createMysql2PoolDatabase(pool);
  try {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_sets");
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_out");
    await pool.query(`
      CREATE PROCEDURE braid_pv15_sets(IN p INT)
      BEGIN
        SELECT CAST(p AS DECIMAL(6, 2)) AS value, 'shape-a' AS tag;
        SELECT p + 1 AS value, 'shape-b' AS tag;
      END
    `);
    await pool.query(`
      CREATE PROCEDURE braid_pv15_out(IN p INT, OUT answer INT, INOUT counter INT)
      BEGIN
        SET answer = p * 2;
        SET counter = counter + p;
      END
    `);
    const before = await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
    await assert.rejects(
      () => db.all(sql.rows<Record<string, unknown>>`CALL braid_pv15_sets(${7})`),
      /BRAID_RESULT_SETS_UNSUPPORTED/u,
    );
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
    assert.deepEqual(
      await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`),
      before,
      "materialized rejection reuses the same physical connection",
    );
    await assert.rejects(() => db.execute(sql`CALL braid_pv15_sets(${7})`), /BRAID_RESULT_SETS_UNSUPPORTED/u);
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
    assert.deepEqual(
      await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`),
      before,
      "unknown-result rejection reuses the same physical connection",
    );
    const sets = await db.call(sql.call`CALL braid_pv15_sets(${7})`);
    assert.deepEqual(sets.output, {});
    assert.equal(sets.returnValue, undefined);
    assert.deepEqual(sets.resultSets, [
      { rows: [{ value: "7.00", tag: "shape-a" }] },
      { rows: [{ value: "8", tag: "shape-b" }] },
    ]);
    await assert.rejects(
      () => db.call(sql.call`CALL braid_pv15_out(${7}, ${sql.out("answer")}, ${sql.inOut("counter", 3)})`),
      /BRAID_CALL_OUT_UNSUPPORTED/,
    );
  } finally {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_sets").catch(() => undefined);
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_out").catch(() => undefined);
    await endPool(pool);
  }
});
