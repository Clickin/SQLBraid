import assert from "node:assert/strict";
import { test } from "vitest";
import { createBulkBindingDescription, createStatementBindingDescription } from "@sqlbraid/core";
import type {
  QueryExecutionResult,
  QueryExecutor,
  RenderedStatement,
  StandardSchemaV1,
  StatementBindingAdapter,
} from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

function stringId(value: unknown): number {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new TypeError("expected a string id");
  }
  return Number(value.id);
}

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "runtime-awaitable-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "runtime-awaitable-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
  describeBulk(bulk, context) {
    return createBulkBindingDescription(bulk, context, {
      adapterId: "runtime-awaitable-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function executorFixture(): QueryExecutor & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    statementBinding,
    query<Row>(): QueryExecutionResult<Row> {
      return { kind: "rows", rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      return;
    },
    call() {
      throw new Error("call unsupported in fixture");
    },
    begin() {
      calls.push("BEGIN");
    },
    commit() {
      calls.push("COMMIT");
    },
    rollback() {
      calls.push("ROLLBACK");
    },
    savepoint(name) {
      calls.push(`SAVEPOINT ${name}`);
    },
    rollbackTo(name) {
      calls.push(`ROLLBACK TO ${name}`);
    },
    releaseSavepoint(name) {
      calls.push(`RELEASE ${name}`);
    },
  };
}

test("sync and async query executors both stay behind the async Database API", async () => {
  const sync = executorFixture();
  sync.query = <Row>(): QueryExecutionResult<Row> => ({ kind: "rows", rows: [{ value: 1 } as Row] });
  const plain = await sync.query<{ readonly value: number }>(sql.rows`SELECT 1`.render());
  assert.deepEqual(plain.rows, [{ value: 1 }]);
  assert.deepEqual(await createDatabase(sync).all(sql.rows`SELECT 1`), [{ value: 1 }]);

  const asynchronous = executorFixture();
  asynchronous.query = async <Row>(): Promise<QueryExecutionResult<Row>> => ({
    kind: "rows",
    rows: [{ value: 2 } as Row],
  });
  assert.deepEqual(await createDatabase(asynchronous).all(sql.rows`SELECT 2`), [{ value: 2 }]);
});

test("sync throws and async rejections use the normal driver error path", async () => {
  const syncFailure = new Error("sync query failed");
  const sync = executorFixture();
  sync.query = () => {
    throw syncFailure;
  };
  await assert.rejects(
    () => createDatabase(sync).execute(sql`SELECT sync_failure`),
    (error) => error === syncFailure,
  );

  const asyncFailure = new Error("async query failed");
  const asynchronous = executorFixture();
  asynchronous.query = async () => {
    throw asyncFailure;
  };
  await assert.rejects(
    () => createDatabase(asynchronous).execute(sql`SELECT async_failure`),
    (error) => error === asyncFailure,
  );
});

test("sync bulk results are normalized by the async Database API", async () => {
  const executor = executorFixture();
  executor.bulk = (bulk) => ({
    inputCount: bulk.parameterSets.length,
    affectedRows: bulk.parameterSets.length,
    executionMode: "prepared-loop",
  });
  const result = await createDatabase(executor).bulk(
    ["a", "b"],
    (value) => sql.command`UPDATE users SET name = ${value}`,
  );
  assert.deepEqual(result, { inputCount: 2, affectedRows: 2 });
});

test("sync transaction controls include nested savepoint cleanup", async () => {
  const executor = executorFixture();
  executor.query = <Row>(rendered: RenderedStatement): QueryExecutionResult<Row> => {
    executor.calls.push(rendered.segments.join(""));
    return { kind: "rows", rows: [] as readonly Row[] };
  };
  const db = createDatabase(executor);
  await db.tx(async (tx) => {
    await assert.rejects(
      () =>
        tx.tx(async () => {
          throw new Error("nested failure");
        }),
      /nested failure/,
    );
    await tx.execute(sql`SELECT after_savepoint`);
  });
  assert.equal(executor.calls[0], "BEGIN");
  assert.match(executor.calls[1]!, /^SAVEPOINT braid_sp_braid_tx_\d+$/u);
  assert.match(executor.calls[2]!, /^ROLLBACK TO braid_sp_braid_tx_\d+$/u);
  assert.match(executor.calls[3]!, /^RELEASE braid_sp_braid_tx_\d+$/u);
  assert.equal(executor.calls[4], "SELECT after_savepoint");
  assert.equal(executor.calls[5], "COMMIT");
});

test("observer failures preserve sync driver errors and report before/after stages", async () => {
  const beforeError = new Error("observer before");
  const beforeExecutor = executorFixture();
  let beforeExecuted = false;
  beforeExecutor.query = <Row>(): QueryExecutionResult<Row> => {
    beforeExecuted = true;
    return { kind: "rows", rows: [] as readonly Row[] };
  };
  const beforeDb = createDatabase(beforeExecutor, {
    observers: [
      {
        async onEvent(event) {
          if (event.type === "query:ready") throw beforeError;
        },
      },
    ],
  });
  await assert.rejects(
    () => beforeDb.execute(sql`SELECT before`),
    (error) => error === beforeError,
  );
  assert.equal(beforeExecuted, false);

  const physicalError = new Error("sync physical error");
  const observerError = new Error("observer error");
  const afterExecutor = executorFixture();
  afterExecutor.query = () => {
    throw physicalError;
  };
  const events: string[] = [];
  const afterDb = createDatabase(afterExecutor, {
    observers: [
      {
        async onEvent(event) {
          events.push(event.type === "query:error" ? event.stage : event.type);
          if (event.type === "query:error") throw observerError;
        },
      },
    ],
  });
  await assert.rejects(
    () => afterDb.execute(sql`SELECT after`),
    (error) => {
      return error instanceof AggregateError && error.errors[0] === physicalError && error.errors[1] === observerError;
    },
  );
  assert.deepEqual(events, ["query:ready", "driver"]);

  const observerAfterError = new Error("observer after");
  const observerAfterExecutor = executorFixture();
  const observerAfterDb = createDatabase(observerAfterExecutor, {
    observers: [
      {
        async onEvent(event) {
          if (event.type === "query:result") throw observerAfterError;
        },
      },
    ],
  });
  await assert.rejects(
    () => observerAfterDb.execute(sql`SELECT observer_after`),
    (error) => error === observerAfterError,
  );
});

test("async Standard Schema mapping runs after a synchronous result", async () => {
  const executor = executorFixture();
  executor.query = <Row>(): QueryExecutionResult<Row> => ({ kind: "rows", rows: [{ id: "7" } as Row] });
  const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
    "~standard": {
      version: 1,
      vendor: "runtime-awaitable-test",
      async validate(value) {
        return { value: { id: stringId(value) } };
      },
    },
  };
  const result = await createDatabase(executor).all(sql.rows<{ readonly id: number }>`SELECT 7`, { schema });
  assert.deepEqual(result, [{ id: 7 }]);
});
