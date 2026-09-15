import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { generateModels } from "@sqlbraid/codegen";
import { hashSnapshot } from "@sqlbraid/metadata";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createSqliteInspector } from "@sqlbraid/sqlite/inspector";
import { sql, typePolicy as sqliteTypePolicy } from "@sqlbraid/sqlite";
import { runW01 } from "../w01.js";
import { bindingObserver } from "../binding.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty, assertGeneratedPropertyAbsent } from "../codegen.js";

test("SQLite binding diagnostics preserve literal marker text through real execution", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const probe = bindingObserver("sqlite", "text-positional");
    const db = createNodeSqliteDatabase(native, { observers: [probe.observer] });
    assert.deepEqual(
      await db.one(sql.rows`SELECT ${"O'Reilly"} AS value, '$1 ? :1 @p1' AS marker /* $1 ? :1 @p1 */`),
      { value: "O'Reilly", marker: "$1 ? :1 @p1" },
    );
    probe.verify("SELECT ? AS value, '$1 ? :1 @p1' AS marker /* $1 ? :1 @p1 */");
  } finally {
    native.close();
  }
});

test("SQLite materialized query mappers reenter after releasing the root resource", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const db = createNodeSqliteDatabase(native);
    const mapper: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "reentry",
        async validate() {
          const row = await db.one(sql.rows<{ value: number }>`SELECT CAST(42 AS REAL) AS value`);
          return { value: row.value };
        },
      },
    };
    const query = sql.rows(mapper)`SELECT 1`;
    assert.deepEqual((await db.execute(query)).rows, [42]);
    assert.deepEqual((await db.prepare("reentry", () => query).execute()).rows, [42]);
    assert.deepEqual((await db.batch([query, query])).map((result) => result.rows), [[42], [42]]);
  } finally {
    native.close();
  }
}, 1000);

test("SQLite stream mapper reentry rejects without retaining the resource", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const db = createNodeSqliteDatabase(native);
    const mapper: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "stream-reentry",
        async validate(value) {
          await db.execute(sql`SELECT 2`);
          return { value };
        },
      },
    };
    await assert.rejects(async () => {
      for await (const row of db.stream(sql.rows(mapper)`SELECT 1`)) void row;
    }, (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_STREAM_SCOPE");
    assert.deepEqual(await db.one(sql.rows`SELECT CAST(3 AS REAL) AS value`), { value: 3 });
  } finally {
    native.close();
  }
}, 1000);

test("SQLite streams close native iteration on break, mapper failure and abort", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const db = createNodeSqliteDatabase(native);
    const query = sql.rows<{ value: number }>`SELECT CAST(1 AS REAL) AS value UNION ALL SELECT CAST(2 AS REAL)`;
    for await (const row of db.stream(query)) {
      assert.equal(row.value, 1);
      break;
    }
    const failure = new Error("mapper failed");
    await assert.rejects(async () => {
      for await (const row of db.stream(query, {
        schema: { "~standard": { version: 1, vendor: "failure", validate() { throw failure; } } },
      })) void row;
    }, (error) => error === failure);
    const abort = new AbortController();
    await assert.rejects(async () => {
      for await (const row of db.stream(query, { signal: abort.signal })) {
        assert.equal(row.value, 1);
        abort.abort(failure);
      }
    }, (error) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED");
    await db.tx(async (tx) => {
      assert.deepEqual(await tx.one(sql.rows`SELECT CAST(3 AS REAL) AS value`), { value: 3 });
    });
  } finally {
    native.close();
  }
}, 1000);

test("SQLite observer failures preserve root side effects but roll back transaction writes", async () => {
  const native = new DatabaseSync(":memory:");
  native.exec("CREATE TABLE audit_effect (id INTEGER PRIMARY KEY)");
  const failure = new Error("post-execution audit failed");
  let rejectResult = true;
  const db = createNodeSqliteDatabase(native, { observers: [{
    onEvent(event) {
      if (rejectResult && event.type === "query:result") throw failure;
    },
  }] });
  try {
    await assert.rejects(db.execute(sql.command`INSERT INTO audit_effect VALUES (1)`), (error) => error === failure);
    assert.deepEqual(native.prepare("SELECT id FROM audit_effect").all().map((row) => row.id), [1]);
    await assert.rejects(db.tx(async (tx) => {
      await tx.execute(sql.command`INSERT INTO audit_effect VALUES (2)`);
    }), (error) => error === failure);
    rejectResult = false;
    assert.deepEqual(await db.all(sql.rows`SELECT id FROM audit_effect`), [{ id: "1" }]);
  } finally {
    native.close();
  }
});

test("SQLite wrappers sharing one database preserve transaction isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlbraid-sqlite-w01-"));
  const file = join(directory, "w01.sqlite");
  const native = new DatabaseSync(file);
  const observer = new DatabaseSync(file);
  try {
    const version = observer.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    console.info(`[db-sqlite] version=${version.version}`);
    const db = createNodeSqliteDatabase(native);
    const secondaryDb = createNodeSqliteDatabase(native);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () => (observer.prepare("SELECT id FROM braid_w01 ORDER BY id").all() as { id: string }[]).map((row) => row.id),
      clear: async () => { observer.prepare("DELETE FROM braid_w01").run(); },
    });
  } finally {
    observer.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite result kinds follow native columns metadata", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('Ada');");
    const db = createNodeSqliteDatabase(native);

    const explicitRows = await db.execute(sql.rows<{ readonly id: string; readonly name: string }>`SELECT id, name FROM users`);
    assert.equal(explicitRows.kind, "rows");
    assert.deepEqual(explicitRows.rows, [{ id: "1", name: "Ada" }]);

    const commandAsRows = await db.execute(sql`UPDATE users SET name = 'Grace' WHERE id = 1`);
    assert.equal(commandAsRows.kind, "command");
    assert.deepEqual(commandAsRows.rows, []);

    const explicitCommand = await db.execute(sql.command`UPDATE users SET name = 'Grace' WHERE id = 1`);
    assert.equal(explicitCommand.kind, "command");
    assert.equal(explicitCommand.rowCount, 1);
    assert.deepEqual(explicitCommand.rows, []);

    const unknownRows = await db.execute(sql`SELECT name FROM users`);
    assert.equal(unknownRows.kind, "rows");
    assert.deepEqual(unknownRows.rows, [{ name: "Grace" }]);

    const unknownCommand = await db.execute(sql`DELETE FROM users WHERE id = 1`);
    assert.equal(unknownCommand.kind, "command");
    assert.equal(unknownCommand.rowCount, 1);
    assert.deepEqual(unknownCommand.rows, []);

    const returning = await db.execute(sql.rows`INSERT INTO users (name) VALUES ('Bob') RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: "1" }]);

    await assert.rejects(
      () => db.execute(sql.command`SELECT name FROM users`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );

    await assert.rejects(
      () => db.execute(sql.rows`DELETE FROM users`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );
    await assert.rejects(() => db.call(sql.call`CALL unsupported()`), /BRAID_CALL_UNSUPPORTED/);
    await assert.rejects(() => db.execute(sql`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/);
    await assert.rejects(() => db.execute(sql.rows`SELECT 1 AS "", 2 AS ""`), /BRAID_RESULT_COLUMNS/);

    native.exec("INSERT INTO users (id, name) VALUES (1, 'Grace')");
    const schema: StandardSchemaV1<unknown, { readonly name: string }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly name: string };
          return { value: { name: row.name.toUpperCase() } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly name: string }>`SELECT name FROM users WHERE id = 1`, { schema }),
      [{ name: "GRACE" }],
    );
    const mapped = v.object({
      payload: v.pipe(v.string(), v.parseJson(), v.object({ enabled: v.boolean() })),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT '{"enabled":true}' AS payload`)).rows,
      [{ payload: { enabled: true } }],
    );
  } finally {
    native.close();
  }
});

test("SQLite inspector reports only proven rowid identity", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec("CREATE TABLE braid_pv8_rowid (id INTEGER PRIMARY KEY, payload TEXT); CREATE TABLE braid_pv8_desc (id INTEGER PRIMARY KEY DESC); CREATE TABLE braid_pv8_composite (a INTEGER, b INTEGER, PRIMARY KEY (a, b)); CREATE TABLE braid_pv8_without (id INTEGER PRIMARY KEY) WITHOUT ROWID");
    const snapshot = await createSqliteInspector(native).inspect();
    assert.equal(snapshot.format, "sqlbraid-metadata");
    assert.equal(snapshot.relations["main.braid_pv8_rowid"]?.columns[0]?.identity, true);
    assert.equal(snapshot.relations["main.braid_pv8_rowid"]?.columns[0]?.nullable, false);
    assert.equal(snapshot.relations["main.braid_pv8_desc"]?.columns[0]?.identity, undefined);
    assert.equal(snapshot.relations["main.braid_pv8_composite"]?.columns[0]?.identity, undefined);
    assert.equal(snapshot.relations["main.braid_pv8_without"]?.columns[0]?.identity, undefined);
  } finally {
    native.close();
  }
});

test("SQLite inspector reads structured STRICT and WITHOUT ROWID flags in either order", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(`
      CREATE TABLE braid_pv18_order_a (id INTEGER PRIMARY KEY) STRICT, WITHOUT ROWID;
      CREATE TABLE braid_pv18_order_b (id INTEGER PRIMARY KEY) WITHOUT ROWID, STRICT;
      CREATE TABLE braid_pv18_strict (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE braid_pv18_without (id INTEGER PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE braid_pv18_words (
        id INTEGER CHECK (id <> 'WITHOUT ROWID, STRICT')
      ) /* STRICT WITHOUT ROWID */;
    `);
    const snapshot = await createSqliteInspector(native).inspect();
    const relation = (name: string) => snapshot.relations[`main.${name}`];
    for (const name of ["braid_pv18_order_a", "braid_pv18_order_b"] as const) {
      assert.equal(relation(name)?.strict, true);
      assert.equal(relation(name)?.withoutRowid, true);
    }
    assert.equal(relation("braid_pv18_strict")?.strict, true);
    assert.equal(relation("braid_pv18_strict")?.withoutRowid, false);
    assert.equal(relation("braid_pv18_without")?.strict, false);
    assert.equal(relation("braid_pv18_without")?.withoutRowid, true);
    assert.equal(relation("braid_pv18_words")?.strict, false);
    assert.equal(relation("braid_pv18_words")?.withoutRowid, false);
    const generated = generateModels(snapshot, { typePolicy: sqliteTypePolicy });
    assertGeneratedProperty(generated.source, "BraidPv18StrictRow", "id", "string", false);
    assert.ok(generated.diagnostics.some((diagnostic) =>
      diagnostic.code === "CODEGEN_SQLITE_DYNAMIC_TYPE"
      && diagnostic.relation === "main.braid_pv18_words"));
  } finally {
    native.close();
  }
});

test("SQLite inspector evidence generates compiling strict and conservative dynamic models", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(`
      CREATE TABLE braid_pv9_strict (
        id INTEGER PRIMARY KEY,
        count INT NOT NULL,
        score REAL NOT NULL DEFAULT 0.0,
        title TEXT NOT NULL,
        bytes BLOB,
        payload ANY,
        calculated INTEGER GENERATED ALWAYS AS (id + count) STORED
      ) STRICT;
      CREATE TABLE braid_pv9_dynamic (
        id INTEGER PRIMARY KEY,
        count INT NOT NULL,
        title TEXT,
        payload BLOB
      );
    `);

    const snapshot = await createSqliteInspector(native).inspect();
    const strict = snapshot.relations["main.braid_pv9_strict"];
    const dynamic = snapshot.relations["main.braid_pv9_dynamic"];
    assert.ok(strict);
    assert.ok(dynamic);
    assert.equal(strict.strict, true);
    assert.equal(dynamic.strict, false);
    const strictColumns = new Map(strict.columns.map((column) => [column.name, column]));
    assert.equal(strictColumns.get("id")?.type, "INTEGER");
    assert.equal(strictColumns.get("id")?.identity, true);
    assert.equal(strictColumns.get("count")?.type, "INT");
    assert.equal(strictColumns.get("score")?.type, "REAL");
    assert.equal(typeof strictColumns.get("score")?.defaultExpression, "string");
    assert.equal(strictColumns.get("bytes")?.type, "BLOB");
    assert.equal(strictColumns.get("payload")?.type, "ANY");
    assert.equal(strictColumns.get("calculated")?.generated, true);
    assert.equal(strictColumns.get("calculated")?.insertable, false);
    assert.equal(strictColumns.get("calculated")?.updatable, false);

    const result = generateModels(snapshot, { typePolicy: sqliteTypePolicy });
    assert.equal(result.metadataHash, hashSnapshot(snapshot));
    assert.equal(result.typePolicyId, sqliteTypePolicy.id);
    assert.equal(result.typePolicyHash, sqliteTypePolicy.hash);
    assert.deepEqual(result.models, [
      {
        relationIdentity: "main.braid_pv9_dynamic",
        modelName: "BraidPv9Dynamic",
        rowName: "BraidPv9DynamicRow",
        insertName: "BraidPv9DynamicInsert",
        updateName: "BraidPv9DynamicUpdate",
      },
      {
        relationIdentity: "main.braid_pv9_strict",
        modelName: "BraidPv9Strict",
        rowName: "BraidPv9StrictRow",
        insertName: "BraidPv9StrictInsert",
        updateName: "BraidPv9StrictUpdate",
      },
    ]);

    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "id", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "count", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "score", "number", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "title", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "bytes", "Uint8Array | null", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "payload", "unknown | null", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictRow", "calculated", "string | null", false);

    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "id", "string | number | bigint", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "count", "string | number | bigint", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "score", "number", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "title", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "bytes", "Uint8Array | null", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictInsert", "payload", "unknown | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9StrictInsert", "calculated");

    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "id", "string | number | bigint", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "count", "string | number | bigint", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "score", "number", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "title", "string", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "bytes", "Uint8Array | null", true);
    assertGeneratedProperty(result.source, "BraidPv9StrictUpdate", "payload", "unknown | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9StrictUpdate", "calculated");

    for (const model of ["BraidPv9DynamicRow", "BraidPv9DynamicInsert", "BraidPv9DynamicUpdate"]) {
      for (const column of dynamic.columns) {
        const expectedType = column.nullable ? "unknown | null" : "unknown";
        const optional = model.endsWith("Row")
          ? false
          : model.endsWith("Insert")
            ? column.identity === true || column.nullable
            : true;
        assertGeneratedProperty(result.source, model, column.name, expectedType, optional);
      }
    }
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CODEGEN_SQLITE_DYNAMIC_TYPE" && diagnostic.relation === "main.braid_pv9_dynamic"));

    await assertCompilesGeneratedSource(result.source, "sqlite-pv9");
  } finally {
    native.close();
  }
});
