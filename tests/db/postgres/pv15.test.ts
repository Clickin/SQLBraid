import assert from "node:assert/strict";
import { Pool } from "pg";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createPgPoolDatabase,
  type PgCursorFactory,
  type PgCursorLike,
  type PgPoolClientLike,
} from "@sqlbraid/postgres/pg";
import { postgresParameter, sql } from "@sqlbraid/postgres";
import { runStreamingConformance } from "../../streaming-conformance.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  await pool.end().catch(() => undefined);
}

function rowSchema<Output>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15-postgres",
      validate,
    },
  };
}

test("[contract:pg:resource.stream-return:integration] [ownership:pooled] PostgreSQL pg-cursor reuses streaming conformance with row schemas and lease counters", async () => {
  const pool = new Pool({ connectionString: inject("postgres").connectionUri, max: 1, idleTimeoutMillis: 0 });
  let releases = 0;
  let terminated = 0;
  pool.on("release", () => {
    releases += 1;
  });
  pool.on("remove", () => {
    terminated += 1;
  });
  try {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_conformance");
    await pool.query("CREATE TABLE braid_pv15_conformance (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
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
        return { issues: [{ message: "invalid PostgreSQL conformance row" }] };
      return { value: { id: value.id, label: value.label } };
    });
    const mapping = rowSchema<never>(() => ({ issues: [{ message: "query-bound mapper failed" }] }));
    const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
    const Cursor = (loaded.default ?? loaded) as unknown as PgCursorFactory;
    await runStreamingConformance(() => {
      const releaseStart = releases;
      const terminatedStart = terminated;
      let closes = 0;
      class CountingCursor extends Cursor {
        close(callback: (error?: unknown) => void): void {
          closes += 1;
          super.close(callback);
        }
      }
      const db = createPgPoolDatabase(pool, { cursor: CountingCursor, streamBatchSize: 2 });
      return {
        db,
        query: sql.rows(schema)`SELECT id, label FROM braid_pv15_conformance ORDER BY id`,
        expected: [
          { id: "1", label: "one" },
          { id: "2", label: "two" },
        ],
        mappingQuery: sql.rows(mapping)`SELECT id, label FROM braid_pv15_conformance ORDER BY id`,
        released: () => releases - releaseStart,
        iteratorReturns: () => closes + terminated - terminatedStart,
      };
    });
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_conformance").catch(() => undefined);
    await endPool(pool);
  }
});

test("PostgreSQL abort interrupts native pending Execute and frees a single-connection pool", async () => {
  const pool = new Pool({ connectionString: inject("postgres").connectionUri, max: 1 });
  const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
  const Cursor = (loaded.default ?? loaded) as unknown as PgCursorFactory;
  const reading = Promise.withResolvers<void>();
  class PendingCursor extends Cursor {
    read(...args: Parameters<PgCursorLike["read"]>): void {
      super.read(...args);
      reading.resolve();
    }
  }
  const db = createPgPoolDatabase(pool, { cursor: PendingCursor });
  const controller = new AbortController();
  try {
    const before = await db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
    const iterator = db.stream(sql.rows`SELECT pg_sleep(60)`, { signal: controller.signal })[Symbol.asyncIterator]();
    const next = iterator.next();
    await reading.promise;
    const reason = new Error("abort native pending read");
    controller.abort(reason);
    await assert.rejects(next, (error: unknown) => error instanceof Error && error.cause === reason);
    const after = await db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
    assert.notEqual(after.pid, before.pid);
  } finally {
    controller.abort();
    await pool.end();
  }
});

test("PostgreSQL transaction streaming pins its backend and keeps binds value-only", async () => {
  const pool = new Pool({ connectionString: inject("postgres").connectionUri, max: 1, idleTimeoutMillis: 0 });
  const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
  const Cursor = (loaded.default ?? loaded) as unknown as PgCursorFactory;
  const db = createPgPoolDatabase(pool, { cursor: Cursor, streamBatchSize: 2 });
  try {
    const secret = "x'); DROP TABLE braid_pv15_bind; --";
    await db.tx(async (tx) => {
      const before = await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
      const rows: { readonly pid: string; readonly value: string }[] = [];
      for await (const row of tx.stream(
        sql.rows<{
          readonly pid: string;
          readonly value: string;
        }>`SELECT pg_backend_pid() AS pid, ${secret}::text AS value`,
      )) {
        rows.push(row);
      }
      const after = await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
      assert.equal(after.pid, before.pid);
      assert.deepEqual(rows, [{ pid: before.pid, value: secret }]);
    });
    assert.deepEqual(await db.one(sql.rows<{ readonly ok: string }>`SELECT 1 AS ok`), { ok: "1" });
  } finally {
    await endPool(pool);
  }
});

test("PostgreSQL pg-cursor streams 100k rows and releases after break", async () => {
  const pool = new Pool({ connectionString: inject("postgres").connectionUri, max: 1 });
  const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
  const Cursor = (loaded.default ?? loaded) as unknown as PgCursorFactory;
  const db = createPgPoolDatabase(pool, { cursor: Cursor, streamBatchSize: 100 });
  try {
    await pool.query("DROP TABLE IF EXISTS braid_pv15_stream");
    await pool.query("CREATE TABLE braid_pv15_stream AS SELECT value AS id FROM generate_series(1, 100000) value");
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
    await pool.end();
  }
});

test("PostgreSQL refcursor routines require tx and close heterogeneous portals", async () => {
  const pool = new Pool({ connectionString: inject("postgres").connectionUri, max: 1 });
  const loaded = (await import("pg-cursor")) as unknown as { readonly default?: unknown };
  const Cursor = (loaded.default ?? loaded) as unknown as PgCursorFactory;
  const controlSql: string[] = [];
  const db = createPgPoolDatabase(
    {
      async connect() {
        const client = await pool.connect();
        const query = client.query.bind(client) as unknown as (
          query: unknown,
          queryValues?: readonly unknown[],
        ) => Promise<unknown>;
        return {
          query(value: unknown, values?: readonly unknown[]) {
            if (typeof value === "object" && value !== null && "text" in value) {
              controlSql.push((value as { readonly text: string }).text);
            }
            return query(value, values);
          },
          escapeIdentifier: client.escapeIdentifier.bind(client),
          escapeLiteral: client.escapeLiteral.bind(client),
          end: client.end.bind(client),
          release: client.release.bind(client),
        } as unknown as PgPoolClientLike;
      },
    },
    { cursor: Cursor },
  );
  try {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_routine(integer)");
    await pool.query(`
      CREATE PROCEDURE braid_pv15_routine(
        IN p integer,
        OUT answer integer,
        OUT users refcursor,
        OUT payments refcursor
      )
      LANGUAGE plpgsql AS $$
      BEGIN
        answer := p * 2;
        users := 'braid_pv15_users';
        payments := 'braid_pv15_payments';
        OPEN users FOR SELECT 1 AS user_id, 'Ada'::text AS name;
        OPEN payments FOR SELECT 10 AS payment_id, 12.5::numeric AS amount;
      END;
      $$;
    `);
    await pool.query(`
      CREATE FUNCTION braid_pv15_rows()
      RETURNS TABLE (id integer, label text)
      LANGUAGE SQL
      AS $$ VALUES (1, 'table-function'::text), (2, 'table-function-2'::text) $$;
    `);
    const tableSchema = rowSchema<{ readonly id: string; readonly label: string; readonly source: "table-function" }>(
      (value) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("id" in value) ||
          !("label" in value) ||
          typeof value.id !== "string" ||
          typeof value.label !== "string"
        ) {
          return { issues: [{ message: "invalid table-function row" }] };
        }
        const row = value as { readonly id: string; readonly label: string };
        return { value: { id: row.id, label: row.label, source: "table-function" } };
      },
    );
    const tableRows: { readonly id: string; readonly label: string; readonly source: "table-function" }[] = [];
    for await (const row of db.stream(sql.rows(tableSchema)`SELECT * FROM braid_pv15_rows()`)) tableRows.push(row);
    assert.deepEqual(tableRows, [
      { id: "1", label: "table-function", source: "table-function" },
      { id: "2", label: "table-function-2", source: "table-function" },
    ]);
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: string; readonly label: string }>`SELECT * FROM braid_pv15_rows()`),
      [
        { id: "1", label: "table-function" },
        { id: "2", label: "table-function-2" },
      ],
    );
    const outputSchema = rowSchema<{ readonly users: string }>((value) => {
      if (!value || typeof value !== "object" || !("users" in value) || typeof value.users !== "string") {
        return { issues: [{ message: "invalid PostgreSQL OUT values" }] };
      }
      return { value: { users: value.users } };
    });
    const usersSchema = rowSchema<{ readonly user_id: string; readonly name: string }>((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("user_id" in value) ||
        !("name" in value) ||
        typeof value.user_id !== "string" ||
        typeof value.name !== "string"
      ) {
        return { issues: [{ message: "invalid PostgreSQL users result set" }] };
      }
      const row = value as { readonly user_id: string; readonly name: string };
      return { value: { user_id: row.user_id, name: row.name } };
    });
    const paymentsSchema = rowSchema<{ readonly payment_id: string; readonly amount: string }>((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("payment_id" in value) ||
        !("amount" in value) ||
        typeof value.payment_id !== "string" ||
        typeof value.amount !== "string"
      ) {
        return { issues: [{ message: "invalid PostgreSQL payments result set" }] };
      }
      const row = value as { readonly payment_id: string; readonly amount: string };
      return { value: { payment_id: row.payment_id, amount: row.amount } };
    });
    const query = sql.call({
      output: outputSchema,
      resultSets: [usersSchema, paymentsSchema] as const,
      procedure: {
        name: "braid_pv15_routine",
        parameterNames: ["p", "answer", "users", "payments"],
      },
    })`
      CALL braid_pv15_routine(
        ${7},
        ${sql.out("users")},
        ${sql.out("payments", postgresParameter.refcursor())},
        ${sql.out("answer", postgresParameter.refcursor())}
      )
    `;
    await assert.rejects(() => db.call(query), /BRAID_CALL_CURSOR_TX_REQUIRED/);
    const result = await db.tx(async (tx) => {
      const before = await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
      const called = await tx.call(query);
      const after = await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
      assert.equal(after.pid, before.pid);
      return called;
    });
    assert.deepEqual(result.output, { users: "14" });
    assert.deepEqual(result.resultSets, [
      { rows: [{ user_id: "1", name: "Ada" }] },
      { rows: [{ payment_id: "10", amount: "12.5" }] },
    ]);
    assert.ok(controlSql.includes('CLOSE "braid_pv15_users"'));
    assert.ok(controlSql.includes('CLOSE "braid_pv15_payments"'));
    assert.ok(controlSql.indexOf('CLOSE "braid_pv15_users"') < controlSql.indexOf('CLOSE "braid_pv15_payments"'));

    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_fetch_failure(integer)");
    await pool.query(`
      CREATE PROCEDURE braid_pv15_fetch_failure(
        IN p integer,
        OUT users refcursor,
        OUT missing refcursor
      )
      LANGUAGE plpgsql AS $$
      BEGIN
        users := 'braid_pv15_failure_users';
        missing := 'braid_pv15_failure_missing';
        OPEN users FOR SELECT p AS user_id;
      END;
      $$;
    `);
    const fetchFailure = sql.call`
      CALL braid_pv15_fetch_failure(
        ${7},
        ${sql.out("users", postgresParameter.refcursor())},
        ${sql.out("missing", postgresParameter.refcursor())}
      )
    `;
    await assert.rejects(
      () => db.tx(async (tx) => tx.call(fetchFailure)),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((nested) => nested instanceof Error && /cursor/i.test(nested.message)),
    );
    assert.ok(controlSql.includes('CLOSE "braid_pv15_failure_users"'));
    assert.ok(controlSql.includes('CLOSE "braid_pv15_failure_missing"'));
  } finally {
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_routine(integer)").catch(() => undefined);
    await pool.query("DROP PROCEDURE IF EXISTS braid_pv15_fetch_failure(integer)").catch(() => undefined);
    await pool.query("DROP FUNCTION IF EXISTS braid_pv15_rows()").catch(() => undefined);
    await pool.end();
  }
});
