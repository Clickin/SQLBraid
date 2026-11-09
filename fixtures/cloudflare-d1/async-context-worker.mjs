import { createStatementBindingDescription } from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/sqlite";

const statementBinding = Object.freeze({
  id: "workers-async-context",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "workers-async-context",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

const capabilities = { transaction: { status: "guaranteed" } };
const environment = {
  database: { product: "synthetic-sql" },
  driver: { id: "workers-async-context" },
  capabilities,
};

function createDb() {
  return createPooledDatabase({
    statementBinding,
    environment,
    async acquire() {
      return {
        ownershipKey: {},
        statementBinding,
        environment,
        query: async () => ({ kind: "rows", rows: [{ value: 1 }] }),
        async *stream() {},
        async begin() {},
        async commit() {},
        async rollback() {},
        async release() {},
      };
    },
  });
}

const outcome = (promise) =>
  promise.then(
    () => "ok",
    (error) => error?.code ?? String(error),
  );

export default {
  async fetch() {
    const db = createDb();
    let enter;
    const entered = new Promise((resolve) => (enter = resolve));
    let leave;
    const left = new Promise((resolve) => (leave = resolve));
    let escape;
    const transaction = db.tx(async () => {
      await Promise.resolve();
      escape = await outcome(db.all(sql.rows`SELECT 1 AS value`));
      enter();
      await left;
    });
    await entered;
    const concurrent = await outcome(db.all(sql.rows`SELECT 1 AS value`));
    leave();
    await transaction;
    const after = await outcome(db.all(sql.rows`SELECT 1 AS value`));
    return Response.json({ concurrent, escape, after });
  },
};
