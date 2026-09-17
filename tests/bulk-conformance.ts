import type { BulkResult, CommandQuery, Database } from "@sqlbraid/core";
import { assert } from "./certification/assert.js";

export interface BulkConformanceFixture<Input> {
  readonly db: Pick<Database, "bulk">;
  readonly inputs: readonly Input[];
  readonly factory: (input: Input, index: number) => CommandQuery;
  readonly expected: BulkResult;
  readonly acquireCount?: () => number;
  readonly executeCount?: () => number;
  readonly values?: () => readonly (readonly unknown[])[];
  readonly middleFailure?: () => Promise<BulkFailureEvidence | unknown>;
  readonly close?: () => void | Promise<void>;
}

export interface BulkFailureEvidence {
  readonly error: unknown;
  readonly observedRows: readonly unknown[];
  readonly expectedRows: readonly unknown[];
  readonly durability: "prefix" | "atomic";
}

export async function runBulkConformanceCase(
  id: "BULK001" | "BULK002" | "BULK003",
  fixtureOrCreate: BulkConformanceFixture<unknown> | (() => BulkConformanceFixture<unknown> | Promise<BulkConformanceFixture<unknown>>),
): Promise<void> {
  const fixture = typeof fixtureOrCreate === "function" ? await fixtureOrCreate() : fixtureOrCreate;
  const acquireBefore = fixture.acquireCount?.() ?? 0;
  const executeBefore = fixture.executeCount?.() ?? 0;
  const emptyResult = await fixture.db.bulk([], () => fixture.factory(fixture.inputs[0]!, 0));
  assert.deepEqual(emptyResult, { inputCount: 0, affectedRows: 0 });
  assert.equal((fixture.acquireCount?.() ?? acquireBefore) - acquireBefore, 0);
  assert.equal((fixture.executeCount?.() ?? executeBefore) - executeBefore, 0);
  if (id === "BULK001") return;

  assert.deepEqual(await fixture.db.bulk(fixture.inputs, fixture.factory), fixture.expected);
  assert.equal((fixture.acquireCount?.() ?? acquireBefore) - acquireBefore, 1);
  assert.equal((fixture.executeCount?.() ?? executeBefore) - executeBefore, 1);
  if (fixture.values) assert.equal(fixture.values().length, fixture.inputs.length);
  if (id === "BULK003") {
    const middleFailure = fixture.middleFailure;
    if (!middleFailure) throw new Error("BULK003 requires middleFailure fixture evidence.");
    const evidence = await middleFailure();
    assert.ok(evidence !== null && typeof evidence === "object", "BULK003 must expose native middle-item evidence.");
    const proof = evidence as Partial<BulkFailureEvidence>;
    assert.ok(proof.error !== undefined, "BULK003 must expose the native middle-item failure.");
    assert.ok(Array.isArray(proof.observedRows), "BULK003 must expose observed durable rows.");
    assert.ok(Array.isArray(proof.expectedRows), "BULK003 must expose expected durable rows.");
    assert.deepEqual(proof.observedRows, proof.expectedRows, "BULK003 observed durable rows differ from the declared native outcome.");
    if (proof.durability === "atomic") assert.equal(proof.expectedRows.length, 0);
    else {
      assert.equal(proof.durability, "prefix");
      assert.ok(proof.expectedRows.length > 0, "BULK003 prefix durability requires a non-empty committed prefix.");
    }
  }
}

export async function runBulkConformance<Input>(
  create: () => BulkConformanceFixture<Input> | Promise<BulkConformanceFixture<Input>>,
): Promise<void> {
  const fixture = await create();
  try {
    await runBulkConformanceCase("BULK002", fixture as unknown as BulkConformanceFixture<unknown>);
  } finally {
    await fixture.close?.();
  }
}
