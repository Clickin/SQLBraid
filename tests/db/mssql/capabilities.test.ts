import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Connection, ISOLATION_LEVEL, Request } from "tedious";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ResultExactnessError, type ExecutionEvent } from "@sqlbraid/core";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { assertFloatBits, binary32Finite, binary64Finite, exactJsonText } from "../fidelity.js";
import { runTransparencyCase } from "../../transparency.js";
import { stampSupportEnvironment } from "../support-target.js";

interface MssqlSettings {
  readonly server: string;
  readonly port: number;
  readonly userName: string;
  readonly password: string;
  readonly database: string;
}

const tediousVersion = (
  JSON.parse(readFileSync(new URL("../../node_modules/tedious/package.json", import.meta.url), "utf8")) as {
    readonly version: string;
  }
).version;

function rawRow(connection: Connection, text: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let row: Record<string, unknown> = {};
    const request = new Request(text, (error) => (error ? reject(error) : resolve(row)));
    request.on(
      "row",
      (columns: readonly { readonly metadata: { readonly colName: string }; readonly value: unknown }[]) => {
        row = Object.fromEntries(columns.map((column) => [column.metadata.colName, column.value]));
      },
    );
    connection.execSql(request);
  });
}

function connect(settings: MssqlSettings): Promise<Connection> {
  const connection = new Connection({
    server: settings.server,
    options: {
      port: settings.port,
      database: settings.database,
      encrypt: false,
      trustServerCertificate: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      connectionIsolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
    },
    authentication: { type: "default", options: { userName: settings.userName, password: settings.password } },
  });
  return new Promise<Connection>((resolve, reject) => {
    connection.once("connect", (error) => (error ? reject(error) : resolve(connection)));
    connection.connect();
  });
}

async function stampMssqlEnvironment(db: ReturnType<typeof createTediousDatabase>, testId: string): Promise<void> {
  const environment = await db.environment();
  const probe = await db.one(sql.rows<{
    readonly version: string;
    readonly edition: string;
    readonly major_version: string;
    readonly update_level: string | null;
  }>`
    SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
           CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
           CAST(SERVERPROPERTY('ProductMajorVersion') AS nvarchar(16)) AS major_version,
           CAST(SERVERPROPERTY('ProductUpdateLevel') AS nvarchar(32)) AS update_level
  `);
  assert.ok(probe.version && probe.edition && probe.major_version);
  const major = probe.major_version === "16" ? "2022" : probe.major_version;
  const databaseVersion = probe.update_level ? `${major}-${probe.update_level}` : probe.version;
  const edition = /^(Developer|Enterprise|Standard|Express)/u.exec(probe.edition)?.[1] ?? probe.edition;
  stampSupportEnvironment(
    "mssql",
    {
      ...environment,
      database: { product: "mssql", version: databaseVersion, edition },
      driver: { ...environment.driver, version: tediousVersion },
      runtime: { id: "node", version: process.versions.node },
    },
    testId,
  );
}

async function close(connection: Connection): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.once("end", resolve);
    connection.close();
    setTimeout(resolve, 500);
  });
}

test("mssql.sql.native-transparency", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const events: ExecutionEvent[] = [];
  const db = createTediousDatabase(connection, {
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
      SELECT N'literal @p1 ? :1 $1' AS [marker],
             JSON_VALUE(N'{"enabled":true}', '$.enabled') AS [enabled],
             CAST(${7} AS int) AS [actual]
    `;
    await runTransparencyCase({
      capabilityId: "mssql.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT N'literal @p1 ? :1 $1' AS [marker],\n             JSON_VALUE(N'{\"enabled\":true}', '$.enabled') AS [enabled],\n             CAST(",
        " AS int) AS [actual]\n    ",
      ],
      expectedParameterizedSql:
        "\n      SELECT N'literal @p1 ? :1 $1' AS [marker],\n             JSON_VALUE(N'{\"enabled\":true}', '$.enabled') AS [enabled],\n             CAST(@p1 AS int) AS [actual]\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ marker: "literal @p1 ? :1 $1", enabled: "true", actual: "7" }],
    });
  } finally {
    await close(connection);
  }
});

test("mssql.sql.generated-structure", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("value")} FROM (VALUES (${1})) AS source([value])`;
    assert.deepEqual(query.render().segments, ["SELECT [value] FROM (VALUES (", ")) AS source([value])"]);
    assert.deepEqual(await db.all(query), [{ value: "1" }]);
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.exact-integer", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    assert.equal((await db.environment()).capabilities["numeric.exact-integer"]?.canonical, "string");
    const raw = await rawRow(
      connection,
      "SELECT CAST('2147483647' AS int) AS standard, CAST('9223372036854775807' AS bigint) AS max",
    );
    assert.deepEqual(raw, { standard: 2147483647, max: "9223372036854775807" });
    const row = await db.one(sql.rows<{
      readonly tiny: string;
      readonly small: string;
      readonly standard: string;
      readonly safe: string;
      readonly unsafe: string;
      readonly min: string;
      readonly max: string;
    }>`
      SELECT
        CAST('255' AS tinyint) AS tiny,
        CAST('-32768' AS smallint) AS small,
        CAST('2147483647' AS int) AS standard,
        CAST('9007199254740991' AS bigint) AS safe,
        CAST('9007199254740992' AS bigint) AS unsafe,
        CAST('-9223372036854775808' AS bigint) AS min,
        CAST('9223372036854775807' AS bigint) AS max
    `);
    assert.deepEqual(row, {
      tiny: "255",
      small: "-32768",
      standard: "2147483647",
      safe: "9007199254740991",
      unsafe: "9007199254740992",
      min: "-9223372036854775808",
      max: "9223372036854775807",
    });
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.exact-decimal", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    assert.equal((await db.environment()).capabilities["numeric.exact-decimal"]?.status, "unsupported");
    const exact = "1234567890123456789012345678.1234567890";
    await assert.rejects(
      () =>
        db.one(sql.rows`
        SELECT CAST(${sql.bind(exact, mssqlParameter.nvarchar(80))} AS decimal(38, 10)) AS decimal_value,
               CAST('123.4500' AS numeric(19, 4)) AS numeric_value,
               CAST('12.3456' AS money) AS money_value,
               CAST('-7.8901' AS smallmoney) AS smallmoney_value
      `),
      (error: unknown) => error instanceof ResultExactnessError && error.code === "BRAID_RESULT_EXACTNESS",
    );
    await assert.rejects(
      () =>
        db.one(
          sql.rows`SELECT SUM(CAST(${sql.bind(exact, mssqlParameter.nvarchar(80))} AS decimal(38, 10))) AS aggregate_value`,
        ),
      (error: unknown) => error instanceof ResultExactnessError && error.code === "BRAID_RESULT_EXACTNESS",
    );
    await assert.rejects(
      () => db.one(sql.rows`SELECT AVG(CAST('12.3456' AS money)) AS aggregate_value`),
      (error: unknown) => error instanceof ResultExactnessError && error.code === "BRAID_RESULT_EXACTNESS",
    );
    const row = await db.one(sql.rows<{ readonly value: string }>`
      SELECT CONVERT(varchar(64), CAST(${sql.bind(exact, mssqlParameter.nvarchar(80))} AS decimal(38, 10))) AS value
    `);
    assert.equal(row.value, exact);
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.approximate-float", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    assert.equal((await db.environment()).capabilities["numeric.approximate-float"]?.status, "guaranteed");
    for (const expected of binary32Finite) {
      const normalized = Math.fround(expected);
      if (!Number.isFinite(normalized)) continue;
      const row = await db.one(
        sql.rows<{
          readonly value: number;
        }>`SELECT CAST(${sql.bind(expected, { databaseType: "real" })} AS real) AS value`,
      );
      if (Object.is(expected, -0)) {
        assert.equal(Object.is(row.value, -0), false, "SQL Server normalizes -0 to +0");
        assertFloatBits(row.value, 0, 32);
      } else {
        assertFloatBits(row.value, normalized, 32);
      }
    }
    for (const expected of binary64Finite) {
      const row = await db.one(
        sql.rows<{
          readonly value: number;
        }>`SELECT CAST(${sql.bind(expected, { databaseType: "float" })} AS float) AS value`,
      );
      if (Object.is(expected, -0)) {
        assert.equal(Object.is(row.value, -0), false, "SQL Server normalizes -0 to +0");
        assertFloatBits(row.value, 0, 64);
      } else {
        assertFloatBits(row.value, expected, 64);
      }
    }
  } finally {
    await close(connection);
  }
});

test("mssql.numeric.exact-bind-character", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  const exact = "1234567890123456789012345678.1234567890";
  const second = "-987654321098765432109876543.0123456789";
  try {
    assert.equal((await db.environment()).capabilities["numeric.bind-exact"]?.status, "guarded");
    const query = sql.rows<{ readonly value: string }>`
      SELECT CONVERT(varchar(64), CAST(${sql.bind(exact, mssqlParameter.nvarchar(80))} AS decimal(38, 10))) AS value
    `;
    assert.equal((await db.one(query)).value, exact);
    const prepared = db.prepare("mssql-exact-character", () => query, { input: "none" });
    assert.equal((await prepared.execute()).rows[0]?.value, exact);

    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv17_exact_bind`);
    await db.execute(sql`CREATE TABLE dbo.braid_pv17_exact_bind (value decimal(38, 10) NOT NULL)`);
    await db.bulk(
      [exact, second],
      (value) => sql.command`
      INSERT INTO dbo.braid_pv17_exact_bind (value)
      VALUES (CAST(${sql.bind(value, mssqlParameter.nvarchar(80))} AS decimal(38, 10)))
    `,
    );
    const rows = await db.all(sql.rows<{ readonly value: string }>`
      SELECT CONVERT(varchar(64), value) AS value
      FROM dbo.braid_pv17_exact_bind
      ORDER BY value
    `);
    assert.deepEqual(
      rows.map((row) => row.value),
      [second, exact],
    );
  } finally {
    await createTediousDatabase(connection)
      .execute(sql`DROP TABLE IF EXISTS dbo.braid_pv17_exact_bind`)
      .catch(() => undefined);
    await close(connection);
  }
});

test("mssql.data.json-lossless-text", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    assert.equal((await db.environment()).capabilities["data.json-lossless-text"]?.status, "guaranteed");
    const row = await db.one(sql.rows<{ readonly payload: string; readonly enabled: string }>`
      SELECT JSON_QUERY(${sql.bind(exactJsonText, mssqlParameter.nvarchar("max"))}) AS payload,
             JSON_VALUE(N'{"enabled":true}', '$.enabled') AS enabled
    `);
    assert.equal(row.payload, exactJsonText);
    assert.equal(row.enabled, "true");
  } finally {
    await close(connection);
  }
});

test("mssql.data.sql-variant-unclassified", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const environment = await db.environment();
    await stampMssqlEnvironment(db, "mssql.data.sql-variant-unclassified");
    assert.equal(environment.capabilities["data.sql-variant"]?.status, "unsupported");
    assert.deepEqual(environment.capabilities["data.sql-variant"]?.rawRepresentations, ["driver-native"]);
    const text =
      "SELECT CAST(CAST('9007199254740993' AS bigint) AS sql_variant) AS variantBigint, CAST('payload' AS sql_variant) AS variantText, CAST(CAST('12.34' AS decimal(10, 2)) AS sql_variant) AS variantDecimal";
    const raw = await rawRow(connection, text);
    const row = await db.one(sql.rows<Record<string, unknown>>`${sql.raw(text)}`);
    assert.deepEqual(row, raw);
    assert.deepEqual(Object.keys(row), ["variantBigint", "variantText", "variantDecimal"]);
  } finally {
    await close(connection);
  }
});

test("mssql.data.temporal-native", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    assert.equal((await db.environment()).capabilities["data.temporal-native"]?.status, "guarded");
    const row = await db.one(sql.rows<{ readonly local: Date; readonly offsetValue: Date }>`
      SELECT DATETIME2FROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 7) AS local,
             DATETIMEOFFSETFROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 9, 30, 7) AS offsetValue
    `);
    assert.ok(row.local instanceof Date);
    assert.ok(row.offsetValue instanceof Date);
    assert.equal(row.local.toISOString(), "2026-09-14T12:34:56.123Z");
    assert.equal(row.offsetValue.toISOString(), "2026-09-14T03:04:56.123Z");
    const text = await db.one(sql.rows<{ readonly local: string; readonly offsetValue: string }>`
      SELECT CONVERT(varchar(40), DATETIME2FROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 7), 127) AS local,
             CONVERT(varchar(40), DATETIMEOFFSETFROMPARTS(2026, 9, 14, 12, 34, 56, 1234567, 9, 30, 7), 127) AS offsetValue
    `);
    assert.match(text.local, /2026-09-14T12:34:56\.1234567/u);
    assert.equal(text.offsetValue, "2026-09-14T03:04:56.1234567Z");
  } finally {
    await close(connection);
  }
});

test("mssql.data.binary", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly payload: Buffer }>`SELECT CONVERT(varbinary(3), 0x00FF10) AS payload`);
    assert.ok(Buffer.isBuffer(row.payload));
    assert.deepEqual([...row.payload], [0, 255, 16]);
  } finally {
    await close(connection);
  }
});

test("mssql.data.uuid", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const row = await db.one(
      sql.rows<{ readonly id: string }>`SELECT CAST('550e8400-e29b-41d4-a716-446655440000' AS uniqueidentifier) AS id`,
    );
    assert.equal(row.id.toLowerCase(), "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await close(connection);
  }
});

test(
  "[contract:tedious:metadata.affected-rows:integration] mssql.dml.insert-returning",
  { timeout: 30_000 },
  async () => {
    const connection = await connect(inject("mssql") as MssqlSettings);
    const events: ExecutionEvent[] = [];
    const db = createTediousDatabase(connection, {
      observers: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    });
    try {
      await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv16_capability`);
      await db.execute(
        sql`CREATE TABLE dbo.braid_pv16_capability (id int NOT NULL PRIMARY KEY, name nvarchar(100) NOT NULL, amount int NOT NULL)`,
      );
      events.length = 0;
      const bulkReport = await verifyBulkConformance({
        db,
        sql,
        dialectId: "mssql",
        expectedMode: "prepared-loop",
        events,
      });
      assert.equal(bulkReport.executionMode, "prepared-loop");
      assert.deepEqual(
        await db.bulk(
          [
            { id: 10, name: "Bulk-A", amount: 30 },
            { id: 11, name: "Bulk-B", amount: 40 },
          ],
          (input) =>
            sql.command`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${input.id}, ${input.name}, ${input.amount})`,
        ),
        { inputCount: 2, affectedRows: 2 },
      );

      const inserted = await db.all(sql.rows`
      INSERT INTO dbo.braid_pv16_capability (id, name, amount)
      OUTPUT INSERTED.id, INSERTED.name
      VALUES (${1}, ${sql.bind("Ada", mssqlParameter.nvarchar(100))}, ${10})
    `);
      assert.deepEqual(inserted, [{ id: "1", name: "Ada" }]);
      const updated = await db.all(sql.rows`
      UPDATE dbo.braid_pv16_capability
      SET name = ${sql.bind("Grace", mssqlParameter.nvarchar(100))}, amount = ${20}
      OUTPUT DELETED.amount AS old_amount, INSERTED.amount AS new_amount
      WHERE id = ${1}
    `);
      assert.deepEqual(updated, [{ old_amount: "10", new_amount: "20" }]);
      const deleted = await db.all(sql.rows`
      DELETE FROM dbo.braid_pv16_capability
      OUTPUT DELETED.id, DELETED.name
      WHERE id = ${1}
    `);
      assert.deepEqual(deleted, [{ id: "1", name: "Grace" }]);
      const schema: StandardSchemaV1<unknown, { readonly id: string }> = {
        "~standard": {
          version: 1,
          vendor: "sqlbraid-tests",
          validate(value) {
            const row = value as { readonly id: string };
            return { value: { id: `${Number(row.id) + 10}` } };
          },
        },
      };
      assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT ${2} AS id`, { schema }), [{ id: "12" }]);

      await db.execute(sql`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${2}, ${"Bob"}, ${30})`);
      const merged = await db.all(sql.rows`
      MERGE dbo.braid_pv16_capability AS target
      USING (VALUES (${2}, ${"Robert"}, ${31}), (${3}, ${"Cara"}, ${40})) AS source(id, name, amount)
      ON target.id = source.id
      WHEN MATCHED THEN UPDATE SET name = source.name, amount = source.amount
      WHEN NOT MATCHED THEN INSERT (id, name, amount) VALUES (source.id, source.name, source.amount)
      OUTPUT $action AS action, INSERTED.id AS inserted_id, DELETED.id AS deleted_id;
    `);
      assert.deepEqual(merged, [
        { action: "UPDATE", inserted_id: "2", deleted_id: "2" },
        { action: "INSERT", inserted_id: "3", deleted_id: null },
      ]);

      await assert.rejects(
        () =>
          db.bulk(
            [
              { id: 2, name: "Duplicate", amount: 99 },
              { id: 99, name: "Later", amount: 100 },
            ],
            (input) =>
              sql.command`INSERT INTO dbo.braid_pv16_capability (id, name, amount) VALUES (${input.id}, ${input.name}, ${input.amount})`,
          ),
        /duplicate|primary key/iu,
      );
      assert.deepEqual(await db.all(sql.rows`SELECT id FROM dbo.braid_pv16_capability WHERE id = ${99}`), []);
      assert.equal(
        (await db.one(sql.rows<{ readonly count: string }>`SELECT COUNT(*) AS count FROM dbo.braid_pv16_capability`))
          .count,
        "4",
      );

      await assert.rejects(() => db.execute(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/u);
      await assert.rejects(() =>
        db.execute(sql.rows`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        INSERT INTO dbo.braid_pv16_capability (id, name, amount)
        OUTPUT INSERTED.id
        VALUES (${4}, ${"Dora"}, ${50});
        THROW 50000, 'late batch failure', 1;
      `),
      );
      assert.equal(
        (await db.one(sql.rows<{ readonly count: string }>`SELECT COUNT(*) AS count FROM dbo.braid_pv16_capability`))
          .count,
        "4",
      );
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_pv16_capability`).catch(() => undefined);
      await close(connection);
    }
  },
);

test("rc.mssql.session", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  let scoped: ReturnType<typeof createTediousDatabase> | undefined;
  try {
    const environment = await db.environment();
    for (const capability of [
      "session.pinned",
      "transaction",
      "transaction.savepoint",
      "transaction.read-only",
      "statement.prepare",
      "statement.cancel",
      "statement.stream",
      "statement.bulk",
      "routine.call",
      "routine.out",
      "routine.inout",
      "routine.return-value",
      "routine.result-sets",
      "routine.out-cursor",
    ])
      assert.ok(environment.capabilities[capability]);
    await db.session(async (session) => {
      scoped = session;
      const first = await session.one(sql.rows<{ readonly spid: string }>`SELECT @@SPID AS spid`);
      const second = await session.one(sql.rows<{ readonly spid: string }>`SELECT @@SPID AS spid`);
      assert.equal(first.spid, second.spid);
    });
    await assert.rejects(
      () => scoped!.execute(sql`SELECT 1`),
      (error: unknown) => (error as { readonly code?: string }).code === "BRAID_SESSION_CLOSED",
    );
  } finally {
    await close(connection);
  }
});

test("rc.mssql.prepare", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    await db.execute(sql.command`DROP TABLE IF EXISTS dbo.braid_rc_mssql_prepare`);
    await db.execute(sql.command`CREATE TABLE dbo.braid_rc_mssql_prepare (value int NOT NULL)`);
    await db.execute(sql.command`
      CREATE OR ALTER PROCEDURE dbo.braid_rc_mssql_call
        @value int,
        @answer int OUTPUT
      AS
      BEGIN
        SET NOCOUNT ON;
        SET @answer = @answer + @value;
      END
    `);
    const row = db.prepare(
      "rc-mssql-row",
      (value: number) => sql.rows<{ readonly spid: string; readonly value: string }>`
        SELECT @@SPID AS spid, ${value} AS value
      `,
    );
    const first = await row.one(7);
    const second = await row.one(11);
    assert.equal(first.value, "7");
    assert.equal(second.value, "11");
    assert.equal(first.spid, second.spid);

    const command = db.prepare(
      "rc-mssql-command",
      (value: number) => sql.command`INSERT INTO dbo.braid_rc_mssql_prepare (value) VALUES (${value})`,
    );
    await command.execute(1);
    await command.execute(2);
    assert.deepEqual(
      await db.all(sql.rows<{ readonly value: string }>`SELECT value FROM dbo.braid_rc_mssql_prepare ORDER BY value`),
      [{ value: "1" }, { value: "2" }],
    );

    const call = db.prepare(
      "rc-mssql-call",
      (value: number) => sql.call({
        procedure: { name: "dbo.braid_rc_mssql_call", parameterNames: ["value", "answer"] },
      })`
        ${value}, ${sql.inOut("answer", 1, mssqlParameter.int())}
      `,
    );
    assert.deepEqual((await call.call(41)).output, { answer: "42" });
  } finally {
    await db.execute(sql`DROP PROCEDURE IF EXISTS dbo.braid_rc_mssql_call`).catch(() => undefined);
    await db.execute(sql`DROP TABLE IF EXISTS dbo.braid_rc_mssql_prepare`).catch(() => undefined);
    await close(connection);
  }
});

test("rc.mssql.transaction-options", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    for (const [isolation, expected] of [
      ["read-uncommitted", "1"],
      ["read-committed", "2"],
      ["repeatable-read", "3"],
      ["serializable", "4"],
    ] as const) {
      await db.tx({ isolation }, async (tx) => {
        const row = await tx.one(sql.rows<{ readonly level: string }>`
          SELECT transaction_isolation_level AS level
          FROM sys.dm_exec_sessions
          WHERE session_id = @@SPID
        `);
        assert.equal(row.level, expected);
      });
    }
    await assert.rejects(
      () => db.tx({ readOnly: true }, async () => undefined),
      (error: unknown) => (error as { readonly code?: string }).code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
  } finally {
    await close(connection);
  }
});

test("rc.mssql.cancel", { timeout: 30_000 }, async () => {
  const connection = await connect(inject("mssql") as MssqlSettings);
  const db = createTediousDatabase(connection);
  try {
    const alreadyAborted = new AbortController();
    const reason = new Error("rc.mssql.already-aborted");
    alreadyAborted.abort(reason);
    await assert.rejects(
      () => db.execute(sql.command`WAITFOR DELAY '00:00:10'`, { signal: alreadyAborted.signal }),
      (error: unknown) => error === reason,
    );

    const controller = new AbortController();
    const pending = db.execute(sql.command`WAITFOR DELAY '00:01:00'`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error("rc.mssql.cancelled"));
    await assert.rejects(pending);
    assert.equal((await db.one(sql.rows<{ readonly value: string }>`SELECT @@SPID AS value`)).value.length > 0, true);
  } finally {
    await close(connection);
  }
});
