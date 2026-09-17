import assert from "node:assert/strict";
import { test } from "vitest";
import { assertSavepointName, createCleanupScope, defineResultProperty } from "@sqlbraid/core/driver";

test("cleanup scope is a no-op without registered actions", () => {
  const scope = createCleanupScope();
  assert.doesNotThrow(() => scope.run());
  assert.doesNotThrow(() => scope.run());
});

test("cleanup scope runs actions exactly once in LIFO order", () => {
  const events: string[] = [];
  const scope = createCleanupScope();
  scope.add(() => {
    events.push("first");
  });
  scope.add(() => {
    events.push("second");
  });

  scope.run();
  scope.run();

  assert.deepEqual(events, ["second", "first"]);
});

test("cleanup scope disarm transfers ownership without running actions", () => {
  let count = 0;
  const scope = createCleanupScope();
  scope.add(() => {
    count += 1;
  });
  scope.disarm();
  scope.run();
  assert.equal(count, 0);
});

test("cleanup scope preserves a primary failure when cleanup succeeds", () => {
  const primary = new Error("primary");
  const scope = createCleanupScope();
  scope.add(() => undefined);
  assert.throws(
    () => scope.run(primary),
    (error: unknown) => error === primary,
  );
});

test("cleanup scope wraps a cleanup-only failure with the canonical code", () => {
  const cleanup = new Error("cleanup");
  const scope = createCleanupScope();
  scope.add(() => {
    throw cleanup;
  });

  assert.throws(
    () => scope.run(),
    (error: unknown) =>
      error instanceof Error &&
      error !== cleanup &&
      "code" in error &&
      error.code === "BRAID_RESOURCE_CLEANUP" &&
      error.cause === cleanup,
  );
});

test("cleanup scope aggregates one cleanup failure with the primary failure", () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  const scope = createCleanupScope();
  scope.add(() => {
    throw cleanup;
  });

  assert.throws(
    () => scope.run(primary),
    (error: unknown) =>
      error instanceof AggregateError &&
      "code" in error &&
      error.code === "BRAID_RESOURCE_CLEANUP" &&
      error.errors.length === 2 &&
      error.errors[0] === primary &&
      error.errors[1] === cleanup,
  );
});

test("cleanup scope aggregates primary and all cleanup failures in LIFO order", async () => {
  const primary = new Error("primary");
  const first = new Error("first");
  const second = new Error("second");
  const scope = createCleanupScope();
  scope.add(() => {
    throw first;
  });
  scope.add(async () => {
    throw second;
  });

  await assert.rejects(
    async () => {
      await scope.run(primary);
    },
    (error: unknown) =>
      error instanceof AggregateError &&
      "code" in error &&
      error.code === "BRAID_RESOURCE_CLEANUP" &&
      error.errors[0] === primary &&
      error.errors[1] === second &&
      error.errors[2] === first,
  );
});

test("cleanup scope treats a thenable inspection throw as cleanup failure and continues LIFO cleanup", () => {
  const primary = new Error("primary");
  const inspected = new Error("then getter");
  const events: string[] = [];
  const scope = createCleanupScope();
  scope.add(() => {
    events.push("oldest");
  });
  scope.add(
    () =>
      ({
        get then(): never {
          throw inspected;
        },
      }) as PromiseLike<void>,
  );

  assert.throws(
    () => scope.run(primary),
    (error: unknown) =>
      error instanceof AggregateError &&
      "code" in error &&
      error.code === "BRAID_RESOURCE_CLEANUP" &&
      error.errors[0] === primary &&
      error.errors[1] === inspected,
  );
  assert.deepEqual(events, ["oldest"]);
});

test("cleanup scope cannot rerun after an asynchronous failure path", async () => {
  let count = 0;
  const scope = createCleanupScope();
  scope.add(async () => {
    count += 1;
    throw new Error("cleanup");
  });

  await assert.rejects(async () => {
    await scope.run();
  });
  assert.doesNotThrow(() => scope.run());
  assert.equal(count, 1);
});

test("repeated run calls share the in-flight cleanup completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const scope = createCleanupScope();
  scope.add(async () => {
    count += 1;
    await gate;
  });

  const first = scope.run();
  const second = scope.run();
  assert.ok(first instanceof Promise);
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test("result properties remain own enumerable properties on ordinary objects", () => {
  const row: Record<string, unknown> = {};
  for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
    defineResultProperty(row, key, key);
  }

  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
    assert.equal(Object.hasOwn(row, key), true);
    assert.equal(row[key], key);
    assert.equal(Object.getOwnPropertyDescriptor(row, key)?.enumerable, true);
  }
});

test("savepoint names accept runtime-generated grammar and reject SQL syntax", () => {
  for (const name of ["braid_sp_1", "braid_sp_abc_2", "_savepoint", "A1"]) {
    assert.equal(assertSavepointName(name), name);
  }
  for (const name of ["", " ", "a;b", "a'b", 'a"b', "-- comment", "/* comment */", "a\nb", "a\tb"]) {
    assert.throws(() => assertSavepointName(name), TypeError);
  }
});
