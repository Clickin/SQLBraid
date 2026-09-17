import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
  type ConnectionProvider,
  type DriverRoutineResult,
  type QueryExecutor,
  type StatementBindingAdapter,
} from "@sqlbraid/core";
import { sql } from "@sqlbraid/template";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "pv17-bind-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "pv17-bind-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function hasUnsupportedBindCode(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "BRAID_BIND_VALUE_UNSUPPORTED"
  );
}

function provider(acquired: { value: number }): ConnectionProvider {
  return {
    statementBinding,
    async acquire(): Promise<QueryExecutor & { release(): void }> {
      acquired.value += 1;
      return {
        statementBinding,
        async query<Row>(): Promise<{ readonly kind: "rows"; readonly rows: readonly Row[] }> {
          return { kind: "rows", rows: [] };
        },
        async *stream<Row>(): AsyncGenerator<Row> {
          return;
        },
        async call(): Promise<DriverRoutineResult> {
          return { output: { output: "ok" }, resultSets: [] };
        },
        release() {},
      };
    },
  };
}

test("rendered statements reject undefined IN values but retain legal OUT placeholders", () => {
  assert.throws(
    () =>
      createRenderedStatement({
        segments: ["SELECT ", ""],
        parameters: [{ value: undefined }],
        resultKind: "rows",
        dialectId: "test",
      }),
    hasUnsupportedBindCode,
  );
  const rendered = createRenderedStatement({
    segments: ["CALL procedure(", ")"],
    parameters: [{ value: null, direction: "out", outputName: "output" }],
    resultKind: "call",
    dialectId: "test",
  });
  assert.equal(rendered.parameters[0]?.value, null);
  assert.equal(rendered.parameters[0]?.direction, "out");
});

test("all ordinary undefined IN paths fail before a pooled lease is acquired", async () => {
  const acquired = { value: 0 };
  const db = createPooledDatabase(provider(acquired));
  await assert.rejects(() => db.execute(sql`SELECT ${undefined}`), hasUnsupportedBindCode);
  const prepared = db.prepare("undefined-input", () => sql.rows`SELECT ${undefined}`, { input: "none" });
  await assert.rejects(() => prepared.execute(), hasUnsupportedBindCode);
  await assert.rejects(
    () => db.bulk([undefined], (value) => sql.command`INSERT INTO values (value) VALUES (${value})`),
    hasUnsupportedBindCode,
  );
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows`SELECT ${undefined}`)) void row;
  }, hasUnsupportedBindCode);
  await assert.rejects(() => db.call(sql.call`CALL procedure(${undefined})`), hasUnsupportedBindCode);
  assert.equal(acquired.value, 0);
});

test("OUT placeholders remain legal and execute through the routine path", async () => {
  const acquired = { value: 0 };
  const db = createPooledDatabase(provider(acquired));
  const result = await db.call(sql.call`CALL procedure(${sql.out("output")})`);
  assert.deepEqual(result.output, { output: "ok" });
  assert.equal(acquired.value, 1);
});

test("runtime rejects database-reported counts outside the safe integer range", async () => {
  const db = createDatabase({
    statementBinding,
    async query() {
      return {
        kind: "command" as const,
        rows: [] as const,
        rowCount: Number.MAX_SAFE_INTEGER + 1,
        command: { affectedRows: Number.MAX_SAFE_INTEGER + 1 },
      };
    },
    async *stream(): AsyncGenerator<never> {},
    async call(): Promise<DriverRoutineResult> {
      return { output: {}, resultSets: [] };
    },
  });
  await assert.rejects(
    () => db.execute(sql.command`UPDATE values SET value = ${1}`),
    (error: unknown) => error instanceof ResultExactnessError && error.code === "BRAID_RESULT_EXACTNESS",
  );
});
