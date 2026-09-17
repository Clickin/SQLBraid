import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { generateModels } from "@sqlbraid/codegen";
import {
  diffSnapshots,
  hashSnapshot,
  parseSnapshotJson,
  qualifiedIdentity,
  validateSnapshot,
} from "@sqlbraid/metadata";
import { DatabaseResultKindError } from "@sqlbraid/runtime";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";
import { sql, typePolicy as postgresTypePolicy } from "@sqlbraid/postgres";
import { runW01 } from "../w01.js";
import { bindingObserver } from "../binding.js";
import { assertCompilesGeneratedSource, assertGeneratedProperty, assertGeneratedPropertyAbsent } from "../codegen.js";

async function endPool(pool: Pick<Pool, "end">): Promise<void> {
  const ending = pool.end().catch(() => undefined);
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, 500);
  await Promise.race([ending, timeout.promise]);
  clearTimeout(timer);
}

test("PostgreSQL binding diagnostics preserve literal marker text through real execution", async () => {
  const client = new Client({ connectionString: inject("postgres").connectionUri });
  await client.connect();
  try {
    const probe = bindingObserver("postgres", "text-positional");
    const db = createPgDatabase(client, { observers: [probe.observer] });
    const query = sql.rows`SELECT ${"O'Reilly"}::text AS value, '$1 ? :1 @p1' AS marker /* $1 ? :1 @p1 */`;
    assert.deepEqual(await db.one(query), { value: "O'Reilly", marker: "$1 ? :1 @p1" });
    probe.verify("SELECT $1::text AS value, '$1 ? :1 @p1' AS marker /* $1 ? :1 @p1 */");
  } finally {
    await client.end();
  }
});

test("PostgreSQL wrappers sharing one client preserve transaction isolation", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  const observer = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  await observer.connect();
  try {
    const version = await observer.query<{ server_version: string }>("SHOW server_version");
    console.info(`[db-postgres] server_version=${version.rows[0]?.server_version ?? "unknown"}`);
    const db = createPgDatabase(client);
    const secondaryDb = createPgDatabase(client);
    await runW01({
      db,
      secondaryDb,
      sql,
      rows: async () =>
        (await observer.query<{ id: string }>("SELECT id FROM braid_w01 ORDER BY id")).rows.map((row) => row.id),
      clear: async () => {
        await observer.query("DELETE FROM braid_w01");
      },
    });
  } finally {
    await observer.end();
    await client.end();
  }
});

test("PostgreSQL result kinds follow driver metadata", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    const db = createPgDatabase(client);
    await client.query("DROP TABLE IF EXISTS braid_pv4");
    await client.query("CREATE TABLE braid_pv4 (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await client.query("INSERT INTO braid_pv4 (id, name) VALUES (1, 'Ada')");

    const rows = await db.execute(
      sql.rows<{ readonly id: string; readonly name: string }>`SELECT id, name FROM braid_pv4`,
    );
    assert.equal(rows.kind, "rows");
    assert.deepEqual(rows.rows, [{ id: "1", name: "Ada" }]);
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
    const returning = await db.execute(sql.rows`INSERT INTO braid_pv4 (id, name) VALUES (3, 'Carol') RETURNING id`);
    assert.equal(returning.kind, "rows");
    assert.deepEqual(returning.rows, [{ id: "3" }]);

    await assert.rejects(
      () => db.execute(sql.command`SELECT id FROM braid_pv4`),
      (error) =>
        error instanceof DatabaseResultKindError &&
        error.code === "BRAID_RESULT_KIND" &&
        error.declaredKind === "command" &&
        error.actualKind === "rows",
    );
    await assert.rejects(
      () => db.execute(sql.rows`UPDATE braid_pv4 SET name = 'Dora' WHERE id = 2`),
      (error) =>
        error instanceof DatabaseResultKindError &&
        error.code === "BRAID_RESULT_KIND" &&
        error.declaredKind === "rows" &&
        error.actualKind === "command",
    );

    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        validate(value) {
          const row = value as { readonly id: string };
          return { value: { id: Number(row.id) + 10 } };
        },
      },
    };
    assert.deepEqual(
      await db.all(sql.rows<{ readonly id: number }>`SELECT id FROM braid_pv4 WHERE id = 2`, { schema }),
      [{ id: 12 }],
    );
    const mapped = v.object({
      payload: v.pipe(
        v.string(),
        v.transform((value) => JSON.parse(value) as { readonly enabled: boolean }),
      ),
      stamp: v.pipe(
        v.string(),
        v.transform((stamp) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z`)),
      ),
    });
    assert.deepEqual(
      (await db.execute(sql.rows(mapped)`SELECT '{"enabled":true}'::jsonb AS payload, '20260912'::text AS stamp`)).rows,
      [{ payload: { enabled: true }, stamp: new Date("2026-09-12T00:00:00Z") }],
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv4").catch(() => undefined);
    await client.end();
  }
});

test("PostgreSQL inspector preserves identity and generated-column evidence", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector");
    await client.query("DROP FUNCTION IF EXISTS braid_pv8_routine(integer)");
    await client.query(
      "CREATE FUNCTION braid_pv8_routine(value integer) RETURNS integer LANGUAGE SQL IMMUTABLE AS $$ SELECT value $$",
    );
    await client.query(
      "CREATE TABLE braid_pv8_inspector (external_id INTEGER PRIMARY KEY, generated_id BIGINT GENERATED BY DEFAULT AS IDENTITY, computed INTEGER GENERATED ALWAYS AS (external_id + 1) STORED)",
    );
    const snapshot = await createPostgresInspector(client).inspect();
    const columns = snapshot.relations["public.braid_pv8_inspector"]?.columns ?? [];
    assert.equal(snapshot.format, "sqlbraid-metadata");
    assert.equal(columns.find((column) => column.name === "external_id")?.identity, undefined);
    assert.equal(columns.find((column) => column.name === "generated_id")?.identity, true);
    assert.equal(columns.find((column) => column.name === "computed")?.generated, true);
    assert.equal(columns.find((column) => column.name === "computed")?.insertable, false);
    assert.equal("tsType" in (columns[0] ?? {}), false);
    assert.equal(
      Object.values(snapshot.routines)
        .flat()
        .find((routine) => routine.name === "braid_pv8_routine")?.argumentsComplete,
      false,
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv8_inspector").catch(() => undefined);
    await client.query("DROP FUNCTION IF EXISTS braid_pv8_routine(integer)").catch(() => undefined);
    await client.end();
  }
});

test("PostgreSQL inspector preserves collision-free identities through tooling", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  const schemaWithDot = "braid_pv18.b";
  const plainSchema = "braid_pv18";
  const escapedSchema = "braid_pv18\\:#.schema";
  const escapedName = "value\\:#.name";
  const escapedTypeName = "type\\:#.name";
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schemaWithDot}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${plainSchema}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${escapedSchema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schemaWithDot}"`);
    await client.query(`CREATE SCHEMA "${plainSchema}"`);
    await client.query(`CREATE SCHEMA "${escapedSchema}"`);
    await client.query(`CREATE TABLE "${schemaWithDot}"."c" (id int4 NOT NULL)`);
    await client.query(`CREATE TABLE "${plainSchema}"."b.c" (id int4 NOT NULL)`);
    await client.query(`CREATE TYPE "${escapedSchema}"."${escapedTypeName}" AS ENUM ('ready')`);
    await client.query(
      `CREATE TABLE "${escapedSchema}"."${escapedName}" (id int4 NOT NULL, status "${escapedSchema}"."${escapedTypeName}")`,
    );
    await client.query(`CREATE FUNCTION "${escapedSchema}"."${escapedName}"() RETURNS int LANGUAGE SQL AS 'SELECT 1'`);
    const snapshot = await createPostgresInspector(client).inspect();
    const left = qualifiedIdentity(schemaWithDot, "c");
    const right = qualifiedIdentity(plainSchema, "b.c");
    const escaped = qualifiedIdentity(escapedSchema, escapedName);
    assert.notEqual(left, right);
    assert.ok(snapshot.relations[left]);
    assert.ok(snapshot.relations[right]);
    assert.equal(snapshot.relations[escaped]?.name, escapedName);
    assert.equal(snapshot.types[qualifiedIdentity(escapedSchema, escapedTypeName)]?.name, escapedTypeName);
    const routine = snapshot.routines[escapedName]?.find((entry) => entry.schema === escapedSchema);
    assert.ok(routine);
    assert.equal(routine.name, escapedName);
    const roundTrip = parseSnapshotJson(JSON.stringify(snapshot));
    validateSnapshot(roundTrip);
    assert.equal(hashSnapshot(snapshot), hashSnapshot(roundTrip));
    assert.deepEqual(diffSnapshots(snapshot, roundTrip), []);
    const generated = generateModels(roundTrip, {
      typePolicy: postgresTypePolicy,
      filters: { includeRelations: [left, right, escaped] },
      naming: { relations: { [left]: "DotSchema", [right]: "DotTable", [escaped]: "EscapedTable" } },
      typeOverrides: { columns: { [right]: { id: { outputType: "number" } } } },
    });
    assert.equal(generated.models.length, 3);
    assertGeneratedProperty(generated.source, "DotTableRow", "id", "number", false);
    assertGeneratedProperty(generated.source, "EscapedTableRow", "id", "string", false);
  } finally {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaWithDot}" CASCADE`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${plainSchema}" CASCADE`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${escapedSchema}" CASCADE`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
});

test("PostgreSQL inspector evidence generates compiling Row Insert and Update models", async () => {
  const settings = inject("postgres");
  const client = new Client({ connectionString: settings.connectionUri });
  await client.connect();
  try {
    await client.query("DROP TABLE IF EXISTS braid_pv9_codegen");
    await client.query(`
      CREATE TABLE braid_pv9_codegen (
        id int4 NOT NULL PRIMARY KEY,
        identity_value int8 GENERATED BY DEFAULT AS IDENTITY,
        amount numeric(12, 2) NOT NULL DEFAULT 0,
        label text NOT NULL,
        enabled bool NOT NULL DEFAULT true,
        nickname text,
        calculated int4 GENERATED ALWAYS AS (id + 1) STORED
      )
    `);

    const snapshot = await createPostgresInspector(client).inspect();
    const relation = snapshot.relations["public.braid_pv9_codegen"];
    assert.ok(relation);
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    assert.equal(columns.get("id")?.type, "pg_catalog.int4");
    assert.equal(columns.get("identity_value")?.type, "pg_catalog.int8");
    assert.equal(columns.get("identity_value")?.identity, true);
    assert.equal(columns.get("amount")?.type, "pg_catalog.numeric");
    assert.equal(typeof columns.get("amount")?.defaultExpression, "string");
    assert.equal(columns.get("enabled")?.type, "pg_catalog.bool");
    assert.equal(columns.get("nickname")?.nullable, true);
    assert.equal(columns.get("calculated")?.generated, true);
    assert.equal(columns.get("calculated")?.insertable, false);
    assert.equal(columns.get("calculated")?.updatable, false);

    const result = generateModels(snapshot, { typePolicy: postgresTypePolicy });
    assert.equal(result.metadataHash, hashSnapshot(snapshot));
    assert.equal(result.typePolicyId, postgresTypePolicy.id);
    assert.equal(result.typePolicyHash, postgresTypePolicy.hash);
    assert.deepEqual(
      result.models.find((model) => model.relationIdentity === relation.identity),
      {
        relationIdentity: "public.braid_pv9_codegen",
        modelName: "BraidPv9Codegen",
        rowName: "BraidPv9CodegenRow",
        insertName: "BraidPv9CodegenInsert",
        updateName: "BraidPv9CodegenUpdate",
      },
    );

    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "id", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "identity_value", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "amount", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "label", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "enabled", "boolean", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "nickname", "string | null", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenRow", "calculated", "string | null", false);

    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "id", "number | string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "identity_value", "bigint | string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "amount", "string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "label", "string", false);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "enabled", "boolean", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenInsert", "nickname", "string | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9CodegenInsert", "calculated");

    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "id", "number | string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "identity_value", "bigint | string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "amount", "string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "label", "string", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "enabled", "boolean", true);
    assertGeneratedProperty(result.source, "BraidPv9CodegenUpdate", "nickname", "string | null", true);
    assertGeneratedPropertyAbsent(result.source, "BraidPv9CodegenUpdate", "calculated");

    await assertCompilesGeneratedSource(result.source, "postgres-pv9");
  } finally {
    await client.query("DROP TABLE IF EXISTS braid_pv9_codegen").catch(() => undefined);
    await client.end();
  }
});

test("PostgreSQL pool leases run concurrent roots and pin transactions", async () => {
  const settings = inject("postgres");
  const pool = new Pool({ connectionString: settings.connectionUri, max: 2, idleTimeoutMillis: 0 });
  const db = createPgPoolDatabase(pool);
  try {
    const backendIds = await Promise.all([
      db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.15)`),
      db.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.15)`),
    ]);
    assert.equal(new Set(backendIds.map(({ pid }) => pid)).size, 2);

    await db.execute(sql`DROP TABLE IF EXISTS braid_pv6_pool`);
    await db.execute(sql`CREATE TABLE braid_pv6_pool (id TEXT PRIMARY KEY)`);
    const pinnedIds: string[] = [];
    await db.tx(async (tx) => {
      pinnedIds.push((await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`)).pid);
      await assert.rejects(
        tx.tx(async (nested) => {
          pinnedIds.push((await nested.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`)).pid);
          await nested.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('nested')`);
          throw new Error("rollback savepoint");
        }),
        /rollback savepoint/,
      );
      pinnedIds.push((await tx.one(sql.rows<{ readonly pid: string }>`SELECT pg_backend_pid() AS pid`)).pid);
      await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('committed')`);
    });
    assert.equal(new Set(pinnedIds).size, 1);
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [
      { id: "committed" },
    ]);

    await assert.rejects(
      db.tx(async () => db.execute(sql`SELECT 1`)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
    );
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [
      { id: "committed" },
    ]);

    await assert.rejects(
      db.tx(async (tx) => {
        await tx.execute(sql`INSERT INTO braid_pv6_pool (id) VALUES ('rolled-back')`);
        throw new Error("rollback transaction");
      }),
      /rollback transaction/,
    );
    assert.deepEqual(await db.all(sql.rows<{ readonly id: string }>`SELECT id FROM braid_pv6_pool`), [
      { id: "committed" },
    ]);
    assert.equal(pool.idleCount, pool.totalCount);
    assert.ok(pool.totalCount > 0);
  } finally {
    await pool.query("DROP TABLE IF EXISTS braid_pv6_pool").catch(() => undefined);
    await endPool(pool);
  }
});

test("PostgreSQL pool releases before an async mapper can re-enter a max-one pool", async () => {
  const settings = inject("postgres");
  const pool = new Pool({ connectionString: settings.connectionUri, max: 1, idleTimeoutMillis: 0 });
  const db = createPgPoolDatabase(pool);
  try {
    const mapper: StandardSchemaV1<unknown, { readonly value: number }> = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-tests",
        async validate(value) {
          await db.execute(sql`SELECT 2`);
          return { value: { value: Number((value as { readonly value: string }).value) + 1 } };
        },
      },
    };
    const mappedQuery = sql.rows(mapper)`SELECT 1 AS value`;
    const operation = (async () => {
      const executed = await db.execute(mappedQuery);
      assert.deepEqual(executed.rows, [{ value: 2 }]);
      const prepared = db.prepare("pv6-postgres-mapped", () => mappedQuery, { input: "none" });
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
    assert.equal(pool.idleCount, 1);
  } finally {
    await endPool(pool);
  }
});
