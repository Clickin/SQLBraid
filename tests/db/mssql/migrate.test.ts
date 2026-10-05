import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Connection } from "tedious";
import { inject } from "vitest";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { dialect, sql } from "@sqlbraid/mssql";
import { createMigrator, type MigrationBody, type MigrationManifest } from "@sqlbraid/migrate";
import { docsClaim, errorCode } from "../docs-claims.js";
import { withMigrationLock } from "../../../packages/migrate/src/dialect.js";

const page = "packages/migrate/README.md";
function manifest(body: MigrationBody): MigrationManifest {
  return {
    format: "sqlbraid-migrations",
    formatVersion: 1,
    dialects: {
      mssql: {
        hash: "a".repeat(64),
        repeatable: [],
        versioned: [
          {
            version: "1",
            description: "mssql migration",
            source: "V1__mssql.sql",
            checksum: "b".repeat(64),
            load: async () => body,
          },
        ],
      },
    },
  };
}
async function connect(): Promise<Connection> {
  const settings = inject("mssql");
  const connection = new Connection({
    server: settings.server,
    options: { port: settings.port, database: settings.database, encrypt: false, trustServerCertificate: true },
    authentication: { type: "default", options: { userName: settings.userName, password: settings.password } },
  });
  const { promise, resolve, reject } = Promise.withResolvers<Connection>();
  connection.once("connect", (error) => (error ? reject(error) : resolve(connection)));
  connection.connect();
  return promise;
}
function names() {
  const suffix = randomUUID().replaceAll("-", "");
  return { table: `_mig_${suffix}`, data: `mig_${suffix}`, procedure: `mp_${suffix}` };
}

docsClaim(page, "SQL Server executes GO-separated routine batches and current startup reads once", async () => {
  const connection = await connect();
  const { table, data, procedure } = names();
  let queries = 0;
  const db = createTediousDatabase(connection, {
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
      manifest: manifest(`CREATE TABLE ${data} (value NVARCHAR(30));
GO
CREATE PROCEDURE ${procedure} AS
BEGIN
 INSERT INTO ${data} (value) VALUES (N'semi;colon');
END;
GO
EXEC ${procedure};
GO`),
    });
    assert.equal((await migrator.up(db)).status, "current");
    assert.deepEqual(await db.all(sql.rows`SELECT value FROM ${sql.ident(data)}`), [{ value: "semi;colon" }]);
    queries = 0;
    assert.equal((await migrator.startup(db, { mode: "verify" })).status, "current");
    assert.equal(queries, 1);
  } finally {
    await db.execute(sql.command`DROP PROCEDURE IF EXISTS ${sql.ident(procedure)}`);
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(data)}`);
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(table)}`);
    connection.close();
  }
});

docsClaim(page, "SQL Server GO batches share SET options and temporary tables on one session", async () => {
  const connection = await connect();
  const { table, data } = names();
  const db = createTediousDatabase(connection);
  try {
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(`CREATE TABLE ${data} (id INT IDENTITY(1,1) PRIMARY KEY, value NVARCHAR(10));
GO
SET IDENTITY_INSERT ${data} ON;
GO
CREATE TABLE #seed (id INT, value NVARCHAR(10));
INSERT INTO #seed (id, value) VALUES (42, N'kept');
GO
INSERT INTO ${data} (id, value) SELECT id, value FROM #seed;
GO
SET IDENTITY_INSERT ${data} OFF;
DROP TABLE #seed;
GO`),
    });
    assert.equal((await migrator.up(db)).status, "current");
    assert.deepEqual(await db.all(sql.rows`SELECT CAST(id AS NVARCHAR(10)) AS id, value FROM ${sql.ident(data)}`), [
      { id: "42", value: "kept" },
    ]);
  } finally {
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(data)}`);
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(table)}`);
    connection.close();
  }
});

docsClaim(page, "SQL Server rolls back migration DDL and its history claim on transactional failure", async () => {
  const connection = await connect();
  const { table, data } = names();
  const db = createTediousDatabase(connection);
  try {
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(`CREATE TABLE ${data} (value INT);
GO
THROW 51000, 'migration failure', 1;
GO`),
    });
    await assert.rejects(() => migrator.up(db));
    assert.deepEqual(await db.all(sql.rows`SELECT status FROM ${sql.ident(table)}`), []);
    assert.deepEqual(await db.all(sql.rows`SELECT name FROM sys.tables WHERE name = ${data}`), []);
    assert.equal((await migrator.startup(db, { mode: "report" })).status, "pending");
  } finally {
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(data)}`);
    await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(table)}`);
    connection.close();
  }
});

docsClaim(
  page,
  "SQL Server application locks prevent independent sessions from running a migration twice",
  async () => {
    const first = await connect();
    const second = await connect();
    const { table } = names();
    const db = createTediousDatabase(first);
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
      assert.equal(
        await errorCode(() => createMigrator(options).up(createTediousDatabase(second))),
        "BRAID_MIGRATE_BUSY",
      );
      release();
      assert.equal((await applying).status, "current");
      assert.equal((await createMigrator(options).up(createTediousDatabase(second))).status, "current");
      assert.equal(runs, 1);
    } finally {
      release();
      await applying.catch(() => undefined);
      await db.execute(sql.command`DROP TABLE IF EXISTS ${sql.ident(table)}`);
      first.close();
      second.close();
    }
  },
);

docsClaim(
  page,
  "SQL Server releases session application locks after acquisition hooks or migration bodies fail",
  async () => {
    const first = await connect();
    const second = await connect();
    const firstDb = createTediousDatabase(first);
    const secondDb = createTediousDatabase(second);
    const options = { table: names().table, scope: "cleanup", busyTimeoutMs: 50 };
    const failure = new Error("migration lock callback failed");
    try {
      for (const failOnAcquire of [true, false]) {
        let releases = 0;
        await assert.rejects(
          () =>
            withMigrationLock(
              firstDb,
              dialect,
              {
                ...options,
                onAcquire() {
                  if (failOnAcquire) throw failure;
                },
                onRelease() {
                  releases += 1;
                },
              },
              async () => {
                throw failure;
              },
            ),
          (error) => error === failure,
        );
        assert.equal(releases, 1);
        assert.equal(await withMigrationLock(secondDb, dialect, options, async () => "acquired"), "acquired");
      }
    } finally {
      first.close();
      second.close();
    }
  },
);
