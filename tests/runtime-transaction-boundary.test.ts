import assert from "node:assert/strict";
import { test } from "vitest";
import type { QueryExecutor, RenderedQuery } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

function physical(log: string[]): QueryExecutor {
  return {
    async query<Row>(query: RenderedQuery) { log.push(query.text); return { kind: "rows", rows: [] as readonly Row[] }; },
    async begin() { log.push("begin"); }, async commit() { log.push("commit"); }, async rollback() { log.push("rollback"); },
    async savepoint(name) { log.push(`savepoint:${name}`); },
    async rollbackTo(name) { log.push(`rollback-to:${name}`); },
    async releaseSavepoint(name) { log.push(`release:${name}`); },
  };
}

test("concurrent pooled transactions each retain root escape protection", async () => {
  const firstReady = Promise.withResolvers<void>();
  const secondReady = Promise.withResolvers<void>();
  const db = createPooledDatabase({ async acquire() { return { ...physical([]), release() {} }; } });
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
