import assert from "node:assert/strict";
import { createConnection, createPool, type Connection, type RowDataPacket } from "mysql2/promise";
import { inject, test } from "vitest";
import { type Database, type ExecutionEvent } from "@sqlbraid/core";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";
import {
  assertFloatBits,
  assertRepresentationConformance,
  binary32Finite,
  binary64Finite,
  exactJsonText,
} from "../fidelity.js";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { runTransparencyCase } from "../../transparency.js";

interface Settings {
  readonly connectionUri: string;
}

async function connect(
  overrides: Partial<{
    readonly jsonStrings: boolean;
    readonly dateStrings: boolean;
  }> = {},
): Promise<Connection> {
  const settings = inject("mysql") as Settings;
  const uri = new URL(settings.connectionUri);
  return createConnection({
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 3306,
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.replace(/^\//u, "")),
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    rowsAsArray: false,
    jsonStrings: overrides.jsonStrings ?? true,
    dateStrings: overrides.dateStrings ?? true,
  });
}

test("mysql.sql.native-transparency", { timeout: 30_000 }, async () => {
  const connection = await connect({ jsonStrings: false, dateStrings: false });
  const events: ExecutionEvent[] = [];
  const db = createMysql2Database(connection, {
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
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,
             ${7} AS actual
    `;
    await runTransparencyCase({
      capabilityId: "mysql.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,\n             ",
        " AS actual\n    ",
      ],
      expectedParameterizedSql:
        "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             JSON_EXTRACT(JSON_OBJECT('enabled', TRUE), '$.enabled') AS enabled,\n             ? AS actual\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal $1 :1 @p1 ?", enabled: true, actual: 7 }],
    });
  } finally {
    await connection.end();
  }
});

test("mysql.sql.generated-structure", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} AS value FROM (SELECT ${1} AS value) AS source`;
    assert.deepEqual(query.render().segments, ["SELECT `value` AS value FROM (SELECT ", " AS value) AS source"]);
    assert.deepEqual(await db.all(query), [{ value: 1 }]);
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly safe: string;
      readonly unsafe: string;
      readonly min: string;
      readonly max: string;
    }>`
      SELECT
        CAST('9007199254740991' AS SIGNED) AS safe,
        CAST('9007199254740992' AS SIGNED) AS unsafe,
        CAST('-9223372036854775808' AS SIGNED) AS min,
        CAST('9223372036854775807' AS SIGNED) AS max
    `);
    assert.equal(row.safe, "9007199254740991");
    assert.equal(row.unsafe, "9007199254740992");
    assert.equal(row.min, "-9223372036854775808");
    assert.equal(row.max, "9223372036854775807");
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly fraction: string;
      readonly trailing_value: string;
      readonly large: string;
    }>`
      SELECT
        CAST('0.1' AS DECIMAL(20, 10)) AS fraction,
        CAST('123.4500' AS DECIMAL(20, 4)) AS trailing_value,
        CAST('123456789012345678901234567890.1234567890' AS DECIMAL(40, 10)) AS large
    `);
    assert.equal(row.fraction, "0.1000000000");
    assert.equal(row.trailing_value, "123.4500");
    assert.equal(row.large, "123456789012345678901234567890.1234567890");
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.approximate-float", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    for (const expected of binary64Finite) {
      const literal = Object.is(expected, -0) ? "-0.0e0" : String(expected);
      const row = await db.one(sql.rows<{ readonly value: number }>`SELECT CAST(${literal} AS DOUBLE) AS value`);
      assertFloatBits(row.value, expected, 64);
    }
    for (const expected of binary32Finite) {
      const literal = Object.is(expected, -0) ? "-0.0e0" : String(expected);
      const row = await db.one(sql.rows<{ readonly value: number }>`SELECT CAST(${literal} AS FLOAT) AS value`);
      assertFloatBits(row.value, expected, 32);
    }
  } finally {
    await connection.end();
  }
});

test("mysql.numeric.exact-bind", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    await connection.query(
      "CREATE TEMPORARY TABLE braid_pv17_bind (id BIGINT NOT NULL, amount DECIMAL(40, 20) NOT NULL)",
    );
    const insert = sql.command`INSERT INTO braid_pv17_bind (id, amount) VALUES (${"9007199254740993"}, ${"12345678901234567890.12345678901234567890"})`;
    await db.execute(insert);
    await db.execute(sql.command`INSERT INTO braid_pv17_bind (id, amount) VALUES (${1}, ${"0.10000000000000000001"})`);
    assert.deepEqual(
      await db.bulk(
        [
          { id: "9007199254740994", amount: "12345678901234567890.12345678901234567891" },
          { id: "9007199254740995", amount: "12345678901234567890.12345678901234567892" },
        ],
        (input) => sql.command`INSERT INTO braid_pv17_bind (id, amount) VALUES (${input.id}, ${input.amount})`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );
    const rows = await db.all(
      sql.rows<{ readonly id: string; readonly amount: string }>`SELECT id, amount FROM braid_pv17_bind ORDER BY id`,
    );
    assert.deepEqual(rows, [
      { id: "1", amount: "0.10000000000000000001" },
      { id: "9007199254740993", amount: "12345678901234567890.12345678901234567890" },
      { id: "9007199254740994", amount: "12345678901234567890.12345678901234567891" },
      { id: "9007199254740995", amount: "12345678901234567890.12345678901234567892" },
    ]);
  } finally {
    await connection.end();
  }
});

test("mysql.data.json-native", { timeout: 30_000 }, async () => {
  const connection = await connect({ jsonStrings: false, dateStrings: false });
  const db = createMysql2Database(connection);
  try {
    await connection.query("CREATE TEMPORARY TABLE braid_pv16_json (id INT PRIMARY KEY, payload JSON NOT NULL)");
    await db.execute(
      sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, ${JSON.stringify({ enabled: true, nested: { count: 2 } })})`,
    );
    const row = await db.one(sql.rows<{ readonly payload: unknown; readonly enabled: number }>`
      SELECT payload, JSON_EXTRACT(payload, '$.nested.count') AS enabled
      FROM braid_pv16_json
      WHERE id = ${1}
    `);
    assert.deepEqual(row.payload, { enabled: true, nested: { count: 2 } });
    assert.equal(row.enabled, 2);
    const roots = await db.one(sql.rows<{
      readonly object_value: unknown;
      readonly array_value: unknown;
      readonly null_value: unknown;
    }>`
      SELECT JSON_OBJECT('enabled', TRUE) AS object_value,
             JSON_ARRAY(1, TRUE, 'text') AS array_value,
             JSON_EXTRACT('null', '$') AS null_value
    `);
    assert.deepEqual(roots.object_value, { enabled: true });
    assert.deepEqual(roots.array_value, [1, true, "text"]);
    assert.equal(roots.null_value, null);
  } finally {
    await connection.end();
  }
});

test("mysql.data.json-lossless-text", { timeout: 30_000 }, async () => {
  const connection = await connect({ jsonStrings: true, dateStrings: true });
  const db = createMysql2Database(connection);
  try {
    const environment = await db.environment();
    assert.equal(environment.driver.profile, "mysql2-lossless-text");
    assert.equal(environment.capabilities["data.json-lossless-text"]?.status, "guaranteed");
    assert.equal(environment.capabilities["data.temporal-lossless"]?.status, "guaranteed");
    const [rawProfileRows] = await connection.query<RowDataPacket[]>(`
      SELECT 7 AS integer_literal_value,
             CAST('9223372036854775807' AS SIGNED) AS big_value,
             CAST('123.4500' AS DECIMAL(20, 4)) AS decimal_value,
             CAST('1.25' AS DOUBLE) AS float_value,
             JSON_OBJECT('enabled', TRUE) AS json_value,
             CAST('2026-09-14 12:34:56.123456' AS DATETIME(6)) AS temporal_value
    `);
    const rawProfile = rawProfileRows[0]!;
    assert.equal(typeof rawProfile.integer_literal_value, "string");
    assert.equal(typeof rawProfile.big_value, "string");
    assert.equal(typeof rawProfile.decimal_value, "string");
    assert.equal(typeof rawProfile.float_value, "number");
    assert.equal(typeof rawProfile.json_value, "string");
    assert.equal(typeof rawProfile.temporal_value, "string");
    const canonicalDecimal = await db.one(
      sql.rows<{ readonly value: string }>`SELECT CAST('123.4500' AS DECIMAL(20, 4)) AS value`,
    );
    assertRepresentationConformance(
      rawProfile.decimal_value,
      "123.4500",
      canonicalDecimal.value,
      "123.4500",
      MYSQL2_LOSSLESS_TEXT.typePolicy,
      "DECIMAL",
      "string",
    );
    await connection.query("CREATE TEMPORARY TABLE braid_pv17_json (payload JSON NOT NULL)");
    await db.execute(sql.command`INSERT INTO braid_pv17_json (payload) VALUES (${exactJsonText})`);
    const row = await db.one(sql.rows<{ readonly payload: string }>`SELECT payload FROM braid_pv17_json`);
    // MySQL JSON canonicalizes its binary representation (including decimal rounding and key/whitespace formatting).
    // This fixture checks transport of that native JSON text; exact decimal JSON fidelity is covered by the TEXT column below.
    const [nativeRows] = await connection.query<(RowDataPacket & { readonly payload: string })[]>(
      "SELECT CAST(payload AS CHAR) AS payload FROM braid_pv17_json",
    );
    const nativePayload = nativeRows[0]?.payload;
    assert.equal(typeof row.payload, "string");
    assert.equal(typeof nativePayload, "string");
    assert.equal(row.payload, nativePayload);
    assert.match(row.payload, /"largeInteger":\s*9223372036854775807/u);

    await connection.query("CREATE TEMPORARY TABLE braid_pv17_json_text (payload TEXT NOT NULL)");
    await db.execute(sql.command`INSERT INTO braid_pv17_json_text (payload) VALUES (${exactJsonText})`);
    const text = await db.one(sql.rows<{ readonly payload: string }>`SELECT payload FROM braid_pv17_json_text`);
    assert.equal(text.payload, exactJsonText);

    const temporal = await db.one(
      sql.rows<{ readonly value: string }>`SELECT CAST('2026-09-14 12:34:56.123456' AS DATETIME(6)) AS value`,
    );
    assert.equal(temporal.value, "2026-09-14 12:34:56.123456");
    await connection.query(`
      CREATE TEMPORARY TABLE braid_pv18_temporal (
        date_value DATE,
        time_value TIME(6),
        datetime_value DATETIME(6),
        timestamp_value TIMESTAMP(6)
      )
    `);
    await connection.query(
      "INSERT INTO braid_pv18_temporal VALUES ('2026-09-14', '12:34:56.123456', '2026-09-14 12:34:56.123456', '2026-09-14 12:34:56.123456')",
    );
    assert.deepEqual(
      await db.one(
        sql.rows<{
          readonly date_value: string;
          readonly time_value: string;
          readonly datetime_value: string;
          readonly timestamp_value: string;
        }>`SELECT date_value, time_value, datetime_value, timestamp_value FROM braid_pv18_temporal`,
      ),
      {
        date_value: "2026-09-14",
        time_value: "12:34:56.123456",
        datetime_value: "2026-09-14 12:34:56.123456",
        timestamp_value: "2026-09-14 12:34:56.123456",
      },
    );
  } finally {
    await connection.end();
  }
});

test("mysql.data.temporal", { timeout: 30_000 }, async () => {
  const connection = await connect({ jsonStrings: false, dateStrings: false });
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(
      sql.rows<{ readonly instant: Date }>`SELECT CAST('2026-09-14 12:34:56' AS DATETIME) AS instant`,
    );
    assert.ok(row.instant instanceof Date);
    assert.equal(row.instant.getFullYear(), 2026);
    assert.equal(row.instant.getMonth(), 8);
    assert.equal(row.instant.getDate(), 14);
    assert.equal(row.instant.getHours(), 12);
    assert.equal(row.instant.getMinutes(), 34);
    assert.equal(row.instant.getSeconds(), 56);
  } finally {
    await connection.end();
  }
});

test("mysql.data.binary", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT UNHEX('00FF10') AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await connection.end();
  }
});

test("mysql.data.uuid", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const db = createMysql2Database(connection);
  try {
    const row = await db.one(
      sql.rows<{ readonly id: string }>`SELECT CAST('550e8400-e29b-41d4-a716-446655440000' AS CHAR(36)) AS id`,
    );
    assert.equal(row.id, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await connection.end();
  }
});

test("mysql.result.command", { timeout: 30_000 }, async () => {
  const connection = await connect();
  const events: ExecutionEvent[] = [];
  const db = createMysql2Database(connection, {
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_capability");
    await connection.query(
      "CREATE TABLE braid_pv16_capability (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, team_id INT NOT NULL, payload JSON NOT NULL)",
    );
    await connection.query(
      `INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (1, 'Ada', 10, '{"enabled": true}'), (2, 'Bob', 20, '{"enabled": false}'), (3, 'Cara', 20, '{"enabled": true}')`,
    );
    events.length = 0;
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "mysql",
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
          sql.command`INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (${input.id}, ${input.name}, ${input.team_id}, '{}')`,
      ),
      { inputCount: 2, affectedRows: 2 },
    );
    await connection.query(
      "CREATE TEMPORARY TABLE braid_pv17_command (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, amount DECIMAL(40, 20) NOT NULL)",
    );
    const inserted = await db.execute(
      sql.command`INSERT INTO braid_pv17_command (amount) VALUES (${"12345678901234567890.12345678901234567890"})`,
    );
    assert.equal(inserted.command.affectedRows, 1);
    assert.equal(inserted.command.insertId, "1");

    const lexical = await db.one(sql.rows<{ readonly id: string; readonly enabled: string }>`
      SELECT /*+ NO_INDEX(braid_pv16_capability) */ \`id\`, JSON_EXTRACT(payload, '$.enabled') AS enabled
      FROM braid_pv16_capability
      WHERE id = ${1} # a MySQL line comment
        AND name <> ${"nobody"}
    `);
    assert.equal(lexical.id, "1");
    assert.equal(lexical.enabled, "true");

    const upserted = await db.execute(sql.command`
      INSERT INTO braid_pv16_capability (id, name, team_id, payload)
      VALUES (${2}, ${"Robert"}, ${20}, '{"enabled":true}') AS incoming
      ON DUPLICATE KEY UPDATE name = incoming.name
    `);
    assert.equal(upserted.command.affectedRows, 2);
    const updated = await db.execute(sql.command`
      UPDATE braid_pv16_capability AS target
      JOIN (SELECT ${1} AS id, ${"Grace"} AS name) AS source ON source.id = target.id
      SET target.name = source.name
    `);
    assert.equal(updated.command.affectedRows, 1);

    const cte = await db.all(sql.rows`
      WITH selected AS (SELECT id, name FROM braid_pv16_capability WHERE team_id = ${20})
      SELECT id, name FROM selected ORDER BY id
    `);
    assert.deepEqual(cte, [
      { id: "2", name: "Robert" },
      { id: "3", name: "Cara" },
    ]);

    const deleted = await db.execute(sql.command`
      DELETE target FROM braid_pv16_capability AS target
      JOIN (SELECT ${10} AS team_id) AS doomed ON doomed.team_id = target.team_id
    `);
    assert.equal(deleted.command.affectedRows, 1);

    await assert.rejects(() =>
      db.execute(
        sql.rows`INSERT INTO braid_pv16_capability (id, name, team_id, payload) VALUES (${4}, ${"Dora"}, ${10}, '{}') RETURNING id`,
      ),
    );
  } finally {
    await connection.query("DROP TABLE IF EXISTS braid_pv16_capability").catch(() => undefined);
    await connection.end();
  }
});

test(
  "mysql.rc sessions, prepared execution, and transaction options preserve one connection",
  { timeout: 30_000 },
  async () => {
    const settings = inject("mysql") as Settings;
    const pool = createPool({
      uri: settings.connectionUri,
      ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
      connectionLimit: 1,
      idleTimeout: 0,
    });
    const db = createMysql2PoolDatabase(pool);
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
      await pool.query("CREATE TABLE IF NOT EXISTS braid_rc_mysql_options (value INT NOT NULL)");
      await db.tx({ readOnly: true }, async (tx) => {
        await assert.rejects(
          () => tx.execute(sql.command`INSERT INTO braid_rc_mysql_options (value) VALUES (${1})`),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION",
        );
      });

      let scoped: Database | undefined;
      await db.session(async (session) => {
        scoped = session;
        const first = await session.one(
          sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`,
        );
        await assert.rejects(
          () => db.execute(sql`SELECT 1`),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_SCOPE",
        );
        const prepared = session.prepare(
          "mysql-rc-session-id",
          (value: string) => sql.rows<{ readonly connectionId: string; readonly value: string }>`
          SELECT CONNECTION_ID() AS connectionId, ${value} AS value
        `,
        );
        const row = await prepared.one("prepared");
        assert.equal(String(row.connectionId), String(first.connectionId));
        assert.equal(row.value, "prepared");
        await session.tx({ isolation: "serializable" }, async (tx) => {
          const nested = await tx.one(
            sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`,
          );
          assert.equal(String(nested.connectionId), String(first.connectionId));
        });
        await session.session(async (nestedSession) => {
          const nested = await nestedSession.one(
            sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`,
          );
          assert.equal(String(nested.connectionId), String(first.connectionId));
        });
      });
      await assert.rejects(
        () => scoped!.execute(sql`SELECT 1`),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_CLOSED",
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS braid_rc_mysql_options").catch(() => undefined);
      await pool.end();
    }
  },
);

test("mysql.rc transaction isolation has native visibility and locking semantics", { timeout: 30_000 }, async () => {
  const settings = inject("mysql") as Settings;
  const pool = createPool({
    uri: settings.connectionUri,
    ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
    connectionLimit: 1,
    idleTimeout: 0,
  });
  const db = createMysql2PoolDatabase(pool);
  const writer = await connect();
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS braid_rc_mysql_isolation (id INT PRIMARY KEY, value VARCHAR(32) NOT NULL)",
    );
    await pool.query(
      "INSERT INTO braid_rc_mysql_isolation (id, value) VALUES (1, 'base') ON DUPLICATE KEY UPDATE value = 'base'",
    );
    const reset = async (): Promise<void> => {
      await writer.query("UPDATE braid_rc_mysql_isolation SET value = 'base' WHERE id = 1");
    };
    for (const [isolation, dirtyVisible] of [
      ["read-uncommitted", true],
      ["read-committed", false],
      ["repeatable-read", false],
    ] as const) {
      await reset();
      await writer.beginTransaction();
      await writer.query("UPDATE braid_rc_mysql_isolation SET value = 'dirty' WHERE id = 1");
      await db.tx({ isolation }, async (tx) => {
        const row = await tx.one(
          sql.rows<{ readonly value: string }>`SELECT value FROM braid_rc_mysql_isolation WHERE id = ${1}`,
        );
        assert.equal(row.value, dirtyVisible ? "dirty" : "base");
      });
      await writer.rollback();
    }
    for (const [isolation, seesCommit] of [
      ["read-committed", true],
      ["repeatable-read", false],
    ] as const) {
      await reset();
      await db.tx({ isolation }, async (tx) => {
        const before = await tx.one(
          sql.rows<{ readonly value: string }>`SELECT value FROM braid_rc_mysql_isolation WHERE id = ${1}`,
        );
        assert.equal(before.value, "base");
        await writer.query("UPDATE braid_rc_mysql_isolation SET value = 'committed' WHERE id = 1");
        const after = await tx.one(
          sql.rows<{ readonly value: string }>`SELECT value FROM braid_rc_mysql_isolation WHERE id = ${1}`,
        );
        assert.equal(after.value, seesCommit ? "committed" : "base");
      });
    }
    await reset();
    await writer.query("SET SESSION innodb_lock_wait_timeout = 1");
    await db.tx({ isolation: "serializable" }, async (tx) => {
      await tx.one(sql.rows<{ readonly value: string }>`SELECT value FROM braid_rc_mysql_isolation WHERE id = ${1}`);
      await assert.rejects(
        () => writer.query("UPDATE braid_rc_mysql_isolation SET value = 'blocked' WHERE id = 1"),
        /lock wait timeout/iu,
      );
    });
  } finally {
    await writer.rollback().catch(() => undefined);
    await writer.end();
    await pool.query("DROP TABLE IF EXISTS braid_rc_mysql_isolation").catch(() => undefined);
    await pool.end();
  }
});

test(
  "mysql.rc cancellation destroys in-flight query, call, bulk, and prepared leases",
  { timeout: 30_000 },
  async () => {
    const settings = inject("mysql") as Settings;
    const pool = createPool({
      uri: settings.connectionUri,
      ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
      connectionLimit: 1,
      idleTimeout: 0,
    });
    const db = createMysql2PoolDatabase(pool);
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS braid_rc_mysql_cancel (value INT NOT NULL)");
      const cancel = async (operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
        const controller = new AbortController();
        const reason = new Error("cancel MySQL sleep");
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
        if (outcome.kind === "resolved") throw new Error("MySQL SLEEP unexpectedly completed after cancellation.");
        if (outcome.kind === "timeout") throw new Error("MySQL cancellation did not settle within 5 seconds.");
        assert.equal(
          outcome.error instanceof Error && "code" in outcome.error ? outcome.error.code : undefined,
          "BRAID_RESOURCE_CLEANUP",
        );
        assert.equal(outcome.error instanceof Error ? outcome.error.cause : undefined, reason);
      };

      const before = await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
      await cancel((signal) => db.one(sql.rows`SELECT SLEEP(30) AS slept`, { signal }));
      const prepared = db.prepare("mysql-rc-cancel-prepared", () => sql.rows`SELECT SLEEP(30) AS slept`, {
        input: "none",
      });
      await cancel((signal) => prepared.one({ signal }));
      await cancel((signal) => db.call(sql.call`SELECT SLEEP(30) AS slept`, { signal }));
      await cancel((signal) =>
        db.bulk([30], (seconds) => sql.command`INSERT INTO braid_rc_mysql_cancel (value) SELECT SLEEP(${seconds})`, {
          signal,
        }),
      );
      const after = await db.one(sql.rows<{ readonly connectionId: string }>`SELECT CONNECTION_ID() AS connectionId`);
      assert.notEqual(String(after.connectionId), String(before.connectionId));
    } finally {
      await pool.query("DROP TABLE IF EXISTS braid_rc_mysql_cancel").catch(() => undefined);
      await pool.end();
    }
  },
);
