import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createBulkBindingDescription,
  createStatementBindingDescription,
  type CommandQuery,
  type DriverRoutineResult,
  type ExecutionEvent,
  type QueryExecutor,
  type RenderedBulk,
  type RenderedStatement,
  type StatementBindingContext,
  type StatementBindingAdapter,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

function adapterWithBulk(): StatementBindingAdapter {
  return Object.freeze({
    id: "pv16-bulk-test",
    describe(statement: RenderedStatement, context: StatementBindingContext) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "pv16-bulk-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "driver" },
      });
    },
    describeBulk(bulk: RenderedBulk, context: StatementBindingContext) {
      return createBulkBindingDescription(bulk, context, {
        adapterId: "pv16-bulk-test",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "driver" },
      });
    },
  });
}

function executor(
  statementBinding: StatementBindingAdapter,
  onBulk: (bulk: RenderedBulk) => void,
  lifecycle: string[] = [],
): QueryExecutor {
  return {
    statementBinding,
    async query<Row>(): Promise<{ readonly kind: "rows"; readonly rows: readonly Row[] }> {
      return { kind: "rows", rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      return;
    },
    async call(): Promise<DriverRoutineResult> {
      return { output: {}, resultSets: [] };
    },
    async bulk(bulk) {
      onBulk(bulk);
      lifecycle.push("bulk");
      return {
        inputCount: bulk.parameterSets.length,
        affectedRows: bulk.parameterSets.length,
        executionMode: "native-bulk",
      };
    },
    async begin() {
      lifecycle.push("begin");
    },
    async commit() {
      lifecycle.push("commit");
    },
    async rollback() {
      lifecycle.push("rollback");
    },
  };
}

test("bulk preflights every factory result, snapshots values, and executes once", async () => {
  const captured: RenderedBulk[] = [];
  const db = createDatabase(executor(adapterWithBulk(), (bulk) => captured.push(bulk)));
  const inputs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let factoryCalls = 0;
  const result = await db.bulk(inputs, (input) => {
    factoryCalls += 1;
    return sql.command`UPDATE account SET touched = ${true} WHERE id = ${input.id}`;
  });
  assert.deepEqual(result, { inputCount: 3, affectedRows: 3 });
  assert.equal(factoryCalls, 3);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.parameterSets, [
    [true, 1],
    [true, 2],
    [true, 3],
  ]);
  assert.equal(Object.isFrozen(captured[0]!.parameterSets), true);
  assert.equal(Object.isFrozen(captured[0]!.parameterSets[0]), true);
});

test("empty bulk is a true no-op", async () => {
  let factoryCalls = 0;
  let bulkCalls = 0;
  const db = createDatabase(
    executor(adapterWithBulk(), () => {
      bulkCalls += 1;
    }),
  );
  const result = await db.bulk([], () => {
    factoryCalls += 1;
    return sql.command`DELETE FROM account`;
  });
  assert.deepEqual(result, { inputCount: 0, affectedRows: 0 });
  assert.equal(factoryCalls, 0);
  assert.equal(bulkCalls, 0);
});

test("bulk rejects guarded, list-cardinality, and hint shape changes before lease or execution", async () => {
  const cases = [
    {
      name: "guarded",
      factory: (id: number) => sql.command`
        UPDATE account SET touched = ${true} WHERE id = ${id}
        /*@braid if ${id === 2}*/ AND id = ${id} /*@braid end*/
      `,
    },
    {
      name: "list-cardinality",
      factory: (id: number) => sql.command`
        UPDATE account SET touched = ${true} WHERE id IN (${sql.list(id === 1 ? [id] : [id, id + 1])})
      `,
    },
    {
      name: "hint",
      factory: (id: number) => sql.command`
        UPDATE account SET touched = ${id === 1 ? true : sql.bind(true, { databaseType: "INTEGER" })}
        WHERE id = ${id}
      `,
    },
  ] as const;

  for (const shapeCase of cases) {
    let factoryCalls = 0;
    let acquisitions = 0;
    let executions = 0;
    const statementBinding = adapterWithBulk();
    const db = createPooledDatabase({
      statementBinding,
      async acquire() {
        acquisitions += 1;
        const resource = executor(statementBinding, () => {
          executions += 1;
        });
        return { ...resource, release() {} };
      },
    });
    await assert.rejects(
      () =>
        db.bulk([1, 2], (id) => {
          factoryCalls += 1;
          return shapeCase.factory(id);
        }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "BRAID_BULK_SHAPE",
      shapeCase.name,
    );
    assert.equal(factoryCalls, 2);
    assert.equal(acquisitions, 0);
    assert.equal(executions, 0);
  }
});

test("bulk rejects a rendered non-command before lease acquisition", async () => {
  let acquisitions = 0;
  let executions = 0;
  const statementBinding = adapterWithBulk();
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      acquisitions += 1;
      const resource = executor(statementBinding, () => {
        executions += 1;
      });
      return { ...resource, release() {} };
    },
  });
  await assert.rejects(
    () =>
      db.bulk([1], (id) => {
        const query = sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`;
        return {
          ...query,
          render: () => ({ ...query.render(), resultKind: "rows" as const }),
        } as CommandQuery;
      }),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "BRAID_BULK_SHAPE",
  );
  assert.equal(acquisitions, 0);
  assert.equal(executions, 0);
});

test("rejected concurrent nested transaction leaves the parent scope usable", async () => {
  const statementBinding = adapterWithBulk();
  const resource = executor(statementBinding, () => undefined);
  resource.savepoint = async () => undefined;
  resource.rollbackTo = async () => undefined;
  resource.releaseSavepoint = async () => undefined;
  const db = createDatabase(resource);
  await db.tx(async (tx) => {
    const branches = await Promise.allSettled([
      tx.tx(async (nested) => {
        await nested.all(sql.rows`SELECT ${1}`);
      }),
      tx.tx(async (nested) => {
        await nested.all(sql.rows`SELECT ${2}`);
      }),
    ]);
    assert.equal(branches.filter((branch) => branch.status === "rejected").length, 1);
    const rejected = branches.find((branch): branch is PromiseRejectedResult => branch.status === "rejected");
    assert.equal(rejected?.reason.code, "BRAID_TX_SCOPE");
    await tx.all(sql.rows`SELECT ${3}`);
  });
});

test("bulk emits one ready/result operation and transaction bulk stays pinned", async () => {
  const lifecycle: string[] = [];
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    executor(adapterWithBulk(), () => undefined, lifecycle),
    {
      observers: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    },
  );
  await db.tx(async (tx) => {
    const result = await tx.bulk([1, 2], (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`);
    assert.equal(result.inputCount, 2);
  });
  assert.deepEqual(lifecycle, ["begin", "bulk", "commit"]);
  const operations = events.filter((event) => event.type !== "transaction");
  assert.deepEqual(
    operations.map((event) => event.type),
    ["bulk:ready", "bulk:result"],
  );
  const ready = operations[0];
  assert.equal(ready?.type, "bulk:ready");
  if (ready?.type === "bulk:ready") {
    assert.equal(ready.itemCount, 2);
    assert.deepEqual(ready.valuesAt(1), [true, 2]);
    assert.equal(ready.literalizedSql(0, { values: "inline" }).text, "UPDATE account SET touched = TRUE WHERE id = 1");
  }
});

test("bulk reports explicit unsupported capability without acquisition", async () => {
  const statementBinding: StatementBindingAdapter = {
    id: "pv16-no-bulk",
    describe(statement: RenderedStatement, context: StatementBindingContext) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "pv16-no-bulk",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "driver" },
      });
    },
  };
  const db = createDatabase({
    statementBinding,
    async query<Row>() {
      return { kind: "rows" as const, rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      return;
    },
    async call() {
      return { output: {}, resultSets: [] };
    },
  });
  await assert.rejects(
    () => db.bulk([1], (id) => sql.command`DELETE FROM account WHERE id = ${id}`),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "BRAID_BULK_UNSUPPORTED",
  );
});

test("pooled bulk reports a missing leased capability and releases the lease", async () => {
  let releases = 0;
  const statementBinding = adapterWithBulk();
  const db = createPooledDatabase({
    statementBinding,
    async acquire() {
      return {
        statementBinding,
        async query<Row>() {
          return { kind: "rows" as const, rows: [] as readonly Row[] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          return;
        },
        async call() {
          return { output: {}, resultSets: [] };
        },
        release() {
          releases += 1;
        },
      };
    },
  });
  await assert.rejects(
    () => db.bulk([1], (id) => sql.command`DELETE FROM account WHERE id = ${id}`),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "BRAID_BULK_UNSUPPORTED",
  );
  assert.equal(releases, 1);
});

test("pooled bulk releases exactly once on success, driver failure, and observer failure", async () => {
  {
    let acquisitions = 0;
    let releases = 0;
    const statementBinding = adapterWithBulk();
    const db = createPooledDatabase({
      statementBinding,
      async acquire() {
        acquisitions += 1;
        const resource = executor(statementBinding, () => undefined);
        return {
          ...resource,
          release() {
            releases += 1;
          },
        };
      },
    });
    await db.bulk([1, 2, 3], (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`);
    assert.equal(acquisitions, 1);
    assert.equal(releases, 1);
  }

  {
    let attempts = 0;
    let releases = 0;
    const driverFailure = new Error("bulk driver failure");
    const statementBinding = adapterWithBulk();
    const db = createPooledDatabase({
      statementBinding,
      async acquire() {
        attempts += 1;
        const resource = executor(statementBinding, () => {
          if (attempts === 1) throw driverFailure;
        });
        return {
          ...resource,
          release() {
            releases += 1;
          },
        };
      },
    });
    await assert.rejects(
      () => db.bulk([1], (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`),
      driverFailure,
    );
    await db.all(sql.rows`SELECT ${2}`);
    assert.equal(releases, 2);
  }

  {
    let rejectResult = true;
    let releases = 0;
    const observerFailure = new Error("bulk observer failure");
    const statementBinding = adapterWithBulk();
    const db = createPooledDatabase(
      {
        statementBinding,
        async acquire() {
          const resource = executor(statementBinding, () => undefined);
          return {
            ...resource,
            release() {
              releases += 1;
            },
          };
        },
      },
      {
        observers: [
          {
            onEvent(event) {
              if (rejectResult && event.type === "bulk:result") throw observerFailure;
            },
          },
        ],
      },
    );
    await assert.rejects(
      () => db.bulk([1], (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`),
      observerFailure,
    );
    rejectResult = false;
    await db.bulk([2], (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`);
    assert.equal(releases, 2);
  }
});

test("bulk shares one logical metadata description across 10k items", async () => {
  const captured: RenderedBulk[] = [];
  const events: ExecutionEvent[] = [];
  const db = createDatabase(
    executor(adapterWithBulk(), (bulk) => captured.push(bulk)),
    {
      observers: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    },
  );
  const inputs = Array.from({ length: 10_001 }, (_, index) => index);
  await db.bulk(inputs, (id) => sql.command`UPDATE account SET touched = ${true} WHERE id = ${id}`);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.parameterSets[10_000], [true, 10_000]);
  assert.deepEqual(
    events.filter((event) => event.type === "bulk:ready" || event.type === "bulk:result").map((event) => event.type),
    ["bulk:ready", "bulk:result"],
  );
  const ready = events.find((event) => event.type === "bulk:ready");
  assert.equal(ready?.type, "bulk:ready");
  if (ready?.type === "bulk:ready") assert.equal(ready.itemCount, 10_001);
});
