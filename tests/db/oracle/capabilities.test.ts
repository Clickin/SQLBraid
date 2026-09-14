import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject, test } from "vitest";
import { decodeExactDecimal, type ExecutionEvent } from "@sqlbraid/core";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
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
  await connection.execute(`BEGIN EXECUTE IMMEDIATE 'DROP ${object}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`);
}

test("oracle.sql.native-transparency", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const events: ExecutionEvent[] = [];
  const db = createOracledbDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
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
      expectedParameterizedSql: "\n      SELECT q'[literal ? :1 @p1 $1 /*@braid*/]' AS marker,\n             TO_CHAR(LEVEL) AS level_value,\n             :1 AS actual\n      FROM dual CONNECT BY LEVEL <= 1\n    ",
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
        advance(${sql.inOut("integer", "9007199254740992", oracleParameter.number())},
                ${sql.out("decimal", oracleParameter.number())});
      END;
    `);
    assert.deepEqual(routine.output, { integer: "9007199254740993", decimal: row.DECIMAL_VALUE });
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
    await db.execute(sql.command`INSERT INTO braid_pv16_json (id, payload) VALUES (${1}, JSON_OBJECT('enabled' VALUE 1, 'nested' VALUE JSON_OBJECT('count' VALUE 2) FORMAT JSON RETURNING JSON))`);
    const row = await db.one(sql.rows<{ readonly PAYLOAD: { readonly enabled: number; readonly nested: { readonly count: number } }; readonly ENABLED: string; readonly NESTEDCOUNT: string }>`
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

test("oracle.data.temporal", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const db = createOracledbDatabase(connection);
  try {
    const row = await db.one(sql.rows<{ readonly VALUE: Date }>`SELECT TIMESTAMP '2026-09-14 12:34:56' AS value FROM dual`);
    assert.ok(row.VALUE instanceof Date);
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
    const row = await db.one(sql.rows<{ readonly ID: string }>`SELECT RAWTOHEX(HEXTORAW('550E8400E29B41D4A716446655440000')) AS id FROM dual`);
    assert.equal(row.ID, "550E8400E29B41D4A716446655440000");
  } finally {
    await connection.close();
  }
});

test("oracle.routine.scalar-out", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const fill = async (
    lob: oracledb.Lob,
    value: string | Uint8Array,
  ): Promise<void> => {
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
    await connection.execute("CREATE OR REPLACE PROCEDURE braid_pv16_mixed (p_in IN NUMBER, p_out OUT NUMBER, p_in2 IN NUMBER, p_out2 OUT NUMBER) IS BEGIN p_out := p_in + 1; p_out2 := p_in2 + 2; END;");
    const events: ExecutionEvent[] = [];
    const db = createOracledbDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });

    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "oracle",
      expectedMode: "native-bulk",
      events,
    });
    assert.equal(bulkReport.executionMode, "native-bulk");
    await db.execute(sql.command`INSERT /*+ APPEND */ INTO ${sql.ident("BRAID_PV16_CAP")} ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, ${sql.bind("Ada", oracleParameter.varchar2())})`);
    await db.execute(sql.command`MERGE INTO braid_pv16_cap target USING (SELECT ${sql.bind("Grace", oracleParameter.varchar2())} AS name FROM dual) source ON (target."Name" = source.name) WHEN NOT MATCHED THEN INSERT ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, source.name)`);
    const native = await db.all(sql.rows`SELECT /*+ FIRST_ROWS(1) */ q'[/*@braid if \${false}*/marker]' AS marker, TO_CHAR(LEVEL) AS value FROM dual CONNECT BY LEVEL <= 1`);
    assert.deepEqual(native, [{ MARKER: "/*@braid if ${false}*/marker", VALUE: "1" }]);

    const inserted = await db.all(sql.rows<{ readonly id: string; readonly name: string }>`INSERT INTO braid_pv16_cap ("Id", "Name") VALUES (braid_pv16_cap_seq.NEXTVAL, ${sql.bind("Linus", oracleParameter.varchar2())}) RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.name, "Linus");
    assert.equal(typeof inserted[0]?.id, "string");

    const updated = await db.all(sql.rows<{ readonly id: string; readonly name: string }>`UPDATE braid_pv16_cap SET "Name" = "Name" || ${sql.bind("!", oracleParameter.varchar2())} WHERE "Name" IN (${sql.bind("Ada", oracleParameter.varchar2())}, ${sql.bind("Grace", oracleParameter.varchar2())}) RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`);
    assert.equal(updated.length, 2);
    assert.deepEqual(updated.map((row) => row.name).sort(), ["Ada!", "Grace!"].sort());

    const deleted = await db.all(sql.rows<{ readonly id: string; readonly name: string }>`DELETE FROM braid_pv16_cap WHERE "Name" = ${sql.bind("does-not-exist", oracleParameter.varchar2())} RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`);
    assert.deepEqual(deleted, []);
    const removed = await db.all(sql.rows<{ readonly id: string; readonly name: string }>`DELETE FROM braid_pv16_cap WHERE "Name" = ${sql.bind("Linus", oracleParameter.varchar2())} RETURNING "Id", "Name" INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(64))}`);
    assert.deepEqual(removed, inserted);
    const mixed = await db.call(sql.call`BEGIN braid_pv16_mixed(${sql.bind(3, oracleParameter.number())}, ${sql.out("first", oracleParameter.number())}, ${sql.bind(4, oracleParameter.number())}, ${sql.out("second", oracleParameter.number())}); END;`);
    assert.deepEqual(mixed.output, { first: "4", second: "6" });
    await db.execute(sql.command`BEGIN NULL; END;`);
  } finally {
    await connection.execute("DROP PROCEDURE braid_pv16_mixed").catch(() => undefined);
    await drop(connection, "TABLE braid_pv16_cap PURGE").catch(() => undefined);
    await drop(connection, "SEQUENCE braid_pv16_cap_seq").catch(() => undefined);
    await connection.close();
  }
});
