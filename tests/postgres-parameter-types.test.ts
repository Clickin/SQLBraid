import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgliteDatabase } from "@sqlbraid/postgres/pglite";
import type { PgliteQueryOptionsLike } from "@sqlbraid/postgres/pglite";
import { createPgExecutor } from "@sqlbraid/postgres/pg";
import { postgresParameter, sql } from "@sqlbraid/postgres";
import { createDatabase } from "@sqlbraid/runtime";

interface Call {
  readonly text: string;
  readonly params: readonly unknown[] | undefined;
  readonly paramTypes: readonly number[] | undefined;
}

function recordingPglite() {
  const calls: Call[] = [];
  return {
    calls,
    pg: {
      async query(text: string, params?: readonly unknown[], options?: PgliteQueryOptionsLike) {
        calls.push({ text, params, paramTypes: options?.paramTypes });
        return { rows: [], fields: [], affectedRows: 0, command: "INSERT" };
      },
    },
  };
}

const codeOf = (error: unknown) => (error as { code?: string }).code;

test("PGlite sends the type OID of each hinted parameter and 0 for the others", async () => {
  const { calls, pg } = recordingPglite();
  const db = createPgliteDatabase(pg);
  await db.execute(
    sql.command`INSERT INTO t VALUES (${sql.bind(7, postgresParameter.int4())}, ${"plain"}, ${sql.bind(9007199254740993n, postgresParameter.int8())})`,
  );
  await db.execute(sql.command`INSERT INTO t VALUES (${1})`);
  const hinted = calls.find((call) => call.text.includes("$3"));
  assert.deepEqual(hinted?.paramTypes, [23, 0, 20]);
  assert.deepEqual(hinted?.params, [7, "plain", 9007199254740993n]);
  const plain = calls.find((call) => !call.text.includes("$3") && call.text.includes("$1"));
  assert.equal(plain?.paramTypes, undefined);
});

test("PGlite accepts the aliases and the case of a hand-written hint name", async () => {
  const { calls, pg } = recordingPglite();
  const db = createPgliteDatabase(pg);
  await db.execute(
    sql.command`INSERT INTO t VALUES (${sql.bind(1, { databaseType: " Integer " })}, ${sql.bind("x", { databaseType: "CHARACTER   VARYING" })})`,
  );
  assert.deepEqual(calls.at(-1)?.paramTypes, [23, 1043]);
});

test("PGlite bulk sends the same OIDs for every item", async () => {
  const { calls, pg } = recordingPglite();
  const db = createPgliteDatabase(pg);
  await db.bulk([1, 2, 3], (id) => sql.command`INSERT INTO t VALUES (${sql.bind(id, postgresParameter.int4())})`);
  const inserts = calls.filter((call) => call.text.includes("INSERT"));
  assert.equal(inserts.length, 3);
  for (const call of inserts) assert.deepEqual(call.paramTypes, [23]);
  assert.deepEqual(
    inserts.map((call) => call.params),
    [[1], [2], [3]],
  );
});

test("PGlite rejects unknown names, facets, json types and refcursor before any query", async () => {
  const { calls, pg } = recordingPglite();
  const db = createPgliteDatabase(pg);
  const bad: ReadonlyArray<{ readonly databaseType: string; readonly length?: number; readonly scale?: number }> = [
    { databaseType: "citext" },
    { databaseType: "jsonb" },
    { databaseType: "json" },
    { databaseType: "varchar", length: 10 },
    { databaseType: "numeric", scale: 2 },
    { databaseType: "refcursor" },
  ];
  for (const entry of bad) {
    // oxlint-disable-next-line no-await-in-loop -- check each rejection in order
    await assert.rejects(
      () => db.execute(sql.command`INSERT INTO t VALUES (${sql.bind("x", entry)})`),
      (error: unknown) => codeOf(error) === "BRAID_BIND_HINT_UNSUPPORTED",
      entry.databaseType,
    );
  }
  assert.equal(calls.length, 0);
});

test("a changed parameter type is a changed prepared shape, a changed value is not", async () => {
  const { calls, pg } = recordingPglite();
  const db = createPgliteDatabase(pg);
  let value = 1;
  let hint = postgresParameter.int4();
  const prepared = db.prepare("typed", () => sql.command`INSERT INTO t VALUES (${sql.bind(value, hint)})`, {
    input: "none",
  });
  await prepared.execute();
  value = 2;
  await prepared.execute();
  assert.deepEqual(
    calls.map((call) => call.params),
    [[1], [2]],
  );
  hint = postgresParameter.int2();
  await assert.rejects(
    () => prepared.execute(),
    (error: unknown) => /BRAID_PREPARED_SHAPE/u.test(String((error as Error).message) + codeOf(error)),
  );
  assert.equal(calls.length, 2);
});

test("the pg adapter still rejects every hint before driver I/O", async () => {
  let calls = 0;
  const executor = createPgExecutor({
    async query() {
      calls += 1;
      return { rows: [] };
    },
    escapeIdentifier: (value: string) => value,
    escapeLiteral: (value: string) => value,
  });
  const db = createDatabase(executor);
  await assert.rejects(
    () => db.execute(sql.command`INSERT INTO t VALUES (${sql.bind(7, postgresParameter.int4())})`),
    (error: unknown) => codeOf(error) === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.equal(calls, 0);
});
