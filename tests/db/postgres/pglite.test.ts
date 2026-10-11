import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, test } from "vitest";
import { sql } from "@sqlbraid/postgres";
import { createPgliteDatabase } from "@sqlbraid/postgres/pglite";
import { transactionIntegrationTests } from "../../contracts/transaction.integration.js";
import { affectedRowsContract, affectedRowsTitle } from "../command-metadata.js";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

const codeOf = (error: unknown) => (error as { code?: string }).code;

test("pglite.environment reports the driver and unsupported capabilities", { timeout: 30_000 }, async () => {
  const environment = await createPgliteDatabase(pg).environment();
  assert.equal(environment.driver.id, "pglite");
  assert.equal(environment.driver.profile, "pg-lossless-text");
  for (const id of ["statement.cancel", "statement.stream", "routine.call"] as const) {
    assert.equal(environment.capabilities[id]?.status, "unsupported", id);
  }
  for (const id of ["session.pinned", "transaction", "transaction.savepoint", "statement.bulk"] as const) {
    assert.equal(environment.capabilities[id]?.status, "guaranteed", id);
  }
});

test("pglite.lossless text results", { timeout: 30_000 }, async () => {
  const db = createPgliteDatabase(pg);
  await db.execute(sql.command`SET TIME ZONE 'UTC'`);
  const row = await db.one(sql.rows`
    SELECT 9007199254740993::int8 AS exact_id,
           7::int4 AS small,
           1.10::numeric(5,2) AS exact_decimal,
           '{"a":1}'::jsonb AS payload,
           TIMESTAMPTZ '2024-01-02 03:04:05.123456+00' AS stamped,
           ARRAY[1,2]::int4[] AS items,
           1.5::float8 AS ratio,
           2.5::float4 AS ratio32,
           true AS flag
  `);
  assert.deepEqual(row, {
    exact_id: "9007199254740993",
    small: "7",
    exact_decimal: "1.10",
    payload: '{"a": 1}',
    stamped: "2024-01-02 03:04:05.123456+00",
    items: "{1,2}",
    ratio: 1.5,
    ratio32: 2.5,
    flag: true,
  });
});

test("pglite.parameters keep exact values", { timeout: 30_000 }, async () => {
  const db = createPgliteDatabase(pg);
  const row = await db.one(sql.rows`SELECT ${9007199254740993n}::int8 AS big, ${"text"}::text AS label`);
  assert.deepEqual(row, { big: "9007199254740993", label: "text" });
});

test("pglite.duplicate result labels are rejected", { timeout: 30_000 }, async () => {
  await assert.rejects(
    createPgliteDatabase(pg).all(sql.rows`SELECT 1 AS a, 2 AS a`),
    /duplicate PostgreSQL result label/u,
  );
});

test("pglite.transaction, savepoint, rollback and read-only", { timeout: 60_000 }, async () => {
  const db = createPgliteDatabase(pg);
  await db.execute(sql.command`DROP TABLE IF EXISTS pgl_items`);
  await db.execute(sql.command`CREATE TABLE pgl_items (id int PRIMARY KEY)`);
  await db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO pgl_items VALUES (1)`);
    await assert.rejects(
      tx.tx(async (nested) => {
        await nested.execute(sql.command`INSERT INTO pgl_items VALUES (2)`);
        throw new Error("rollback the savepoint");
      }),
    );
  });
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO pgl_items VALUES (9)`);
      throw new Error("rollback the transaction");
    }),
  );
  assert.deepEqual(await db.all(sql.rows`SELECT id FROM pgl_items ORDER BY id`), [{ id: "1" }]);
  await assert.rejects(
    db.tx({ readOnly: true }, async (tx) => tx.execute(sql.command`INSERT INTO pgl_items VALUES (3)`)),
    /read-only/u,
  );
});

test("pglite.command results and bulk", { timeout: 60_000 }, async () => {
  const db = createPgliteDatabase(pg);
  await db.execute(sql.command`DROP TABLE IF EXISTS pgl_bulk`);
  await db.execute(sql.command`CREATE TABLE pgl_bulk (id int PRIMARY KEY)`);
  const insert = await db.execute(sql.command`INSERT INTO pgl_bulk VALUES (1), (2)`);
  assert.equal(insert.kind, "command");
  assert.equal(insert.command.affectedRows, 2);
  const bulk = await db.bulk(
    [{ id: 3 }, { id: 4 }, { id: 5 }],
    ({ id }) => sql.command`INSERT INTO pgl_bulk VALUES (${id})`,
  );
  assert.equal(bulk.inputCount, 3);
  assert.equal(bulk.affectedRows, 3);
  assert.deepEqual(
    (await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM pgl_bulk ORDER BY id`)).map((row) => row.id),
    ["1", "2", "3", "4", "5"],
  );
});

test("pglite.rejects stream, routine call and an active AbortSignal before I/O", { timeout: 30_000 }, async () => {
  const db = createPgliteDatabase(pg);
  await assert.rejects(
    db.all(sql.rows`SELECT 1`, { signal: new AbortController().signal }),
    (error: unknown) => codeOf(error) === "BRAID_CANCEL_UNSUPPORTED",
  );
  await assert.rejects(
    (async () => {
      for await (const row of db.stream(sql.rows`SELECT 1`)) assert.ok(row);
    })(),
    (error: unknown) => codeOf(error) === "BRAID_STREAM_UNSUPPORTED",
  );
});

test("pglite.rejects an object that is not a PGlite instance", () => {
  assert.throws(() => createPgliteDatabase({} as never), /PGlite instance/u);
});

// PGlite has one connection. A poisoned instance stays poisoned, so each fixture owns a fresh instance.
// The observer reads the same instance outside any transaction.
for (const contract of transactionIntegrationTests(
  "pglite",
  "direct",
  async () => {
    const own = await PGlite.create();
    const db = createPgliteDatabase(own);
    await own.query("CREATE TABLE braid_contract_tx (id VARCHAR(255) PRIMARY KEY)");
    return {
      db,
      caughtStatementOutcome: "rollback",
      write: (tx, id) => tx.execute(sql.command`INSERT INTO braid_contract_tx (id) VALUES (${id})`),
      committedRows: async () =>
        (await own.query<{ id: string }>("SELECT id FROM braid_contract_tx ORDER BY id")).rows.map((row) => row.id),
      accessMode: {
        inheritedReadOnly: true,
        setDefault: async () => {
          await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
        },
        restoreDefault: async () => {
          await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`);
        },
      },
      close: async () => {
        await own.close();
      },
    };
  },
  { accessMode: true },
))
  test(contract.title, { timeout: 60_000 }, contract.run);

test(`${affectedRowsTitle("pglite")} command affected rows are exact`, { timeout: 60_000 }, async () => {
  const own = await PGlite.create();
  try {
    await own.query("CREATE TABLE braid_contract_affected (id VARCHAR(255) PRIMARY KEY, name TEXT NOT NULL)");
    await affectedRowsContract(createPgliteDatabase(own), sql, async () =>
      (await own.query<{ id: string }>("SELECT id FROM braid_contract_affected ORDER BY id")).rows.map((row) => row.id),
    );
  } finally {
    await own.close();
  }
});
