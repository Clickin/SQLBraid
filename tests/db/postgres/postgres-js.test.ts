import assert from "node:assert/strict";
import postgres from "postgres";
import { afterAll, inject, test } from "vitest";
import { postgresParameter, sql } from "@sqlbraid/postgres";
import { createPostgresJsDatabase, createPostgresJsProvider, postgresJsOptions } from "@sqlbraid/postgres/postgres-js";

type Settings = { readonly connectionUri: string };

const connectionUri = (): string => (inject("postgres") as Settings).connectionUri;
const clients: ReturnType<typeof postgres>[] = [];

function client(max = 3) {
  const created = postgres(connectionUri(), { max, onnotice: () => undefined, ...postgresJsOptions() });
  clients.push(created);
  return created;
}

afterAll(async () => {
  await Promise.all(clients.map((entry) => entry.end({ timeout: 2 })));
});

test("postgres-js.environment reports the driver and unsupported capabilities", { timeout: 30_000 }, async () => {
  const db = createPostgresJsDatabase(client());
  const environment = await db.environment();
  assert.equal(environment.driver.id, "postgres-js");
  assert.equal(environment.driver.profile, "pg-lossless-text");
  for (const id of ["statement.cancel", "routine.call"] as const) {
    assert.equal(environment.capabilities[id]?.status, "unsupported", id);
  }
  for (const id of [
    "session.pinned",
    "transaction",
    "transaction.savepoint",
    "statement.stream",
    "statement.bulk",
  ] as const) {
    assert.equal(environment.capabilities[id]?.status, "guaranteed", id);
  }
});

test("postgres-js.lossless text results", { timeout: 30_000 }, async () => {
  const db = createPostgresJsDatabase(client());
  const row = await db.one(sql.rows`
    SELECT 9007199254740993::int8 AS exact_id,
           7::int4 AS small,
           1.10::numeric(5,2) AS exact_decimal,
           '{"a":1}'::jsonb AS payload,
           TIMESTAMPTZ '2024-01-02 03:04:05.123456+00' AS stamped,
           ARRAY[1,2]::int4[] AS items,
           1.5::float8 AS ratio
  `);
  assert.deepEqual(row, {
    exact_id: "9007199254740993",
    small: "7",
    exact_decimal: "1.10",
    payload: '{"a": 1}',
    stamped: "2024-01-02 03:04:05.123456+00",
    items: "{1,2}",
    ratio: 1.5,
  });
});

test("postgres-js.rejects a client without the lossless parsers", { timeout: 30_000 }, async () => {
  const plain = postgres(connectionUri(), { max: 1 });
  clients.push(plain);
  assert.throws(() => createPostgresJsProvider(plain), /fetch_types/u);
  const noTypes = postgres(connectionUri(), { max: 1, fetch_types: false });
  clients.push(noTypes);
  assert.throws(() => createPostgresJsProvider(noTypes), /lossless text parser/u);
});

test("postgres-js.transaction, savepoint and rollback keep one connection", { timeout: 60_000 }, async () => {
  const db = createPostgresJsDatabase(client(2));
  await db.execute(sql.command`DROP TABLE IF EXISTS pjs_items`);
  await db.execute(sql.command`CREATE TABLE pjs_items (id int PRIMARY KEY)`);
  await db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO pjs_items VALUES (1)`);
    await assert.rejects(
      tx.tx(async (nested) => {
        await nested.execute(sql.command`INSERT INTO pjs_items VALUES (2)`);
        throw new Error("rollback the savepoint");
      }),
    );
  });
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO pjs_items VALUES (9)`);
      throw new Error("rollback the transaction");
    }),
  );
  assert.deepEqual(await db.all(sql.rows`SELECT id FROM pjs_items ORDER BY id`), [{ id: "1" }]);
  await assert.rejects(
    db.tx({ readOnly: true }, async (tx) => tx.execute(sql.command`INSERT INTO pjs_items VALUES (3)`)),
    /read-only/u,
  );
});

test("postgres-js.bulk and stream, including an early break", { timeout: 60_000 }, async () => {
  const db = createPostgresJsDatabase(client(1), { streamBatchSize: 10 });
  await db.execute(sql.command`DROP TABLE IF EXISTS pjs_bulk`);
  await db.execute(sql.command`CREATE TABLE pjs_bulk (id int PRIMARY KEY)`);
  const bulk = await db.bulk(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    ({ id }) => sql.command`INSERT INTO pjs_bulk VALUES (${id})`,
  );
  assert.equal(bulk.inputCount, 3);
  assert.equal(bulk.affectedRows, 3);

  const seen: string[] = [];
  for await (const row of db.stream(sql.rows<{ readonly g: string }>`SELECT g FROM generate_series(1, 25) g`))
    seen.push(row.g);
  assert.equal(seen.length, 25);

  let count = 0;
  for await (const row of db.stream(sql.rows<{ readonly g: string }>`SELECT g FROM generate_series(1, 25) g`)) {
    assert.ok(row.g);
    count += 1;
    if (count === 3) break;
  }
  // max is 1: this query waits for the stream lease, so it proves the lease was released.
  assert.deepEqual(await db.all(sql.rows`SELECT 1 AS one`), [{ one: "1" }]);
});

test("postgres-js.rejects an active AbortSignal and routine calls before I/O", { timeout: 30_000 }, async () => {
  const db = createPostgresJsDatabase(client());
  await assert.rejects(
    db.all(sql.rows`SELECT 1`, { signal: new AbortController().signal }),
    (error: unknown) => (error as { code?: string }).code === "BRAID_CANCEL_UNSUPPORTED",
  );
  await db.execute(sql.command`DROP PROCEDURE IF EXISTS pjs_out`);
  await db.execute(
    sql.command`CREATE PROCEDURE pjs_out(OUT c refcursor) LANGUAGE plpgsql AS $$ BEGIN OPEN c FOR SELECT 1 AS a; END $$`,
  );
  await assert.rejects(
    db.tx(async (tx) => tx.call(sql.call`CALL pjs_out(${sql.out("c", postgresParameter.refcursor())})`)),
    (error: unknown) => (error as { code?: string }).code === "BRAID_CALL_UNSUPPORTED",
  );
});

const rendered = (text: string) => sql.command`${sql.raw(text)}`.render();

test("postgres-js.a discarded lease resets the session", { timeout: 30_000 }, async () => {
  const pool = client(1);
  const provider = createPostgresJsProvider(pool);
  const first = await provider.acquire();
  await first.query(rendered("CREATE TEMP TABLE pjs_temp (id int)"));
  await first.release({ discard: true });
  const second = await provider.acquire();
  try {
    await assert.rejects(async () => second.query(rendered("SELECT * FROM pjs_temp")), /pjs_temp/u);
  } finally {
    await second.release();
  }
});
