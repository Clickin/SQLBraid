import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription } from "@sqlbraid/core";
import type { DriverRoutineResult, QueryExecutor, RenderedStatement, StatementBindingAdapter } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "runtime-transaction-boundary-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-transaction-boundary-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
})

function statementText(statement: RenderedStatement): string {
  return statement.segments.join("?");
}

function physical(log: string[]): QueryExecutor {
  return {
    statementBinding,
    async query<Row>(query: RenderedStatement) { log.push(statementText(query)); return { kind: "rows", rows: [] as readonly Row[] }; },
    async *stream<Row>(): AsyncGenerator<Row> { throw new Error("BRAID_STREAM_UNSUPPORTED"); },
    async call(): Promise<DriverRoutineResult> { throw new Error("BRAID_CALL_UNSUPPORTED"); },
    async begin() { log.push("begin"); }, async commit() { log.push("commit"); }, async rollback() { log.push("rollback"); },
    async savepoint(name) { log.push(`savepoint:${name}`); },
    async rollbackTo(name) { log.push(`rollback-to:${name}`); },
    async releaseSavepoint(name) { log.push(`release:${name}`); },
  };
}

test("concurrent pooled transactions each retain root escape protection", async () => {
  const firstReady = Promise.withResolvers<void>();
  const secondReady = Promise.withResolvers<void>();
  const db = createPooledDatabase({ statementBinding, async acquire() { return { ...physical([]), release() {} }; } });
  await Promise.all([
    db.tx(async () => {
      firstReady.resolve();
      await secondReady.promise;
      await assert.rejects(db.execute(sql`SELECT escaped_first`), { code: "BRAID_TX_SCOPE" });
    }),
    db.tx(async () => {
      await firstReady.promise;
      secondReady.resolve();
      await assert.rejects(db.execute(sql`SELECT escaped_second`), { code: "BRAID_TX_SCOPE" });
    }),
  ]);
}, 1000);

test("begin observer failure rolls back but committed observer failure cannot roll back", async () => {
  for (const phase of ["begin", "commit"] as const) {
    const log: string[] = [];
    const failure = new Error("observer failed");
    let fail = true;
    const db = createDatabase(physical(log), { observers: [{ onEvent(event) {
      if (fail && event.type === "transaction" && event.phase === phase && event.status === "completed") throw failure;
    } }] });
    await assert.rejects(db.tx(async () => undefined), (error) => error === failure);
    assert.deepEqual(log, phase === "begin" ? ["begin", "rollback"] : ["begin", "commit"]);
    fail = false;
    await db.execute(sql`SELECT healthy`);
    assert.equal(log.at(-1), "SELECT healthy");
  }
});

test("nested observer failures clean savepoints and reject parent or sibling scope escape", async () => {
  for (const phase of ["savepoint", "release-savepoint"] as const) {
    const log: string[] = [];
    const failure = new Error("savepoint observer failed");
    let failed = false;
    const db = createDatabase(physical(log), { observers: [{ onEvent(event) {
      const status = phase === "savepoint" ? "completed" : "requested";
      if (!failed && event.type === "transaction" && event.phase === phase && event.status === status) {
        failed = true;
        throw failure;
      }
    } }] });
    await db.tx(async (tx) => {
      await assert.rejects(tx.tx(async () => undefined), (error) => error === failure);
      await tx.execute(sql`SELECT parent`);
    });
    const savepoint = log.find((entry) => entry.startsWith("savepoint:"))!.slice("savepoint:".length);
    assert.deepEqual(log, ["begin", `savepoint:${savepoint}`, `rollback-to:${savepoint}`, `release:${savepoint}`, "SELECT parent", "commit"]);
  }
  const db = createDatabase(physical([]));
  await db.tx(async (tx) => {
    await tx.tx(async (nested) => {
      await assert.rejects(tx.execute(sql`SELECT parent_escape`), { code: "BRAID_TX_SCOPE" });
      await assert.rejects(tx.tx(async () => undefined), { code: "BRAID_TX_SCOPE" });
      await nested.execute(sql`SELECT nested`);
    });
  });
});

test("a live transaction stream prevents transaction completion and closes before rollback", async () => {
  const log: string[] = [];
  const db = createDatabase({ ...physical(log), async *stream<Row>() {
    try { yield 1 as Row; yield 2 as Row; } finally { log.push("stream-close"); }
  } });
  await assert.rejects(db.tx(async (tx) => {
    const stream = tx.stream(sql.rows`SELECT stream`)[Symbol.asyncIterator]();
    await stream.next();
  }), { code: "BRAID_STREAM_SCOPE" });
  assert.deepEqual(log, ["begin", "stream-close", "rollback"]);
  await db.execute(sql`SELECT healthy`);
});

test("an open session stream rejects transaction re-entry before control I/O", async () => {
  for (const pooled of [false, true] as const) {
    const log: string[] = [];
    let acquires = 0;
    let releases = 0;
    const resource = pooled
      ? createPooledDatabase({
        statementBinding,
        async acquire() {
          acquires += 1;
          return {
            ...physical(log),
            async *stream<Row>() {
              try { yield 1 as Row; } finally { log.push("stream-close"); }
            },
            release() { releases += 1; },
          };
        },
      })
      : createDatabase({
        ...physical(log),
        async *stream<Row>() {
          try { yield 1 as Row; } finally { log.push("stream-close"); }
        },
      });

    if (!pooled) {
      const rootIterator = resource.stream(sql.rows`SELECT root_stream`)[Symbol.asyncIterator]();
      await rootIterator.next();
      await assert.rejects(
        () => resource.tx(async () => undefined),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_STREAM_SCOPE",
      );
      assert.equal(log.includes("begin"), false);
      await rootIterator.return();
    }

    await resource.session(async (session) => {
      const iterator = session.stream(sql.rows`SELECT stream`)[Symbol.asyncIterator]();
      await iterator.next();
      await assert.rejects(
        () => session.tx(async () => undefined),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_STREAM_SCOPE",
      );
      assert.equal(log.includes("begin"), false);
      await iterator.return();
      await session.tx(async (tx) => {
        await tx.execute(sql`SELECT after_stream`);
      });
    });
    assert.equal(log.includes("begin"), true);
    if (pooled) {
      assert.equal(acquires, 2);
      assert.equal(releases, 2);
    }
  }
});

test("transaction and session wrappers retain active savepoint scope", async () => {
  for (const pooled of [false, true] as const) {
    const log: string[] = [];
    const base = physical(log);
    const resource = pooled
      ? createPooledDatabase({
        statementBinding,
        async acquire() {
          return { ...base, release() {} };
        },
      })
      : createDatabase(base);
    let leakedTransaction: import("@sqlbraid/core").Database | undefined;
    let leakedSession: import("@sqlbraid/core").Database | undefined;

    await resource.tx(async (outer) => {
      leakedTransaction = outer;
      await outer.session(async (parent) => {
        leakedSession = parent;
        await parent.tx(async (inner) => {
          await assert.rejects(
            () => parent.execute(sql`SELECT parent_escape`),
            (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
          );
          await assert.rejects(
            () => outer.execute(sql`SELECT outer_escape`),
            (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
          );
          await assert.rejects(
            () => parent.session(async (sibling) => sibling.execute(sql`SELECT sibling_escape`)),
            (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
          );
          await inner.execute(sql`SELECT inner`);
        });
        await parent.execute(sql`SELECT parent_after`);
      });
    });
    await assert.rejects(
      () => leakedTransaction!.execute(sql`SELECT closed_transaction`),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_CLOSED",
    );
    await assert.rejects(
      () => leakedSession!.execute(sql`SELECT closed_session`),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_CLOSED",
    );
    assert.equal(log.some((entry) => entry === "SELECT parent_escape" || entry === "SELECT outer_escape" || entry === "SELECT sibling_escape"), false);

    await resource.session(async (session) => {
      await session.tx(async (transaction) => {
        await transaction.session(async (transactionSession) => {
          await transactionSession.tx(async (innermost) => {
            await assert.rejects(
              () => transactionSession.execute(sql`SELECT transaction_session_escape`),
              (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
            );
            await assert.rejects(
              () => transaction.execute(sql`SELECT transaction_escape`),
              (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_SCOPE",
            );
            await innermost.execute(sql`SELECT innermost`);
          });
        });
      });
    });
    assert.equal(log.some((entry) => entry === "SELECT transaction_session_escape" || entry === "SELECT transaction_escape"), false);
  }
});
