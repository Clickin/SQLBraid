export class CertificationAssertionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CertificationAssertionError";
  }
}

function fail(message: string): never {
  throw new CertificationAssertionError(message);
}

function equalValues(actual: unknown, expected: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false;
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.constructor !== expected.constructor) return false;
    if (actual.byteLength !== expected.byteLength) return false;
    const left = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
    const right = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
    return left.every((value, index) => value === right[index]);
  }
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) return false;
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && Object.is(actual.getTime(), expected.getTime());
  }
  const prior = seen.get(actual);
  if (prior === expected) return true;
  seen.set(actual, expected);
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (
    !Array.isArray(actual) &&
    Object.getPrototypeOf(actual) !== Object.prototype &&
    Object.getPrototypeOf(actual) !== null
  )
    return false;
  const leftKeys = Object.keys(actual);
  const rightKeys = Object.keys(expected);
  if (Array.isArray(actual) && actual.length !== (expected as unknown[]).length) return false;
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.hasOwn(expected, key))) return false;
  return leftKeys.every((key) =>
    equalValues((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], seen),
  );
}

interface CertificationAssert {
  ok(value: unknown, message?: string): asserts value;
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  rejects(operation: () => unknown | Promise<unknown>, predicate?: (error: unknown) => boolean | void): Promise<void>;
}

export const assert: CertificationAssert = Object.freeze({
  ok(value: unknown, message = "Expected a truthy value."): asserts value {
    if (!value) fail(message);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) fail(message ?? `Expected ${String(actual)} to equal ${String(expected)}.`);
  },
  notEqual(actual: unknown, expected: unknown, message?: string): void {
    if (Object.is(actual, expected)) fail(message ?? `Expected ${String(actual)} not to equal ${String(expected)}.`);
  },
  deepEqual(actual: unknown, expected: unknown, message = "Values are not deeply equal."): void {
    if (!equalValues(actual, expected)) fail(message);
  },
  async rejects(
    operation: () => unknown | Promise<unknown>,
    predicate?: (error: unknown) => boolean | void,
  ): Promise<void> {
    let rejected = false;
    try {
      await operation();
    } catch (error) {
      rejected = true;
      if (predicate && predicate(error) === false) fail("Rejected with an unexpected error.");
    }
    if (!rejected) fail("Expected operation to reject.");
  },
});
