import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import type { Database } from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/sqlite";
import { createD1Executor } from "@sqlbraid/sqlite/d1";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { createSqliteWasmExecutor } from "@sqlbraid/sqlite/wasm";

function assertCapability(
  capabilities: Readonly<Record<string, { readonly status: string }>>,
  key: string,
  status: string,
): void {
  assert.equal(capabilities[key]?.status, status, `${key} capability changed`);
}

function aborted(reason: Error): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

test("node:sqlite exposes frozen capability boundaries and serializable-only transactions", async () => {
  const native = new DatabaseSync(":memory:");
  try {
    const executor = createNodeSqliteExecutor(native);
    const capabilities = executor.environment?.capabilities ?? {};
    assertCapability(capabilities, "session.pinned", "guaranteed");
    assertCapability(capabilities, "transaction", "guaranteed");
    assertCapability(capabilities, "transaction.savepoint", "guaranteed");
    assertCapability(capabilities, "transaction.isolation.serializable", "guaranteed");
    assertCapability(capabilities, "transaction.isolation.read-committed", "unsupported");
    assertCapability(capabilities, "transaction.read-only", "unsupported");
    assertCapability(capabilities, "statement.prepare", "guaranteed");
    assertCapability(capabilities, "statement.cancel", "unsupported");
    assertCapability(capabilities, "statement.stream", "guaranteed");
    assertCapability(capabilities, "statement.bulk", "guaranteed");
    assertCapability(capabilities, "routine.call", "unsupported");
    const begin = executor.begin;
    const rollback = executor.rollback;
    assert.ok(begin);
    assert.ok(rollback);
    await begin({ isolation: "serializable" });
    await rollback();
    await assert.rejects(
      async () => begin({ isolation: "read-committed" }),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "transaction.isolation.read-committed"
        && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
    await assert.rejects(
      async () => begin({ readOnly: true }),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "transaction.read-only"
        && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
    await assert.rejects(
      async () => begin({ isolation: "DROP TABLE users" } as never),
      (error: unknown) => error instanceof TypeError
        && "code" in error
        && error.code === "BRAID_TX_OPTIONS_INVALID",
    );
    await assert.rejects(
      async () => begin({ readOnly: "yes" } as never),
      (error: unknown) => error instanceof TypeError
        && "code" in error
        && error.code === "BRAID_TX_OPTIONS_INVALID",
    );
    let controlCalls = 0;
    const guarded = createNodeSqliteExecutor({
      prepare() { throw new Error("Unexpected SQLite prepare during option validation."); },
      exec() {
        controlCalls += 1;
      },
    });
    await assert.rejects(
      async () => guarded.begin!({ isolation: "serializable", extra: true } as never),
      (error: unknown) => error instanceof TypeError
        && "code" in error
        && error.code === "BRAID_TX_OPTIONS_INVALID",
    );
    assert.equal(controlCalls, 0);
  } finally {
    native.close();
  }
});

test("SQLite adapters reject active cancellation before statement I/O", async () => {
  const query = sql.rows`SELECT 1 AS value`.render();
  const active = new AbortController();

  let nodePrepares = 0;
  const node = createNodeSqliteExecutor({
    prepare() {
      nodePrepares += 1;
      throw new Error("statement I/O should not start");
    },
  });
  await assert.rejects(
    () => node.query(query, undefined, { signal: active.signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(nodePrepares, 0);

  let wasmPrepares = 0;
  const wasm = createSqliteWasmExecutor({
    prepare() {
      wasmPrepares += 1;
      throw new Error("statement I/O should not start");
    },
    exec() {},
  });
  await assert.rejects(
    () => wasm.query(query, undefined, { signal: active.signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(wasmPrepares, 0);

  let d1Prepares = 0;
  const d1 = createD1Executor({
    prepare() {
      d1Prepares += 1;
      throw new Error("statement I/O should not start");
    },
    batch: async () => [],
  });
  await assert.rejects(
    () => d1.query(query, undefined, { signal: active.signal }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.cancel"
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(d1Prepares, 0);
});

test("already-aborted SQLite executions reject with the supplied reason without I/O", async () => {
  const reason = new Error("stop now");
  const query = sql.rows`SELECT 1 AS value`.render();
  let prepares = 0;
  const executor = createNodeSqliteExecutor({
    prepare() {
      prepares += 1;
      throw new Error("statement I/O should not start");
    },
  });
  await assert.rejects(
    () => executor.query(query, undefined, { signal: aborted(reason) }),
    (error: unknown) => error === reason,
  );
  assert.equal(prepares, 0);
});

test("SQLite adapters reject row OUT parameters before acquisition or prepare", async () => {
  const query = sql.rows`UPDATE users SET name = ${sql.out("name")}`;
  const rendered = query.render();
  const native = new DatabaseSync(":memory:");
  let acquires = 0;
  try {
    const node = createNodeSqliteExecutor(native);
    const db = createPooledDatabase({
      statementBinding: node.statementBinding,
      environment: node.environment,
      async acquire() {
        acquires += 1;
        return { ...node, release() {} };
      },
    });
    await assert.rejects(
      () => db.all(query),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "routine.out"
        && error.code === "BRAID_CALL_OUT_UNSUPPORTED",
    );
    assert.equal(acquires, 0);

    let wasmPrepares = 0;
    const wasm = createSqliteWasmExecutor({
      prepare() {
        wasmPrepares += 1;
        throw new Error("statement I/O should not start");
      },
      exec() {},
    });
    await assert.rejects(
      () => wasm.query(rendered),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "routine.out"
        && error.code === "BRAID_CALL_OUT_UNSUPPORTED",
    );
    assert.equal(wasmPrepares, 0);

    let d1Prepares = 0;
    const d1 = createD1Executor({
      prepare() {
        d1Prepares += 1;
        throw new Error("statement I/O should not start");
      },
      batch: async () => [],
    });
    await assert.rejects(
      () => d1.query(rendered),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "routine.out"
        && error.code === "BRAID_CALL_OUT_UNSUPPORTED",
    );
    assert.equal(d1Prepares, 0);
  } finally {
    native.close();
  }
});

test("native SQLite sessions retain TEMP state, nested transactions, prepared inputs, and closure", async () => {
  const native = new DatabaseSync(":memory:");
  let acquires = 0;
  let released = 0;
  let closedSession: Database | undefined;
  try {
    native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const executor = createNodeSqliteExecutor(native);
    const db = createPooledDatabase({
      statementBinding: executor.statementBinding,
      environment: executor.environment,
      async acquire() {
        acquires += 1;
        return {
          ...executor,
          release() {
            released += 1;
          },
        };
      },
    });

    await db.session(async (session) => {
      closedSession = session;
      const row = session.prepare("lookup-user", (id: number) => sql.rows<{ readonly name: string }>`
        SELECT name FROM users WHERE id = ${id}
      `);
      const insert = session.prepare("insert-user", (name: string) => sql.command`
        INSERT INTO users (name) VALUES (${name})
      `);
      await session.execute(sql.command`CREATE TEMP TABLE session_marker (value TEXT NOT NULL)`);
      await session.execute(sql.command`INSERT INTO session_marker VALUES (${"pinned"})`);
      await session.tx(async (tx) => {
        await tx.execute(sql.command`INSERT INTO users (name) VALUES (${"Ada"})`);
        await tx.execute(sql.command`INSERT INTO session_marker VALUES (${"nested"})`);
      });
      assert.deepEqual(await session.all(sql.rows`SELECT value FROM session_marker ORDER BY rowid`), [
        { value: "pinned" },
        { value: "nested" },
      ]);
      assert.deepEqual(await insert.execute("Grace"), {
        rows: [],
        rowCount: 1,
        kind: "command",
        command: { affectedRows: 1, insertId: "2" },
      });
      assert.deepEqual(await row.one(1), { name: "Ada" });
      assert.deepEqual(await row.one(2), { name: "Grace" });
    });

    assert.equal(acquires, 1, "session.tx must reuse one physical lease");
    assert.equal(released, 1, "session must release its lease once");
    await assert.rejects(
      () => closedSession!.execute(sql`SELECT 1`),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_CLOSED",
    );
    assert.deepEqual(await db.all(sql.rows`SELECT name FROM users ORDER BY id`), [
      { name: "Ada" },
      { name: "Grace" },
    ]);
  } finally {
    native.close();
  }
});

test("native SQLite transaction options and active cancellation fail before user SQL", async () => {
  const native = new DatabaseSync(":memory:");
  let acquires = 0;
  try {
    const executor = createNodeSqliteExecutor(native);
    const db = createPooledDatabase({
      statementBinding: executor.statementBinding,
      environment: executor.environment,
      async acquire() {
        acquires += 1;
        return { ...executor, release() {} };
      },
    });
    await db.tx({ isolation: "serializable" }, async (tx) => {
      await tx.execute(sql.command`CREATE TABLE tx_options (value TEXT NOT NULL)`);
    });
    await assert.rejects(
      () => db.tx({ isolation: "read-committed" }, async () => undefined),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "transaction.isolation.read-committed"
        && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
    await assert.rejects(
      () => db.tx({ readOnly: true }, async () => undefined),
      (error: unknown) => error instanceof UnsupportedFeatureError
        && error.feature === "transaction.read-only"
        && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
    );
    const beforeAbortAcquire = acquires;
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await assert.rejects(
      () => db.execute(sql`INSERT INTO tx_options VALUES (${"must not write"})`, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.message === "already stopped",
    );
    assert.equal(acquires, beforeAbortAcquire, "already-aborted execution must not acquire a lease");

    const active = new AbortController();
    await assert.rejects(
      () => db.execute(sql`INSERT INTO tx_options VALUES (${"must not write"})`, { signal: active.signal }),
      (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "statement.cancel",
    );
    assert.equal(acquires, beforeAbortAcquire, "unsupported active cancellation must not acquire a lease");
  } finally {
    native.close();
  }
});

test("D1 and SQLite WASM advertise physical session limitations honestly", async () => {
  const controls: string[] = [];
  const wasm = createSqliteWasmExecutor({
    prepare: () => { throw new Error("unused"); },
    exec(sqlText) { controls.push(sqlText); },
  });
  assertCapability(wasm.environment?.capabilities ?? {}, "session.pinned", "guaranteed");
  assertCapability(wasm.environment?.capabilities ?? {}, "transaction", "guaranteed");
  const begin = wasm.begin;
  assert.ok(begin);
  await begin({ isolation: "serializable" });
  assert.deepEqual(controls, ["BEGIN"]);
  await assert.rejects(
    async () => begin({ readOnly: true }),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "transaction.read-only"
      && error.code === "BRAID_TX_OPTION_UNSUPPORTED",
  );
  await assert.rejects(
    async () => begin({ isolation: "serializable", extra: true } as never),
    (error: unknown) => error instanceof TypeError
      && "code" in error
      && error.code === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.deepEqual(controls, ["BEGIN"]);
  const d1 = createD1Executor({ prepare: () => { throw new Error("unused"); }, batch: async () => [] });
  assertCapability(d1.environment?.capabilities ?? {}, "session.pinned", "unsupported");
  assertCapability(d1.environment?.capabilities ?? {}, "transaction", "unsupported");
  assertCapability(d1.environment?.capabilities ?? {}, "statement.stream", "unsupported");
});
