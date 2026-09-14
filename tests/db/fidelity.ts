import assert from "node:assert/strict";
import type { TypePolicy } from "@sqlbraid/core";

export function assertRepresentationConformance(
  raw: unknown,
  expectedRaw: unknown,
  canonical: unknown,
  expectedCanonical: unknown,
  policy: TypePolicy,
  databaseType: string,
  outputType: string,
): void {
  assert.deepEqual(raw, expectedRaw, "Driver raw carrier/value differs from the fixture.");
  assert.deepEqual(canonical, expectedCanonical, "Canonical value differs from the representation contract.");
  assert.equal(policy.mappings.find(mapping => mapping.databaseType === databaseType)?.outputType, outputType);
}

export const exactJsonText = '{"small":42,"largeInteger":9223372036854775807,"highPrecision":12345678901234567890.12345678901234567890,"nested":{"array":[9007199254740993,0.1000000000000000000001]}}';

export const binary64Finite = [0, -0, 0.1, 1.2345678901234567, 2 ** -1022, Number.MAX_VALUE, Number.MIN_VALUE, 1.0000000000000002] as const;
export const binary32Finite = [0, -0, Math.fround(0.1), Math.fround(1.234567), 2 ** -126, Math.fround(3.4028234663852886e38), 2 ** -149, Math.fround(1.0000001192092896)] as const;

export function assertFloatBits(actual: unknown, expected: number, precision: 32 | 64): void {
  assert.equal(typeof actual, "number");
  if (typeof actual !== "number") throw new TypeError("Expected a binary floating-point result.");
  if (Number.isNaN(expected)) {
    assert.ok(Number.isNaN(actual), "NaN must remain NaN (payload is not an application contract).");
    return;
  }
  const buffer = new DataView(new ArrayBuffer(16));
  if (precision === 32) {
    assert.ok(Object.is(actual, Math.fround(actual)), "binary32 must widen exactly to a JavaScript Number");
    buffer.setFloat32(0, actual);
    buffer.setFloat32(4, expected);
    assert.equal(buffer.getUint32(0), buffer.getUint32(4), "binary32 transport changed the stored value");
  } else {
    buffer.setFloat64(0, actual);
    buffer.setFloat64(8, expected);
    assert.equal(buffer.getBigUint64(0), buffer.getBigUint64(8), "binary64 transport changed the stored value");
  }
}
