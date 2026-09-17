import assert from "node:assert/strict";
import { test } from "vitest";
import { createStatementBindingDescription, ResultExactnessError } from "@sqlbraid/core";
import type {
  DatabaseEnvironment,
  DriverRoutineResult,
  EnvironmentSupportTarget,
  QueryExecutionResult,
  QueryExecutor,
  StatementBindingAdapter,
} from "@sqlbraid/core";
import { sql } from "@sqlbraid/template";
import { createDatabase } from "@sqlbraid/runtime";

const statementBinding = Object.freeze<StatementBindingAdapter>({
  id: "pv18-command-metadata-test",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "pv18-command-metadata-test",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});

function commandExecutor(
  command: Record<string, unknown>,
  environment?: QueryExecutor["environment"],
  rowCount?: number,
): QueryExecutor {
  return {
    statementBinding,
    environment,
    async query<Row>(): Promise<QueryExecutionResult<Row>> {
      return {
        kind: "command",
        rows: [],
        command: command as never,
        ...(rowCount === undefined ? {} : { rowCount }),
      };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("BRAID_STREAM_UNSUPPORTED");
    },
    async call(): Promise<DriverRoutineResult> {
      throw new Error("BRAID_CALL_UNSUPPORTED");
    },
  };
}

test("command insertId is an exact string at the public boundary", async () => {
  const db = createDatabase(commandExecutor({ insertId: "9007199254740993" }));
  const result = await db.execute(sql.command`INSERT INTO records DEFAULT VALUES`);
  assert.equal(result.command.insertId, "9007199254740993");
});

test.each([
  ["unsafe Number", Number.MAX_SAFE_INTEGER + 1],
  ["bigint", 1n],
] as const)("command insertId rejects %s with stable exactness semantics", async (_label, insertId) => {
  const db = createDatabase(commandExecutor({ insertId }));
  await assert.rejects(
    () => db.execute(sql.command`INSERT INTO records DEFAULT VALUES`),
    (error: unknown) =>
      error instanceof ResultExactnessError &&
      error.code === "BRAID_RESULT_EXACTNESS" &&
      error.message === "Database insertId must be represented as an exact string.",
  );
});

test("command metadata keeps non-negative safe count checks", async () => {
  const valid = createDatabase(commandExecutor({ affectedRows: 2 }, undefined, 2));
  const result = await valid.execute(sql.command`UPDATE records SET active = TRUE`);
  assert.equal(result.command.affectedRows, 2);
  assert.equal(result.rowCount, 2);

  for (const [command, rowCount] of [
    [{ affectedRows: -1 }, undefined],
    [{ affectedRows: Number.MAX_SAFE_INTEGER + 1 }, undefined],
    [{}, -1],
    [{}, Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    const db = createDatabase(commandExecutor(command, undefined, rowCount));
    await assert.rejects(
      () => db.execute(sql.command`UPDATE records SET active = TRUE`),
      (error: unknown) => error instanceof ResultExactnessError && error.code === "BRAID_RESULT_EXACTNESS",
    );
  }
});

function exactTarget(environment: DatabaseEnvironment, typePolicy = environment.typePolicy): EnvironmentSupportTarget {
  const databaseVersion = environment.database.version;
  const databaseEdition = environment.database.edition;
  const driverVersion = environment.driver.version;
  const driverProfile = environment.driver.profile;
  const runtimeVersion = environment.runtime.version;
  assert.ok(databaseVersion);
  assert.ok(databaseEdition);
  assert.ok(driverVersion);
  assert.ok(driverProfile);
  assert.ok(runtimeVersion);
  assert.ok(typePolicy);
  return {
    id: "pv18-command-metadata-target",
    status: "official",
    database: {
      product: environment.database.product,
      version: databaseVersion,
      edition: databaseEdition,
    },
    driver: {
      id: environment.driver.id,
      version: driverVersion,
      profile: driverProfile,
    },
    runtime: {
      id: environment.runtime.id,
      version: runtimeVersion,
    },
    typePolicy,
    evidence: { status: "verified" },
  };
}

test("environment snapshots freeze policy identity and reject incomplete certification targets", async () => {
  const sourcePolicy = { id: "pv18-test-policy", hash: "pv18-test-policy-hash" };
  const db = createDatabase(
    commandExecutor(
      {},
      {
        database: { product: "pv18-test-db", version: "1", edition: "community" },
        driver: { id: "pv18-test-driver", version: "1", profile: "lossless-text" },
        typePolicy: sourcePolicy,
        capabilities: {},
      },
    ),
  );
  const environment = await db.environment();
  assert.deepEqual(environment.typePolicy, {
    id: "pv18-test-policy",
    hash: "pv18-test-policy-hash",
  });
  assert.ok(environment.typePolicy);
  assert.equal(Object.isFrozen(environment.typePolicy), true);
  sourcePolicy.id = "mutated-policy";
  assert.equal(environment.typePolicy.id, "pv18-test-policy");

  const target = exactTarget(environment);
  assert.equal((await db.environment({ targets: [target] })).supportMatch.status, "official");
  const { typePolicy: _ignoredTypePolicy, ...incompleteTarget } = target;
  // @ts-expect-error A JavaScript caller may omit the required policy identity.
  assert.equal((await db.environment({ targets: [incompleteTarget] })).supportMatch.status, "compatible");
  assert.equal(
    (
      await db.environment({
        targets: [{ ...target, typePolicy: { id: "wrong-policy", hash: "wrong-hash" } }],
      })
    ).supportMatch.status,
    "compatible",
  );
});
