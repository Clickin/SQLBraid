import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription, parameterizedSql } from "@sqlbraid/core";
import type { DriverRoutineResult, QueryExecutor, RenderedStatement, StatementBindingContext } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/postgres";

test("routine database call preserves output and result-set shape", async () => {
  const executor: QueryExecutor = {
    statementBinding: {
      id: "routines-test",
      describe(statement, context: StatementBindingContext) {
        return createStatementBindingDescription(statement, context, {
          adapterId: "routines-test",
          transport: "native-value-template",
          reuse: { effective: "simple", owner: "sqlbraid" },
        });
      },
    },
    async query<Row>() {
      return { kind: "rows", rows: [] as readonly Row[] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call(rendered: RenderedStatement): Promise<DriverRoutineResult> {
      assert.equal(
        parameterizedSql(rendered, (index) => `$${index}`),
        "CALL do_work($1)",
      );
      return {
        output: { ok: true },
        resultSets: [
          { rows: [{ id: 1 }], source: { kind: "emitted", index: 0 } },
          { rows: [], source: { kind: "emitted", index: 1 } },
        ],
        returnValue: 5,
      };
    },
  };
  const db = createDatabase(executor);
  const query = sql.call`CALL do_work(${1})`;
  assert.deepEqual(await db.call(query), {
    output: { ok: true },
    resultSets: [{ rows: [{ id: 1 }] }, { rows: [] }],
    returnValue: 5,
  });
});
