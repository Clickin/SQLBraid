import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertSavepointName,
  createCleanupScope,
  defineResultProperty,
  identityResultValue,
  preparePositionalResultProjector,
  prepareResultProjector,
} from "@sqlbraid/core/driver";

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

test("prepared result projectors keep a safe stable shape and overwrite duplicate slots", () => {
  let reads = 0;
  const projector = prepareResultProjector<readonly unknown[]>([
    { name: "first", read: (values) => ((reads += 1), values[0]) },
    { name: "constructor", read: (values) => ((reads += 1), values[1]) },
    { name: "__proto__", read: (values) => ((reads += 1), values[2]) },
    { name: "prototype", read: (values) => ((reads += 1), values[3]) },
    { name: "2", read: (values) => ((reads += 1), values[4]) },
    { name: "患者🩺", read: (values) => ((reads += 1), values[5]) },
    { name: "duplicate", read: (values) => ((reads += 1), values[6]) },
    { name: "duplicate", read: (values) => ((reads += 1), values[7]) },
    { name: "nullable", read: (values) => ((reads += 1), values[8]) },
  ]);

  const first = projector([
    "one",
    "ctor-one",
    "proto-one",
    "prototype-one",
    "numeric-one",
    "환자",
    "early",
    "late",
    null,
  ]);
  const second = projector([
    "two",
    "ctor-two",
    "proto-two",
    "prototype-two",
    "numeric-two",
    "患者",
    "early-2",
    "late-2",
    null,
  ]);
  const smallProjector = prepareResultProjector<readonly unknown[]>(
    [
      { name: "first", read: (values) => ((reads += 1), values[0]) },
      { name: "constructor", read: (values) => ((reads += 1), values[1]) },
      { name: "__proto__", read: (values) => ((reads += 1), values[2]) },
      { name: "prototype", read: (values) => ((reads += 1), values[3]) },
      { name: "2", read: (values) => ((reads += 1), values[4]) },
      { name: "患者🩺", read: (values) => ((reads += 1), values[5]) },
      { name: "duplicate", read: (values) => ((reads += 1), values[6]) },
      { name: "duplicate", read: (values) => ((reads += 1), values[7]) },
      { name: "nullable", read: (values) => ((reads += 1), values[8]) },
    ],
    1,
  );
  const small = smallProjector([
    "one",
    "ctor-one",
    "proto-one",
    "prototype-one",
    "numeric-one",
    "환자",
    "early",
    "late",
    null,
  ]);

  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.equal(Object.getPrototypeOf(small), Object.prototype);
  assert.deepEqual(Object.keys(first), [
    "2",
    "first",
    "constructor",
    "__proto__",
    "prototype",
    "患者🩺",
    "duplicate",
    "nullable",
  ]);
  assert.deepEqual(Object.keys(second), Object.keys(first));
  assert.deepEqual(Object.keys(small), Object.keys(first));
  assert.equal(small["__proto__"], "proto-one");
  assert.equal(small.constructor, "ctor-one");
  assert.equal(small["患者🩺"], "환자");
  assert.equal(first.first, "one");
  assert.equal(first.constructor, "ctor-one");
  assert.equal(first["__proto__"], "proto-one");
  assert.equal(first.prototype, "prototype-one");
  assert.equal(first["2"], "numeric-one");
  assert.equal(first["患者🩺"], "환자");
  assert.equal(first.duplicate, "late");
  assert.equal(first.nullable, null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(first, "__proto__"), {
    configurable: true,
    enumerable: true,
    value: "proto-one",
    writable: true,
  });
  assert.equal(reads, 27);
});

test("positional result projectors preserve labels and property order for every row", () => {
  const projector = preparePositionalResultProjector(
    [
      { name: "__proto__", index: 0, decode: identityResultValue },
      { name: "constructor", index: 1, decode: identityResultValue },
      { name: "prototype", index: 2, decode: identityResultValue },
      { name: "hasOwnProperty", index: 3, decode: identityResultValue },
      { name: "toString", index: 4, decode: identityResultValue },
      { name: "0", index: 5, decode: identityResultValue },
      { name: "01", index: 6, decode: identityResultValue },
      { name: "한글", index: 7, decode: identityResultValue },
      { name: "😀", index: 8, decode: identityResultValue },
      { name: "nullable", index: 9, decode: identityResultValue },
    ],
    2,
  );
  const first = projector([
    "proto-1",
    "ctor-1",
    "prototype-1",
    "own-1",
    "string-1",
    "zero-1",
    "leading-1",
    "한-1",
    "emoji-1",
    null,
  ]);
  const second = projector([
    "proto-2",
    "ctor-2",
    "prototype-2",
    "own-2",
    "string-2",
    "zero-2",
    "leading-2",
    "한-2",
    "emoji-2",
    null,
  ]);

  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.deepEqual(Object.keys(second), Object.keys(first));
  assert.deepEqual(Object.keys(first), [
    "0",
    "__proto__",
    "constructor",
    "prototype",
    "hasOwnProperty",
    "toString",
    "01",
    "한글",
    "😀",
    "nullable",
  ]);
  assert.equal(Object.getOwnPropertyDescriptor(first, "__proto__")?.value, "proto-1");
  assert.equal(first.constructor, "ctor-1");
  assert.equal(first.hasOwnProperty, "own-1");
  assert.equal(first.toString, "string-1");
  assert.equal(first.nullable, null);
});

test("single-row positional projection treats __proto__ as row data", () => {
  const project = preparePositionalResultProjector([{ name: "__proto__", index: 0, decode: identityResultValue }], 1);
  const row = project(["safe"]);
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.hasOwn(row, "__proto__"), true);
  assert.equal(row["__proto__"], "safe");
});

test("savepoint names accept runtime-generated grammar and reject SQL syntax", () => {
  for (const name of ["braid_sp_1", "braid_sp_abc_2", "_savepoint", "A1"]) {
    assert.equal(assertSavepointName(name), name);
  }
  for (const name of ["", " ", "a;b", "a'b", 'a"b', "-- comment", "/* comment */", "a\nb", "a\tb"]) {
    assert.throws(() => assertSavepointName(name), TypeError);
  }
});
