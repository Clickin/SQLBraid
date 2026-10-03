// Proves the runtime claims of the documentation on a real SQL Server with Tedious.
import assert from "node:assert/strict";
import { Connection } from "tedious";
import { inject } from "vitest";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import type { Database } from "@sqlbraid/core";
import { assertCode, bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const GS = "getting-started/mssql.md";

function connect(options: {
  readonly encrypt: boolean;
  readonly trustServerCertificate: boolean;
}): Promise<Connection> {
  const settings = inject("mssql");
  const connection = new Connection({
    server: settings.server,
    options: { port: settings.port, database: settings.database, ...options },
    authentication: { type: "default", options: { userName: settings.userName, password: settings.password } },
  });
  return new Promise((resolve, reject) => {
    connection.once("connect", (error) => (error ? reject(error) : resolve(connection)));
    connection.connect();
  });
}

async function withDb(
  fn: (db: Database) => Promise<void>,
  extra: Parameters<typeof createTediousDatabase>[1] = {},
): Promise<void> {
  const connection = await connect({ encrypt: false, trustServerCertificate: true });
  try {
    await fn(createTediousDatabase(connection, extra));
  } finally {
    connection.close();
  }
}

docsClaim(GS, "with encrypt and certificate verification, a self-signed container certificate is refused", async () => {
  if (inject("mssql").image === "external") return;
  await assert.rejects(() => connect({ encrypt: true, trustServerCertificate: false }), /certificate/u);
});

docsClaim(GS, "the example binds with an nvarchar hint; integers are strings, FLOAT a number, DATETIME2 a Date", () =>
  withDb(async (db) => {
    await db.execute(sql.command`DROP TABLE IF EXISTS ##docs_users`);
    await db.execute(sql.command`CREATE TABLE ##docs_users (id INT IDENTITY PRIMARY KEY, name NVARCHAR(200))`);
    await db.execute(sql.command`INSERT INTO ##docs_users (name) VALUES (N'Ada')`);
    assert.deepEqual(
      await db.all(
        sql.rows`SELECT id, name FROM ##docs_users WHERE name = ${sql.bind("Ada", mssqlParameter.nvarchar(200))}`,
      ),
      [{ id: "1", name: "Ada" }],
    );
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT CAST(9223372036854775807 AS BIGINT) AS big, CAST(1.5 AS FLOAT) AS fl, CAST('2026-09-14 12:34:56.1234567' AS DATETIME2(7)) AS dt`);
    assert.equal(row.big, "9223372036854775807");
    assert.equal(row.fl, 1.5);
    assert.ok(row.dt instanceof Date);
  }),
);

docsClaim(GS, "DECIMAL and MONEY results fail with BRAID_RESULT_EXACTNESS; CONVERT to varchar gives exact text", () =>
  withDb(async (db) => {
    await assertCode(() => db.one(sql.rows`SELECT CAST(1.10 AS DECIMAL(10,2)) AS d`), "BRAID_RESULT_EXACTNESS");
    await assertCode(() => db.one(sql.rows`SELECT CAST(1.10 AS MONEY) AS m`), "BRAID_RESULT_EXACTNESS");
    assert.deepEqual(await db.one(sql.rows`SELECT CONVERT(varchar(100), CAST(1.10 AS DECIMAL(10,2))) AS d`), {
      d: "1.10",
    });
  }),
);

docsClaim(GS, "native OUTPUT rows are materialized through sql.rows", () =>
  withDb(async (db) => {
    await db.execute(sql.command`DROP TABLE IF EXISTS ##docs_out`);
    await db.execute(sql.command`CREATE TABLE ##docs_out (id INT IDENTITY PRIMARY KEY, name NVARCHAR(200))`);
    assert.deepEqual(
      await db.all(sql.rows`INSERT INTO ##docs_out (name) OUTPUT INSERTED.id, INSERTED.name VALUES (N'Grace')`),
      [{ id: "1", name: "Grace" }],
    );
  }),
);

docsClaim(
  "concepts/routines.md",
  "procedure metadata returns OUTPUT, emitted sets and RETURN status; SQL text and unhinted OUTPUT are rejected",
  () =>
    withDb(async (db) => {
      await db.execute(sql.command`IF OBJECT_ID('dbo.docs_refresh', 'P') IS NOT NULL DROP PROCEDURE dbo.docs_refresh`);
      await db.execute(
        sql.command`CREATE PROCEDURE dbo.docs_refresh @accountId INT, @generatedAt DATETIME2 OUTPUT AS BEGIN SET @generatedAt = SYSUTCDATETIME(); SELECT @accountId AS id; SELECT 1 AS total; RETURN 7; END`,
      );
      const procedure = { name: "dbo.docs_refresh", parameterNames: ["accountId", "generatedAt"] };
      const result = await db.call(
        sql.call({ procedure })`${1}, ${sql.out("generatedAt", mssqlParameter.datetime2())}`,
      );
      assert.ok(result.output.generatedAt instanceof Date);
      assert.equal(result.resultSets.length, 2);
      assert.equal(result.returnValue, 7);
      await assertCode(
        () =>
          db.call(
            sql.call({ procedure })`EXEC dbo.docs_refresh ${1}, ${sql.out("generatedAt", mssqlParameter.datetime2())}`,
          ),
        "BRAID_CALL_PROCEDURE_INVALID",
      );
      assert.equal(
        await errorCode(() => db.call(sql.call({ procedure })`${1}, ${sql.out("generatedAt")}`)),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
    }),
);

docsClaim("concepts/bulk.md", "Tedious bulk reports prepared-loop", async () => {
  const bulk = bulkModeObserver();
  await withDb(
    async (db) => {
      await db.execute(sql.command`DROP TABLE IF EXISTS ##docs_bulk`);
      await db.execute(sql.command`CREATE TABLE ##docs_bulk (name NVARCHAR(10))`);
      await db.bulk(["a", "b"], (name) => sql.command`INSERT INTO ##docs_bulk (name) VALUES (${name})`);
      assert.equal(bulk.mode(), "prepared-loop");
    },
    { observers: [bulk.observer] },
  );
});

docsClaim("runtime/streaming.md", "the Tedious stream supports an early break and the connection stays usable", () =>
  withDb(async (db) => {
    let count = 0;
    for await (const row of db.stream(sql.rows`SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3`)) {
      void row;
      count += 1;
      if (count === 1) break;
    }
    assert.equal(count, 1);
    assert.equal((await db.all(sql.rows`SELECT 1 AS x`)).length, 1);
  }),
);
