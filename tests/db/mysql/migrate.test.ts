import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { inject, test } from "vitest";
import type { Database, ExecutionObserver, QueryReadyEvent } from "@sqlbraid/core";
import { createMigrator, type ManifestEntry, type MigrationManifest } from "@sqlbraid/migrate";
import { dialect, MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { assertCode, docsClaim } from "../docs-claims.js";

const apply = { mode: "apply" } as const;

const README = "packages/migrate/README.md";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function entry(version: string | null, body: string, identity = body): ManifestEntry {
  return {
    version,
    description: version === null ? "refresh" : `step ${version}`,
    source: version === null ? "R__refresh.sql" : `V${version}__step.sql`,
    checksum: hash(identity),
    sql: body,
  };
}

function manifest(...entries: ManifestEntry[]): MigrationManifest {
  return {
    format: "sqlbraid-migrations",
    formatVersion: 1,
    dialects: {
      mysql: {
        hash: hash(entries.map((item) => item.checksum).join("")),
        versioned: entries.filter((item) => item.version !== null),
        repeatable: entries.filter((item) => item.version === null),
      },
    },
  };
}

const options = () => ({ uri: inject("mysql").connectionUri, ...MYSQL2_LOSSLESS_TEXT.connectionOptions });

async function connect(observers: readonly ExecutionObserver[] = []) {
  const client = await createConnection(options());
  return { client, db: createMysql2Database(client, { profile: MYSQL2_LOSSLESS_TEXT, observers }) };
}

async function withDb(
  fn: (context: { db: Database; client: Connection; table: string; data: string }) => Promise<void>,
  observers: readonly ExecutionObserver[] = [],
): Promise<void> {
  const { db, client } = await connect(observers);
  const id = randomUUID().replaceAll("-", "");
  const table = `migrate_history_${id}`;
  const data = `migrate_data_${id}`;
  try {
    await fn({ db, client, table, data });
  } finally {
    try {
      await client.query(`DROP TABLE IF EXISTS ${data}, ${table}`);
    } finally {
      await client.end();
    }
  }
}

function claimOnly(db: Database): Database {
  return {
    ...db,
    async environment(environmentOptions) {
      const environment = await db.environment(environmentOptions);
      return {
        ...environment,
        capabilities: { ...environment.capabilities, "session.pinned": { status: "unsupported" } },
      };
    },
  };
}

docsClaim(README, "MySQL applies SQL once and current pooled verification uses one SELECT and one lease", async () => {
  const queries: QueryReadyEvent[] = [];
  await withDb(
    async ({ db, client, table, data }) => {
      const migrator = createMigrator({
        dialect,
        table,
        manifest: manifest(entry("001", `CREATE TABLE ${data} (value text); INSERT INTO ${data} VALUES ('a;b');`)),
      });
      assert.equal((await migrator.startup(db, { mode: "report" })).status, "uninitialized");
      await assertCode(() => migrator.startup(db, { mode: "verify" }), "BRAID_MIGRATE_UNINITIALIZED");
      assert.equal((await migrator.startup(db, apply)).status, "current");
      assert.deepEqual((await client.query(`SELECT value FROM ${data}`))[0], [{ value: "a;b" }]);
      assert.ok(queries.some((query) => query.sql?.includes(`CREATE TABLE ${data}`)));
      assert.ok(queries.some((query) => query.sql?.includes(`INSERT INTO ${data}`)));

      const pool = createPool({ ...options(), connectionLimit: 1 });
      let acquired = 0;
      let released = 0;
      pool.on("acquire", () => {
        acquired += 1;
      });
      pool.on("release", () => {
        released += 1;
      });
      const pooled = createMysql2PoolDatabase(pool, {
        profile: MYSQL2_LOSSLESS_TEXT,
        observers: [
          {
            onEvent(event) {
              if (event.type === "query:ready") queries.push(event);
            },
          },
        ],
      });
      queries.length = 0;
      try {
        const report = await migrator.startup(pooled, { mode: "verify" });
        assert.equal(report.status, "current");
        assert.equal(report.history.length, 1);
        assert.equal(queries.length, 1);
        assert.match(queries[0]!.sql!, /^SELECT\b/i);
        assert.ok(queries[0]!.sql!.includes(table));
        assert.equal(acquired, 1);
        assert.equal(released, 1);
        queries.length = 0;
        assert.equal((await migrator.startup(pooled, { mode: "off" })).status, "off");
        assert.equal(queries.length, 0);
        assert.equal(acquired, 1);
      } finally {
        await pool.end();
      }
    },
    [
      {
        onEvent(event) {
          if (event.type === "query:ready") queries.push(event);
        },
      },
    ],
  );
});

for (const locking of ["session", "claim-only"] as const) {
  docsClaim(README, `MySQL concurrent ${locking} runners apply each version exactly once`, async () => {
    await withDb(async ({ db, client, table, data }) => {
      await createMigrator({ dialect, table, manifest: manifest() }).startup(db, apply);
      await client.query(`CREATE TABLE ${data} (value integer)`);
      let readers = 0;
      let releaseReaders!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        releaseReaders = resolve;
      });
      const statements: string[] = [];
      let conflicts = 0;
      const observer = (): ExecutionObserver => {
        let firstRead: string | undefined;
        let captured = false;
        return {
          async onEvent(event) {
            if (event.type === "query:ready") {
              statements.push(event.sql ?? "");
              if (
                locking === "claim-only" &&
                !captured &&
                /^SELECT\b/i.test(event.sql ?? "") &&
                event.sql?.includes(table)
              ) {
                captured = true;
                firstRead = event.operationId;
              }
            }
            if (event.type === "query:error") conflicts += 1;
            if (event.type === "query:result" && event.operationId === firstRead) {
              firstRead = undefined;
              readers += 1;
              if (readers === 2) releaseReaders();
              await bothRead;
            }
          },
        };
      };
      const first = await connect([observer()]);
      const second = await connect([observer()]);
      const events: string[] = [];
      const migrations = manifest(
        entry("001", `INSERT INTO ${data} VALUES (1)`, "first"),
        entry("002", `INSERT INTO ${data} VALUES (2)`),
      );
      const runner = () =>
        createMigrator({
          dialect,
          table,
          manifest: migrations,
          onEvent: (event) => {
            events.push(event.type);
          },
        });
      try {
        const reports = await Promise.all([
          runner().startup(locking === "session" ? first.db : claimOnly(first.db), apply),
          runner().startup(locking === "session" ? second.db : claimOnly(second.db), apply),
        ]);
        assert.deepEqual(
          reports.map((report) => report.status),
          ["current", "current"],
        );
        assert.deepEqual((await client.query(`SELECT value FROM ${data} ORDER BY value`))[0], [
          { value: 1 },
          { value: 2 },
        ]);
        assert.deepEqual(
          reports[1]!.history.map((row) => [row.installed_rank, row.status]),
          [
            [1, "success"],
            [2, "success"],
          ],
        );
        assert.equal(events.filter((event) => event === "migration.start").length, 2);
        if (locking === "session") {
          assert.equal(events.filter((event) => event === "lock.acquire").length, 2);
          assert.equal(events.filter((event) => event === "lock.release").length, 2);
          assert.ok(statements.some((statement) => /GET_LOCK/i.test(statement)));
        } else {
          assert.equal(readers, 2);
          assert.ok(conflicts > 0, "both stale readers must contend for the same history rank");
          assert.equal(events.filter((event) => event === "lock.acquire").length, 0);
          assert.equal(
            statements.some((statement) => /GET_LOCK/i.test(statement)),
            false,
          );
        }
      } finally {
        await Promise.all([first.client.end(), second.client.end()]);
      }
    });
  });
}

docsClaim(README, "MySQL implicit DDL commits leave failed history until explicit repair", () =>
  withDb(async ({ db, client, table, data }) => {
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(
        entry(
          "001",
          `CREATE TABLE ${data} (value integer); INSERT INTO ${data} VALUES (1); INSERT INTO ${data}_missing VALUES (2);`,
        ),
      ),
    });
    await assert.rejects(() => migrator.startup(db, apply));
    assert.deepEqual((await client.query(`SELECT value FROM ${data}`))[0], [{ value: 1 }]);
    const report = await migrator.startup(db, { mode: "report" });
    assert.equal(report.status, "incomplete");
    assert.equal(report.history.length, 1);
    assert.equal(report.history[0]?.status, "failed");
    await assertCode(() => migrator.startup(db, { mode: "verify" }), "BRAID_MIGRATE_DIRTY");
    await assertCode(() => migrator.startup(db, apply), "BRAID_MIGRATE_DIRTY");
    const repaired = await migrator.repair(db);
    assert.equal(repaired.status, "pending");
    assert.deepEqual(repaired.history, []);
    assert.deepEqual((await client.query(`SELECT value FROM ${data}`))[0], [{ value: 1 }]);
    const corrected = createMigrator({
      dialect,
      table,
      manifest: manifest(entry("001", `INSERT INTO ${data} VALUES (2)`)),
    });
    assert.equal((await corrected.startup(db, apply)).status, "current");
    assert.deepEqual((await client.query(`SELECT value FROM ${data} ORDER BY value`))[0], [{ value: 1 }, { value: 2 }]);
  }),
);

docsClaim(README, "MySQL running claims time out and repair preserves successful history", () =>
  withDb(async ({ db, client, table, data }) => {
    const migrator = createMigrator({
      dialect,
      table,
      busyTimeoutMs: 0,
      manifest: manifest(
        entry("001", `CREATE TABLE ${data} (value integer)`),
        entry("002", `INSERT INTO ${data} VALUES (2)`),
      ),
    });
    const applied = await migrator.startup(db, apply);
    await client.query(`UPDATE ${table} SET status = 'running', duration_ms = NULL WHERE installed_rank = 2`);
    assert.equal((await migrator.startup(db, { mode: "report" })).status, "incomplete");
    await assertCode(() => migrator.startup(db, apply), "BRAID_MIGRATE_BUSY");
    await client.query(`DELETE FROM ${data}`);
    const repaired = await migrator.repair(db);
    assert.equal(repaired.status, "pending");
    assert.deepEqual(repaired.history, [applied.history[0]]);
    assert.equal((await migrator.startup(db, apply)).status, "current");
    assert.deepEqual((await client.query(`SELECT value FROM ${data}`))[0], [{ value: 2 }]);
  }),
);

docsClaim(README, "MySQL baseline skips existing versions and changed repeatables append history", () =>
  withDb(async ({ db, client, table, data }) => {
    await client.query(`CREATE TABLE ${data} (value integer)`);
    const versioned = [
      entry("001", `CREATE TABLE ${data} (value integer)`),
      entry("002", `INSERT INTO ${data} VALUES (2)`),
    ];
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(...versioned, entry(null, `INSERT INTO ${data} VALUES (3)`)),
    });
    const baseline = await migrator.baseline(db, "001");
    assert.equal(baseline.history[0]?.kind, "baseline");
    assert.equal(baseline.head, "001");
    const applied = await migrator.startup(db, apply);
    assert.deepEqual(
      applied.history.map((row) => row.kind),
      ["baseline", "versioned", "repeatable"],
    );
    assert.deepEqual((await migrator.startup(db, apply)).history, applied.history);
    const changed = createMigrator({
      dialect,
      table,
      manifest: manifest(...versioned, entry(null, `INSERT INTO ${data} VALUES (4)`)),
    });
    const pending = await changed.startup(db, { mode: "report" });
    assert.equal(pending.status, "pending");
    assert.deepEqual(
      pending.differences.map((difference) => difference.kind),
      ["repeatable-changed"],
    );
    const current = await changed.startup(db, apply);
    assert.equal(current.status, "current");
    assert.equal(current.history.length, 4);
    assert.deepEqual(current.history.slice(0, 3), applied.history);
    assert.deepEqual((await client.query(`SELECT value FROM ${data} ORDER BY value`))[0], [
      { value: 2 },
      { value: 3 },
      { value: 4 },
    ]);
  }),
);

test(`docs/${README}: MySQL verification works with only SELECT on history`, async (context) => {
  if (inject("mysql").image === "external") {
    context.skip("An external MySQL URL does not provide account-administration credentials.");
    return;
  }
  await withDb(async ({ db, table }) => {
    const migrator = createMigrator({ dialect, table, manifest: manifest(entry("001", "")) });
    await migrator.startup(db, apply);
    const uri = new URL(inject("mysql").connectionUri);
    const database = decodeURIComponent(uri.pathname.slice(1));
    uri.username = "root";
    uri.password = "root-sqlbraid";
    const admin = await createConnection({ ...options(), uri: uri.toString() });
    const user = `migrate_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const password = randomUUID();
    try {
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`);
      try {
        await admin.query(
          `GRANT SELECT ON ${dialect.quoteIdentifier(database)}.${dialect.quoteIdentifier(table)} TO '${user}'@'%'`,
        );
        uri.username = user;
        uri.password = password;
        const reader = await createConnection({ ...options(), uri: uri.toString() });
        try {
          const readOnlyDb = createMysql2Database(reader, { profile: MYSQL2_LOSSLESS_TEXT });
          assert.equal((await migrator.startup(readOnlyDb, { mode: "verify" })).status, "current");
          assert.equal((await migrator.startup(readOnlyDb, { mode: "report" })).status, "current");
          await assert.rejects(() => reader.query(`DELETE FROM ${table} WHERE false`), {
            code: "ER_TABLEACCESS_DENIED_ERROR",
          });
        } finally {
          await reader.end();
        }
      } finally {
        await admin.query(`DROP USER '${user}'@'%'`);
      }
    } finally {
      await admin.end();
    }
  });
});

test("MySQL migrations apply DELIMITER routines and split=none routine bodies", () =>
  withDb(async ({ db, client, table, data }) => {
    const procedure = `${data}_p`;
    const fn = `${data}_f`;
    const migrator = createMigrator({
      dialect,
      table,
      manifest: manifest(
        entry(
          "001",
          `CREATE TABLE ${data} (value integer);
DELIMITER //
CREATE PROCEDURE ${procedure}() BEGIN INSERT INTO ${data} VALUES (1); END//
CREATE TRIGGER ${data}_t BEFORE INSERT ON ${data} FOR EACH ROW BEGIN SET NEW.value = NEW.value * 10; END//
DELIMITER ;
`,
        ),
        entry("002", `-- @braid-migrate split=none\nCREATE FUNCTION ${fn}() RETURNS integer DETERMINISTIC RETURN 7`),
      ),
    });
    try {
      assert.equal((await migrator.startup(db, apply)).status, "current");
      await client.query(`CALL ${procedure}()`);
      assert.deepEqual((await client.query(`SELECT value, ${fn}() AS f FROM ${data}`))[0], [{ value: 10, f: 7 }]);
    } finally {
      await client.query(`DROP PROCEDURE IF EXISTS ${procedure}`);
      await client.query(`DROP FUNCTION IF EXISTS ${fn}`);
    }
  }));

test("MySQL simple execution preserves server-bound parameters and per-operation reuse precedence", () =>
  withDb(async ({ db, client }) => {
    const count = async () => {
      const [rows] = await client.query<RowDataPacket[]>("SHOW SESSION STATUS LIKE 'Com_stmt_execute'");
      return Number(rows[0]!.Value);
    };
    let previous = await count();
    assert.deepEqual(await db.all(sql.rows`SELECT 'simple' AS value`, { reuse: "simple" }), [{ value: "simple" }]);
    assert.equal(await count(), previous);
    assert.deepEqual(await db.all(sql.rows`SELECT 'default' AS value`), [{ value: "default" }]);
    assert.equal(await count(), ++previous);
    const value = "'; SELECT 'not a second statement'; -- ?";
    assert.deepEqual(await db.all(sql.rows`SELECT ${value} AS value`, { reuse: "simple" }), [{ value }]);
    assert.equal(await count(), ++previous);
    const simple = createMysql2Database(client, { profile: MYSQL2_LOSSLESS_TEXT, reuse: "simple" });
    const prepared = simple.prepare("reuse-override", () => sql.rows`SELECT 'prepared' AS value`, { input: "none" });
    assert.deepEqual(await prepared.all({ reuse: "reuse" }), [{ value: "prepared" }]);
    assert.equal(await count(), ++previous);
    assert.deepEqual(await prepared.all(), [{ value: "prepared" }]);
    assert.equal(await count(), previous);
    const streamed: unknown[] = [];
    for await (const row of db.stream(sql.rows`SELECT 'streamed' AS value`, { reuse: "simple" })) streamed.push(row);
    assert.deepEqual(streamed, [{ value: "streamed" }]);
    assert.equal(await count(), previous);
  }));
