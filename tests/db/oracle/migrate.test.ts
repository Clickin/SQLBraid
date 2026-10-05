import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import oracledb from "oracledb";
import { inject } from "vitest";
import { createOracledbDatabase, createOracledbPoolDatabase } from "@sqlbraid/oracle/oracledb";
import { createOracleInspector } from "@sqlbraid/oracle/inspector";
import { dialect, sql } from "@sqlbraid/oracle";
import { createMigrator, type MigrationBody, type MigrationManifest } from "@sqlbraid/migrate";
import { createSchemaDrift } from "@sqlbraid/migrate/drift";
import { docsClaim, errorCode } from "../docs-claims.js";

const page = "packages/migrate/README.md";
function manifest(body: MigrationBody): MigrationManifest {
  return {
    format: "sqlbraid-migrations",
    formatVersion: 1,
    dialects: {
      oracle: {
        hash: "a".repeat(64),
        repeatable: [],
        versioned: [
          {
            version: "1",
            description: "oracle migration",
            source: "V1__oracle.sql",
            checksum: "b".repeat(64),
            load: async () => body,
          },
        ],
      },
    },
  };
}
async function connect() {
  return oracledb.getConnection({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: inject("oracle").connectionUri,
  });
}
function names() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { table: `_mig_${suffix}`, data: `MIG_${suffix.toUpperCase()}`, procedure: `MP_${suffix.toUpperCase()}` };
}

docsClaim(
  page,
  "Oracle quotes history identifiers, executes slash-separated PL/SQL, and verifies with one query",
  async () => {
    const connection = await connect();
    const { table, data, procedure } = names();
    let queries = 0;
    const db = createOracledbDatabase(connection, {
      observers: [
        {
          onEvent(event) {
            if (event.type === "query:ready") queries += 1;
          },
        },
      ],
    });
    try {
      const migrator = createMigrator({
        dialect,
        table,
        manifest: manifest(`CREATE TABLE ${data} (value VARCHAR2(30));
CREATE OR REPLACE PROCEDURE ${procedure} AS
BEGIN
 INSERT INTO ${data} (value) VALUES ('semi;colon');
END;
/
BEGIN
 ${procedure};
END;
/`),
      });
      assert.equal((await migrator.up(db)).status, "current");
      assert.deepEqual(await db.all(sql.rows`SELECT value AS "value" FROM ${sql.ident(data)}`), [
        { value: "semi;colon" },
      ]);
      assert.deepEqual(await db.all(sql.rows`SELECT "status" FROM ${sql.ident(table)}`), [{ status: "success" }]);
      queries = 0;
      assert.equal((await migrator.startup(db, { mode: "verify" })).status, "current");
      assert.equal(queries, 1);
    } finally {
      await connection.execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP PROCEDURE ${procedure}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -4043 THEN RAISE; END IF; END;`,
      );
      await connection.execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${data} PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
      );
      await connection.execute(
        `BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${table}" PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
      );
      await connection.close();
    }
  },
);

docsClaim(page, "Oracle nontransactional DDL failure persists a failed attempt and blocks startup", async () => {
  const connection = await connect();
  const second = await connect();
  const { table, data } = names();
  const db = createOracledbDatabase(connection);
  const observer = createOracledbDatabase(second);
  try {
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(`CREATE TABLE ${data} (value NUMBER); INSERT INTO ${data} (missing_column) VALUES (1);`),
    });
    await assert.rejects(() => migrator.up(db));
    assert.deepEqual(await db.all(sql.rows`SELECT "status" FROM ${sql.ident(table)}`), [{ status: "failed" }]);
    assert.deepEqual(await db.all(sql.rows`SELECT value FROM ${sql.ident(data)}`), []);
    assert.equal(await errorCode(() => migrator.startup(db, { mode: "verify" })), "BRAID_MIGRATE_DIRTY");
    assert.equal(await errorCode(() => migrator.startup(observer, { mode: "verify" })), "BRAID_MIGRATE_DIRTY");
    assert.deepEqual(
      (await migrator.startup(observer, { mode: "report" })).history.map((row) => row.status),
      ["failed"],
    );
    assert.equal((await migrator.repair(db)).status, "pending");
    assert.deepEqual((await migrator.startup(observer, { mode: "report" })).history, []);
    assert.equal((await migrator.baseline(db, "1")).status, "current");
    assert.deepEqual(
      (await migrator.startup(observer)).history.map((row) => row.kind),
      ["baseline"],
    );
  } finally {
    await connection.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${data} PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
    );
    await connection.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${table}" PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
    );
    await connection.close();
    await second.close();
  }
});

docsClaim(page, "Oracle independent sessions cannot execute the same claimed migration twice", async () => {
  const first = await connect();
  const second = await connect();
  const { table } = names();
  const db = createOracledbDatabase(first);
  const observer = createOracledbDatabase(second);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  let runs = 0;
  const options = {
    dialect,
    table,
    busyTimeoutMs: 50,
    manifest: manifest(async () => {
      runs += 1;
      entered();
      await gate;
    }),
  };
  const applying = createMigrator(options).up(db);
  try {
    await Promise.race([
      started,
      applying.then(() => {
        throw new Error("Migration body did not run");
      }),
    ]);
    assert.deepEqual(
      (await createMigrator(options).startup(observer, { mode: "report" })).history.map((row) => row.status),
      ["running"],
    );
    assert.equal(await errorCode(() => createMigrator(options).up(observer)), "BRAID_MIGRATE_BUSY");
    release();
    assert.equal((await applying).status, "current");
    assert.equal(runs, 1);
    assert.equal((await createMigrator(options).up(observer)).status, "current");
    assert.equal(runs, 1);
  } finally {
    release();
    await applying.catch(() => undefined);
    await first.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${table}" PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
    );
    await first.close();
    await second.close();
  }
});

docsClaim(page, "Oracle pooled nontransactional SQL and TypeScript DML commit history and schema hashes", async () => {
  const connection = await connect();
  const pool = await oracledb.createPool({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: inject("oracle").connectionUri,
    poolMin: 1,
    poolMax: 1,
    poolIncrement: 1,
  });
  const { table, data } = names();
  const db = createOracledbPoolDatabase(pool);
  const observer = createOracledbDatabase(connection);
  const drift = createSchemaDrift({ inspector: createOracleInspector(connection) });
  try {
    await connection.execute(`CREATE TABLE ${data} (value VARCHAR2(30))`);
    const bodies: readonly MigrationBody[] = [
      `INSERT INTO ${data} (value) VALUES ('sql')`,
      async (scoped) => {
        await scoped.execute(sql.command`INSERT INTO ${sql.ident(data)} (value) VALUES (${"typescript"})`);
        await scoped.execute(
          sql.command`UPDATE ${sql.ident(data)} SET value = ${"updated"} WHERE value = ${"typescript"}`,
        );
      },
    ];
    for (const [index, body] of bodies.entries()) {
      const migrator = createMigrator({ dialect, table, scope: `body-${index}`, manifest: manifest(body), drift });
      const applied = await migrator.up(db);
      assert.equal(applied.status, "current");
      assert.match(applied.history[0]!.schema_hash!, /^[a-f\d]{64}$/);
      const observed = await migrator.startup(observer);
      assert.equal(observed.status, "current");
      assert.equal(observed.history[0]?.schema_hash, applied.history[0]?.schema_hash);
    }
    assert.deepEqual(await observer.all(sql.rows`SELECT value AS "value" FROM ${sql.ident(data)} ORDER BY value`), [
      { value: "sql" },
      { value: "updated" },
    ]);
  } finally {
    await pool.close(0);
    await connection.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${data} PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
    );
    await connection.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${table}" PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
    );
    await connection.close();
  }
});
