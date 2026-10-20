import assert from "node:assert/strict";
import pg from "pg";
import { pgConnection, pgPool } from "@execution-lab/driver";

const connectionString = process.env.DRIVER_EXPERIMENT_DATABASE_URL;
assert.ok(connectionString, "Run through runner.mjs, which supplies a disposable test database.");
const client = new pg.Client({ connectionString });
await client.connect();
const connection = pgConnection(client);
let ended = false;
client.once("end", () => {
  ended = true;
});
let primaryError;
try {
  await connection.execute({ sql: "CREATE TABLE example (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)" });
  const inserted = await connection.execute({
    sql: "INSERT INTO example VALUES ($1, $2)",
    parameters: [1, "O'Reilly; -- bound, not SQL"],
  });
  assert.equal(inserted.affectedRows, 1);
  const selected = await connection.execute({ sql: "SELECT id, name FROM example WHERE id = $1", parameters: [1] });
  assert.equal(selected.rows[0].id, 1); // Native pg int4 is a number, not SQLBraid's string.
  assert.equal(selected.rows[0].name, "O'Reilly; -- bound, not SQL");
  const native = await connection.execute({
    sql: "SELECT 42::int4 AS small, 9007199254740993::int8 AS large, 1.25::numeric AS exact",
  });
  assert.deepEqual(native.rows, [{ small: 42, large: "9007199254740993", exact: "1.25" }]);
  assert.equal(native.columns[0].dataTypeID, 23);
  const duplicate = await connection.execute({ sql: "SELECT 1 AS repeated, 2 AS repeated" });
  assert.deepEqual(duplicate.rows, [{ repeated: 2 }]);
  assert.deepEqual(
    duplicate.columns.map((column) => column.name),
    ["repeated", "repeated"],
  );

  await connection.begin();
  await connection.execute({ sql: "UPDATE example SET name = $1 WHERE id = $2", parameters: ["committed", 1] });
  await connection.commit();
  await connection.begin();
  await connection.execute({ sql: "INSERT INTO example VALUES ($1, $2)", parameters: [2, "rolled back"] });
  await assert.rejects(
    connection.execute({ sql: "INSERT INTO example VALUES ($1, $2)", parameters: [3, "committed"] }),
    { code: "23505" },
  );
  await assert.rejects(connection.execute({ sql: "SELECT 1" }), { code: "TRANSACTION_STATE" });
  await connection.rollback();
  assert.deepEqual((await connection.execute({ sql: "SELECT id, name FROM example" })).rows, [
    { id: 1, name: "committed" },
  ]);
  await assert.rejects(connection.execute({ sql: "SELECT * FROM missing_example_relation" }), { code: "42P01" });
  assert.equal((await connection.execute({ sql: "SELECT 1 AS recovered" })).rows[0].recovered, 1);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await connection.release();
  } catch (error) {
    throw primaryError ? new AggregateError([primaryError, error], "Query and cleanup failed.") : error;
  }
}
assert.equal(ended, true, "Direct release must end the native client.");
await assert.rejects(connection.execute({ sql: "SELECT 1" }), { code: "CLOSED" });

const pool = new pg.Pool({ connectionString, max: 1 });
const provider = pgPool(pool);
let active;
try {
  const first = await provider.acquire();
  active = first;
  const pid = (await first.execute({ sql: "SELECT pg_backend_pid() AS pid" })).rows[0].pid;
  await first.begin();
  await first.execute({ sql: "INSERT INTO example VALUES ($1, $2)", parameters: [4, "rollback on release"] });
  await first.release();
  active = undefined;
  assert.equal(pool.idleCount, 1);
  await assert.rejects(first.execute({ sql: "SELECT 1" }), { code: "CLOSED" });
  const second = await provider.acquire();
  active = second;
  assert.equal((await second.execute({ sql: "SELECT pg_backend_pid() AS pid" })).rows[0].pid, pid);
  assert.equal((await second.execute({ sql: "SELECT count(*)::int4 AS count FROM example" })).rows[0].count, 1);
  await second.release({ discard: true });
  active = undefined;
  assert.equal(pool.totalCount, 0, "Discard must remove the physical connection, not end the pool.");
  const third = await provider.acquire();
  active = third;
  await third.release();
  active = undefined;
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const errors = [];
  if (active) {
    try {
      await active.release({ discard: true });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await pool.end();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(primaryError ? [primaryError, ...errors] : errors, "Pool cleanup failed.");
}
console.log(
  "packed pg: parameters, native values, duplicate metadata, transactions, errors, pooled rollback/reuse/discard passed",
);
