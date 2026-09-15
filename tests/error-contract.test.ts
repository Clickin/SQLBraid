import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  AdapterError,
  createRenderedStatement,
  PUBLIC_ERROR_DEFINITIONS,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { createMysql2Executor } from "@sqlbraid/mysql/mysql2";
import { createPgExecutor } from "@sqlbraid/postgres/pg";
import { createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";

const docs = [
  new URL("../website/src/content/docs/reference/errors.md", import.meta.url),
  new URL("../website/src/content/docs/ko/reference/errors.md", import.meta.url),
];

function documentedCodes(url: URL): Set<string> {
  const rows = readFileSync(url, "utf8").split("\n").filter((line) => line.startsWith("|"));
  return new Set(rows.flatMap((line) => line.match(/BRAID_[A-Z0-9_]+/gu) ?? []));
}

test("the explicit public error registry is complete in both error references", () => {
  const registryCodes = PUBLIC_ERROR_DEFINITIONS.map(({ code }) => code);
  assert.equal(new Set(registryCodes).size, registryCodes.length);
  for (const url of docs) {
    assert.deepEqual([...documentedCodes(url)].sort(), [...registryCodes].sort(), String(url));
  }
});

function hinted(dialectId: string) {
  return createRenderedStatement({
    segments: ["SELECT ", ""],
    parameters: [{ value: 1, hint: { databaseType: "INTEGER" } }],
    dialectId,
    resultKind: "rows",
  });
}

test("adapter-owned unsupported paths expose UnsupportedFeatureError and a code", async () => {
  const pg = createPgExecutor({
    async query() { throw new Error("must not execute"); },
    escapeIdentifier(value: string) { return value; },
    escapeLiteral(value: string) { return value; },
  });
  await assert.rejects(
    () => pg.query(hinted("postgres")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );

  const mysql = createMysql2Executor({
    async execute() { throw new Error("must not execute"); },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  });
  await assert.rejects(
    () => mysql.query(hinted("mysql")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.throws(
    () => mysql.statementBinding.describeBulk!({
      statement: createRenderedStatement({
        segments: ["INSERT INTO example VALUES (", ")"],
        parameters: [{ value: 1 }],
        dialectId: "mysql",
        resultKind: "command",
      }),
      parameterSets: [[() => undefined]],
    }, { dialectId: "mysql", requestedReuse: "auto", transactionScoped: false }),
    (error: unknown) => error instanceof AdapterError && error.code === "BRAID_BIND_VALUE_UNSUPPORTED",
  );

  let prepares = 0;
  const sqlite = createNodeSqliteExecutor({
    prepare() {
      prepares += 1;
      throw new Error("must not prepare");
    },
  });
  await assert.rejects(
    () => sqlite.query(hinted("sqlite")),
    (error: unknown) => error instanceof UnsupportedFeatureError
      && error.feature === "statement.bind-hint"
      && error.code === "BRAID_BIND_HINT_UNSUPPORTED",
  );
  assert.equal(prepares, 0);
});
