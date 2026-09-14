import assert from "node:assert/strict";
import { test } from "vitest";
import type { OracleDriverLike, OracleConnectionLike } from "@sqlbraid/oracle/oracledb";
import { createOracledbExecutor, oracleOutputOrdinals } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { createRenderedBulk } from "@sqlbraid/core";

const driver: OracleDriverLike = {
  BIND_IN: "in",
  BIND_OUT: "out",
  BIND_INOUT: "inout",
  OUT_FORMAT_OBJECT: "object",
  STRING: "STRING",
  NUMBER: "NUMBER",
  DATE: "DATE",
  BUFFER: "BUFFER",
  DB_TYPE_VARCHAR: "VARCHAR2",
  DB_TYPE_NUMBER: "NUMBER",
  DB_TYPE_DATE: "DATE",
  DB_TYPE_RAW: "RAW",
};

function connectionFor(
  execute: OracleConnectionLike["execute"],
  executeMany?: NonNullable<OracleConnectionLike["executeMany"]>,
): OracleConnectionLike {
  return { execute, ...(executeMany === undefined ? {} : { executeMany }), commit: async () => undefined, rollback: async () => undefined };
}

function directionOf(bind: unknown): unknown {
  if (bind && typeof bind === "object" && "dir" in bind) return bind.dir;
  return undefined;
}

test("Oracle maps mixed IN/OUT results by physical OUT ordinal", async () => {
  const calls: unknown[][] = [];
  const connection = connectionFor(async (_sql, binds) => {
    calls.push(binds);
    return { outBinds: ["first", "second"] };
  });
  const executor = createOracledbExecutor(connection, { driver });
  const query = sql.call`BEGIN mixed(${1}, ${sql.out("first", oracleParameter.varchar2(32))}, ${2}, ${sql.out("second", oracleParameter.varchar2(32))}); END;`;
  assert.deepEqual(oracleOutputOrdinals(query.render()), [undefined, 0, undefined, 1]);
  const result = await executor.call(query.render());
  assert.deepEqual(result.output, { first: "first", second: "second" });
  assert.deepEqual(calls[0]?.map(directionOf), [undefined, "out", undefined, "out"]);
});

test("Oracle DML RETURNING zips arrays, preserves zero rows, and uses driver rowcount", async () => {
  let next: unknown = { outBinds: [["1", "2"], ["Ada", "Grace"]], rowsAffected: 2 };
  const connection = connectionFor(async () => next);
  const executor = createOracledbExecutor(connection, { driver });
  const returned = sql.rows`UPDATE account SET name = ${"updated"} RETURNING id, name INTO ${sql.out("id", oracleParameter.number())}, ${sql.out("name", oracleParameter.varchar2(32))}`;
  assert.deepEqual(await executor.query(returned.render()), {
    kind: "rows",
    rows: [{ id: "1", name: "Ada" }, { id: "2", name: "Grace" }],
    rowCount: 2,
  });
  next = { outBinds: [[], []], rowsAffected: 0 };
  assert.deepEqual(await executor.query(returned.render()), { kind: "rows", rows: [], rowCount: 0 });
  next = { outBinds: [["1"], []], rowsAffected: 1 };
  await assert.rejects(() => executor.query(returned.render()), /BRAID_RETURNING_LENGTH/u);
});

test("Oracle bulk precomputes one encoded matrix and executes executeMany once", async () => {
  let executions = 0;
  let receivedBinds: unknown;
  let receivedOptions: unknown;
  const connection = connectionFor(
    async () => ({ rowsAffected: 0 }),
    async (_sql, binds, options) => {
      executions += 1;
      receivedBinds = binds;
      receivedOptions = options;
      return { rowsAffected: 2 };
    },
  );
  const executor = createOracledbExecutor(connection, { driver });
  const adapter = executor.statementBinding;
  const statement = sql.command`UPDATE account SET name = ${"first"} WHERE id = ${1}`.render();
  const bulk = createRenderedBulk({ statement, parameterSets: [["Ada", 1], ["Grace", 2]] });
  const binding = adapter.describeBulk!(bulk, { dialectId: "oracle", requestedReuse: "auto" });
  assert.deepEqual(await executor.bulk!(bulk, binding), { inputCount: 2, affectedRows: 2, executionMode: "native-bulk" });
  assert.equal(executions, 1);
  assert.deepEqual(receivedBinds, [["Ada", 1], ["Grace", 2]]);
  let definitions: readonly unknown[] = [];
  if (receivedOptions && typeof receivedOptions === "object" && "bindDefs" in receivedOptions && Array.isArray(receivedOptions.bindDefs)) {
    definitions = receivedOptions.bindDefs;
  }
  const first = definitions[0];
  const second = definitions[1];
  const firstMaxSize = first && typeof first === "object" && "maxSize" in first ? first.maxSize : undefined;
  const secondMaxSize = second && typeof second === "object" && "maxSize" in second ? second.maxSize : undefined;
  assert.equal(firstMaxSize, 5);
  assert.equal(secondMaxSize, undefined);
});

