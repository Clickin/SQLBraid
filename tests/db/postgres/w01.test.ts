import { Client } from "pg";
import { inject, test } from "vitest";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";
import { runW01 } from "../w01.js";

test("PostgreSQL adapter preserves transaction isolation on an independent observer connection", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  const observer = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  await observer.connect();
  try {
    const version = await observer.query<{ server_version: string }>("SHOW server_version");
    console.info(`[db-postgres] server_version=${version.rows[0]?.server_version ?? "unknown"}`);
    const db = createPgDatabase(client);
    await runW01({
      db,
      sql,
      rows: async () => (await observer.query<{ id: string }>("SELECT id FROM braid_w01 ORDER BY id")).rows.map((row) => row.id),
      clear: async () => { await observer.query("DELETE FROM braid_w01"); },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});
