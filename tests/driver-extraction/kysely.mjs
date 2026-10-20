import assert from "node:assert/strict";
import pg from "pg";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { pgPool } from "@execution-lab/driver";

function rejectSignal(options) {
  if (!options?.signal) return;
  options.signal.throwIfAborted();
  throw new Error("The experimental adapter does not support cancellation.");
}

function nativeInteger(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError("An unsafe native integer cannot be converted losslessly to bigint.");
  }
  return BigInt(value);
}

function kyselyResult(result) {
  return {
    rows: result.rows,
    ...(result.affectedRows === undefined ? {} : { numAffectedRows: nativeInteger(result.affectedRows) }),
    ...(result.insertId === undefined ? {} : { insertId: nativeInteger(result.insertId) }),
  };
}

// Kysely owns compilation and transaction callbacks; each adapter connection owns one lease.
class ExtractionDriver {
  constructor(provider, close) {
    this.provider = provider;
    this.close = close;
  }
  async init(options) {
    rejectSignal(options);
  }
  async acquireConnection(options) {
    rejectSignal(options);
    const lease = await this.provider.acquire();
    return {
      lease,
      async executeQuery(query, executionOptions) {
        return kyselyResult(await lease.execute({ sql: query.sql, parameters: query.parameters }, executionOptions));
      },
      async *streamQuery() {
        throw new Error("The experimental adapter does not support streaming.");
      },
    };
  }
  async beginTransaction(connection, settings) {
    const isolation = {
      "read uncommitted": "read-uncommitted",
      "read committed": "read-committed",
      "repeatable read": "repeatable-read",
      serializable: "serializable",
    };
    if (
      Object.keys(settings).some((key) => key !== "isolationLevel" && key !== "accessMode") ||
      (settings.isolationLevel !== undefined && !Object.hasOwn(isolation, settings.isolationLevel)) ||
      (settings.accessMode !== undefined && !["read only", "read write"].includes(settings.accessMode))
    ) {
      throw new Error("Unsupported transaction settings.");
    }
    await connection.lease.begin({
      ...(settings.isolationLevel === undefined ? {} : { isolation: isolation[settings.isolationLevel] }),
      ...(settings.accessMode === undefined ? {} : { readOnly: settings.accessMode === "read only" }),
    });
  }
  async commitTransaction(connection) {
    await connection.lease.commit();
  }
  async rollbackTransaction(connection) {
    await connection.lease.rollback();
  }
  async releaseConnection(connection) {
    await connection.lease.release();
  }
  async destroy() {
    await this.close();
  }
}

const connectionString = process.env.DRIVER_EXPERIMENT_DATABASE_URL;
assert.ok(connectionString, "Run through runner.mjs with a disposable test database.");
const pool = new pg.Pool({ connectionString, max: 1 });
const driver = new ExtractionDriver(pgPool(pool), () => pool.end());
const db = new Kysely({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
let primaryError;
try {
  await db.schema
    .createTable("kysely_example")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .execute();
  const inserted = await db.insertInto("kysely_example").values({ id: 1, name: "bound ' value" }).executeTakeFirst();
  assert.equal(inserted.numInsertedOrUpdatedRows, 1n);
  assert.deepEqual(await db.selectFrom("kysely_example").selectAll().where("id", "=", 1).execute(), [
    { id: 1, name: "bound ' value" },
  ]);

  let transactionLease;
  const acquire = driver.acquireConnection.bind(driver);
  let acquisitions = 0;
  driver.acquireConnection = async (options) => {
    acquisitions++;
    transactionLease = await acquire(options);
    return transactionLease;
  };
  await db
    .transaction()
    .setIsolationLevel("serializable")
    .execute(async (transaction) => {
      await transaction.insertInto("kysely_example").values({ id: 2, name: "committed" }).execute();
      assert.equal(
        (await transaction.selectFrom("kysely_example").selectAll().where("id", "=", 2).executeTakeFirst()).name,
        "committed",
      );
    });
  assert.equal(acquisitions, 1, "A transaction must keep one physical lease for all statements.");
  await assert.rejects(transactionLease.lease.execute({ sql: "SELECT 1" }), { code: "CLOSED" });
  await assert.rejects(
    db.transaction().execute(async (transaction) => {
      await transaction.insertInto("kysely_example").values({ id: 3, name: "rolled back" }).execute();
      await transaction.insertInto("kysely_example").values({ id: 4, name: "committed" }).execute();
    }),
    { code: "23505" },
  );
  assert.deepEqual(
    (await db.selectFrom("kysely_example").select("id").orderBy("id").execute()).map((row) => row.id),
    [1, 2],
  );
  const updated = await db
    .updateTable("kysely_example")
    .set({ name: "updated" })
    .where("id", "=", 1)
    .executeTakeFirst();
  assert.equal(updated.numUpdatedRows, 1n);
  const deleted = await db.deleteFrom("kysely_example").where("id", "=", 2).executeTakeFirst();
  assert.equal(deleted.numDeletedRows, 1n);
  const lease = await driver.acquireConnection();
  let leaseError;
  try {
    await assert.rejects(driver.beginTransaction(lease, { isolationLevel: "snapshot" }), /Unsupported/);
    await assert.rejects(driver.beginTransaction(lease, { deferrable: true }), /Unsupported/);
    await assert.rejects(lease.streamQuery({ sql: "SELECT 1", parameters: [] }, 10).next(), /streaming/);
  } catch (error) {
    leaseError = error;
    throw error;
  } finally {
    try {
      await driver.releaseConnection(lease);
    } catch (error) {
      throw leaseError ? new AggregateError([leaseError, error], "Adapter check and cleanup failed.") : error;
    }
  }
  // pg has no native insert ID. The common mapping also preserves SQLite-style bigint IDs.
  assert.deepEqual(kyselyResult({ rows: [], affectedRows: 2, insertId: 9007199254740993n }), {
    rows: [],
    numAffectedRows: 2n,
    insertId: 9007199254740993n,
  });
  assert.throws(() => kyselyResult({ rows: [], affectedRows: Number.MAX_SAFE_INTEGER + 1 }), RangeError);
  assert.throws(() => kyselyResult({ rows: [], insertId: Number.MAX_SAFE_INTEGER + 1 }), RangeError);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await db.destroy();
  } catch (error) {
    throw primaryError ? new AggregateError([primaryError, error], "Query and cleanup failed.") : error;
  }
}
console.log(
  "packed Kysely 0.29.7: built-in compiler, native parameters, pinned transactions, rollback, bigint metadata passed",
);
