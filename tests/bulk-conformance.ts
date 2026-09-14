import assert from "node:assert/strict";
import type { BulkResult, CommandQuery, Database } from "@sqlbraid/core";

export interface BulkConformanceFixture<Input> {
  readonly db: Pick<Database, "bulk">;
  readonly inputs: readonly Input[];
  readonly factory: (input: Input, index: number) => CommandQuery;
  readonly expected: BulkResult;
  readonly acquireCount?: () => number;
  readonly executeCount?: () => number;
  readonly values?: () => readonly (readonly unknown[])[];
  readonly close?: () => void | Promise<void>;
}

export async function runBulkConformance<Input>(
  create: () => BulkConformanceFixture<Input> | Promise<BulkConformanceFixture<Input>>,
): Promise<void> {
  const empty = await create();
  try {
    let invoked = false;
    const result = await empty.db.bulk([], () => {
      invoked = true;
      return empty.factory(empty.inputs[0]!, 0);
    });
    assert.deepEqual(result, { inputCount: 0, affectedRows: 0 });
    assert.equal(invoked, false);
    assert.equal(empty.acquireCount?.(), 0);
    assert.equal(empty.executeCount?.(), 0);
  } finally {
    await empty.close?.();
  }

  const fixture = await create();
  try {
    assert.deepEqual(await fixture.db.bulk(fixture.inputs, fixture.factory), fixture.expected);
    assert.equal(fixture.acquireCount?.(), 1);
    assert.equal(fixture.executeCount?.(), 1);
    if (fixture.values !== undefined) {
      assert.equal(fixture.values().length, fixture.inputs.length);
    }
  } finally {
    await fixture.close?.();
  }
}
