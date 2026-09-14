import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject, test } from "vitest";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";

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

test("Oracle capability fixtures preserve native syntax and DML RETURNING rows", { timeout: 60_000 }, async () => {
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
