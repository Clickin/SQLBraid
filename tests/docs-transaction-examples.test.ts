import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import ts from "typescript";
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
    environment: {
      database: { product: "docs-examples" },
      driver: { id: "docs-examples", version: "1", profile: "test" },
      capabilities: {
        transaction: { status: "guaranteed" },
        "transaction.read-only": { status: "guaranteed" },
        "transaction.isolation.serializable": { status: "guaranteed" },
      },
    },
    async query(statement) {
      events.push({ type: "query", value: statement.resultKind });
      return statement.resultKind === "rows"
        ? { kind: "rows", rows: [{ id: "acct-1", active: true }] }
        : { kind: "command", rows: [], command: { affectedRows: 1 } };
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
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText;
  const execute = new Function("db", "sql", "accountId", "signal", `return (async () => {${javascript}\n})();`) as (
    database: typeof db,
    tags: typeof sql,
    accountId: string,
    signal?: AbortSignal,
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

test("English and Korean zero-input prepared examples use the executable options-only contract", async () => {
  for (const path of [
    "website/src/content/docs/runtime/prepared.md",
    "website/src/content/docs/ko/runtime/prepared.md",
  ]) {
    const source = await readFile(path, "utf8");
    const code = [...source.matchAll(/```ts\n([\s\S]*?)```/gu)]
      .map((match) => match[1]!)
      .find((example) => example.includes('{ input: "none" }'));
    assert.ok(code, `${path} must contain the zero-input canonical example`);
    assert.deepEqual(await runExample(code), [{ type: "query", value: "rows" }]);
  }
});
