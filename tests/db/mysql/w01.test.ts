import { createConnection } from "mysql2/promise";
import { inject, test } from "vitest";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";
import { runW01 } from "../w01.js";

test("MySQL adapter preserves transaction isolation on an independent observer connection", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  const observer = await createConnection(settings.connectionUri);
  try {
    const [versionRows] = await observer.query("SELECT VERSION() AS version");
    const version = (versionRows as { version: string }[])[0]?.version ?? "unknown";
    console.info(`[db-mysql] server_version=${version}`);
    const db = createMysql2Database(client);
    await runW01({
      db,
      sql,
      rows: async () => {
        const [result] = await observer.query("SELECT id FROM braid_w01 ORDER BY id");
        return (result as { id: string }[]).map((row) => row.id);
      },
      clear: async () => { await observer.query("DELETE FROM braid_w01"); },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});
