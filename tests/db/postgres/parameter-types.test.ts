// Proves the parameter type hints of the postgres.js and PGlite adapters on a real server and a real PGlite.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { afterAll, beforeAll, inject } from "vitest";
import type { Database } from "@sqlbraid/core";
import { postgresParameter, sql } from "@sqlbraid/postgres";
import { createPgliteDatabase } from "@sqlbraid/postgres/pglite";
import { createPostgresJsDatabase, postgresJsOptions } from "@sqlbraid/postgres/postgres-js";
import { assertCode, docsClaim } from "../docs-claims.js";

const PH = "concepts/parameter-hints.md";

let client: ReturnType<typeof postgres>;
let pglite: PGlite;

beforeAll(async () => {
  client = postgres((inject("postgres") as { connectionUri: string }).connectionUri, {
    max: 2,
    onnotice: () => undefined,
    ...postgresJsOptions(),
  });
  pglite = await PGlite.create();
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await pglite?.close();
});

const adapters: ReadonlyArray<readonly [string, () => Database]> = [
  ["postgres.js", () => createPostgresJsDatabase(client)],
  ["PGlite", () => createPgliteDatabase(pglite)],
];

// Each factory selects its type, and the value arrives unchanged.
const cases: ReadonlyArray<{
  readonly name: string;
  readonly hint: ReturnType<(typeof postgresParameter)[keyof typeof postgresParameter]>;
  readonly value: unknown;
  readonly type: string;
  readonly text: string;
}> = [
  { name: "boolean", hint: postgresParameter.boolean(), value: true, type: "boolean", text: "true" },
  { name: "int2", hint: postgresParameter.int2(), value: 7, type: "smallint", text: "7" },
  { name: "int4", hint: postgresParameter.int4(), value: 7, type: "integer", text: "7" },
  {
    name: "int8 bigint",
    hint: postgresParameter.int8(),
    value: 9007199254740993n,
    type: "bigint",
    text: "9007199254740993",
  },
  {
    name: "int8 text",
    hint: postgresParameter.int8(),
    value: "9007199254740993",
    type: "bigint",
    text: "9007199254740993",
  },
  { name: "float4", hint: postgresParameter.float4(), value: 1.5, type: "real", text: "1.5" },
  { name: "float8", hint: postgresParameter.float8(), value: 1.5, type: "double precision", text: "1.5" },
  {
    name: "numeric",
    hint: postgresParameter.numeric(),
    value: "12345678901234567890.5",
    type: "numeric",
    text: "12345678901234567890.5",
  },
  { name: "text", hint: postgresParameter.text(), value: "x", type: "text", text: "x" },
  { name: "varchar", hint: postgresParameter.varchar(), value: "x", type: "character varying", text: "x" },
  {
    name: "uuid",
    hint: postgresParameter.uuid(),
    value: "123e4567-e89b-12d3-a456-426614174000",
    type: "uuid",
    text: "123e4567-e89b-12d3-a456-426614174000",
  },
  {
    name: "bytea",
    hint: postgresParameter.bytea(),
    value: new Uint8Array([1, 2, 255]),
    type: "bytea",
    text: "\\x0102ff",
  },
  { name: "date", hint: postgresParameter.date(), value: "2026-01-02", type: "date", text: "2026-01-02" },
  { name: "time", hint: postgresParameter.time(), value: "03:04:05", type: "time without time zone", text: "03:04:05" },
  { name: "interval", hint: postgresParameter.interval(), value: "1 day", type: "interval", text: "1 day" },
];

for (const [adapter, create] of adapters) {
  docsClaim(PH, `${adapter}: each factory sets the parameter type and keeps the value`, async () => {
    const db = create();
    await db.execute(sql.command`SET TIME ZONE 'UTC'`);
    for (const entry of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one session setting, one statement at a time
      const row = await db.one(
        sql.rows<{
          t: string;
          v: string;
        }>`SELECT pg_typeof(${sql.bind(entry.value as never, entry.hint as never)})::text AS t, (${sql.bind(entry.value as never, entry.hint as never)})::text AS v`,
      );
      assert.equal(row.t, entry.type, entry.name);
      assert.equal(row.v, entry.text, entry.name);
    }
  });

  docsClaim(PH, `${adapter}: timestamptz takes a Date and an ISO string; a typed NULL needs no CAST`, async () => {
    const db = create();
    await db.execute(sql.command`SET TIME ZONE 'UTC'`);
    const stamp = postgresParameter.timestamptz();
    const date = await db.one(
      sql.rows<{ v: string }>`SELECT (${sql.bind(new Date("2026-01-02T03:04:05.678Z"), stamp)})::text AS v`,
    );
    assert.equal(date.v, "2026-01-02 03:04:05.678+00");
    const text = await db.one(sql.rows<{ v: string }>`SELECT (${sql.bind("2026-01-02T03:04:05Z", stamp)})::text AS v`);
    assert.equal(text.v, "2026-01-02 03:04:05+00");
    const empty = await db.one(
      sql.rows<{ t: string }>`SELECT pg_typeof(${sql.bind(null, postgresParameter.int4())})::text AS t`,
    );
    assert.equal(empty.t, "integer");
  });

  docsClaim(
    PH,
    `${adapter}: hinted and plain parameters mix; an unknown or faceted hint fails before I/O`,
    async () => {
      const db = create();
      const row = await db.one(
        sql.rows<{
          a: string;
          b: string;
        }>`SELECT pg_typeof(${sql.bind(1, postgresParameter.int4())})::text AS a, (${"x"})::text AS b`,
      );
      assert.deepEqual(row, { a: "integer", b: "x" });
      await assertCode(
        () => db.all(sql.rows`SELECT ${sql.bind("x", { databaseType: "citext" })}`),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
      await assertCode(
        () => db.all(sql.rows`SELECT ${sql.bind("x", { databaseType: "varchar", length: 10 })}`),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
      await assertCode(
        () => db.all(sql.rows`SELECT ${sql.bind("{}", { databaseType: "jsonb" })}`),
        "BRAID_BIND_HINT_UNSUPPORTED",
      );
    },
  );

  docsClaim(PH, `${adapter}: a hinted bulk command binds every item with the type`, async () => {
    const db = create();
    await db.execute(sql.command`CREATE TEMP TABLE IF NOT EXISTS hint_bulk (id int8, tag text)`);
    await db.execute(sql.command`DELETE FROM hint_bulk`);
    const result = await db.bulk(
      [1n, 2n, 9007199254740993n],
      (id) => sql.command`INSERT INTO hint_bulk (id, tag) VALUES (${sql.bind(id, postgresParameter.int8())}, ${"t"})`,
    );
    assert.equal(result.inputCount, 3);
    const rows = await db.all(sql.rows<{ id: string }>`SELECT id FROM hint_bulk ORDER BY id`);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["1", "2", "9007199254740993"],
    );
  });
}

docsClaim(PH, "postgres.js: a hinted stream applies the type", async () => {
  const db = createPostgresJsDatabase(client);
  const types: string[] = [];
  for await (const row of db.stream(
    sql.rows<{ t: string }>`SELECT pg_typeof(${sql.bind(7, postgresParameter.int2())})::text AS t`,
  )) {
    types.push(row.t);
  }
  assert.deepEqual(types, ["smallint"]);
});
