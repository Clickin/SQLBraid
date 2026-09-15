import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";

interface UserRow {
  readonly id: string;
  readonly name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.exec("INSERT INTO users (name) VALUES ('Ada'), ('Grace')");
  const db = createNodeSqliteDatabase(native);
  const requestedId: number | undefined = 1;
  const query = sql.rows<UserRow>`
    SELECT id, name
    FROM users
    /*@braid where*/
      /*@braid if ${requestedId !== undefined}*/ AND id = ${requestedId} /*@braid end*/
    /*@braid end*/
    ORDER BY id
  `;

  assert.deepEqual(await db.all(query), [{ id: "1", name: "Ada" }]);
  console.info("PASS sqlite quickstart query and dynamic guard");
} finally {
  native.close();
}
