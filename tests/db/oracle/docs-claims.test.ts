// Proves the runtime claims of the documentation on a real Oracle Free server with node-oracledb Thin.
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject } from "vitest";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import type { Database } from "@sqlbraid/core";
import { bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const GS = "getting-started/oracle.md";

async function withDb(
  fn: (db: Database) => Promise<void>,
  extra: Parameters<typeof createOracledbDatabase>[1] = {},
): Promise<void> {
  const connection = await oracledb.getConnection({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: inject("oracle").connectionUri,
  });
  try {
    await fn(createOracledbDatabase(connection, extra));
  } finally {
    await connection.close();
  }
}

docsClaim(
  GS,
  "NUMBER (including FLOAT) is a string; BINARY_DOUBLE a number; CLOB text; BLOB bytes; dates are Date",
  () =>
    withDb(async (db) => {
      const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT CAST(12345678901234567890.5 AS NUMBER) AS "n", CAST(1.5 AS BINARY_DOUBLE) AS "bd", CAST(2.5 AS FLOAT) AS "fl",
        TO_CLOB('hello') AS "c", TO_BLOB(HEXTORAW('0102')) AS "b", TIMESTAMP '2026-09-14 12:34:56.123456' AS "ts" FROM dual`);
      assert.equal(row.n, "12345678901234567890.5");
      assert.equal(row.bd, 1.5);
      assert.equal(row.fl, "2.5");
      assert.equal(row.c, "hello");
      assert.ok(Buffer.isBuffer(row.b));
      assert.ok(row.ts instanceof Date);
    }),
);

docsClaim(GS, "a NUMBER hint binds the example value", () =>
  withDb(async (db) => {
    const row = await db.one(
      sql.rows<{ x: string }>`SELECT ${sql.bind(1001, oracleParameter.number())} AS "x" FROM dual`,
    );
    assert.equal(row.x, "1001");
  }),
);

docsClaim(
  GS,
  "SYS_REFCURSOR OUT becomes a result set; OUT needs a hint; IN length facets and procedure metadata are rejected",
  () =>
    withDb(async (db) => {
      await db.execute(
        sql.command`CREATE OR REPLACE PROCEDURE docs_p_cur(c OUT SYS_REFCURSOR, msg OUT VARCHAR2) AS BEGIN OPEN c FOR SELECT 1 AS a FROM dual UNION ALL SELECT 2 FROM dual; msg := 'ok'; END;`,
      );
      const result = await db.call(
        sql.call`BEGIN docs_p_cur(${sql.out("c", oracleParameter.refCursor())}, ${sql.out("msg", oracleParameter.varchar2(20))}); END;`,
      );
      assert.equal(result.resultSets[0]?.rows.length, 2);
      assert.deepEqual(result.output, { msg: "ok" });
      assert.equal(
        await errorCode(() => db.call(sql.call`BEGIN docs_p_cur(${sql.out("c")}, ${sql.out("msg")}); END;`)),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
      assert.equal(
        await errorCode(() => db.all(sql.rows`SELECT ${sql.bind("x", oracleParameter.varchar2(10))} AS "x" FROM dual`)),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
      assert.equal(
        await errorCode(() => db.call(sql.call({ procedure: { name: "docs_p_cur", parameterNames: [] } })``)),
        "BRAID_CALL_UNSUPPORTED",
      );
    }),
);

docsClaim(GS, "RETURNING ... INTO with sql.out returns rows", () =>
  withDb(async (db) => {
    await db
      .execute(
        sql.command`CREATE GLOBAL TEMPORARY TABLE docs_users (id NUMBER, name VARCHAR2(100)) ON COMMIT PRESERVE ROWS`,
      )
      .catch(() => undefined);
    const rows = await db.all(
      sql.rows`INSERT INTO docs_users (id, name) VALUES (1, 'Grace') RETURNING name INTO ${sql.out("name", oracleParameter.varchar2(100))}`,
    );
    assert.deepEqual(rows, [{ name: "Grace" }]);
  }),
);

docsClaim("concepts/bulk.md", "Oracle bulk reports native-bulk", async () => {
  const bulk = bulkModeObserver();
  await withDb(
    async (db) => {
      await db
        .execute(sql.command`CREATE GLOBAL TEMPORARY TABLE docs_bulk (id NUMBER) ON COMMIT PRESERVE ROWS`)
        .catch(() => undefined);
      await db.bulk([1, 2], (id) => sql.command`INSERT INTO docs_bulk (id) VALUES (${id})`);
      assert.equal(bulk.mode(), "native-bulk");
    },
    { observers: [bulk.observer] },
  );
});

docsClaim("runtime/streaming.md", "the Oracle ResultSet stream supports an early break", () =>
  withDb(async (db) => {
    let count = 0;
    for await (const row of db.stream(sql.rows`SELECT LEVEL AS "n" FROM dual CONNECT BY LEVEL <= 5`)) {
      void row;
      count += 1;
      if (count === 1) break;
    }
    assert.equal(count, 1);
    assert.equal((await db.all(sql.rows`SELECT 1 AS "x" FROM dual`)).length, 1);
  }),
);
