import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type { DriverEnvironment, EnvironmentSupportTarget, ExecutionEvent, StatementBindingAdapter } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

function environmentDescriptor(): DriverEnvironment {
  return {
    database: { product: "sqlite", edition: "native" },
    driver: { id: "node-sqlite", version: process.versions.node, profile: "exact-text" },
    typePolicy: { id: "environment-test-policy", hash: "environment-test-hash" },
    capabilities: { "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint"] } },
    probe: {
      statement: sql.rows`SELECT sqlite_version() AS version`.render(),
      read(rows) {
        const row = rows[0];
        assert.ok(row && typeof row === "object" && "version" in row && typeof row.version === "string");
        return { version: row.version };
      },
    },
  };
}

test("environment probes are explicit, observed, released, cached and transaction scoped", async () => {
  const native = new DatabaseSync(":memory:");
  const executor = { ...createNodeSqliteExecutor(native), environment: environmentDescriptor() };
  let acquired = 0;
  let released = 0;
  const events: ExecutionEvent[] = [];
  const db = createPooledDatabase({
    statementBinding: executor.statementBinding,
    environment: executor.environment,
    async acquire() {
      acquired++;
      return { ...executor, release() { released++; } };
    },
  }, { observers: [{ onEvent(event) { events.push(event); } }] });
  try {
    assert.equal(acquired, 0);
    const first = await db.environment();
    assert.equal(first.database.version, native.prepare("SELECT sqlite_version() AS version").get()!.version);
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    assert.ok(events.some((event) => event.type === "query:ready" && event.purpose === "environment" && event.preparedName === undefined));
    assert.deepEqual(await db.environment(), first);
    assert.equal(acquired, 1);
    assert.equal(Reflect.set(first.database, "version", "forged"), false);
    await db.tx(async (tx) => {
      await assert.rejects(() => db.environment(), { code: "BRAID_TX_SCOPE" });
      const scoped = await tx.environment();
      assert.equal(scoped.database.version, first.database.version);
      assert.equal(acquired, 2);
      assert.equal(released, 1);
    });
    assert.equal(released, 2);
  } finally { native.close(); }
});

test("environment support matching requires exact verified evidence and never guesses versions", async () => {
  const native = new DatabaseSync(":memory:");
  const db = createDatabase({ ...createNodeSqliteExecutor(native), environment: environmentDescriptor() });
  try {
    const env = await db.environment();
    const target: EnvironmentSupportTarget = {
      id: "test-exact-target", status: "conditional",
      database: { product: "sqlite", edition: "native", version: env.database.version! },
      driver: { id: "node-sqlite", profile: "exact-text", version: process.versions.node },
      runtime: { id: env.runtime.id, version: env.runtime.version! },
      typePolicy: { id: "environment-test-policy", hash: "environment-test-hash" },
      evidence: { status: "verified" },
    };
    assert.equal((await db.environment()).supportMatch.status, "compatible");
    assert.equal((await db.environment({ targets: [target] })).supportMatch.targetId, target.id);
    for (const changed of [
      { ...target, evidence: { status: "pending" } },
      { ...target, database: { ...target.database, version: "0.0.0" } },
      { ...target, driver: { ...target.driver, profile: "custom" } },
    ]) assert.equal((await db.environment({ targets: [changed] })).supportMatch.status, "compatible");
    assert.equal((await db.environment({ targets: [target, target] })).supportMatch.reason, "ambiguous-exact-target");
  } finally { native.close(); }
});

test("failed environment probes are not cached and before observers prevent acquisition", async () => {
  const native = new DatabaseSync(":memory:");
  const executor = { ...createNodeSqliteExecutor(native), environment: environmentDescriptor() };
  let fail = true;
  let failBinding = true;
  let acquired = 0;
  const sentinel = new Error("audit rejected probe");
  const bindingError = new Error("binding rejected probe");
  const events: ExecutionEvent[] = [];
  const statementBinding: StatementBindingAdapter = {
    ...executor.statementBinding,
    describe(statement, context) {
      if (failBinding) throw bindingError;
      return executor.statementBinding.describe(statement, context);
    },
  };
  const db = createPooledDatabase({
    statementBinding,
    environment: executor.environment,
    async acquire() { acquired++; return { ...executor, statementBinding, release() {} }; },
  }, { observers: [{ onEvent(event) { events.push(event); if (fail && event.type === "query:ready") throw sentinel; } }] });
  try {
    await assert.rejects(() => db.environment(), (error) => error === bindingError);
    assert.equal(acquired, 0);
    assert.ok(events.some((event) => event.type === "query:error" && event.stage === "materialize" && event.purpose === "environment" && !event.executionStarted));
    failBinding = false;
    await assert.rejects(() => db.environment(), (error) => error === sentinel);
    assert.equal(acquired, 0);
    fail = false;
    assert.equal((await db.environment()).database.product, "sqlite");
    assert.equal(acquired, 1);
  } finally { native.close(); }
});

test("environment refresh replaces the pooled snapshot without claiming pool-wide probe guarantees", async () => {
  const native = new DatabaseSync(":memory:");
  native.exec("PRAGMA user_version = 1");
  const base = createNodeSqliteExecutor(native);
  const executor = {
    ...base,
    environment: {
      ...environmentDescriptor(),
      probe: {
        statement: sql.rows`PRAGMA user_version`.render(),
        read(rows: readonly unknown[]) {
          const row = rows[0];
          assert.ok(row && typeof row === "object" && "user_version" in row);
          return {
            version: String((row as { readonly user_version: number }).user_version),
            capabilities: {
              "numeric.approximate-float": {
                status: "guaranteed" as const,
                canonical: "number" as const,
                rawRepresentations: ["number"] as const,
              },
            },
          };
        },
      },
    },
  };
  let acquired = 0;
  let released = 0;
  const db = createPooledDatabase({
    statementBinding: executor.statementBinding,
    environment: executor.environment,
    async acquire() {
      acquired++;
      return { ...executor, release() { released++; } };
    },
  });
  try {
    assert.equal((await db.environment()).database.version, "1");
    assert.equal((await db.environment()).capabilities["numeric.approximate-float"]?.status, "guarded");
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    native.exec("PRAGMA user_version = 2");
    const refreshed = await db.environment({ refresh: true });
    assert.equal(refreshed.database.version, "2");
    assert.equal(refreshed.capabilities["numeric.approximate-float"]?.status, "guarded");
    assert.equal(acquired, 2);
    assert.equal(released, 2);
    assert.equal((await db.environment()).database.version, "2");
    assert.equal(acquired, 2);
  } finally { native.close(); }
});
