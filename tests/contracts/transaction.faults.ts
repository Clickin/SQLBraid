import assert from "node:assert/strict";
import { test } from "vitest";
import type { Database } from "@sqlbraid/core";

export type Control = "begin" | "commit" | "rollback" | "savepoint" | "rollback-to" | "release-savepoint";
export type Fault = Exclude<Control, "begin">;

/** Only the native driver boundary is fake: Database, adapter and runtime are real. */
export interface TransactionFaultHarness {
  readonly db: Database;
  readonly pooled: boolean;
  readonly calls: Control[];
  readonly failure: Error;
  readonly releases: boolean[];
  fail(control: Fault): void;
  write(db: Database): Promise<unknown>;
}

function includesError(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (!(error instanceof Error)) return false;
  return (
    includesError(error.cause, expected) ||
    (error instanceof AggregateError && error.errors.some((entry: unknown) => includesError(entry, expected)))
  );
}

export async function assertUnusable(harness: TransactionFaultHarness): Promise<void> {
  if (harness.pooled) {
    assert.deepEqual(harness.releases, [true], "uncertain physical lease must be discarded exactly once");
  } else {
    const before = [...harness.calls];
    await assert.rejects(
      () => harness.write(harness.db),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_CONNECTION_POISONED",
    );
    await assert.rejects(
      () => harness.db.tx(async () => "must not run"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_CONNECTION_POISONED",
    );
    assert.deepEqual(harness.calls, before, "poisoned resource must not reach native control I/O");
  }
}

export async function assertControlFailure(harness: TransactionFaultHarness, fault: Fault): Promise<void> {
  const original = new Error("original callback failure");
  let nestedEntered = false;
  let nestedFailure: unknown;
  harness.fail(fault);
  await assert.rejects(
    () =>
      harness.db.tx(async (tx) => {
        await harness.write(tx);
        if (fault === "rollback") throw original;
        if (fault === "commit") return "callback-success";
        try {
          await tx.tx(async (nested) => {
            nestedEntered = true;
            await harness.write(nested);
            if (fault === "rollback-to") throw original;
            return "nested-success";
          });
        } catch (error) {
          nestedFailure = error;
        }
        // Deliberately catch the nested rejection: uncertain recovery must still
        // prevent the enclosing callback's apparent success from committing.
        return "outer-success";
      }),
    (error: unknown) => {
      assert.ok(includesError(error, harness.failure), "native control failure must survive wrapping");
      if (fault === "rollback" || fault === "rollback-to") {
        assert.ok(includesError(error, original), "original failure must survive cleanup failure");
      }
      return true;
    },
  );
  assert.equal(harness.calls.filter((entry) => entry === fault).length, 1, "never retry uncertain controls");
  assert.equal(harness.calls.filter((entry) => entry === "commit").length, fault === "commit" ? 1 : 0);
  if (fault === "savepoint") assert.equal(nestedEntered, false, "failed savepoint cannot run its callback");
  if (fault === "savepoint" || fault === "rollback-to" || fault === "release-savepoint") {
    assert.ok(includesError(nestedFailure, harness.failure), "nested boundary cannot claim successful recovery");
  }
  if (fault === "rollback-to") assert.ok(includesError(nestedFailure, original));
  await assertUnusable(harness);
}

export function transactionFaultContracts(
  transport: string,
  ownership: "direct" | "pooled",
  create: () => TransactionFaultHarness,
  releaseSavepoint = true,
): void {
  const scenarios: readonly (readonly [Fault, string])[] = [
    ["commit", "transaction.commit-failure"],
    ["rollback", "transaction.rollback-failure"],
    ["savepoint", "transaction.savepoint-create-failure"],
    ["rollback-to", "transaction.savepoint-rollback-failure"],
    ...(releaseSavepoint ? [["release-savepoint", "transaction.savepoint-release-failure"] as const] : []),
  ];
  for (const [fault, scenario] of scenarios) {
    test(`[contract:${transport}:${scenario}:boundary] [ownership:${ownership}] preserves errors and rejects uncertain state`, async () => {
      await assertControlFailure(create(), fault);
    });
  }
  test(`${transport} ${ownership} successful savepoint recovery remains usable and commits once`, async () => {
    const harness = create();
    const original = new Error("recoverable nested callback");
    const result = await harness.db.tx(async (tx) => {
      await harness.write(tx);
      await assert.rejects(
        () =>
          tx.tx(async (nested) => {
            await harness.write(nested);
            throw original;
          }),
        (error: unknown) => error === original,
      );
      await harness.write(tx);
      return "committed";
    });
    assert.equal(result, "committed");
    assert.equal(harness.calls.filter((entry) => entry === "commit").length, 1);
    assert.equal(harness.calls.filter((entry) => entry === "rollback-to").length, 1);
    if (harness.pooled) assert.deepEqual(harness.releases, [false]);
    else await harness.write(harness.db);
  });
}
