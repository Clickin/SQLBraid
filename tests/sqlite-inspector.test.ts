import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSqliteInspector,
  type SqliteMetadataDatabaseLike,
} from "@sqlbraid/sqlite/inspector";
import {
  quoteSqliteIdentifier,
  sqliteMetadataInteger,
  sqliteMetadataRow,
  sqliteMetadataText,
} from "../packages/sqlite/src/internal/sqlite-metadata.js";

test("SQLite metadata helpers preserve scalar checks and identifier quoting", () => {
  assert.equal(sqliteMetadataText("TEXT"), "TEXT");
  assert.equal(sqliteMetadataText(42), undefined);
  assert.equal(sqliteMetadataInteger(42), 42);
  assert.equal(sqliteMetadataInteger(42n), 42);
  assert.equal(sqliteMetadataInteger(4.2), undefined);
  assert.deepEqual(sqliteMetadataRow({ name: "id" }), { name: "id" });
  assert.throws(() => sqliteMetadataRow([]), /SQLITE_INSPECT_ROW/);
  assert.equal(quoteSqliteIdentifier('a"b'), '"a""b"');
});

test("SQLite inspector accepts only its neutral metadata query surface", async () => {
  const responses = new Map<string, readonly unknown[]>([
    ["SELECT sqlite_version() AS version", [{ version: "3.45.0" }]],
    ["PRAGMA database_list", [{ seq: 0, name: "main", file: "" }]],
    ["PRAGMA table_list", [{ schema: "main", name: "quoted\"table", strict: 1, wr: 0 }]],
    ["SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name", [{ type: "table", name: "quoted\"table", sql: null }]],
    ['PRAGMA main.table_xinfo("quoted""table")', [{ cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 }]],
    ['PRAGMA main.index_list("quoted""table")', []],
    ["PRAGMA compile_options", [{ compile_options: "ENABLE_JSON1" }]],
  ]);
  const database: SqliteMetadataDatabaseLike = {
    prepare(sql) {
      return {
        all() {
          const rows = responses.get(sql);
          if (rows === undefined) throw new Error(`Unexpected metadata query: ${sql}`);
          return rows;
        },
      };
    },
  };

  const snapshot = await createSqliteInspector(database).inspect();
  const relation = snapshot.relations['main.quoted"table'];
  assert.equal(snapshot.dialect, "sqlite");
  assert.equal(snapshot.dialectVersion, "3.45.0");
  assert.equal(relation?.columns[0]?.identity, true);
  assert.equal(relation?.columns[0]?.nullable, false);
});
