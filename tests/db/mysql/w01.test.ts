import assert from "node:assert/strict";
import { createConnection, createPool, type Pool } from "mysql2/promise";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import type { ExecutionEvent } from "@sqlbraid/core";
import { generateModels } from "@sqlbraid/codegen";
import { hashSnapshot } from "@sqlbraid/metadata";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createMysql2Database, createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { createMysqlInspector } from "@sqlbraid/mysql/inspector";
import { sql, typePolicy as mysqlTypePolicy } from "@sqlbraid/mysql";
import { runW01 } from "../w01.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty, assertGeneratedPropertyAbsent } from "../codegen.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  const ending = pool.end().catch(() => undefined);
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, 500);
  await Promise.race([ending, timeout.promise]);
  clearTimeout(timer);
}

test("MySQL wrappers sharing one connection preserve transaction isolation", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  const observer = await createConnection(settings.connectionUri);
  try {
    const [versionRows] = await observer.query("SELECT VERSION() AS version");
    const version = (versionRows as { version: string }[])[0]?.version ?? "unknown";
    console.info(`[db-mysql] server_version=${version}`);
    const db = createMysql2Database(client);
    const secondaryDb = createMysql2Database(client);
    await runW01({
      db,
      secondaryDb,
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

test("MySQL result kinds follow payload metadata", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  try {
    const db = createMysql2Database(client);
    await client.query("DROP TABLE IF EXISTS braid_pv4");
    await client.query("CREATE TABLE braid_pv4 (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL)");
    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (1, 'Ada')");

    const rows = await db.execute(sql.rows<{ readonly id: number; readonly name: string }>`SELECT id, name FROM braid_pv4`);
    assert.equal(rows.kind, "rows");
    assert.deepEqual(rows.rows, [{ id: 1, name: "Ada" }]);
    const unknownRows = await db.execute(sql`SELECT id FROM braid_pv4`);
    assert.equal(unknownRows.kind, "rows");
    const command = await db.execute(sql.command`UPDATE braid_pv4 SET name = 'Grace' WHERE id = 1`);
    assert.equal(command.kind, "command");
    assert.deepEqual(command.rows, []);
    assert.equal(command.command.affectedRows, 1);
    const unknownCommand = await db.execute(sql`DELETE FROM braid_pv4 WHERE id = 1`);
    assert.equal(unknownCommand.kind, "command");
    assert.deepEqual(unknownCommand.rows, []);
    assert.equal(unknownCommand.command.affectedRows, 1);

    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (2, 'Bob')");
    await assert.rejects(
      () => db.execute(sql.command`SELECT id FROM braid_pv4`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "command"
        && error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sql.rows`UPDATE braid_pv4 SET name = 'Dora' WHERE id = 2`),
      (error) => error instanceof DatabaseResultKindError
        && error.code === "BRAID_RESULT_KIND"
        && error.declaredKind === "rows"
        && error.actualKind === "command",
    );

    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly id: number };
          return { value: { id: row.id + 10 } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: number }>`SELECT id FROM braid_pv4 WHERE id = 2`, { schema }),
      [{ id: 12 }],
    );
    const mapped = v.object({
      payload: v.pipe(v.string(), v.parseJson(), v.object({ enabled: v.boolean() })),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT CAST('{"enabled":true}' AS CHAR) AS payload`)).rows,
      [{ payload: { enabled: true } }],
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv4").catch(() => undefined);
    await client.end();
  }
});

test("MySQL inspector separates primary-key and auto-increment identity", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector");
    await client.query("CREATE TABLE braid_pv8_inspector (external_id INT PRIMARY KEY, generated_id INT NOT NULL AUTO_INCREMENT, computed INT GENERATED ALWAYS AS (external_id + 1) STORED, UNIQUE KEY generated_id_unique (generated_id))");
    const snapshot = await createMysqlInspector(client).inspect();
    const relation = Object.values(snapshot.relations).find((entry) => entry.name === "braid_pv8_inspector");
    const columns = relation?.columns ?? [];
    assert.equal(snapshot.format, "sqlbraid-metadata");
    assert.equal(columns.find((column) => column.name === "external_id")?.identity, undefined);
    assert.equal(columns.find((column) => column.name === "generated_id")?.identity, true);
    assert.equal(columns.find((column) => column.name === "computed")?.generated, true);
    assert.equal(columns.find((column) => column.name === "computed")?.updatable, false);
    assert.equal("tsType" in (columns[0] ?? {}), false);
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector").catch(() => undefined);
    await client.end();
  }
});

test("MySQL inspector evidence generates compiling Row Insert and Update models", async () => {
  const settings = inject("mysql");
  const client = await createConnection(settings.connectionUri);
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv9_codegen");
    await client.query(`
      CREATE TABLE braid_pv9_codegen (
        external_id INT NOT NULL PRIMARY KEY,
        identity_value BIGINT NOT NULL AUTO_INCREMENT,
        amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
        label VARCHAR(255) NOT NULL,
        payload JSON,
        nickname VARCHAR(255) NULL,
        calculated INT GENERATED ALWAYS AS (external_id + 1) STORED,
        UNIQUE KEY braid_pv9_codegen_identity (identity_value)
      ) ENGINE=InnoDB
    `);

    const snapshot = await createMysqlInspector(client).inspect();
    const relation = Object.values(snapshot.relations).find((entry) => entry.name === "braid_pv9_codegen");
    assert.ok(relation);
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    assert.equal(columns.get("external_id")?.type, "int");
    assert.equal(columns.get("external_id")?.identity, undefined);
    assert.equal(columns.get("identity_value")?.type, "bigint");
    assert.equal(columns.get("identity_value")?.identity, true);
    assert.equal(columns.get("amount")?.type, "decimal");
    assert.equal(typeof columns.get("amount")?.defaultExpression, "string");
    assert.equal(columns.get("payload")?.type, "json");
    assert.equal(columns.get("nickname")?.nullable, true);
    assert.equal(columns.get("calculated")?.generated, true);
    assert.equal(columns.get("calculated")?.insertable, false);
    assert.equal(columns.get("calculated")?.updatable, false);

    const result = generateModels(snapshot, { typePolicy: mysqlTypePolicy });
    assert.equal(result.metadataHash, hashSnapshot(snapshot));
    assert.equal(result.typePolicyId, mysqlTypePolicy.id);
    assert.equal(result.typePolicyHash, mysqlTypePolicy.hash);
    assert.deepEqual(result.models.find((model) => model.relationIdentity === relation.identity), {
      relationIdentity: relation.identity,
      modelName: "BraidPv9Codegen",
      rowName: "BraidPv9CodegenRow",
      insertName: "BraidPv9CodegenInsert",
      updateName: "BraidPv9CodegenUpdate",
    });

    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "external_id", "number", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "identity_value", "bigint | string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "amount", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "label", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "payload", "unknown | null", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "nickname", "string | null", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "calculated", "number | null", false);

    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "external_id", "number", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "identity_value", "bigint | string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "amount", "string | number", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "label", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "payload", "unknown | null", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "nickname", "string | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9CodegenInsert", "calculated");

    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "external_id", "number", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "identity_value", "bigint | string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "amount", "string | number", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "label", "string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "payload", "unknown | null", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "nickname", "string | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9CodegenUpdate", "calculated");

    await assertCompilesGeneratedSource(result.source, "mysql-pv9");
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv9_codegen").catch(() => undefined);
    await client.end();
  }
});

test("MySQL pool leases run concurrent roots and pin transactions", async () => {
  const settings = inject("mysql");
  const pool = createPool({ uri: settings.connectionUri, connectionLimit: 2, idleTimeout: 0 });
  const acquiredIds: number[] = [];
  let releaseCount = 0;
  pool.on("acquire", (connection) => { acquiredIds.push(connection.threadId); });
  pool.on("release", () => { releaseCount += 1; });
  const db = createMysql2PoolDatabase(pool);
  try {
    const backendIds = await Promise.all([
      db.one(sql.rows<{ readonly connectionId: number }>`SELECT CONNECTION_ID() AS connectionId, SLEEP(0.15) AS pause`),
      db.one(sql.rows<{ readonly connectionId: number }>`SELECT CONNECTION_ID() AS connectionId, SLEEP(0.15) AS pause`),
    ]);
    assert.equal(new Set(backendIds.map(({ connectionId }) => String(connectionId))).size, 2);

    await db.execute(sql`DROP TABLE IF EXISTS braid_pv6_pool`);
    await db.execute(sql`CREATE TABLE braid_pv6_pool (id VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB`);
    const pinnedIds: string[] = [];
    await db.tx(async (tx) => {
      pinnedIds.push(String((await tx.one(sql.rows<{ readonly connectionId: number }>`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
      await assert.rejects(
        tx.tx(async (nested) => {
          pinnedIds.push(String((await nested.one(sql.rows<{ readonly connectionId: number }>`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
          await nested.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('nested')`);
          throw new Error("rollback savepoint");
        }),
        /rollback savepoint/,
      );
      pinnedIds.push(String((await tx.one(sql.rows<{ readonly connectionId: number }>`SELECT CONNECTION_ID() AS connectionId`)).connectionId));
      await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('committed')`);
    });
    assert.equal(new Set(pinnedIds).size, 1);
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [{ id: "committed" }]);

    await assert.rejects(
      db.tx(async () => db.execute(sql`SELECT 1`)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
    );
    await assert.rejects(db.tx(async (tx) => {
      await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('rolled-back')`);
      throw new Error("rollback transaction");
    }), /rollback transaction/);
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [{ id: "committed" }]);
    assert.equal(releaseCount, acquiredIds.length);
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv6_pool").catch(() => undefined);
    await endPool(pool);
  }
});

test("MySQL pool releases before an async mapper can re-enter a max-one pool", async () => {
  const settings = inject("mysql");
  const pool = createPool({ uri: settings.connectionUri, connectionLimit: 1, idleTimeout: 0 });
  let acquired = 0;
  let released = 0;
  pool.on("acquire", () => { acquired += 1; });
  pool.on("release", () => { released += 1; });
  const db = createMysql2PoolDatabase(pool);
  try {
    const mapper: StandardSchemaV1<unknown, { readonly value: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        async validate(value) {
          await db.execute(sql`SELECT 2`);
          return { value: { value: (value as { readonly value: number }).value + 1 } };
        },
      },
    };
    const mappedQuery = sql.rows(mapper)`SELECT 1 AS value`;
    const operation = (async () => {
      const executed = await db.execute(mappedQuery);
      assert.deepEqual(executed.rows, [{ value: 2 }]);
      const prepared = db.prepare("pv6-mysql-mapped", () => mappedQuery);
      assert.deepEqual((await prepared.execute()).rows, [{ value: 2 }]);
      const [batched] = await db.batch([mappedQuery] as const);
      assert.deepEqual(batched.rows, [{ value: 2 }]);
    })();
    operation.catch(() => undefined);
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(() => timeout.reject(new Error("mapper re-entry timed out")), 2_000);
    try {
      await Promise.race([operation, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(acquired, released);
  } finally {
    await endPool(pool);
  }
});

test("MySQL pool observers receive SQL, binds, results, errors, and transaction lifecycle", async () => {
  const settings = inject("mysql");
  const pool = createPool({ uri: settings.connectionUri, connectionLimit: 1, idleTimeout: 0 });
  const events: ExecutionEvent[] = [];
  const db = createMysql2PoolDatabase(pool, {
    observers: [{ async onEvent(event) { events.push(event); } }],
  });
  try {
    await db.execute(sql`SELECT ${"observer-secret"}`);
    const ready = events.find((event) => event.type === "query:ready");
    assert.ok(ready && ready.type === "query:ready");
    assert.equal(ready.sql, "SELECT ?");
    assert.deepEqual(ready.values, ["observer-secret"]);
    assert.equal(events.some((event) => event.type === "query:result" && event.actualKind === "rows"), true);
    assert.equal(events.some((event) => event.type === "query:mapped"), true);

    await db.tx(async (tx) => { await tx.execute(sql`SELECT 1`); });
    assert.equal(events.some((event) => event.type === "transaction" && event.phase === "begin" && event.status === "completed"), true);
    assert.equal(events.some((event) => event.type === "transaction" && event.phase === "commit" && event.status === "completed"), true);

    await assert.rejects(db.execute(sql`SELECT * FROM braid_pv6_observer_missing`));
    const error = events.find((event) => event.type === "query:error");
    assert.ok(error && error.type === "query:error");
    assert.equal(error.stage, "driver");
    assert.equal(error.executionStarted, true);
  } finally {
    await endPool(pool);
  }
});
