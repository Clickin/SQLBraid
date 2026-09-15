import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { createStatementBindingDescription } from "@sqlbraid/core";
import type { QueryExecutor, StatementBindingAdapter } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";

const docs = [
  "website/src/content/docs/runtime/transactions.md",
  "website/src/content/docs/ko/runtime/transactions.md",
] as const;

function canonicalExamples(source: string): Map<string, string> {
  const examples = new Map<string, string>();
  for (const match of source.matchAll(/```ts\n([\s\S]*?)```/gu)) {
    const code = match[1]!;
    const label = /canonical-example:\s*([a-z-]+)/u.exec(code)?.[1];
    if (label !== undefined) examples.set(label, code);
  }
  return examples;
}

async function runExample(code: string) {
  const events: Array<{ readonly type: "begin" | "query"; readonly value: unknown }> = [];
  const statementBinding = Object.freeze<StatementBindingAdapter>({
    id: "docs-transaction-examples",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "docs-transaction-examples",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  });
  const executor: QueryExecutor = {
    statementBinding,
    async query(statement) {
      events.push({ type: "query", value: statement.resultKind });
      return statement.resultKind === "rows"
        ? { kind: "rows", rows: [{ id: "acct-1", active: true }] }
        : { kind: "command", command: { affectedRows: 1 } };
    },
    async *stream() {
      throw new Error("stream is not used by this example");
    },
    async call() {
      throw new Error("call is not used by this example");
    },
    async begin(options) {
      events.push({ type: "begin", value: options });
    },
    async commit() {},
    async rollback() {},
  };
  const db = createDatabase(executor);
  const execute = new Function("db", "sql", "accountId", `return (async () => {${code}\n})();`) as (
    database: typeof db,
    tags: typeof sql,
    accountId: string,
  ) => Promise<unknown>;
  await execute(db, sql, "acct-1");
  return events;
}

test("English and Korean canonical transaction examples execute and keep scopes separate", async () => {
  const [english, korean] = await Promise.all(docs.map((path) => readFile(path, "utf8").then(canonicalExamples)));
  assert.deepEqual([...english.keys()], ["serializable-write", "read-only-query"]);
  assert.deepEqual([...korean.keys()], [...english.keys()]);

  for (const examples of [english, korean]) {
    const write = await runExample(examples.get("serializable-write")!);
    assert.deepEqual(write, [
      { type: "begin", value: { isolation: "serializable" } },
      { type: "query", value: "command" },
      { type: "query", value: "command" },
    ]);

    const readOnly = await runExample(examples.get("read-only-query")!);
    assert.deepEqual(readOnly, [
      { type: "begin", value: { readOnly: true } },
      { type: "query", value: "rows" },
    ]);
  }
});
