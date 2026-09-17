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

test("rollback cleanup observer preserves the primary error and releases the pooled lease", async () => {
  const primary = new Error("transaction primary failure");
  const cleanup = new Error("transaction rollback cleanup failure");
  const log: string[] = [];
  let releases = 0;
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        ...physical(log),
        release() { releases += 1; },
      };
    },
  }, {
    observers: [{
      onEvent(event) {
        if (event.type === "transaction" && event.phase === "rollback" && event.status === "completed") throw cleanup;
      },
    }],
  });

  await assert.rejects(
    () => db.tx(async () => { throw primary; }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.ok(error.errors.some((entry) => entry === cleanup));
      return true;
    },
  );
  assert.equal(releases, 1);
  await db.execute(sql`SELECT healthy_after_rollback_cleanup`);
  assert.equal(log.at(-1), "SELECT healthy_after_rollback_cleanup");
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
  for (const [pooled, started] of [[false, false], [false, true], [true, false], [true, true]] as const) {
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
      await rootIterator.return!();
    }

    await resource.session(async (session) => {
      const iterator = session.stream(sql.rows`SELECT stream`)[Symbol.asyncIterator]();
      const first = iterator.next();
      if (started) await first;
      await assert.rejects(
        () => session.tx(async () => undefined),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_STREAM_SCOPE",
      );
      assert.equal(log.includes("begin"), false);
      if (pooled) assert.equal(acquires, 1, "rejected transaction must not acquire another lease");
      await first;
      await iterator.return!();
      await session.tx(async (tx) => {
        await tx.execute(sql`SELECT after_stream`);
      });
      const nextIterator = session.stream(sql.rows`SELECT next_stream`)[Symbol.asyncIterator]();
      const nextFirst = nextIterator.next();
      await assert.rejects(session.execute(sql`SELECT overlapping_stream`), { code: "BRAID_STREAM_SCOPE" });
      await nextFirst;
      await nextIterator.return!();
      assert.equal(log.includes("SELECT overlapping_stream"), false);
    });
    assert.equal(log.includes("begin"), true);
    if (pooled) {
      assert.equal(acquires, 1);
      assert.equal(releases, 1);
    }
  }
});

test("queued parent work rechecks savepoint scope before physical execution", async () => {
  const log: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const db = createDatabase({
    ...physical(log),
    async query<Row>(statement: RenderedStatement) {
      const text = statementText(statement);
      log.push(text);
      if (text === "SELECT holding") {
        entered.resolve();
        await release.promise;
      }
      return { kind: "rows", rows: [] as readonly Row[] };
    },
  });
  await db.tx(async (outer) => outer.session(async (parent) => {
    const holding = parent.execute(sql`SELECT holding`);
    await entered.promise;
    const queued = parent.execute(sql`SELECT escaped`);
    const rejected = assert.rejects(queued, { code: "BRAID_TX_SCOPE" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const nested = parent.tx(async (inner) => {
      await inner.execute(sql`SELECT inner`);
    });
    release.resolve();
    await Promise.all([holding, rejected, nested]);
    await parent.execute(sql`SELECT restored`);
  }));
  assert.equal(log.includes("SELECT escaped"), false);
  assert.equal(log.includes("SELECT inner"), true);
  assert.equal(log.at(-1), "commit");
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
      await outer.tx(async (inner) => {
        await assert.rejects(outer.execute(sql`SELECT direct_parent_escape`), { code: "BRAID_TX_SCOPE" });
        await inner.execute(sql`SELECT direct_inner`);
      });
      const siblingReady = Promise.withResolvers<import("@sqlbraid/core").Database>();
      const finishSibling = Promise.withResolvers<void>();
      const siblingSession = outer.session(async (sibling) => {
        siblingReady.resolve(sibling);
        await finishSibling.promise;
      });
      const sibling = await siblingReady.promise;
      try {
        await outer.session(async (parent) => {
          leakedSession = parent;
          await parent.tx(async (inner) => {
            await assert.rejects(parent.execute(sql`SELECT parent_escape`), { code: "BRAID_TX_SCOPE" });
            await assert.rejects(outer.execute(sql`SELECT outer_escape`), { code: "BRAID_TX_SCOPE" });
            await assert.rejects(sibling.execute(sql`SELECT sibling_escape`), { code: "BRAID_TX_SCOPE" });
            await inner.execute(sql`SELECT inner`);
          });
          await parent.execute(sql`SELECT parent_after`);
        });
      } finally {
        finishSibling.resolve();
        await siblingSession;
      }
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
