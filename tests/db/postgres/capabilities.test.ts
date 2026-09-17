import assert from "node:assert/strict";
import { Client, Pool, types } from "pg";
import { inject, test } from "vitest";
import { type Database, type ExecutionEvent } from "@sqlbraid/core";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { assertFloatBits, binary32Finite, binary64Finite, exactJsonText } from "../fidelity.js";
import { runTransparencyCase } from "../../transparency.js";

type Settings = { readonly connectionUri: string; readonly version?: string };

test("postgres.sql.native-transparency", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const events: ExecutionEvent[] = [];
  const db = createPgDatabase(client, {
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    const query = sql.rows`
      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,
             '{"enabled":true}'::jsonb ? 'enabled' AS has_key,
             ${"Ada"}::text AS actual
    `;
    const rendered = query.render();
    await runTransparencyCase({
      capabilityId: "postgres.sql.native-transparency",
      query: rendered,
      expectedSegments: [
        "\n      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,\n             '{\"enabled\":true}'::jsonb ? 'enabled' AS has_key,\n             ",
        "::text AS actual\n    ",
      ],
      expectedParameterizedSql:
        "\n      SELECT $tag$literal ? :1 @p1 $1 /*@braid*/$tag$ AS marker,\n             '{\"enabled\":true}'::jsonb ? 'enabled' AS has_key,\n             $1::text AS actual\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [
        {
          marker: "literal ? :1 @p1 $1 /*@braid*/",
          has_key: true,
          actual: "Ada",
        },
      ],
    });
  } finally {
    await client.end();
  }
});

test("postgres.sql.generated-structure", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} FROM (VALUES (${1}::integer)) AS source(value)`;
    const rendered = query.render();
    assert.deepEqual(rendered.segments, ['SELECT "value" FROM (VALUES (', "::integer)) AS source(value)"]);
    assert.deepEqual(await db.all(query), [{ value: "1" }]);
  } finally {
    await client.end();
  }
});

test("postgres.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: string;
      readonly unsafe: string;
      readonly min: string;
      readonly max: string;
    }>`
      SELECT
        9007199254740991::int8 AS safe,
        9007199254740992::int8 AS unsafe,
        (-9223372036854775808)::int8 AS min,
        9223372036854775807::int8 AS max
    `);
    assert.equal(row.safe, "9007199254740991");
    assert.equal(row.unsafe, "9007199254740992");
    assert.equal(row.min, "-9223372036854775808");
    assert.equal(row.max, "9223372036854775807");
  } finally {
    await client.end();
  }
});

test("postgres.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{
      readonly fraction: string;
      readonly trailing: string;
      readonly large: string;
      readonly scaleGreaterThanPrecision: string;
      readonly negativeScale: string;
    }>`
      SELECT
        0.1::numeric AS fraction,
        123.4500::numeric(20, 4) AS trailing,
        123456789012345678901234567890.1234567890::numeric(40, 10) AS large,
        0.00123::numeric(3, 5) AS "scaleGreaterThanPrecision",
        12345::numeric(2, -3) AS "negativeScale"
    `);
    assert.equal(row.fraction, "0.1");
    assert.equal(row.trailing, "123.4500");
    assert.equal(row.large, "123456789012345678901234567890.1234567890");
    assert.equal(row.scaleGreaterThanPrecision, "0.00123");
    assert.equal(row.negativeScale, "12000");
  } finally {
    await client.end();
  }
});

test("PostgreSQL query-local parsers isolate exact values from global overrides", async () => {
  const client = new Client({
    connectionString: inject("postgres").connectionUri,
    types: { getTypeParser: (oid, format) => (oid === 20 || oid === 1700 ? Number : types.getTypeParser(oid, format)) },
  });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const environment = await db.environment();
    assert.equal(environment.capabilities["numeric.exact-integer"]?.status, "guaranteed");
    assert.equal(environment.capabilities["numeric.exact-decimal"]?.status, "guaranteed");
    assert.deepEqual(
      await db.one(sql.rows`SELECT 9007199254740993::int8 AS integer_value, 0.1::numeric AS decimal_value`),
      { integer_value: "9007199254740993", decimal_value: "0.1" },
    );
  } finally {
    await client.end();
  }
});

test("postgres.data.json-native", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_json (id integer PRIMARY KEY, payload jsonb NOT NULL)");
    await db.execute(
      sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, ${JSON.stringify({ enabled: true, nested: { count: 2 } })}::jsonb)`,
    );
    const row = await db.one(sql.rows<{ readonly payload: unknown; readonly hasEnabled: boolean }>`
      SELECT payload, payload ? ${"enabled"} AS "hasEnabled"
      FROM braid_pv16_json
      WHERE id = ${1}
    `);
    assert.deepEqual(JSON.parse(row.payload as string), { enabled: true, nested: { count: 2 } });
    assert.equal(row.hasEnabled, true);
  } finally {
    await client.end();
  }
});

test("postgres.data.temporal", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{ readonly date_value: string; readonly instant: string }>`
      SELECT DATE '2026-09-14' AS date_value, TIMESTAMPTZ '2026-09-14 12:34:56.123456+00' AS instant
    `);
    assert.equal(row.date_value, "2026-09-14");
    assert.equal(row.instant, "2026-09-14 12:34:56.123456+00");
  } finally {
    await client.end();
  }
});

test("postgres.pv18.parser-profiles", { timeout: 30_000 }, async () => {
  const client = new Client({ connectionString: (inject("postgres") as Settings).connectionUri });
  await client.connect();
  const db = createPgDatabase(client, { parserProfile: { json: "native", temporal: "native" } });
  try {
    const row = await db.one(sql.rows<{ readonly payload: unknown; readonly instant: Date }>`
      SELECT '{"nested":{"digits":9007199254740993}}'::jsonb AS payload,
             TIMESTAMPTZ '2026-09-14 12:34:56.123456+00' AS instant
    `);
    assert.deepEqual(row.payload, { nested: { digits: 9007199254740993 } });
    assert.ok(row.instant instanceof Date);
    assert.equal(row.instant.toISOString(), "2026-09-14T12:34:56.123Z");
    const environment = await db.environment();
    assert.equal(environment.driver.profile, "pg-native");
    assert.equal(environment.capabilities["data.json-lossless-text"]?.status, "unsupported");
    assert.equal(environment.capabilities["data.temporal-lossless"]?.status, "unsupported");
    assert.equal(environment.capabilities["data.json-parsed"]?.status, "guarded");
    assert.equal(environment.capabilities["data.temporal-native"]?.status, "guarded");
  } finally {
    await client.end();
  }
});

test("postgres.pv17.numeric-transport", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query(
      "CREATE TEMP TABLE braid_pv17_fidelity (id bigint NOT NULL, amount numeric(40, 20) NOT NULL, payload json NOT NULL, measured_at timestamp(6) NOT NULL)",
    );
    const values = [
      { id: "9007199254740993", amount: "12345678901234567890.12345678901234567890" },
      { id: "-9223372036854775808", amount: "-0.00000000000000000001" },
    ];
    const bulk = await db.bulk(
      values,
      (input) => sql.command`
      INSERT INTO braid_pv17_fidelity (id, amount, payload, measured_at)
      VALUES (${input.id}::int8, ${input.amount}::numeric, ${exactJsonText}::json, TIMESTAMP '2026-09-14 12:34:56.123456')
    `,
    );
    assert.equal(bulk.inputCount, 2);
    assert.equal(bulk.affectedRows, 2);

    const row = await db.one(sql.rows<{
      readonly id: string;
      readonly amount: string;
      readonly total: string;
      readonly average: string;
      readonly count: string;
      readonly payload: string;
      readonly measured_at: string;
    }>`
      SELECT id, amount,
             SUM(amount) OVER () AS total,
             AVG(amount) OVER () AS average,
             COUNT(*) OVER () AS count,
             payload,
             measured_at
      FROM braid_pv17_fidelity
      WHERE id = ${values[0]!.id}::int8
    `);
    assert.equal(row.id, values[0]!.id);
    assert.equal(row.amount, values[0]!.amount);
    assert.equal(row.total, values[0]!.amount);
    assert.equal(row.average, values[0]!.amount);
    assert.equal(row.count, "1");
    assert.equal(row.payload, exactJsonText);
    assert.equal(row.measured_at, "2026-09-14 12:34:56.123456");

    const aggregates = await db.one(sql.rows<{
      readonly count: string;
      readonly sumInt: string;
      readonly sumBig: string;
      readonly avgInt: string;
      readonly avgNumeric: string;
    }>`
      SELECT COUNT(*) AS count,
             SUM(1::int4) AS "sumInt",
             SUM(1::int8) AS "sumBig",
             AVG(1::int4) AS "avgInt",
             AVG(1::numeric) AS "avgNumeric"
      FROM generate_series(1, 2)
    `);
    assert.equal(aggregates.count, "2");
    assert.equal(aggregates.sumInt, "2");
    assert.equal(aggregates.sumBig, "2");
    assert.match(aggregates.avgInt, /^1(?:\.0+)?$/u);
    assert.match(aggregates.avgNumeric, /^1(?:\.0+)?$/u);

    const floats = await db.one(sql.rows<Record<string, number>>`
      SELECT
        0::float8 AS f64_0, -0::float8 AS f64_neg_zero,
        0.1::float8 AS f64_fraction, 1.2345678901234567::float8 AS f64_value,
        2.2250738585072014e-308::float8 AS f64_min_normal, 1.7976931348623157e308::float8 AS f64_max,
        5e-324::float8 AS f64_subnormal, 1.0000000000000002::float8 AS f64_roundtrip,
        0::float4 AS f32_0, -0::float4 AS f32_neg_zero,
        0.1::float4 AS f32_fraction, 1.234567::float4 AS f32_value,
        1.17549435e-38::float4 AS f32_min_normal, 3.4028235e38::float4 AS f32_max,
        1.40129846e-45::float4 AS f32_subnormal, 1.0000001192092896::float4 AS f32_roundtrip
    `);
    for (const [index, expected] of binary64Finite.entries()) {
      const key = [
        "f64_0",
        "f64_neg_zero",
        "f64_fraction",
        "f64_value",
        "f64_min_normal",
        "f64_max",
        "f64_subnormal",
        "f64_roundtrip",
      ][index]!;
      assertFloatBits(floats[key], expected, 64);
    }
    for (const [index, expected] of binary32Finite.entries()) {
      const key = [
        "f32_0",
        "f32_neg_zero",
        "f32_fraction",
        "f32_value",
        "f32_min_normal",
        "f32_max",
        "f32_subnormal",
        "f32_roundtrip",
      ][index]!;
      assertFloatBits(floats[key], expected, 32);
    }
    await assert.rejects(() => db.one(sql.rows`SELECT 1.23::money AS value`), { code: "BRAID_RESULT_EXACTNESS" });
  } finally {
    await client.end();
  }
});

test("postgres.data.binary", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT decode('00ff10', 'hex') AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await client.end();
  }
});

test("postgres.data.uuid", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    const row = await db.one(
      sql.rows<{ readonly id: string }>`SELECT '550e8400-e29b-41d4-a716-446655440000'::uuid AS id`,
    );
    assert.equal(row.id, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await client.end();
  }
});

test("postgres.dml.insert-returning", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const events: ExecutionEvent[] = [];
  const db = createPgDatabase(client, {
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv16_capability");
    await client.query(
      "CREATE TABLE braid_pv16_capability (id integer PRIMARY KEY, name text NOT NULL, team_id integer NOT NULL)",
    );
    await client.query(
      "INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (1, 'Ada', 10), (2, 'Bob', 20), (3, 'Cara', 20)",
    );
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "postgres",
      expectedMode: "prepared-loop",
      events,
    });
    assert.equal(bulkReport.executionMode, "prepared-loop");
    assert.deepEqual(
      await db.bulk(
        [
          { id: 10, name: "Bulk-A", team_id: 30 },
          { id: 11, name: "Bulk-B", team_id: 30 },
        ],
        (input) =>
          sql.command`INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${input.id}, ${input.name}, ${input.team_id})`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );

    const inserted = await db.all(
      sql.rows`INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${4}, ${"Dora"}, ${10}) RETURNING id, name`,
    );
    assert.deepEqual(inserted, [{ id: "4", name: "Dora" }]);
    const updated = await db.all(
      sql.rows`UPDATE braid_pv16_capability SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`,
    );
    assert.deepEqual(updated, [{ id: "2", name: "Bobby" }]);
    const deleted = await db.all(sql.rows`DELETE FROM braid_pv16_capability WHERE id = ${3} RETURNING id, name`);
    assert.deepEqual(deleted, [{ id: "3", name: "Cara" }]);
    const upserted = await db.all(sql.rows`
      INSERT INTO braid_pv16_capability (id, name, team_id) VALUES (${2}, ${"Robert"}, ${20})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name
    `);
    assert.deepEqual(upserted, [{ id: "2", name: "Robert" }]);
    const joined = await db.all(sql.rows`
      UPDATE braid_pv16_capability AS target
      SET name = source.name
      FROM (VALUES (${1}::integer, ${"Grace"}::text)) AS source(id, name)
      WHERE target.id = source.id
      RETURNING target.id, target.name
    `);
    assert.deepEqual(joined, [{ id: "1", name: "Grace" }]);
    const using = await db.all(sql.rows<{ readonly id: string }>`
      DELETE FROM braid_pv16_capability AS target
      USING (VALUES (${10}::integer)) AS doomed(team_id)
      WHERE target.team_id = doomed.team_id
      RETURNING target.id
    `);
    assert.deepEqual(
      [...using].sort((left, right) => Number(left.id) - Number(right.id)),
      [{ id: "1" }, { id: "4" }],
    );
    const withDml = await db.all(sql.rows`
      WITH moved AS (
        UPDATE braid_pv16_capability SET name = ${"Moved"} WHERE id = ${2} RETURNING id, name
      ) SELECT id, name FROM moved
    `);
    assert.deepEqual(withDml, [{ id: "2", name: "Moved" }]);

    await assert.rejects(() => db.execute(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/u);

    const version = Number(
      (await client.query<{ server_version_num: string }>("SHOW server_version_num")).rows[0]?.server_version_num ?? 0,
    );
    if (version >= 180000) {
      const merge = await db.all(sql.rows<{
        readonly action: string;
        readonly old_id: string | null;
        readonly new_id: string | null;
      }>`
        MERGE INTO braid_pv16_capability AS target
        USING (VALUES (${2}::integer, ${"Merged"}::text), (${5}::integer, ${"Eve"}::text)) AS source(id, name)
        ON target.id = source.id
        WHEN MATCHED THEN UPDATE SET name = source.name
        WHEN NOT MATCHED THEN INSERT (id, name, team_id) VALUES (source.id, source.name, 30)
        RETURNING merge_action() AS action, old.id AS old_id, new.id AS new_id
      `);
      assert.deepEqual(
        [...merge].sort((left, right) => Number(left.new_id ?? -1) - Number(right.new_id ?? -1)),
        [
          { action: "UPDATE", old_id: "2", new_id: "2" },
          { action: "INSERT", old_id: null, new_id: "5" },
        ],
      );
      const oldNew = await db.all(sql.rows`
        UPDATE braid_pv16_capability SET name = ${"Final"} WHERE id = ${2}
        RETURNING old.name AS old_name, new.name AS new_name
      `);
      assert.deepEqual(oldNew, [{ old_name: "Merged", new_name: "Final" }]);
    }
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv16_capability").catch(() => undefined);
    await client.end();
  }
});

test("postgres.dml.update-returning", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_update (id integer PRIMARY KEY, name text NOT NULL)");
    await client.query("INSERT INTO braid_pv16_update VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(
      await db.all(sql.rows`UPDATE braid_pv16_update SET name = ${"Bobby"} WHERE id = ${2} RETURNING id, name`),
      [{ id: "2", name: "Bobby" }],
    );
  } finally {
    await client.end();
  }
});

test("postgres.dml.delete-returning", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  const db = createPgDatabase(client);
  try {
    await client.query("CREATE TEMP TABLE braid_pv16_delete (id integer PRIMARY KEY, name text NOT NULL)");
    await client.query("INSERT INTO braid_pv16_delete VALUES (1, 'Ada'), (2, 'Bob')");
    assert.deepEqual(await db.all(sql.rows`DELETE FROM braid_pv16_delete WHERE id = ${1} RETURNING id, name`), [
      { id: "1", name: "Ada" },
    ]);
  } finally {
    await client.end();
  }
});

test(
  "postgres.rc sessions, prepared execution, and transaction options preserve one backend",
  { timeout: 30_000 },
  async () => {
    const settings = inject("postgres") as Settings;
    const pool = new Pool({ connectionString: settings.connectionUri, max: 1, idleTimeoutMillis: 0 });
    const db = createPgPoolDatabase(pool);
    try {
      const environment = await db.environment();
      for (const capability of [
        "session.pinned",
        "statement.prepare",
        "transaction.read-only",
        "transaction.isolation.read-uncommitted",
        "transaction.isolation.read-committed",
        "transaction.isolation.repeatable-read",
        "transaction.isolation.serializable",
        "statement.cancel",
      ])
        assert.ok(environment.capabilities[capability]);
      const levels = [
        ["read-uncommitted", "read uncommitted"],
        ["read-committed", "read committed"],
        ["repeatable-read", "repeatable read"],
        ["serializable", "serializable"],
      ] as const;
      for (const [isolation, expected] of levels) {
        await db.tx({ isolation }, async (tx) => {
          const row = await tx.one(
            sql.rows<{ readonly isolation: string }>`SELECT current_setting('transaction_isolation') AS isolation`,
          );
          assert.equal(row.isolation, expected);
        });
      }
      await db.tx({ readOnly: true }, async (tx) => {
        const row = await tx.one(
          sql.rows<{ readonly readOnly: string }>`SELECT current_setting('transaction_read_only') AS "readOnly"`,
        );
        assert.equal(row.readOnly, "on");
      });

      let scoped: Database | undefined;
      await db.session(async (session) => {
        scoped = session;
        const first = await session.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
        await assert.rejects(
          () => db.execute(sql`SELECT 1`),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_SCOPE",
        );
        const prepared = session.prepare(
          "postgres-rc-session-pid",
          (value: string) => sql.rows<{ readonly pid: string; readonly value: string }>`
          SELECT pg_backend_pid() AS pid, ${value}::text AS value
        `,
        );
        const row = await prepared.one("prepared");
        assert.equal(row.pid, first.pid);
        assert.equal(row.value, "prepared");
        await session.tx({ isolation: "serializable" }, async (tx) => {
          const nested = await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
          assert.equal(nested.pid, first.pid);
        });
        await session.session(async (nestedSession) => {
          const nested = await nestedSession.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
          assert.equal(nested.pid, first.pid);
        });
      });
      await assert.rejects(
        () => scoped!.execute(sql`SELECT 1`),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_CLOSED",
      );
    } finally {
      await pool.end();
    }
  },
);

test("postgres.rc cancellation destroys an in-flight pooled connection before reuse", { timeout: 30_000 }, async () => {
  const settings = inject("postgres") as Settings;
  const pool = new Pool({ connectionString: settings.connectionUri, max: 1, idleTimeoutMillis: 0 });
  const db = createPgPoolDatabase(pool);
  try {
    const cancel = async (operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
      const controller = new AbortController();
      const reason = new Error("cancel PostgreSQL sleep");
      const pending = operation(controller.signal);
      const abortTimer = setTimeout(() => controller.abort(reason), 100);
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        pending.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ readonly kind: "timeout" }>((resolve) => {
          timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), 5_000);
        }),
      ]);
      clearTimeout(abortTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (outcome.kind === "resolved") throw new Error("PostgreSQL sleep unexpectedly completed after cancellation.");
      if (outcome.kind === "timeout") throw new Error("PostgreSQL cancellation did not settle within 5 seconds.");
      assert.equal(
        outcome.error instanceof Error && "code" in outcome.error ? outcome.error.code : undefined,
        "BRAID_RESOURCE_CLEANUP",
      );
      assert.equal(outcome.error instanceof Error ? outcome.error.cause : undefined, reason);
    };

    const before = await db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
    await cancel((signal) => db.one(sql.rows`SELECT pg_sleep(30) AS slept`, { signal }));
    const prepared = db.prepare("postgres-rc-cancel-prepared", () => sql.rows`SELECT pg_sleep(30) AS slept`, {
      input: "none",
    });
    await cancel((signal) => prepared.one({ signal }));
    await cancel((signal) => db.call(sql.call`SELECT pg_sleep(30) AS slept`, { signal }));
    await cancel((signal) => db.bulk([30], (seconds) => sql.command`SELECT pg_sleep(${seconds})`, { signal }));
    const after = await db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`);
    assert.notEqual(after.pid, before.pid);
  } finally {
    await pool.end();
  }
});
