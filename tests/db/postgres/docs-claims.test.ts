// Proves the runtime claims of the documentation on a real PostgreSQL server.
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { inject } from "vitest";
import { mssqlParameter } from "@sqlbraid/mssql";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { postgresParameter, representationProfiles, sql } from "@sqlbraid/postgres";
import { sql as sqliteSql } from "@sqlbraid/sqlite";
import type { Database, QueryReadyEvent } from "@sqlbraid/core";
import { assertCode, bulkModeObserver, docsClaim, errorCode } from "../docs-claims.js";

const uri = () => inject("postgres").connectionUri;

async function withDb(
  fn: (db: Database, client: Client) => Promise<void>,
  options: Parameters<typeof createPgDatabase>[1] = {},
): Promise<void> {
  const client = new Client({ connectionString: uri() });
  await client.connect();
  try {
    await fn(createPgDatabase(client, options), client);
  } finally {
    await client.end();
  }
}

const GS = "getting-started/postgres.md";

docsClaim(GS, "the default pg-lossless-text profile returns the documented representations", () =>
  withDb(async (db) => {
    const row = await db.one(sql.rows<Record<string, unknown>>`
      SELECT 1::int8 AS i8, 2::int4 AS i4, 12345678901234567890.123::numeric AS num, 1.5::float8 AS f8,
        2.5::float4 AS f4, '{"a":1}'::json AS j, '{"a":12345678901234567890}'::jsonb AS jb,
        DATE '2026-09-14' AS d, TIMESTAMPTZ '2026-09-14 12:34:56.123456+09' AS tstz,
        '\\x0102'::bytea AS b, gen_random_uuid() AS u`);
    assert.equal(row.i8, "1");
    assert.equal(row.i4, "2");
    assert.equal(row.num, "12345678901234567890.123");
    assert.equal(typeof row.f8, "number");
    assert.equal(typeof row.f4, "number");
    assert.equal(typeof row.j, "string");
    assert.equal(typeof row.jb, "string");
    assert.equal(typeof row.d, "string");
    assert.equal(typeof row.tstz, "string");
    assert.ok(Buffer.isBuffer(row.b));
    assert.equal(typeof row.u, "string");
  }),
);

docsClaim(GS, "pg-native parses JSON, uses Date for date/timestamptz and keeps time/timetz as text", async () => {
  const profile = representationProfiles.find((entry) => entry.id === "pg-native");
  assert.ok(profile);
  await withDb(
    async (db) => {
      const row = await db.one(sql.rows<Record<string, unknown>>`
        SELECT '{"a":1}'::json AS j, DATE '2026-09-14' AS d, TIMESTAMPTZ '2026-09-14 12:34:56+00' AS tstz,
          TIME '12:00' AS t, TIMETZ '12:00+09' AS ttz, 5::int8 AS i8`);
      assert.deepEqual(row.j, { a: 1 });
      assert.ok(row.d instanceof Date);
      assert.ok(row.tstz instanceof Date);
      assert.equal(typeof row.t, "string");
      assert.equal(typeof row.ttz, "string");
      assert.equal(row.i8, "5");
    },
    { profile },
  );
});

docsClaim(GS, "db.environment() reports the profile and derives the float status from extra_float_digits", () =>
  withDb(async (db, client) => {
    await client.query("SET extra_float_digits = 3");
    const environment = await db.environment({ refresh: true });
    assert.equal(environment.driver.profile, "pg-lossless-text");
    assert.equal(typeof environment.typePolicy?.hash, "string");
    assert.equal(environment.capabilities["numeric.approximate-float"]?.status, "guaranteed");
    assert.equal(JSON.stringify(environment).includes("extra_float_digits"), false);
    await client.query("SET extra_float_digits = 0");
    const guarded = await db.environment({ refresh: true });
    assert.equal(guarded.capabilities["numeric.approximate-float"]?.status, "guarded");
    assert.equal(guarded.capabilities["numeric.approximate-float"]?.conditionCode, "pg.extra-float-digits");
  }),
);

docsClaim(GS, "createPgDatabase rejects a pg.Pool; createPgPoolDatabase accepts it", async () => {
  const pool = new Pool({ connectionString: uri() });
  try {
    assert.notEqual(await errorCode(() => createPgDatabase(pool as never)), "no-error");
    const db = createPgPoolDatabase(pool);
    assert.equal((await db.one(sql.rows<{ x: string }>`SELECT ${1}::int AS x`)).x, "1");
  } finally {
    await pool.end();
  }
});

const refcursorOut = () => sql.call`CALL docs_p_out(${sql.out("c", postgresParameter.refcursor())})`;

docsClaim(GS, "a refcursor OUT inside db.tx becomes a result set; INOUT is rejected; outside a tx it fails", () =>
  withDb(async (db) => {
    await db.execute(sql.command`DROP PROCEDURE IF EXISTS docs_p_out`);
    await db.execute(sql.command`DROP PROCEDURE IF EXISTS docs_p_inout`);
    await db.execute(
      sql.command`CREATE PROCEDURE docs_p_out(OUT c refcursor) LANGUAGE plpgsql AS $$ BEGIN OPEN c FOR SELECT 1 AS a UNION ALL SELECT 2; END $$`,
    );
    await db.execute(
      sql.command`CREATE PROCEDURE docs_p_inout(INOUT c refcursor) LANGUAGE plpgsql AS $$ BEGIN OPEN c FOR SELECT 1 AS a; END $$`,
    );
    const result = await db.tx(async (tx) => tx.call(refcursorOut()));
    assert.equal(result.resultSets[0]?.rows.length, 2);
    assert.equal("c" in result.output, false);
    assert.notEqual(await errorCode(() => db.call(refcursorOut())), "no-error");
    await assertCode(
      () =>
        db.tx(async (tx) =>
          tx.call(sql.call`CALL docs_p_inout(${sql.inOut("c", null, postgresParameter.refcursor())})`),
        ),
      "BRAID_CALL_OUT_UNSUPPORTED",
    );
  }),
);

docsClaim("concepts/safe-binds.md", "sql.list([]) fails with BRAID_EMPTY_LIST", () =>
  withDb(async (db) => assertCode(() => db.all(sql.rows`SELECT 1 WHERE 1 IN (${sql.list([])})`), "BRAID_EMPTY_LIST")),
);

docsClaim("concepts/parameter-hints.md", "PostgreSQL rejects ordinary hints with BRAID_BIND_HINT_UNSUPPORTED", () =>
  withDb(async (db) =>
    assertCode(
      () => db.all(sql.rows`SELECT ${sql.bind("x", mssqlParameter.nvarchar(10))} AS x`),
      "BRAID_BIND_HINT_UNSUPPORTED",
    ),
  ),
);

docsClaim("concepts/structural-fragments.md", "a fragment from a different dialect fails with BRAID_DIALECT", () =>
  withDb(async (db) =>
    assertCode(() => db.all(sql.rows`SELECT 1 ${sqliteSql.fragment`WHERE 1 = 1` as never}`), "BRAID_DIALECT"),
  ),
);

docsClaim("concepts/sql-tags.md", "cardinality and result-kind checks behave as documented", () =>
  withDb(async (db) => {
    await db.execute(sql.command`CREATE TEMP TABLE docs_users (id int, name text)`);
    await db.execute(sql.command`INSERT INTO docs_users VALUES (1, 'Ada'), (2, 'Grace')`);
    await assert.rejects(() => db.one(sql.rows`SELECT id FROM docs_users`), { name: "DatabaseCardinalityError" });
    assert.equal(await db.maybeOne(sql.rows`SELECT id FROM docs_users WHERE false`), undefined);
    await assertCode(() => db.execute(sql.rows`UPDATE docs_users SET name = 'x' WHERE id = 1`), "BRAID_RESULT_KIND");
    assert.equal((await db.one(sql.rows<{ name: string }>`SELECT name FROM docs_users WHERE id = 1`)).name, "x");
  }),
);

docsClaim("concepts/data-representation.md", "an ordinary undefined bind fails with BRAID_BIND_VALUE_UNSUPPORTED", () =>
  withDb(async (db) =>
    assertCode(() => db.all(sql.rows`SELECT ${undefined as unknown as string} AS x`), "BRAID_BIND_VALUE_UNSUPPORTED"),
  ),
);

const TX = "runtime/transactions.md";

docsClaim(TX, "fixed options work; malformed, nested and escaping uses are rejected with the documented codes", () =>
  withDb(async (db) => {
    assert.equal(
      await db.tx({ isolation: "serializable" }, async (tx) => (await tx.all(sql.rows`SELECT 1 AS x`)).length),
      1,
    );
    assert.equal(await db.tx({ readOnly: true }, async (tx) => (await tx.all(sql.rows`SELECT 1 AS x`)).length), 1);
    await assertCode(() => db.tx({ isolation: "chaos" } as never, async () => 1), "BRAID_TX_OPTIONS_INVALID");
    await assertCode(() => db.tx(async (tx) => tx.tx({}, async () => 1)), "BRAID_TX_OPTIONS_NESTED");
    await assertCode(() => db.tx(async () => db.all(sql.rows`SELECT 1 AS x`)), "BRAID_TX_SCOPE");
    await assertCode(() => db.tx(async (tx) => tx.tx(async () => tx.all(sql.rows`SELECT 1 AS x`))), "BRAID_TX_SCOPE");
    assert.deepEqual(await db.batch([]), []);
  }),
);

docsClaim(TX, "a nested tx is a savepoint: an inner failure keeps the outer work", () =>
  withDb(async (db) => {
    await db.execute(sql.command`CREATE TEMP TABLE docs_sp (v int)`);
    await db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO docs_sp VALUES (1)`);
      await tx
        .tx(async (nested) => {
          await nested.execute(sql.command`INSERT INTO docs_sp VALUES (2)`);
          throw new Error("inner");
        })
        .catch(() => undefined);
    });
    assert.deepEqual(await db.all(sql.rows<{ v: string }>`SELECT v FROM docs_sp`), [{ v: "1" }]);
  }),
);

docsClaim(
  "runtime/prepared.md",
  "prepared factories, names, shape locks and aborted signals behave as documented",
  () =>
    withDb(async (db) => {
      const byId = db.prepare("docs-by-id", (id: number) => sql.rows<{ x: string }>`SELECT ${id}::int AS x`);
      assert.equal((await byId.one(7)).x, "7");
      await assertCode(
        () => db.prepare("docs-by-id", () => sql.rows`SELECT 1`, { input: "none" }),
        "BRAID_PREPARED_NAME",
      );
      const shape = db.prepare("docs-shape", (wide: boolean) =>
        wide ? sql.rows`SELECT 1 AS x, 2 AS y` : sql.rows`SELECT 1 AS x`,
      );
      await shape.all(false);
      await assertCode(() => shape.all(true), "BRAID_PREPARED_SHAPE");
      const none = db.prepare("docs-none", () => sql.rows`SELECT 1 AS x`, { input: "none" });
      assert.equal((await none.all()).length, 1);
      const controller = new AbortController();
      controller.abort(new Error("stop-reason"));
      await assert.rejects(() => db.all(sql.rows`SELECT 1 AS x`, { signal: controller.signal }), /stop-reason/u);
    }),
);

docsClaim("runtime/streaming.md", "the pg-cursor stream yields rows and an early break releases the connection", () =>
  withDb(async (db) => {
    let count = 0;
    for await (const row of db.stream(sql.rows`SELECT generate_series(1, 5) AS g`)) {
      void row;
      count += 1;
      if (count === 2) break;
    }
    assert.equal(count, 2);
    assert.equal((await db.all(sql.rows`SELECT 1 AS x`)).length, 1);
  }),
);

docsClaim("concepts/bulk.md", "bulk is command-only, empty input is a no-op and pg reports prepared-loop", async () => {
  const bulk = bulkModeObserver();
  await withDb(
    async (db) => {
      await db.execute(sql.command`CREATE TEMP TABLE docs_account (id int PRIMARY KEY, amount numeric)`);
      await db.execute(sql.command`INSERT INTO docs_account VALUES (1, 0), (2, 0)`);
      const result = await db.bulk(
        [
          { id: 1, amount: "10.5" },
          { id: 2, amount: "7" },
        ],
        (input) => sql.command`UPDATE docs_account SET amount = ${input.amount} WHERE id = ${input.id}`,
      );
      assert.equal(result.inputCount, 2);
      assert.equal(bulk.mode(), "prepared-loop");
      assert.deepEqual(await db.bulk([], (input: number) => sql.command`SELECT ${input}`), {
        inputCount: 0,
        affectedRows: 0,
      });
      await assertCode(() => db.bulk([1], (input) => sql.rows`SELECT ${input} AS x` as never), "BRAID_BULK_SHAPE");
    },
    { observers: [bulk.observer] },
  );
});

docsClaim("runtime/observers.md", "query:ready carries the execution plan of the binding", async () => {
  let ready: QueryReadyEvent | undefined;
  await withDb(
    async (db) => {
      await db.all(sql.rows`SELECT ${1}::int AS x`);
      assert.equal(ready?.execution.transport, "text-positional");
      assert.equal(typeof ready?.execution.adapterId, "string");
      assert.equal(typeof ready?.execution.reuse.effective, "string");
    },
    {
      observers: [
        {
          onEvent(event) {
            if (event.type === "query:ready") ready = event;
          },
        },
      ],
    },
  );
});
