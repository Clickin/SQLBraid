import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { generateModels } from "@sqlbraid/codegen";
import { hashSnapshot } from "@sqlbraid/metadata";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createOracledbDatabase, createOracledbPoolDatabase } from "@sqlbraid/oracle/oracledb";
import { createOracleInspector } from "@sqlbraid/oracle/inspector";
import { oracleParameter, sql, typePolicy } from "@sqlbraid/oracle";
import { bindingObserver } from "../binding.js";
import { transactionIntegrationTests } from "../../contracts/transaction.integration.js";

async function connect() {
  const settings = inject("oracle");
  const connection = await oracledb.getConnection({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: settings.connectionUri,
  });
  return { connection, settings };
}

async function drop(connection: { execute(sql: string): Promise<unknown> }, name: string): Promise<void> {
  await connection.execute(
    `BEGIN EXECUTE IMMEDIATE 'DROP ${name}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
  );
}

for (const mode of ["direct", "pooled"] as const) {
  for (const contract of transactionIntegrationTests("node-oracledb", mode, async () => {
    const { connection: observer, settings } = await connect();
    const connection = mode === "direct" ? (await connect()).connection : undefined;
    const pool = mode === "pooled" ? await oracledb.createPool({
      user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
      password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
      connectString: settings.connectionUri,
      poolMin: 0,
      poolMax: 1,
      poolIncrement: 1,
    }) : undefined;
    const db = connection ? createOracledbDatabase(connection, { streamFetchSize: 1 }) : createOracledbPoolDatabase(pool!, { streamFetchSize: 1 });
    await drop(observer, "TABLE braid_contract_tx PURGE");
    await observer.execute("CREATE TABLE braid_contract_tx (id VARCHAR2(255) PRIMARY KEY)");
    const observerDb = createOracledbDatabase(observer);
    return {
      db,
      caughtStatementOutcome: "commit",
      streamQuery: sql.rows<{ id: string }>`SELECT id AS "id" FROM braid_contract_tx ORDER BY id`,
      physicalId: async (scope) => (await scope.one(sql.rows<{ ID: string }>`SELECT SYS_CONTEXT('USERENV', 'SID') AS id FROM dual`)).ID,
      write: (tx, id) => tx.execute(sql.command`INSERT INTO braid_contract_tx (id) VALUES (${id})`),
      committedRows: async () =>
        (await observerDb.all(sql.rows<{ ID: string }>`SELECT id FROM braid_contract_tx ORDER BY id`)).map((row) => row.ID),
      // Oracle has no persistent session read-only default: omission inherits READ WRITE.
      accessMode: {
        inheritedReadOnly: false,
      },
      close: async () => {
        try { await drop(observer, "TABLE braid_contract_tx PURGE"); }
        finally { await connection?.close(); await pool?.close(0); await observer.close(); }
      },
    };
  }, { accessMode: true, pooledLease: mode === "pooled", stream: true })) test(contract.title, contract.run);
}

test("Oracle binding diagnostics preserve literal marker text through real execution", async () => {
  const { connection } = await connect();
  try {
    const probe = bindingObserver("oracle", "text-positional");
    const db = createOracledbDatabase(connection, { observers: [probe.observer] });
    assert.deepEqual(
      await db.one(
        sql.rows`SELECT ${sql.bind("O'Reilly", oracleParameter.varchar2())} AS value, '$1 ? :1 @p1' AS marker FROM dual /* $1 ? :1 @p1 */`,
      ),
      { VALUE: "O'Reilly", MARKER: "$1 ? :1 @p1" },
    );
    probe.verify("SELECT :1 AS value, '$1 ? :1 @p1' AS marker FROM dual /* $1 ? :1 @p1 */");
  } finally {
    await connection.close();
  }
});

for (const ownership of ["direct", "pooled"] as const) {
for (const source of ["executeOptions", "global"] as const) {
for (const mode of ["execute", "executeMany", "call"] as const) {
  test(`[contract:node-oracledb:transaction.autocommit-ownership:integration] [ownership:${ownership}] Oracle ${source} autoCommit true preserves ${mode} and transaction controls`, async () => {
    const originalAutoCommit = oracledb.autoCommit;
    const { connection } = await connect();
    const table = "BRAID_AUTOCOMMIT_CONTRACT";
    let pool: oracledb.Pool | undefined;
    try {
      if (source === "global") oracledb.autoCommit = true;
      const { connection: observer } = await connect();
      try {
        await drop(connection, `TABLE ${table} PURGE`);
        await connection.execute(`CREATE TABLE ${table} (id NUMBER PRIMARY KEY)`);
        const options = source === "executeOptions" ? { executeOptions: { autoCommit: true } } : {};
        if (ownership === "pooled") {
          pool = await oracledb.createPool({
            user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
            password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
            connectString: inject("oracle").connectionUri,
            poolMin: 0,
            poolMax: 1,
            poolIncrement: 1,
          });
        }
        const db = pool ? createOracledbPoolDatabase(pool, options) : createOracledbDatabase(connection, options);
        const otherSession = createOracledbDatabase(observer);
        const insert = (id: number) => sql.command`INSERT INTO ${sql.ident(table)} (id) VALUES (${id})`;
        const routine = (id: number) => sql.call`BEGIN INSERT INTO ${sql.ident(table)} (id) VALUES (${id}); END;`;
        const storedIds = async () =>
          (
            await otherSession.all(sql.rows<{ readonly ID: string }>`SELECT id FROM ${sql.ident(table)} ORDER BY id`)
          ).map(({ ID }) => ID);
        const failure = new Error("rollback requested");

        await db.execute(insert(1));
        assert.deepEqual(await storedIds(), ["1"]);
        await assert.rejects(
          () =>
            db.tx(async (tx) => {
              if (mode === "execute") await tx.execute(insert(2));
              else if (mode === "executeMany") await tx.bulk([2, 3], insert);
              else await tx.call(routine(2));
              // SAVEPOINT must not auto-commit earlier DML when global autoCommit is enabled.
              await tx.tx(async (nested) => { await nested.execute(insert(20)); });
              throw failure;
            }),
          (error: unknown) => error === failure,
        );
        assert.deepEqual(await storedIds(), ["1"]);

        await db.tx(async (tx) => {
          await tx.execute(insert(4));
          await assert.rejects(
            () =>
              tx.tx(async (nested) => {
                if (mode === "execute") await nested.execute(insert(5));
                else if (mode === "executeMany") await nested.bulk([5, 6], insert);
                else await nested.call(routine(5));
                throw failure;
              }),
            (error: unknown) => error === failure,
          );
          if (mode === "execute") await tx.execute(insert(7));
          else if (mode === "executeMany") await tx.bulk([7, 8], insert);
          else await tx.call(routine(7));
        });
        const committed = mode === "executeMany" ? ["1", "4", "7", "8"] : ["1", "4", "7"];
        assert.deepEqual(await storedIds(), committed);

        await db.session(async (session) => {
          await session.execute(insert(9));
          await assert.rejects(
            () =>
              session.tx(async (tx) => {
                if (mode === "execute") await tx.execute(insert(10));
                else if (mode === "executeMany") await tx.bulk([10, 11], insert);
                else await tx.call(routine(10));
                await tx.tx(async (nested) => { await nested.execute(insert(21)); });
                throw failure;
              }),
            (error: unknown) => error === failure,
          );
          await session.execute(insert(12));
          await session.tx(async (tx) => {
            if (mode === "execute") await tx.execute(insert(13));
            else if (mode === "executeMany") await tx.bulk([13, 14], insert);
            else await tx.call(routine(13));
          });
        });
        assert.deepEqual(await storedIds(), [...committed, "9", "12", "13", ...(mode === "executeMany" ? ["14"] : [])]);
      } finally {
        await observer.close();
      }
    } finally {
      try {
        await drop(connection, `TABLE ${table} PURGE`).catch(() => undefined);
        await pool?.close(0);
        await connection.close();
      } finally {
        oracledb.autoCommit = originalAutoCommit;
      }
    }
  });
}
}
}

test("Oracle direct Thin adapter handles typed values, observers, mapping lifetime, stream cleanup, and nested transactions", async () => {
  const { connection, settings } = await connect();
  const events: string[] = [];
  try {
    console.info(`[db-oracle] image=${settings.image} version=${settings.version}`);
    await drop(connection, "TABLE braid_pv13_bind PURGE");
    await connection.execute(
      "CREATE TABLE braid_pv13_bind (id NUMBER GENERATED BY DEFAULT AS IDENTITY, amount NUMBER(38, 6), name NVARCHAR2(80), stamp TIMESTAMP, PRIMARY KEY (id))",
    );
    const db = createOracledbDatabase(connection, {
      observers: [
        {
          onEvent(event) {
            events.push(event.type);
          },
        },
      ],
    });

    await db.execute(
      sql.command`INSERT INTO braid_pv13_bind (amount, name, stamp) VALUES (${sql.bind(123.12, oracleParameter.number())}, ${sql.bind("Ada", oracleParameter.nvarchar2())}, ${sql.bind(new Date("2026-09-13T00:00:00Z"), oracleParameter.timestamp())})`,
    );
    await db.execute(
      sql.command`INSERT INTO braid_pv13_bind (amount, name) VALUES (${sql.bind(null, oracleParameter.number())}, ${sql.bind(null, oracleParameter.nvarchar2())})`,
    );
    const rows = await db.all(
      sql.rows<{
        readonly AMOUNT: string | null;
        readonly NAME: string | null;
      }>`SELECT amount, name FROM braid_pv13_bind ORDER BY id`,
    );
    assert.deepEqual(rows, [
      { AMOUNT: "123.12", NAME: "Ada" },
      { AMOUNT: null, NAME: null },
    ]);
    const materialized = await db.one(
      sql.rows<{
        readonly EXACT_NUMBER: string;
        readonly TEXT_LOB: string;
        readonly BINARY_LOB: Uint8Array;
      }>`SELECT TO_NUMBER('123456789012345678901234567890.12') AS EXACT_NUMBER, TO_CLOB('payload') AS TEXT_LOB, TO_BLOB(UTL_RAW.CAST_TO_RAW('payload')) AS BINARY_LOB FROM dual`,
    );
    assert.equal(materialized.EXACT_NUMBER, "123456789012345678901234567890.12");
    assert.equal(materialized.TEXT_LOB, "payload");
    assert.equal(new TextDecoder().decode(materialized.BINARY_LOB), "payload");

    const gate = Promise.withResolvers<void>();
    const schema: StandardSchemaV1<unknown, { readonly amount: string | null }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-oracle-tests",
        async validate(value) {
          await gate.promise;
          const row = value as { readonly AMOUNT: string | null };
          return { value: { amount: row.AMOUNT } };
        },
      },
    };
    const mapped = db.all(sql.rows(schema)`SELECT amount AS AMOUNT FROM braid_pv13_bind ORDER BY id`);
    await new Promise((resolve) => setImmediate(resolve));
    await db.execute(
      sql.command`INSERT INTO braid_pv13_bind (amount) VALUES (${sql.bind(7, oracleParameter.number())})`,
    );
    gate.resolve();
    assert.deepEqual(await mapped, [{ amount: "123.12" }, { amount: null }]);
    assert.ok(events.includes("query:ready"));
    assert.ok(events.includes("query:mapped"));

    await db.tx(async (tx) => {
      await tx.execute(
        sql.command`INSERT INTO braid_pv13_bind (amount) VALUES (${sql.bind(8, oracleParameter.number())})`,
      );
      await assert.rejects(
        () =>
          tx.tx(async (nested) => {
            await nested.execute(
              sql.command`INSERT INTO braid_pv13_bind (amount) VALUES (${sql.bind(9, oracleParameter.number())})`,
            );
            throw new Error("rollback nested");
          }),
        /rollback nested/u,
      );
      await tx.execute(
        sql.command`INSERT INTO braid_pv13_bind (amount) VALUES (${sql.bind(10, oracleParameter.number())})`,
      );
    });

    const stream = db.stream(
      sql.rows<{
        readonly AMOUNT: string | null;
        readonly EXACT_NUMBER: string;
      }>`SELECT amount, TO_NUMBER('123456789012345678901234567890.12') AS EXACT_NUMBER FROM braid_pv13_bind ORDER BY id`,
    );
    let streamed = 0;
    for await (const row of stream) {
      assert.equal(row.EXACT_NUMBER, "123456789012345678901234567890.12");
      streamed += 1;
      if (streamed === 1) break;
    }
    assert.equal(streamed, 1);
    await assert.rejects(
      () => db.execute(sql.command`SELECT amount FROM braid_pv13_bind`),
      (error) => error instanceof DatabaseResultKindError,
    );
  } finally {
    await drop(connection, "TABLE braid_pv13_bind PURGE").catch(() => undefined);
    await connection.close();
  }
});

test("Oracle inspector exposes positive catalog evidence for codegen", { timeout: 30_000 }, async () => {
  const { connection } = await connect();
  try {
    await drop(connection, "TABLE braid_pv13_catalog PURGE");
    await connection.execute("DROP TYPE braid_pv13_udt FORCE").catch(() => undefined);
    await connection.execute("CREATE TYPE braid_pv13_udt AS OBJECT (code NUMBER)");
    await connection.execute(
      "CREATE TABLE braid_pv13_catalog (id NUMBER GENERATED BY DEFAULT AS IDENTITY, amount NUMBER(18, 4) DEFAULT 0 NOT NULL, computed NUMBER GENERATED ALWAYS AS (amount * 2) VIRTUAL, hidden_value VARCHAR2(20) INVISIBLE, payload braid_pv13_udt)",
    );
    await connection.execute(
      "CREATE OR REPLACE FUNCTION braid_pv13_fee (value IN NUMBER) RETURN NUMBER IS BEGIN RETURN value; END;",
    );
    await connection.execute(
      "CREATE OR REPLACE PROCEDURE braid_pv13_use_udt (value IN braid_pv13_udt) IS BEGIN NULL; END;",
    );
    await connection.execute(
      "CREATE OR REPLACE PACKAGE braid_pv13_pkg AS FUNCTION calc(value NUMBER) RETURN NUMBER; FUNCTION calc(value VARCHAR2) RETURN VARCHAR2; END;",
    );
    const snapshot = await createOracleInspector(connection).inspect();
    const relation = snapshot.relations["SQLBRAID.BRAID_PV13_CATALOG"];
    assert.ok(relation);
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    assert.equal(columns.get("ID")?.identity, true);
    assert.equal(columns.get("COMPUTED")?.generated, true);
    assert.equal(columns.get("COMPUTED")?.insertable, false);
    assert.equal(columns.get("AMOUNT")?.nullable, false);
    assert.equal(columns.get("PAYLOAD")?.type, "SQLBRAID.BRAID_PV13_UDT");
    assert.equal(columns.get("HIDDEN_VALUE")?.type, "VARCHAR2");
    assert.equal(snapshot.types["SQLBRAID.BRAID_PV13_UDT"]?.kind, "composite");
    const routine = Object.values(snapshot.routines)
      .flat()
      .find((entry) => entry.name === "BRAID_PV13_FEE");
    assert.ok(routine);
    assert.equal(routine.argumentsComplete, true);
    assert.equal(routine.arguments[0]?.mode, "in");
    const udtRoutine = Object.values(snapshot.routines)
      .flat()
      .find((entry) => entry.name === "BRAID_PV13_USE_UDT");
    assert.equal(udtRoutine?.arguments[0]?.type, "SQLBRAID.BRAID_PV13_UDT");
    const overloads = Object.values(snapshot.routines)
      .flat()
      .filter((entry) => entry.identity?.startsWith("SQLBRAID.BRAID_PV13_PKG.CALC"));
    assert.deepEqual(overloads.map((entry) => entry.arguments.map((argument) => argument.type)).sort(), [
      ["NUMBER"],
      ["VARCHAR2"],
    ]);
    assert.equal(new Set(overloads.map((entry) => entry.identity)).size, 2);
    const generated = generateModels(snapshot, { typePolicy });
    assert.equal(generated.metadataHash, hashSnapshot(snapshot));
    assert.equal(generated.typePolicyId, typePolicy.id);
    assert.ok(generated.models.some((model) => model.relationIdentity === relation.identity));
  } finally {
    await connection.execute("DROP FUNCTION braid_pv13_fee").catch(() => undefined);
    await connection.execute("DROP PROCEDURE braid_pv13_use_udt").catch(() => undefined);
    await connection.execute("DROP PACKAGE braid_pv13_pkg").catch(() => undefined);
    await drop(connection, "TABLE braid_pv13_catalog PURGE").catch(() => undefined);
    await connection.execute("DROP TYPE braid_pv13_udt FORCE").catch(() => undefined);
    await connection.close();
  }
});

test("Oracle pool provider returns physical leases and supports nested savepoints", async () => {
  const settings = inject("oracle");
  const pool = await oracledb.createPool({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: settings.connectionUri,
    poolMin: 1,
    poolMax: 2,
    poolIncrement: 1,
  });
  try {
    const db = createOracledbPoolDatabase(pool);
    const values = await Promise.all([
      db.one(sql.rows<{ readonly VALUE: string }>`SELECT 'pool-a' AS VALUE FROM dual`),
      db.one(sql.rows<{ readonly VALUE: string }>`SELECT 'pool-b' AS VALUE FROM dual`),
    ]);
    assert.deepEqual(values.map((row) => row.VALUE).sort(), ["pool-a", "pool-b"]);
    const materialized = await db.one(
      sql.rows<{
        readonly EXACT_NUMBER: string;
        readonly TEXT_LOB: string;
        readonly BINARY_LOB: Uint8Array;
      }>`SELECT TO_NUMBER('123456789012345678901234567890.12') AS EXACT_NUMBER, TO_CLOB('payload') AS TEXT_LOB, TO_BLOB(UTL_RAW.CAST_TO_RAW('payload')) AS BINARY_LOB FROM dual`,
    );
    assert.equal(materialized.EXACT_NUMBER, "123456789012345678901234567890.12");
    assert.equal(materialized.TEXT_LOB, "payload");
    assert.equal(new TextDecoder().decode(materialized.BINARY_LOB), "payload");
    assert.equal(
      (await db.one(sql.rows<{ readonly VALUE: string }>`SELECT 'after-lob' AS VALUE FROM dual`)).VALUE,
      "after-lob",
    );
    await db.tx(async (tx) => {
      await tx.execute(sql.command`BEGIN NULL; END;`);
      await tx.tx(async (nested) => {
        await nested.execute(sql.command`BEGIN NULL; END;`);
      });
    });
  } finally {
    await pool.close(0);
  }
});
