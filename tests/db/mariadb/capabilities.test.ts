import assert from "node:assert/strict";
import mariadb from "mariadb";
import { inject, test } from "vitest";
import type { ExecutionEvent } from "@sqlbraid/core";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";
import { sql } from "@sqlbraid/mariadb";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";

test("MariaDB preserves native comments, quoted identifiers, CTEs, JSON, and sequence syntax", async () => {
  const connection = await mariadb.createConnection(inject("mariadb").connectionUri);
  const events: ExecutionEvent[] = [];
  const db = createMariaDbDatabase(connection, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    await connection.query("DROP TABLE IF EXISTS braid_mariadb_capability");
    await connection.query(`
      CREATE TABLE braid_mariadb_capability (
        id INT NOT NULL PRIMARY KEY,
        \`label\` VARCHAR(255) NOT NULL,
        payload JSON NOT NULL
      )
    `);
    const bulkReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "mariadb",
      expectedMode: "native-bulk",
      events,
    });
    assert.equal(bulkReport.executionMode, "native-bulk");
    const marker = "quoted ? :1 $1 @p1";
    await db.execute(sql.command`
      /* MariaDB native comment: quoted ? :1 $1 @p1 */
      INSERT INTO braid_mariadb_capability (id, \`label\`, payload)
      VALUES (${1}, ${marker}, JSON_OBJECT('enabled', TRUE))
    `);
    assert.deepEqual(
      await db.all(sql.rows<{ readonly label: string; readonly enabled: bigint }>`
        WITH selected AS (
          SELECT \`label\`, CAST(JSON_VALUE(payload, '$.enabled') AS UNSIGNED) AS enabled
          FROM braid_mariadb_capability
        )
        SELECT \`label\`, enabled FROM selected
      `),
      [{ label: marker, enabled: 1n }],
    );

    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq");
    await connection.query("CREATE SEQUENCE braid_mariadb_capability_seq START WITH 17");
    assert.deepEqual(
      await db.one(sql.rows<{ readonly value: bigint }>`
        SELECT NEXT VALUE FOR braid_mariadb_capability_seq AS value
      `),
      { value: 17n },
    );
  } finally {
    await connection.query("DROP SEQUENCE IF EXISTS braid_mariadb_capability_seq").catch(() => undefined);
    await connection.query("DROP TABLE IF EXISTS braid_mariadb_capability").catch(() => undefined);
    await connection.end();
  }
});
