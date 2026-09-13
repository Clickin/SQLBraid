import assert from "node:assert/strict";
import { createConnection, createPool } from "mysql2/promise";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

interface UserRow {
  readonly id: number;
  readonly name: string;
}

const connectionString = process.env.SQLBRAID_MYSQL_URL;
if (!connectionString) throw new Error("SQLBRAID_MYSQL_URL is required for the MySQL example.");

const connection = await createConnection(connectionString);
try {
  await connection.query("CREATE TEMPORARY TABLE users (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL)");
  await connection.query("INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Grace')");
  const db = createMysql2Database(connection);
  const requestedId: number | undefined = 1;
  const query = sql.rows<UserRow>`
    SELECT id, name
    FROM users
    /*@braid where*/
      /*@braid if ${requestedId !== undefined}*/ AND id = ${requestedId} /*@braid end*/
    /*@braid end*/
    ORDER BY id
  `;

  assert.deepEqual(await db.all(query), [{ id: 1, name: "Ada" }]);
  console.info("PASS MySQL packed query and dynamic guard");
} finally {
  await connection.end();
}

const pool = createPool(connectionString);
try {
  const db = createMysql2PoolDatabase(pool);
  const name = "Ada";
  assert.deepEqual(await db.all(sql.rows<UserRow>`SELECT 1 AS id, ${name} AS name`), [{ id: 1, name }]);
  console.info("PASS MySQL packed pool query");
} finally {
  await pool.end();
}
