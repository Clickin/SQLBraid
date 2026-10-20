import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqliteConnection } from "@execution-lab/driver";

const native = new DatabaseSync(":memory:");
const connection = sqliteConnection(native);
let primaryError;
try {
  assert.equal(connection.capabilities.streaming, false);
  assert.equal(connection.stream, undefined);
  await connection.execute({ sql: "CREATE TABLE example (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)" });
  const inserted = await connection.execute({
    sql: "INSERT INTO example (name) VALUES (?)",
    parameters: ["O'Reilly; -- bound, not SQL"],
  });
  assert.equal(inserted.affectedRows, 1);
  assert.equal(inserted.insertId, 1);
  const selected = await connection.execute({ sql: "SELECT id, name FROM example WHERE id = ?", parameters: [1] });
  assert.equal(selected.rows[0].id, 1);
  assert.equal(selected.rows[0].name, "O'Reilly; -- bound, not SQL");

  await connection.begin();
  await connection.execute({ sql: "UPDATE example SET name = ? WHERE id = ?", parameters: ["committed", 1] });
  await connection.commit();
  await connection.begin();
  await connection.execute({ sql: "INSERT INTO example (name) VALUES (?)", parameters: ["rolled back"] });
  await assert.rejects(connection.execute({ sql: "INSERT INTO example (name) VALUES (?)", parameters: ["committed"] }));
  await assert.rejects(connection.commit(), { code: "TRANSACTION_STATE" });
  await connection.rollback();
  const after = await connection.execute({ sql: "SELECT name FROM example ORDER BY id" });
  assert.deepEqual(
    after.rows.map((row) => row.name),
    ["committed"],
  );

  // Native object rows retain the last duplicate label; both labels remain in metadata.
  const duplicate = await connection.execute({ sql: "SELECT 1 AS repeated, 2 AS repeated" });
  assert.equal(duplicate.rows[0].repeated, 2);
  assert.deepEqual(
    duplicate.columns.map((column) => column.name),
    ["repeated", "repeated"],
  );
  await assert.rejects(connection.begin({ isolation: "read-committed" }), { code: "UNSUPPORTED" });
  await assert.rejects(connection.begin({ readOnly: true }), { code: "UNSUPPORTED" });
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
assert.throws(() => native.prepare("SELECT 1"));
await assert.rejects(connection.execute({ sql: "SELECT 1" }), { code: "CLOSED" });
console.log("packed node:sqlite: parameters, DML, native values, commit, failed transaction, rollback, close passed");
