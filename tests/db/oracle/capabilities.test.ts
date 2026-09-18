import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject, test } from "vitest";
import { decodeExactDecimal, type ExecutionEvent } from "@sqlbraid/core";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import { assertFloatBits, binary32Finite, binary64Finite, exactJsonText } from "../fidelity.js";
import { stampSupportEnvironment } from "../support-target.js";
import { runTransparencyCase } from "../../transparency.js";

async function connect() {
  const settings = inject("oracle");
  const connection = await oracledb.getConnection({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: settings.connectionUri,
  });
  return { connection, settings };
}

async function drop(connection: { execute(sql: string): Promise<unknown> }, object: string): Promise<void> {
  await connection.execute(
    `BEGIN EXECUTE IMMEDIATE 'DROP ${object}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
  );
}

function canonicalDecimal(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return value;
  const integer = match[2]!.replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  return `${match[1]}${integer}${fraction.length === 0 ? "" : `.${fraction}`}`;
}

async function stampOracleEnvironment(db: ReturnType<typeof createOracledbDatabase>, testId: string): Promise<void> {
  const environment = await db.environment();
  const probe = await db.one(sql.rows<{ readonly VERSION_FULL: string; readonly BANNER: string }>`
    SELECT
      (SELECT version_full
         FROM product_component_version
        WHERE product LIKE 'Oracle Database%'
          AND ROWNUM = 1) AS version_full,
      (SELECT banner
         FROM v$version
        WHERE banner LIKE 'Oracle Database%'
          AND ROWNUM = 1) AS banner
    FROM dual
  `);
  const version = /^(\d+\.\d+)/u.exec(probe.VERSION_FULL)?.[1] ?? probe.VERSION_FULL;
  const edition = /\b(Free|Enterprise|Standard|Express|Developer)\b/iu.exec(probe.BANNER)?.[1] ?? probe.BANNER;
  stampSupportEnvironment(
    "oracle",
    {
      ...environment,
      database: { product: "oracle", version, edition },
      driver: { ...environment.driver, version: oracledb.versionString },
      runtime: { id: "node", version: process.versions.node },
    },
    testId,
  );
}

test("oracle.sql.native-transparency", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const events: ExecutionEvent[] = [];
  const db = createOracledbDatabase(connection, {
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
      SELECT q'[literal ? :1 @p1 $1 /*@braid*/]' AS marker,
             TO_CHAR(LEVEL) AS level_value,
             ${"Ada"} AS actual
      FROM dual CONNECT BY LEVEL <= 1
    `;
    await runTransparencyCase({
      capabilityId: "oracle.sql.native-transparency",
      query: query.render(),
      expectedSegments: [
        "\n      SELECT q'[literal ? :1 @p1 $1 /*@braid*/]' AS marker,\n             TO_CHAR(LEVEL) AS level_value,\n             ",
        " AS actual\n      FROM dual CONNECT BY LEVEL <= 1\n    ",
      ],
      expectedParameterizedSql:
        "\n      SELECT q'[literal ? :1 @p1 $1 /*@braid*/]' AS marker,\n             TO_CHAR(LEVEL) AS level_value,\n             :1 AS actual\n      FROM dual CONNECT BY LEVEL <= 1\n    ",
      events,
      execute: () => db.all(query),
      expectedResult: [{ MARKER: "literal ? :1 @p1 $1 /*@braid*/", LEVEL_VALUE: "1", ACTUAL: "Ada" }],
    });
  } finally {
    await connection.close();
  }
});

test("oracle.sql.generated-structure", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const query = sql.rows`SELECT ${sql.ident("VALUE")} AS "value" FROM (SELECT ${1} AS "VALUE" FROM dual)`;
    assert.deepEqual(query.render().segments, ['SELECT "VALUE" AS "value" FROM (SELECT ', ' AS "VALUE" FROM dual)']);
    assert.deepEqual(await db.all(query), [{ value: "1" }]);
  } finally {
    await connection.close();
  }
});

test("rc.oracle.session", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  let scoped: ReturnType<typeof createOracledbDatabase> | undefined;
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
      const first = await session.one(sql.rows<{ readonly SID: string }>`
        SELECT SYS_CONTEXT('USERENV', 'SID') AS SID FROM dual
      `);
      const second = await session.one(sql.rows<{ readonly SID: string }>`
        SELECT SYS_CONTEXT('USERENV', 'SID') AS SID FROM dual
      `);
      assert.equal(first.SID, second.SID);
    });
    await assert.rejects(
      () => scoped!.execute(sql`SELECT 1 FROM dual`),
      (error: unknown) => (error as { readonly code?: string }).code === "BRAID_SESSION_CLOSED",
    );
  } finally {
    await connection.close();
  }
});

test("rc.oracle.prepare", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    await drop(connection, "TABLE braid_rc_oracle_prepare PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_rc_oracle_prepare (value NUMBER NOT NULL)");
    await connection.execute(`
      CREATE OR REPLACE PROCEDURE braid_rc_oracle_call (p_value IN NUMBER, p_answer OUT NUMBER, p_nullable OUT VARCHAR2) IS
      BEGIN p_answer := p_value + 1; p_nullable := NULL; END;
    `);
    const row = db.prepare(
      "rc-oracle-row",
      (value: number) => sql.rows<{ readonly VALUE: string }>`SELECT ${value} AS VALUE FROM dual`,
    );
    assert.equal((await row.one(7)).VALUE, "7");
    assert.equal((await row.one(11)).VALUE, "11");

    const command = db.prepare(
      "rc-oracle-command",
      (value: number) => sql.command`INSERT INTO braid_rc_oracle_prepare (value) VALUES (${value})`,
    );
    await command.execute(1);
    await command.execute(2);
    assert.deepEqual(
      await db.all(
        sql.rows<{ readonly VALUE: string }>`SELECT value AS VALUE FROM braid_rc_oracle_prepare ORDER BY value`,
      ),
      [{ VALUE: "1" }, { VALUE: "2" }],
    );

    const call = db.prepare(
      "rc-oracle-call",
      (value: number) => sql.call`
        BEGIN braid_rc_oracle_call(${value}, ${sql.out("answer", oracleParameter.number())}, ${sql.out("nullable", oracleParameter.varchar2(32))}); END;
      `,
    );
    assert.deepEqual((await call.call(41)).output, { answer: "42", nullable: null });
  } finally {
    await connection.execute("DROP PROCEDURE braid_rc_oracle_call").catch(() => undefined);
    await drop(connection, "TABLE braid_rc_oracle_prepare PURGE").catch(() => undefined);
    await connection.close();
  }
});

test("rc.oracle.transaction-options", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const { connection: observer } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    await drop(connection, "TABLE braid_rc_oracle_isolation PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_rc_oracle_isolation (value NUMBER)");
    await connection.execute("INSERT INTO braid_rc_oracle_isolation VALUES (0)");
    await connection.commit();
    await db.tx({ isolation: "read-committed" }, async (tx) => {
      assert.equal(
        (await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT value AS VALUE FROM braid_rc_oracle_isolation`))
          .VALUE,
        "0",
      );
      await observer.execute("UPDATE braid_rc_oracle_isolation SET value = 1");
      await observer.commit();
      assert.equal(
        (await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT value AS VALUE FROM braid_rc_oracle_isolation`))
          .VALUE,
        "1",
      );
    });
    await observer.execute("UPDATE braid_rc_oracle_isolation SET value = 0");
    await observer.commit();
    await db.tx({ isolation: "serializable" }, async (tx) => {
      assert.equal(
        (await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT value AS VALUE FROM braid_rc_oracle_isolation`))
          .VALUE,
        "0",
      );
      await observer.execute("UPDATE braid_rc_oracle_isolation SET value = 2");
      await observer.commit();
      assert.equal(
        (await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT value AS VALUE FROM braid_rc_oracle_isolation`))
          .VALUE,
        "0",
      );
    });
    for (const isolation of ["read-uncommitted", "repeatable-read"] as const) {
      await assert.rejects(
        () => db.tx({ isolation }, async () => undefined),
        (error: unknown) => (error as { readonly code?: string }).code === "BRAID_TX_OPTION_UNSUPPORTED",
      );
    }
    await drop(connection, "TABLE braid_rc_oracle_read_only PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_rc_oracle_read_only (value NUMBER)");
    await assert.rejects(
      () =>
        db.tx({ readOnly: true }, (tx) => tx.execute(sql.command`INSERT INTO braid_rc_oracle_read_only VALUES (1)`)),
      /ORA-01456|read.only/iu,
    );
  } finally {
    await drop(connection, "TABLE braid_rc_oracle_isolation PURGE").catch(() => undefined);
    await drop(connection, "TABLE braid_rc_oracle_read_only PURGE").catch(() => undefined);
    await observer.close();
    await connection.close();
  }
});

test("rc.oracle.cancel", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const alreadyAborted = new AbortController();
    const reason = new Error("rc.oracle.already-aborted");
    alreadyAborted.abort(reason);
    await assert.rejects(
      () => db.execute(sql.command`BEGIN NULL; END;`, { signal: alreadyAborted.signal }),
      (error: unknown) => error === reason,
    );

    const controller = new AbortController();
    let settled = false;
    const pending = db
      .execute(sql.command`BEGIN DBMS_SESSION.SLEEP(2); END;`, { signal: controller.signal })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error("rc.oracle.cancelled"));
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
    assert.equal(
      (await db.one(sql.rows<{ readonly VALUE: string }>`SELECT 'reusable' AS VALUE FROM dual`)).VALUE,
      "reusable",
    );
  } finally {
    await connection.close();
  }
});

test("oracle.numeric.exact-decimal", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly INTEGER_VALUE: string; readonly DECIMAL_VALUE: string }>`
      SELECT CAST('9007199254740992' AS NUMBER(20, 0)) AS integer_value,
             CAST('1234567890123456789012345678.1234567890' AS NUMBER(38, 10)) AS decimal_value
      FROM dual
    `);
    assert.equal(decodeExactDecimal(row.INTEGER_VALUE), "9007199254740992");
    assert.equal(decodeExactDecimal(row.DECIMAL_VALUE), "1234567890123456789012345678.123456789");
    const routine = await db.call(sql.call`
      DECLARE
        PROCEDURE advance(p_integer IN OUT NUMBER, p_decimal OUT NUMBER) IS
        BEGIN
          p_integer := p_integer + 1;
          p_decimal := 1234567890123456789012345678.1234567890;
        END;
      BEGIN
        advance(${sql.inOut("integer", 9007199254740992n, oracleParameter.number())},
                ${sql.out("decimal", oracleParameter.number())});
      END;
    `);
    assert.deepEqual(routine.output, { integer: "9007199254740993", decimal: row.DECIMAL_VALUE });
  } finally {
    await connection.close();
  }
});

test("oracle.numeric.aggregate-composite", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{
      readonly EXACT_INTEGER: string;
      readonly EXACT_DECIMAL: string;
      readonly FLOAT_FAMILY: string;
      readonly COUNT_VALUE: string;
      readonly SUM_VALUE: string;
      readonly AVG_VALUE: string;
      readonly BINARY_VALUE: number;
      readonly INPUT_VALUE: string;
    }>`
      SELECT CAST('9007199254740993' AS NUMBER(20, 0)) AS exact_integer,
             CAST('12345678901234567890.123456789' AS NUMBER(38, 9)) AS exact_decimal,
             CAST('9007199254740993' AS FLOAT(126)) AS float_family,
             COUNT(*) AS count_value,
             SUM(CAST('9007199254740993' AS NUMBER(20, 0))) AS sum_value,
             AVG(CAST('12345678901234567890.123456789' AS NUMBER(38, 9))) AS avg_value,
             CAST('1.2345678901234567' AS BINARY_DOUBLE) AS binary_value,
             CAST(${"12345678901234567890.123456789"} AS VARCHAR2(64)) AS input_value
      FROM dual
    `);
    assert.equal(row.EXACT_INTEGER, "9007199254740993");
    assert.equal(row.EXACT_DECIMAL, "12345678901234567890.123456789");
    assert.equal(row.FLOAT_FAMILY, "9007199254740993");
    assert.equal(row.COUNT_VALUE, "1");
    assert.equal(row.SUM_VALUE, "9007199254740993");
    assert.equal(row.AVG_VALUE, "12345678901234567890.123456789");
    assertFloatBits(row.BINARY_VALUE, 1.2345678901234567, 64);
    assert.equal(row.INPUT_VALUE, "12345678901234567890.123456789");
  } finally {
    await connection.close();
  }
});

test("oracle.data.json-native", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    await drop(connection, "TABLE braid_pv16_json PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_pv16_json (id NUMBER PRIMARY KEY, payload JSON)");
    await db.execute(
      sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, JSON_OBJECT('enabled' VALUE 1, 'nested' VALUE JSON_OBJECT('count' VALUE 2) FORMAT JSON RETURNING JSON))`,
    );
    const row = await db.one(sql.rows<{
      readonly PAYLOAD: { readonly enabled: number; readonly nested: { readonly count: number } };
      readonly ENABLED: string;
      readonly NESTEDCOUNT: string;
    }>`
      SELECT payload,
             JSON_VALUE(payload, '$.enabled' RETURNING NUMBER) AS enabled,
             JSON_VALUE(payload, '$.nested.count' RETURNING NUMBER) AS nestedCount
      FROM braid_pv16_json
      WHERE id = ${1}
    `);
    assert.deepEqual(row, { PAYLOAD: { enabled: 1, nested: { count: 2 } }, ENABLED: "1", NESTEDCOUNT: "2" });
  } finally {
    await drop(connection, "TABLE braid_pv16_json PURGE").catch(() => undefined);
    await connection.close();
  }
});

test("oracle.data.json-parsed", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const environment = await db.environment();
    await stampOracleEnvironment(db, "oracle.data.json-parsed");
    assert.deepEqual(environment.capabilities["data.json-parsed"]?.rawRepresentations, [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null",
    ]);
    const row = await db.one(sql.rows<{
      readonly OBJECT_ROOT: { readonly enabled: number };
      readonly ARRAY_ROOT: readonly [number, string];
      readonly STRING_ROOT: string;
      readonly NUMBER_ROOT: number;
      readonly BOOLEAN_ROOT: boolean;
      readonly NULL_ROOT: null;
    }>`
      SELECT JSON_OBJECT('enabled' VALUE 1 RETURNING JSON) AS object_root,
             JSON_ARRAY(1, 'two' RETURNING JSON) AS array_root,
             JSON('"text"') AS string_root,
             JSON('42') AS number_root,
             JSON('false') AS boolean_root,
             JSON('null') AS null_root
      FROM dual
    `);
    assert.deepEqual(row.OBJECT_ROOT, { enabled: 1 });
    assert.deepEqual(row.ARRAY_ROOT, [1, "two"]);
    assert.equal(row.STRING_ROOT, "text");
    assert.equal(row.NUMBER_ROOT, 42);
    assert.equal(row.BOOLEAN_ROOT, false);
    assert.equal(row.NULL_ROOT, null);
  } finally {
    await connection.close();
  }
});

test("oracle.data.containers-unclassified", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const environment = await db.environment();
    assert.equal(environment.capabilities["data.oracle-object"]?.status, "unsupported");
    assert.equal(environment.capabilities["data.oracle-collection"]?.status, "unsupported");
    assert.equal(environment.capabilities["data.vector"]?.status, "unsupported");
    await connection.execute("DROP TYPE braid_pv18_num_varray FORCE").catch(() => undefined);
    await connection.execute("DROP TYPE braid_pv18_num_obj FORCE").catch(() => undefined);
    await connection.execute("CREATE TYPE braid_pv18_num_obj AS OBJECT (value NUMBER)");
    await connection.execute("CREATE TYPE braid_pv18_num_varray AS VARRAY(2) OF NUMBER");
    const row = await db.one(sql.rows<{
      readonly OBJECT_VALUE: unknown;
      readonly COLLECTION_VALUE: unknown;
      readonly VECTOR_VALUE: unknown;
    }>`
      SELECT braid_pv18_num_obj(CAST('9007199254740993' AS NUMBER)) AS object_value,
             braid_pv18_num_varray(CAST('9007199254740993' AS NUMBER), 2) AS collection_value,
             TO_VECTOR('[1,2,3]') AS vector_value
      FROM dual
    `);
    assert.equal(typeof row.OBJECT_VALUE, "object");
    assert.equal(typeof row.COLLECTION_VALUE, "object");
    assert.notEqual(row.VECTOR_VALUE, undefined);
  } finally {
    await connection.execute("DROP TYPE braid_pv18_num_varray FORCE").catch(() => undefined);
    await connection.execute("DROP TYPE braid_pv18_num_obj FORCE").catch(() => undefined);
    await connection.close();
  }
});

test("oracle.data.json-native-text", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    await drop(connection, "TABLE braid_pv17_json PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_pv17_json (id NUMBER PRIMARY KEY, payload JSON)");
    await db.execute(sql.command`INSERT INTO braid_pv17_json (id, payload) VALUES (${1}, JSON(${exactJsonText}))`);
    const row = await db.one(sql.rows<{
      readonly PAYLOAD: Record<string, unknown>;
      readonly PAYLOAD_TEXT: string;
    }>`
      SELECT payload,
             JSON_SERIALIZE(payload RETURNING CLOB) AS payload_text
      FROM braid_pv17_json
      WHERE id = ${1}
    `);
    assert.equal(typeof row.PAYLOAD, "object");
    assert.equal(typeof row.PAYLOAD_TEXT, "string");
    assert.match(row.PAYLOAD_TEXT, /9223372036854775807/u);
    const highPrecision = /"highPrecision":([0-9]+(?:\.[0-9]+)?)/u.exec(row.PAYLOAD_TEXT)?.[1];
    assert.ok(highPrecision !== undefined);
    assert.equal(canonicalDecimal(highPrecision), canonicalDecimal("12345678901234567890.12345678901234567890"));
  } finally {
    await drop(connection, "TABLE braid_pv17_json PURGE").catch(() => undefined);
    await connection.close();
  }
});

test("oracle.data.temporal", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly VALUE: Date; readonly VALUE_TEXT: string; readonly TZ_TEXT: string }>`
      SELECT TO_TIMESTAMP('2026-09-14 12:34:56.123456789', 'YYYY-MM-DD HH24:MI:SS.FF9') AS value,
             TO_CHAR(TO_TIMESTAMP('2026-09-14 12:34:56.123456789', 'YYYY-MM-DD HH24:MI:SS.FF9'), 'YYYY-MM-DD"T"HH24:MI:SS.FF9') AS value_text,
             TO_CHAR(TO_TIMESTAMP_TZ('2026-09-14 12:34:56.123456789 +05:30', 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'), 'YYYY-MM-DD"T"HH24:MI:SS.FF9 TZH:TZM') AS tz_text
      FROM dual
    `);
    assert.ok(row.VALUE instanceof Date);
    assert.equal(row.VALUE_TEXT, "2026-09-14T12:34:56.123456789");
    assert.equal(row.TZ_TEXT, "2026-09-14T12:34:56.123456789 +05:30");
  } finally {
    await connection.close();
  }
});

test("oracle.numeric.bind-nls-audit", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  const exact = "12345678901234567890.123456789";
  const castWithoutFormat = async (): Promise<{ readonly value: string } | { readonly error: unknown }> => {
    try {
      const row = await db.one(sql.rows<{ readonly VALUE: string }>`
        SELECT CAST(${exact} AS NUMBER(38, 9)) AS value
        FROM dual
      `);
      return { value: row.VALUE };
    } catch (error) {
      return { error };
    }
  };
  const explicitQuery = sql.rows<{ readonly VALUE: string }>`
    SELECT TO_CHAR(
      TO_NUMBER(${sql.bind(exact, oracleParameter.varchar2())}, '99999999999999999999D999999999', 'NLS_NUMERIC_CHARACTERS = ''.,'''),
      'FM99999999999999999999D999999999',
      'NLS_NUMERIC_CHARACTERS = ''.,'''
    ) AS value
    FROM dual
  `;
  try {
    await connection.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`);
    const dot = await castWithoutFormat();
    assert.deepEqual(dot, { value: exact });
    assert.equal((await db.one(explicitQuery)).VALUE, exact);

    await connection.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = ',.'`);
    const comma = await castWithoutFormat();
    if ("error" in comma) {
      assert.match(String(comma.error), /ORA-01722/u);
    } else {
      assert.notEqual(
        comma.value,
        exact,
        "unhinted string NUMBER conversion must not be advertised as NLS-independent",
      );
    }
    assert.equal((await db.one(explicitQuery)).VALUE, exact);

    const prepared = db.prepare("oracle-nls-explicit-text", () => explicitQuery, { input: "none" });
    assert.equal((await prepared.execute()).rows[0]?.VALUE, exact);

    await drop(connection, "TABLE braid_pv17_nls_text PURGE").catch(() => undefined);
    await connection.execute("CREATE TABLE braid_pv17_nls_text (id NUMBER PRIMARY KEY, amount NUMBER(38, 9))");
    const bulk = await db.bulk(
      [
        { id: 1, value: exact },
        { id: 2, value: exact },
      ],
      (input) => sql.command`
        INSERT INTO braid_pv17_nls_text (id, amount)
        VALUES (
          ${input.id},
          TO_NUMBER(${sql.bind(input.value, oracleParameter.varchar2())}, '99999999999999999999D999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''')
        )
      `,
    );
    assert.equal(bulk.inputCount, 2);
    assert.equal(bulk.affectedRows, 2);
    const stored = await db.all(sql.rows<{ readonly ID: string; readonly VALUE: string }>`
      SELECT id, TO_CHAR(amount, 'FM99999999999999999999D999999999', 'NLS_NUMERIC_CHARACTERS = ''.,''') AS value
      FROM braid_pv17_nls_text
      ORDER BY id
    `);
    assert.deepEqual(stored, [
      { ID: "1", VALUE: exact },
      { ID: "2", VALUE: exact },
    ]);
  } finally {
    await drop(connection, "TABLE braid_pv17_nls_text PURGE").catch(() => undefined);
    await connection.close();
  }
});

test(
  "[contract:node-oracledb:metadata.affected-rows:integration] oracle.command.safe-count",
  { timeout: 60_000 },
  async () => {
    const { connection } = await connect();
    const db = createOracledbDatabase(connection);
    try {
      await drop(connection, "TABLE braid_pv17_count PURGE").catch(() => undefined);
      await connection.execute("CREATE TABLE braid_pv17_count (id NUMBER)");
      const result = await db.execute(sql.command`INSERT INTO braid_pv17_count (id) VALUES (${1})`);
      assert.equal(result.command.affectedRows, 1);
    } finally {
      await drop(connection, "TABLE braid_pv17_count PURGE").catch(() => undefined);
      await connection.close();
    }
  },
);

test("oracle.binary.finite-transport", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    for (const expected of binary32Finite) {
      const row = await db.one(sql.rows<{ readonly VALUE: number }>`
        SELECT CAST(${sql.bind(expected, oracleParameter.binaryFloat())} AS BINARY_FLOAT) AS value
        FROM dual
      `);
      if (Object.is(expected, -0)) assert.equal(typeof row.VALUE, "number");
      else assertFloatBits(row.VALUE, expected, 32);
    }
    for (const expected of binary64Finite) {
      const row = await db.one(sql.rows<{ readonly VALUE: number }>`
        SELECT CAST(${sql.bind(expected, oracleParameter.binaryDouble())} AS BINARY_DOUBLE) AS value
        FROM dual
      `);
      if (Object.is(expected, -0)) assert.equal(typeof row.VALUE, "number");
      else assertFloatBits(row.VALUE, expected, 64);
    }
  } finally {
    await connection.close();
  }
});

test("oracle.binary.nonfinite-probe", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0.1]) {
      const row = await db.one(sql.rows<{ readonly VALUE: number }>`
        SELECT CAST(${sql.bind(value, oracleParameter.binaryDouble())} AS BINARY_DOUBLE) AS value
        FROM dual
      `);
      if (Number.isNaN(value)) assert.ok(Number.isNaN(row.VALUE));
      else if (Object.is(value, -0)) assert.ok(Object.is(row.VALUE, -0));
      else assert.equal(row.VALUE, value);
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, Math.fround(0.1)]) {
      const row = await db.one(sql.rows<{ readonly VALUE: number }>`
        SELECT CAST(${sql.bind(value, oracleParameter.binaryFloat())} AS BINARY_FLOAT) AS value
        FROM dual
      `);
      if (Number.isNaN(value)) assert.ok(Number.isNaN(row.VALUE));
      else if (Object.is(value, -0)) assert.ok(Object.is(row.VALUE, -0));
      else assertFloatBits(row.VALUE, value, 32);
    }
  } finally {
    await connection.close();
  }
});

test("oracle.data.binary", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly PAYLOAD: Buffer }>`SELECT HEXTORAW('00FF10') AS payload FROM dual`);
    assert.ok(Buffer.isBuffer(row.PAYLOAD));
    assert.deepEqual([...row.PAYLOAD], [0, 255, 16]);
  } finally {
    await connection.close();
  }
});

test("oracle.data.uuid", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(
      sql.rows<{ readonly ID: string }>`SELECT RAWTOHEX(HEXTORAW('550E8400E29B41D4A716446655440000')) AS id FROM dual`,
    );
    assert.equal(row.ID, "550E8400E29B41D4A716446655440000");
  } finally {
    await connection.close();
  }
});

test("oracle.routine.scalar-out", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Keep this LOB writer with its ordinal OUT/INOUT setup.
  const fill = async (lob: oracledb.Lob, value: string | Uint8Array): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      lob.once("error", reject);
      lob.once("finish", resolve);
      lob.end(value);
    });
  };
  let clobInput: oracledb.Lob | undefined;
  let blobInput: oracledb.Lob | undefined;
  try {
    await connection.execute(`
      CREATE OR REPLACE PROCEDURE braid_pv16_ordinal (
        p_in IN NUMBER,
        p_out OUT NUMBER,
        p_clob IN OUT CLOB,
        p_after OUT NUMBER,
        p_blob IN OUT BLOB
      ) IS
      BEGIN
        p_out := p_in + 1;
        p_after := p_in + 2;
        DBMS_LOB.WRITEAPPEND(p_clob, LENGTH('-updated'), '-updated');
        DBMS_LOB.WRITEAPPEND(p_blob, UTL_RAW.LENGTH(UTL_RAW.CAST_TO_RAW('-updated')), UTL_RAW.CAST_TO_RAW('-updated'));
      END;
    `);
    clobInput = await connection.createLob(oracledb.CLOB);
    blobInput = await connection.createLob(oracledb.BLOB);
    await fill(clobInput, "clob-in");
    await fill(blobInput, Buffer.from("blob-in"));
    const db = createOracledbDatabase(connection);
    const result = await db.call(sql.call`
      BEGIN braid_pv16_ordinal(
        ${sql.bind(3, oracleParameter.number())},
        ${sql.out("first", oracleParameter.number())},
        ${sql.inOut("clob", clobInput, oracleParameter.clob())},
        ${sql.out("second", oracleParameter.number())},
        ${sql.inOut("blob", blobInput, oracleParameter.blob())}
      ); END;
    `);
    assert.deepEqual(result.output.first, "4");
    assert.deepEqual(result.output.second, "5");
    assert.equal(result.output.clob, "clob-in-updated");
    assert.equal(new TextDecoder().decode(result.output.blob as Uint8Array), "blob-in-updated");
  } finally {
    clobInput?.destroy();
    blobInput?.destroy();
    await connection.execute("DROP PROCEDURE braid_pv16_ordinal").catch(() => undefined);
    await connection.close();
  }
});

test("oracle.dml.insert-returning", { timeout: 60_000 }, async () => {
  const { connection, settings } = await connect();
  try {
    console.info(`[db-oracle-capabilities] image=${settings.image} version=${settings.version}`);
    await drop(connection, "TABLE braid_pv16_cap PURGE").catch(() => undefined);
    await drop(connection, "SEQUENCE braid_pv16_cap_seq").catch(() => undefined);
    await connection.execute("CREATE SEQUENCE braid_pv16_cap_seq START WITH 1 INCREMENT BY 1");
    await connection.execute('CREATE TABLE braid_pv16_cap ("Id" NUMBER PRIMARY KEY, "Name" VARCHAR2(64))');
    await connection.execute(
      "CREATE OR REPLACE PROCEDURE braid_pv16_mixed (p_in IN NUMBER, p_out OUT NUMBER, p_in2 IN NUMBER, p_out2 OUT NUMBER) IS BEGIN p_out := p_in + 1; p_out2 := p_in2 + 2; END;",
    );
    const events: ExecutionEvent[] = [];
    const db = createOracledbDatabase(connection, {
      observers: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    });

    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "oracle",
      expectedMode: "native-bulk",
      events,
    });
    assert.equal(bulkReport.executionMode, "native-bulk");
    await db.execute(
      sql.command`INSERT /*+ APPEND */ INTO ${sql.ident("BRAID_PV16_CAP")} ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, ${sql.bind("Ada", oracleParameter.varchar2())})`,
    );
    await db.execute(
      sql.command`MERGE INTO braid_pv16_cap target USING (SELECT ${sql.bind("Grace", oracleParameter.varchar2())} AS name FROM dual) source ON (target."Name" = source.name) WHEN NOT MATCHED THEN INSERT ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, source.name)`,
    );
    const native = await db.all(
      sql.rows`SELECT /*+ FIRST_ROWS(1) */ q'[/*@braid if \${false}*/marker]' AS marker, TO_CHAR(LEVEL) AS value FROM dual CONNECT BY LEVEL <= 1`,
    );
    assert.deepEqual(native, [{ MARKER: "/*@braid if ${false}*/marker", VALUE: "1" }]);

    const inserted = await db.all(
      sql.rows<{
        readonly id: string;
        readonly name: string;
      }>`INSERT INTO braid_pv16_cap ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, ${sql.bind("Linus", oracleParameter.varchar2())}) RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`,
    );
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.name, "Linus");
    assert.equal(typeof inserted[0]?.id, "string");

    const updated = await db.all(
      sql.rows<{
        readonly id: string;
        readonly name: string;
      }>`UPDATE braid_pv16_cap SET "Name" = "Name" || ${sql.bind("!", oracleParameter.varchar2())} WHERE "Name" IN (${sql.bind("Ada", oracleParameter.varchar2())}, ${sql.bind("Grace", oracleParameter.varchar2())}) RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`,
    );
    assert.equal(updated.length, 2);
    // eslint-disable-next-line unicorn/no-array-sort -- The mapped names and expected literal are owned assertion arrays.
    assert.deepEqual(updated.map((row) => row.name).sort(), ["Ada!", "Grace!"].sort());

    const deleted = await db.all(
      sql.rows<{
        readonly id: string;
        readonly name: string;
      }>`DELETE FROM braid_pv16_cap WHERE "Name" = ${sql.bind("does-not-exist", oracleParameter.varchar2())} RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`,
    );
    assert.deepEqual(deleted, []);
    const removed = await db.all(
      sql.rows<{
        readonly id: string;
        readonly name: string;
      }>`DELETE FROM braid_pv16_cap WHERE "Name" = ${sql.bind("Linus", oracleParameter.varchar2())} RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`,
    );
    assert.deepEqual(removed, inserted);
    const mixed = await db.call(
      sql.call`BEGIN braid_pv16_mixed(${sql.bind(3, oracleParameter.number())}, ${sql.out("first", oracleParameter.number())}, ${sql.bind(4, oracleParameter.number())}, ${sql.out("second", oracleParameter.number())}); END;`,
    );
    assert.deepEqual(mixed.output, { first: "4", second: "6" });
    await db.execute(sql.command`BEGIN NULL; END;`);
  } finally {
    await connection.execute("DROP PROCEDURE braid_pv16_mixed").catch(() => undefined);
    await drop(connection, "TABLE braid_pv16_cap PURGE").catch(() => undefined);
    await drop(connection, "SEQUENCE braid_pv16_cap_seq").catch(() => undefined);
    await connection.close();
  }
});
