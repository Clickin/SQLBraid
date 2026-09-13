import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

interface UserRow {
  readonly id: number;
  readonly name: string;
}

const connectionString = process.env.SQLBRAID_POSTGRES_URL;
if (!connectionString) throw new Error("SQLBRAID_POSTGRES_URL is required for the PostgreSQL example.");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("CREATE TEMP TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  await client.query("INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Grace')");
  const db = createPgDatabase(client);
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
  console.info("PASS PostgreSQL packed query and dynamic guard");
} finally {
  await client.end();
}

const pool = new Pool({ connectionString });
try {
  const db = createPgPoolDatabase(pool);
  const name = "Ada";
  assert.deepEqual(await db.all(sql.rows<UserRow>`SELECT 1 AS id, ${name}::text AS name`), [{ id: 1, name }]);
  console.info("PASS PostgreSQL packed pool query");
} finally {
  await pool.end();
}
