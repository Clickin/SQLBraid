import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type { Database } from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase, createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import {
  createMigrator,
  defineMigration,
  MigrationStartupError,
  type ManifestEntry,
  type MigrationBody,
  type MigrationEvent,
  type MigrationManifest,
} from "@sqlbraid/migrate";

function entry(
  version: string | null,
  body: MigrationBody,
  source = version === null ? "R__view.sql" : `V${version}__change.sql`,
): ManifestEntry {
  return {
    version,
    description: "change",
    source,
    checksum: createHash("sha256").update(String(body)).digest("hex"),
    load: async () => body,
  };
}

function manifest(entries: readonly ManifestEntry[]): MigrationManifest {
  return {
    format: "sqlbraid-migrations",
    formatVersion: 1,
    dialects: {
      sqlite: {
        hash: createHash("sha256")
          .update(entries.map((migration) => migration.checksum).join(":"))
          .digest("hex"),
        versioned: entries.filter((migration) => migration.version !== null),
        repeatable: entries.filter((migration) => migration.version === null),
      },
    },
  };
}

test("off performs no I/O; report and verify translate a missing history table without writing", async () => {
  const native = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const db = createNodeSqliteDatabase(native, {
    observers: [
      {
        onEvent(event) {
          if (event.type === "query:ready" && event.sql !== undefined) statements.push(event.sql);
        },
      },
    ],
  });
  const migrator = createMigrator({ manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER)")]), dialect });
  try {
    assert.equal((await migrator.startup(db, { mode: "off" })).status, "off");
    assert.deepEqual(statements, []);
    const report = await migrator.startup(db, { mode: "report" });
    assert.equal(report.status, "uninitialized");
    assert.equal(statements.length, 1);
    assert.match(statements[0]!, /^SELECT /);
    await assert.rejects(migrator.startup(db), { code: "BRAID_MIGRATE_UNINITIALIZED" });
    assert.equal(statements.length, 2);
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length, 0);
  } finally {
    native.close();
  }
});

test("native SQLite applies numeric versions before repeatables, reports events, and verifies with one SELECT", async () => {
  const native = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const events: MigrationEvent[] = [];
  const db = createNodeSqliteDatabase(native, {
    observers: [
      {
        onEvent(event) {
          if (event.type === "query:ready" && event.sql !== undefined) statements.push(event.sql);
        },
      },
    ],
  });
  const entries = [
    entry("10", "INSERT INTO users VALUES (10)"),
    entry(
      "2",
      defineMigration(async (scoped) => {
        await scoped.execute(sql.command`INSERT INTO users VALUES (${2})`);
      }),
    ),
    entry("1", "CREATE TABLE users (id INTEGER)"),
    entry(null, "CREATE VIEW user_ids AS SELECT id FROM users"),
  ];
  const migrator = createMigrator({ manifest: manifest(entries), dialect, onEvent: (event) => events.push(event) });
  try {
    const result = await migrator.up(db);
    assert.equal(result.status, "current");
    assert.deepEqual(
      result.history.map((row) => row.version),
      ["1", "2", "10", null],
    );
    assert.equal(new Set(result.history.map((row) => row.execution_id)).size, 1);
    assert.deepEqual(
      events.filter((event) => event.type === "migration.start").map((event) => event.entry.version),
      ["1", "2", "10", null],
    );
    assert.equal(events.filter((event) => event.type === "migration.end").length, 4);
    assert.equal(events.filter((event) => event.type === "lock.acquire").length, 0);
    native.exec("PRAGMA query_only = ON");
    statements.length = 0;
    let callbackReport;
    assert.equal(
      (
        await migrator.startup(db, {
          onReport: (report) => {
            callbackReport = report;
          },
        })
      ).status,
      "current",
    );
    const lastEvent = events.at(-1);
    assert.equal(callbackReport, lastEvent?.type === "startup.check" ? lastEvent.report : undefined);
    assert.equal(statements.length, 1);
    assert.match(statements[0]!, /^SELECT /);
    assert.deepEqual(await db.all(sql.rows`SELECT id FROM user_ids ORDER BY id`), [{ id: "2" }, { id: "10" }]);
  } finally {
    native.close();
  }
});

test("history comparison distinguishes ahead, checksum, missing source, out-of-order and pending", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const first = entry("1", "CREATE TABLE users (id INTEGER)");
  const third = entry("3", "INSERT INTO users VALUES (3)");
  try {
    await createMigrator({ manifest: manifest([first, third]), dialect }).up(db);
    const old = createMigrator({ manifest: manifest([first]), dialect });
    assert.equal((await old.startup(db)).status, "ahead");
    await assert.rejects(old.startup(db, { ahead: "error" }), { code: "BRAID_MIGRATE_AHEAD" });
    const missing = createMigrator({ manifest: manifest([third]), dialect });
    const missingReport = await missing.startup(db, { mode: "report" });
    assert.deepEqual(
      missingReport.differences.map((difference) => difference.kind),
      ["missing-source"],
    );
    await assert.rejects(missing.up(db), { code: "BRAID_MIGRATE_ORDER" });
    const changed = createMigrator({
      manifest: manifest([
        entry("01", "CREATE TABLE users (id TEXT)"),
        entry("2", "SELECT 2"),
        third,
        entry("4", "SELECT 4"),
      ]),
      dialect,
    });
    const result = await changed.startup(db, { mode: "report" });
    assert.equal(result.status, "mismatch");
    assert.deepEqual(
      result.differences.map((difference) => difference.kind),
      ["checksum-mismatch", "out-of-order", "pending"],
    );
    await assert.rejects(changed.startup(db), { code: "BRAID_MIGRATE_CHECKSUM" });
  } finally {
    native.close();
  }
});

test("changed repeatables append history after pending versions and unchanged repeatables do not run", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const first = entry("1", "CREATE TABLE counts (value INTEGER)");
  const repeat = entry(null, "INSERT INTO counts VALUES (1)");
  try {
    await createMigrator({ manifest: manifest([first, repeat]), dialect }).up(db);
    const changed = createMigrator({
      manifest: manifest([
        first,
        entry("2", "INSERT INTO counts VALUES (2)"),
        entry(null, "INSERT INTO counts VALUES (3)"),
      ]),
      dialect,
    });
    assert.deepEqual(
      (await changed.startup(db, { mode: "report" })).differences.map((difference) => difference.kind),
      ["pending", "repeatable-changed"],
    );
    const applied = await changed.up(db);
    assert.deepEqual(
      applied.history.map((row) => row.version),
      ["1", null, "2", null],
    );
    await changed.up(db);
    assert.equal((await db.one(sql.rows<{ count: string }>`SELECT COUNT(*) AS count FROM counts`)).count, "3");
  } finally {
    native.close();
  }
});

test("transactional failure rolls back migration DDL and its claim", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const events: MigrationEvent[] = [];
  const migrator = createMigrator({
    manifest: manifest([entry("1", "CREATE TABLE rollback_probe (id INTEGER); INSERT INTO missing_table VALUES (1)")]),
    dialect,
    onEvent: (event) => events.push(event),
  });
  try {
    await assert.rejects(migrator.up(db), /no such table/);
    const report = await migrator.startup(db, { mode: "report" });
    assert.equal(report.status, "pending");
    assert.equal(report.history.length, 0);
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_probe'").all().length, 0);
    assert.equal(events.filter((event) => event.type === "migration.error").length, 1);
    assert.equal(events.filter((event) => event.type === "migration.end").length, 0);
  } finally {
    native.close();
  }
});

test("transaction=off preserves failed attempts, repair removes only incomplete history, and stale claims time out", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const first = entry("1", "CREATE TABLE retained (id INTEGER)");
  const failed = entry(
    "2",
    "-- @braid-migrate transaction=off\nCREATE TABLE partial (id INTEGER); INSERT INTO missing_table VALUES (1)",
  );
  const migrator = createMigrator({ manifest: manifest([first, failed]), dialect, busyTimeoutMs: 0 });
  try {
    await assert.rejects(migrator.up(db), /no such table/);
    const dirty = await migrator.startup(db, { mode: "report" });
    assert.equal(dirty.status, "incomplete");
    assert.deepEqual(
      dirty.history.map((row) => row.status),
      ["success", "failed"],
    );
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").all().length, 1);
    await assert.rejects(migrator.up(db), { code: "BRAID_MIGRATE_DIRTY" });
    const repaired = await migrator.repair(db);
    assert.equal(repaired.status, "pending");
    assert.deepEqual(
      repaired.history.map((row) => row.version),
      ["1"],
    );
    native.exec("UPDATE \"_sqlbraid_migrations\" SET status = 'running'");
    await assert.rejects(migrator.up(db), { code: "BRAID_MIGRATE_BUSY" });
    assert.equal((await migrator.repair(db)).history.length, 0);
  } finally {
    native.close();
  }
});

test("baseline skips existing versions without executing their bodies and preserves pending work", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  native.exec("CREATE TABLE existing (id INTEGER)");
  const migrator = createMigrator({
    manifest: manifest([
      entry("1", "CREATE TABLE existing (id INTEGER)"),
      entry("2", "INSERT INTO existing VALUES (2)"),
    ]),
    dialect,
  });
  try {
    const baseline = await migrator.baseline(db, "001");
    assert.equal(baseline.status, "pending");
    assert.equal(baseline.history[0]?.kind, "baseline");
    assert.equal((await migrator.up(db)).status, "current");
    assert.deepEqual(await db.all(sql.rows`SELECT id FROM existing`), [{ id: "2" }]);
    await assert.rejects(migrator.baseline(db, "2"), { code: "BRAID_MIGRATE_ORDER" });
  } finally {
    native.close();
  }
});

test("pooled verify acquires and releases exactly one lease and never opens a session or transaction", async () => {
  const native = new DatabaseSync(":memory:");
  const direct = createNodeSqliteDatabase(native);
  const executor = createNodeSqliteExecutor(native);
  let acquisitions = 0;
  let releases = 0;
  const pooled = createPooledDatabase({
    statementBinding: executor.statementBinding,
    async acquire() {
      acquisitions += 1;
      return {
        ...executor,
        release() {
          releases += 1;
        },
      };
    },
  });
  const migrator = createMigrator({ manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER)")]), dialect });
  try {
    await migrator.up(direct);
    assert.equal((await migrator.startup(pooled)).status, "current");
    assert.equal(acquisitions, 1);
    assert.equal(releases, 1);
  } finally {
    native.close();
  }
});

test("once shares in-flight checks, retries rejected checks, and retains successful results per database", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const migrator = createMigrator({ manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER)")]), dialect });
  let reads = 0;
  const intermittent: Database = {
    ...db,
    async all(query, options) {
      reads += 1;
      if (reads === 1) throw new Error("temporary network failure");
      return db.all(query, options);
    },
  };
  try {
    await migrator.up(db);
    const first = migrator.once(intermittent, { retryIntervalMs: 0 });
    assert.equal(migrator.once(intermittent, { retryIntervalMs: 0 }), first);
    await assert.rejects(first, /temporary network/);
    const next = migrator.once(intermittent, { retryIntervalMs: 0 });
    assert.notEqual(next, first);
    assert.equal((await next).status, "current");
    assert.equal(migrator.once(intermittent), next);
    assert.equal(reads, 2);
  } finally {
    native.close();
  }
});

test("concurrent native SQLite claims execute each migration once, with transactional and committed claims", async () => {
  for (const transactional of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "sqlbraid-migrate-"));
    const firstNative = new DatabaseSync(join(directory, "database.sqlite"));
    const secondNative = new DatabaseSync(join(directory, "database.sqlite"));
    firstNative.exec("PRAGMA busy_timeout = 0");
    secondNative.exec("PRAGMA busy_timeout = 0");
    const first = createNodeSqliteDatabase(firstNative);
    const second = createNodeSqliteDatabase(secondNative);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const synchronized = (db: Database): Database => {
      let firstRead = true;
      return {
        ...db,
        async all(query, options) {
          const rows = await db.all(query, options);
          if (firstRead) {
            firstRead = false;
            arrivals += 1;
            if (arrivals === 2) release();
            await gate;
          }
          return rows;
        },
        async environment(options) {
          const environment = await db.environment(options);
          return transactional
            ? environment
            : {
                ...environment,
                capabilities: {
                  ...environment.capabilities,
                  transaction: { status: "unsupported" },
                },
              };
        },
      };
    };
    let runs = 0;
    const body = defineMigration(async (scoped) => {
      runs += 1;
      await scoped.execute(sql.command`CREATE TABLE once_only (id INTEGER)`);
      await scoped.execute(sql.command`INSERT INTO once_only VALUES (1)`);
    });
    const options = { manifest: manifest([entry("1", body)]), dialect, busyTimeoutMs: 2000 };
    try {
      await createMigrator({ manifest: manifest([]), dialect }).up(first);
      const reports = await Promise.all([
        createMigrator(options).up(synchronized(first)),
        createMigrator(options).up(synchronized(second)),
      ]);
      assert.deepEqual(
        reports.map((report) => report.status),
        ["current", "current"],
      );
      assert.equal(runs, 1);
      assert.equal(reports[0]?.history.length, 1);
    } finally {
      firstNative.close();
      secondNative.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("optional drift stores only own successful apply hash and ordinary checks never inspect schema", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  let inspections = 0;
  let hash = "a".repeat(64);
  const snapshot = { tables: ["users"] };
  const migrator = createMigrator({
    manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER)")]),
    dialect,
    drift: {
      dialect: "sqlite",
      async inspect() {
        inspections += 1;
        return { hash, snapshot, differences: ["tables.users.columns.name"] };
      },
    },
  });
  try {
    const applied = await migrator.up(db);
    assert.equal(applied.history[0]?.schema_hash, hash);
    assert.equal(inspections, 1);
    await migrator.up(db);
    await migrator.startup(db);
    assert.equal(inspections, 1);
    assert.equal(await migrator.snapshot(db), snapshot);
    hash = "b".repeat(64);
    await assert.rejects(migrator.startup(db, { schema: "hash" }), (error) => {
      assert.ok(error instanceof MigrationStartupError);
      assert.equal(error.code, "BRAID_MIGRATE_SCHEMA_DRIFT");
      assert.equal(error.report.differences[0]?.path, "tables.users.columns.name");
      return true;
    });
  } finally {
    native.close();
  }
});

test("baseline records the inspected schema hash so later hash checks detect drift", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  let hash = "a".repeat(64);
  const migrator = createMigrator({
    manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER)")]),
    dialect,
    drift: {
      dialect: "sqlite",
      async inspect() {
        return { hash, snapshot: { hash }, differences: ["tables.users.columns.name"] };
      },
    },
  });
  try {
    native.exec("CREATE TABLE users (id INTEGER)");
    const baseline = await migrator.baseline(db, "1");
    assert.equal(baseline.history[0]?.schema_hash, hash);
    assert.equal((await migrator.startup(db, { schema: "hash" })).status, "current");
    hash = "b".repeat(64);
    await assert.rejects(migrator.startup(db, { schema: "hash" }), (error) => {
      assert.ok(error instanceof MigrationStartupError);
      assert.equal(error.code, "BRAID_MIGRATE_SCHEMA_DRIFT");
      return true;
    });
  } finally {
    native.close();
  }
});

test("acceptSchema explicitly refreshes a stale stored schema hash on the latest successful row", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  let hash = "a".repeat(64);
  const drift = {
    dialect: "sqlite",
    async inspect() {
      return { hash, snapshot: {} };
    },
  };
  const entries = [entry("1", "CREATE TABLE users (id INTEGER)"), entry("2", "CREATE TABLE posts (id INTEGER)")];
  const migrator = createMigrator({ manifest: manifest(entries), dialect, drift });
  try {
    await assert.rejects(migrator.acceptSchema(db), { code: "BRAID_MIGRATE_UNINITIALIZED" });
    await createMigrator({ manifest: manifest(entries.slice(0, 1)), dialect, drift }).up(db);
    hash = "b".repeat(64);
    // An apply without a drift adapter leaves the old hash in place.
    await createMigrator({ manifest: manifest(entries), dialect }).up(db);
    await assert.rejects(migrator.startup(db, { schema: "hash" }), { code: "BRAID_MIGRATE_SCHEMA_DRIFT" });
    const accepted = await migrator.acceptSchema(db);
    assert.equal(accepted.status, "current");
    assert.deepEqual(
      accepted.history.map((row) => row.schema_hash),
      ["a".repeat(64), "b".repeat(64)],
    );
    assert.equal((await migrator.startup(db, { schema: "hash" })).status, "current");
    await assert.rejects(createMigrator({ manifest: manifest(entries), dialect }).acceptSchema(db), /drift option/u);
  } finally {
    native.close();
  }
});

test("acceptSchema rejects history without a successful migration", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const migrator = createMigrator({
    manifest: manifest([entry("1", "CREATE TABLE users (id INTEGER); SELECT missing_function()")]),
    dialect,
    drift: { dialect: "sqlite", inspect: async () => ({ hash: "a".repeat(64), snapshot: {} }) },
  });
  try {
    await assert.rejects(migrator.up(db));
    await assert.rejects(migrator.acceptSchema(db), { code: "BRAID_MIGRATE_ORDER" });
  } finally {
    native.close();
  }
});

test("apply with schema hash rejects existing drift before it runs pending migrations", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  let hash = "a".repeat(64);
  const drift = { dialect: "sqlite", inspect: async () => ({ hash, snapshot: {} }) };
  const first = entry("1", "CREATE TABLE users (id INTEGER)");
  const reports: string[] = [];
  try {
    await createMigrator({ manifest: manifest([first]), dialect, drift }).up(db);
    hash = "b".repeat(64);
    const migrator = createMigrator({
      manifest: manifest([first, entry("2", "CREATE TABLE posts (id INTEGER)")]),
      dialect,
      drift,
    });
    await assert.rejects(
      migrator.startup(db, { mode: "apply", schema: "hash", onReport: (report) => reports.push(report.status) }),
      { code: "BRAID_MIGRATE_SCHEMA_DRIFT" },
    );
    assert.deepEqual(reports, ["mismatch"]);
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name = 'posts'").get(), undefined);
    assert.equal((await migrator.startup(db, { mode: "report" })).status, "pending");
  } finally {
    native.close();
  }
});

test("split=none rejects several SQLite statements instead of running only the first", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const migrator = createMigrator({
    manifest: manifest([entry("1", "-- @braid-migrate split=none\nCREATE TABLE a (x); CREATE TABLE b (y);")]),
    dialect,
  });
  try {
    await assert.rejects(migrator.up(db), { code: "BRAID_MIGRATE_SOURCE" });
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name IN ('a', 'b')").get(), undefined);
    assert.equal((await migrator.startup(db, { mode: "report" })).history.length, 0);
  } finally {
    native.close();
  }
});

const noop = async (): Promise<void> => {};

test("defineMigration returns one frozen shape and validates its options", () => {
  const run = noop;
  const definition = defineMigration(run);
  assert.deepEqual(definition, { run, transaction: true });
  assert.ok(Object.isFrozen(definition));
  assert.equal(defineMigration(run, { transaction: false }).transaction, false);
  assert.throws(() => defineMigration(run, { transactions: false } as never), /Unknown migration options/u);
  assert.throws(() => defineMigration(run, { transaction: "no" } as never), /boolean/u);
  assert.throws(() => defineMigration(run, null as never), /object/u);
});

test("a nontransactional TypeScript migration commits its claim first and leaves a failed row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-migrate-tx-off-"));
  const file = join(directory, "database.sqlite");
  const native = new DatabaseSync(file);
  const observer = new DatabaseSync(file);
  const db = createNodeSqliteDatabase(native);
  const seen: unknown[] = [];
  const body = (transaction: boolean) =>
    defineMigration(
      async (scoped) => {
        seen.push(
          observer
            .prepare("SELECT status FROM _sqlbraid_migrations")
            .all()
            .map((row) => ({ status: row.status })),
        );
        await scoped.execute(sql.command`CREATE TABLE kept (id INTEGER)`);
        throw new Error("migration failure");
      },
      { transaction },
    );
  try {
    await assert.rejects(
      createMigrator({ manifest: manifest([entry("1", body(true), "V1__on.ts")]), dialect }).up(db),
      /migration failure/u,
    );
    assert.deepEqual(native.prepare("SELECT status FROM _sqlbraid_migrations").all(), []);
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name = 'kept'").get(), undefined);
    const migrator = createMigrator({ manifest: manifest([entry("1", body(false), "V1__off.ts")]), dialect });
    await assert.rejects(migrator.up(db), /migration failure/u);
    assert.deepEqual(seen, [[], [{ status: "running" }]]);
    assert.deepEqual(
      native
        .prepare("SELECT status FROM _sqlbraid_migrations")
        .all()
        .map((row) => ({ status: row.status })),
      [{ status: "failed" }],
    );
    assert.ok(native.prepare("SELECT name FROM sqlite_master WHERE name = 'kept'").get());
    await assert.rejects(migrator.up(db), { code: "BRAID_MIGRATE_DIRTY" });
  } finally {
    observer.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest and option validation rejects ambiguous identities and malformed inputs before SQL", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const valid = manifest([entry("1", "SELECT 1")]);
  try {
    assert.throws(() => createMigrator({ manifest: manifest([entry("1", ""), entry("01.0", "")]), dialect }), {
      code: "BRAID_MIGRATE_SOURCE",
    });
    assert.throws(() => createMigrator({ manifest: manifest([{ ...entry("1", ""), checksum: "bad" }]), dialect }), {
      code: "BRAID_MIGRATE_SOURCE",
    });
    assert.throws(() => createMigrator({ manifest: valid, dialect, busyTimeoutMs: -1 }), TypeError);
    assert.throws(() => createMigrator({ manifest: valid, dialect, table: "bad\0name" }), TypeError);
    assert.throws(() => createMigrator({ manifest: valid, dialect, appliedBy: "" }), TypeError);
    const migrator = createMigrator({ manifest: valid, dialect });
    // @ts-expect-error This intentionally exercises the JavaScript trust boundary.
    await assert.rejects(migrator.startup(db, { mode: "typo" }), TypeError);
    await assert.rejects(migrator.startup(db, { schema: "hash" }), TypeError);
  } finally {
    native.close();
  }
});

test("custom history identifiers are quoted and scopes remain bound, isolated values", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  native.exec("CREATE TABLE keep (id INTEGER)");
  const table = 'history"; DROP TABLE keep;--';
  const options = { manifest: manifest([entry("1", "SELECT 1")]), dialect, table, schema: "main" };
  const migrator = createMigrator({ ...options, scope: "scope'; DELETE FROM keep;--" });
  try {
    assert.equal((await migrator.up(db)).status, "current");
    assert.equal((await migrator.startup(db)).history.length, 1);
    const other = createMigrator({ ...options, scope: "other" });
    assert.equal((await other.startup(db, { mode: "report" })).status, "pending");
    assert.equal((await other.up(db)).history.length, 1);
    assert.equal(native.prepare("SELECT name FROM sqlite_master WHERE name = 'keep'").all().length, 1);
  } finally {
    native.close();
  }
});

test("migration observer failure preserves the original migration error", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const migrationError = new Error("migration body failed");
  const observerError = new Error("migration error observer failed");
  const migrator = createMigrator({
    manifest: manifest([
      entry("1", async () => {
        throw migrationError;
      }),
    ]),
    dialect,
    onEvent(event) {
      if (event.type === "migration.error") throw observerError;
    },
  });
  try {
    await assert.rejects(migrator.up(db), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationError, observerError]);
      assert.equal(error.cause, migrationError);
      return true;
    });
    assert.equal((await migrator.startup(db, { mode: "report" })).history.length, 0);
  } finally {
    native.close();
  }
});

test("a migration's own unique violation is not mistaken for a lost history claim", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createNodeSqliteDatabase(native);
  const migrator = createMigrator({
    manifest: manifest([
      entry("1", "CREATE TABLE unique_values (id INTEGER UNIQUE)"),
      entry("2", "INSERT INTO unique_values VALUES (1); INSERT INTO unique_values VALUES (1)"),
    ]),
    dialect,
    busyTimeoutMs: 0,
  });
  try {
    await assert.rejects(migrator.up(db), /UNIQUE constraint failed/);
    const report = await migrator.startup(db, { mode: "report" });
    assert.deepEqual(
      report.history.map((row) => row.version),
      ["1"],
    );
    assert.deepEqual(await db.all(sql.rows`SELECT id FROM unique_values`), []);
  } finally {
    native.close();
  }
});
