import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";
import { sql } from "@sqlbraid/postgres";
import { runW01 } from "../w01.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  const ending = pool.end().catch(() => undefined);
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, 500);
  await Promise.race([ending, timeout.promise]);
  clearTimeout(timer);
}

test("PostgreSQL wrappers sharing one client preserve transaction isolation", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  const observer = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  await observer.connect();
  try {
    const version = await observer.query<{ server_version: string }>("SHOW server_version");
    console.info(`[db-postgres] server_version=${version.rows[0]?.server_version ?? "unknown"}`);
    const db = createPgDatabase(client);
    const secondaryDb = createPgDatabase(client);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => (await observer.query<{ id: string }>("SELECT id FROM braid_w01 ORDER BY id")).rows.map((row) => row.id),
      clear: async () => { await observer.query("DELETE FROM braid_w01"); },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});

test("PostgreSQL result kinds follow driver metadata", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    const db = createPgDatabase(client);
    await client.query("DROP TABLE IF EXISTS braid_pv4");
    await client.query("CREATE TABLE braid_pv4 (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (1, 'Ada')");

    const rows = await db.execute(sql.rows<{ readonly id: number; readonly name: string }>`SELECT id, name FROM braid_pv4`);
    assert.equal(rows.kind, "rows");
    assert.deepEqual(rows.rows, [{ id: 1, name: "Ada" }]);
    const unknownRows = await db.execute(sql`SELECT id FROM braid_pv4`);
    assert.equal(unknownRows.kind, "rows");
    const command = await db.execute(sql.command`UPDATE braid_pv4 SET name = 'Grace' WHERE id = 1`);
    assert.equal(command.kind, "command");
    assert.deepEqual(command.rows, []);
    assert.equal(command.command.affectedRows, 1);
    const unknownCommand = await db.execute(sql`DELETE FROM braid_pv4 WHERE id = 1`);
    assert.equal(unknownCommand.kind, "command");
    assert.deepEqual(unknownCommand.rows, []);
    assert.equal(unknownCommand.command.affectedRows, 1);

    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (2, 'Bob')");
    const returning = await db.execute(sql.rows`INSERT INTO braid_pv4 (id, name) VALUES (3, 'Carol') RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: 3 }]);

    await assert.rejects(
      () => db.execute(sql.command`SELECT id FROM braid_pv4`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sql.rows`UPDATE braid_pv4 SET name = 'Dora' WHERE id = 2`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly id: number };
          return { value: { id: row.id + 10 } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: number }>`SELECT id FROM braid_pv4 WHERE id = 2`, { schema }),
      [{ id: 12 }],
    );
    const mapped = v.object({
      payload: v.object({ enabled: v.boolean() }),
      stamp: v.pipe(v.string(), v.transform((stamp) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z`))),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT '{"enabled":true}'::jsonb AS payload, '20260912'::text AS stamp`)).rows,
      [{ payload: { enabled: true }, stamp: new Date("2026-09-12T00:00:00Z") }],
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv4").catch(() => undefined);
    await client.end();
  }
});

test("PostgreSQL inspector preserves identity and generated-column evidence", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector");
    await client.query("CREATE TABLE braid_pv8_inspector (external_id INTEGER PRIMARY KEY, generated_id BIGINT GENERATED BY DEFAULT AS IDENTITY, computed INTEGER GENERATED ALWAYS AS (external_id + 1) STORED)");
    const snapshot = await createPostgresInspector(client).inspect();
    const columns = snapshot.relations["public.braid_pv8_inspector"]?.columns ?? [];
    assert.equal(snapshot.format, "sqlbraid-metadata");
    assert.equal(columns.find((column) => column.name === "external_id")?.identity, undefined);
    assert.equal(columns.find((column) => column.name === "generated_id")?.identity, true);
    assert.equal(columns.find((column) => column.name === "computed")?.generated, true);
    assert.equal(columns.find((column) => column.name === "computed")?.insertable, false);
    assert.equal("tsType" in (columns[0] ?? {}), false);
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector").catch(() => undefined);
    await client.end();
  }
});

test("PostgreSQL pool leases run concurrent roots and pin transactions", async () => {
  const settings = inject("postgres");
  const pool = new Pool({ connectionString: settings.connectionUri, max: 2, idleTimeoutMillis: 0 });
  const db = createPgPoolDatabase(pool);
  try {
    const backendIds = await Promise.all([
      db.one(sql.rows<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.15)`),
      db.one(sql.rows<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.15)`),
    ]);
    assert.equal(new Set(backendIds.map(({ pid }) => pid)).size, 2);

    await db.execute(sql`DROP TABLE IF EXISTS braid_pv6_pool`);
    await db.execute(sql`CREATE TABLE braid_pv6_pool (id TEXT PRIMARY KEY)`);
    const pinnedIds: number[] = [];
    await db.tx(async (tx) => {
      pinnedIds.push((await tx.one(sql.rows<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`)).pid);
      await assert.rejects(
        tx.tx(async (nested) => {
          pinnedIds.push((await nested.one(sql.rows<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`)).pid);
          await nested.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('nested')`);
          throw new Error("rollback savepoint");
        }),
        /rollback savepoint/,
      );
      pinnedIds.push((await tx.one(sql.rows<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`)).pid);
      await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('committed')`);
    });
    assert.equal(new Set(pinnedIds).size, 1);
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [{ id: "committed" }]);

    await assert.rejects(
      db.tx(async () => db.execute(sql`SELECT 1`)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
    );
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [{ id: "committed" }]);

    await assert.rejects(db.tx(async (tx) => {
      await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('rolled-back')`);
      throw new Error("rollback transaction");
    }), /rollback transaction/);
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [{ id: "committed" }]);
    assert.equal(pool.idleCount, pool.totalCount);
    assert.ok(pool.totalCount > 0);
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv6_pool").catch(() => undefined);
    await endPool(pool);
  }
});

test("PostgreSQL pool releases before an async mapper can re-enter a max-one pool", async () => {
  const settings = inject("postgres");
  const pool = new Pool({ connectionString: settings.connectionUri, max: 1, idleTimeoutMillis: 0 });
  const db = createPgPoolDatabase(pool);
  try {
    const mapper: StandardSchemaV1<unknown, { readonly value: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        async validate(value) {
          await db.execute(sql`SELECT 2`);
          return { value: { value: (value as { readonly value: number }).value + 1 } };
        },
      },
    };
    const mappedQuery = sql.rows(mapper)`SELECT 1 AS value`;
    const operation = (async () => {
      const executed = await db.execute(mappedQuery);
      assert.deepEqual(executed.rows, [{ value: 2 }]);
      const prepared = db.prepare("pv6-postgres-mapped", () => mappedQuery);
      assert.deepEqual((await prepared.execute()).rows, [{ value: 2 }]);
      const [batched] = await db.batch([mappedQuery] as const);
      assert.deepEqual(batched.rows, [{ value: 2 }]);
    })();
    operation.catch(() => undefined);
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(() => timeout.reject(new Error("mapper re-entry timed out")), 2_000);
    try {
      await Promise.race([operation, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(pool.idleCount, 1);
  } finally {
    await endPool(pool);
  }
});
