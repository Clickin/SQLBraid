import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeExactDecimal,
  decodeExactInteger,
  ResultExactnessError,
} from "@sqlbraid/core";
import { typePolicy as mariaDbTypePolicy } from "@sqlbraid/mariadb";
import { typePolicy as mssqlTypePolicy } from "@sqlbraid/mssql";
import { typePolicy as mysqlTypePolicy } from "@sqlbraid/mysql";
import { typePolicy as oracleTypePolicy } from "@sqlbraid/oracle";
import { typePolicy as postgresTypePolicy } from "@sqlbraid/postgres";
import { typePolicyForIntegerMode } from "@sqlbraid/sqlite";

function assertExactnessFailure(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof ResultExactnessError
    && error.code === "BRAID_RESULT_EXACTNESS");
}

test("exact integer decoding accepts only lossless representations and enforces bounds", () => {
  assert.equal(decodeExactInteger(0), 0n);
  assert.equal(decodeExactInteger("+9223372036854775807"), 9223372036854775807n);
  assert.equal(decodeExactInteger(-9007199254740991), -9007199254740991n);
  assert.equal(decodeExactInteger("42", { min: 42n, max: 42n }), 42n);

  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1.0", {}, null]) {
    assertExactnessFailure(() => decodeExactInteger(value));
  }
  assertExactnessFailure(() => decodeExactInteger("41", { min: 42n }));
  assertExactnessFailure(() => decodeExactInteger("43", { max: 42n }));
  assert.throws(() => decodeExactInteger(1, { min: 2n, max: 1n }), TypeError);
});

test("exact decimal decoding never performs a Number round trip", () => {
  assert.equal(decodeExactDecimal("123.4500"), "123.4500");
  assert.equal(decodeExactDecimal(123n, { allowBigInt: true }), "123");
  assertExactnessFailure(() => decodeExactDecimal(123n));
  assertExactnessFailure(() => decodeExactDecimal(0.1));
  assertExactnessFailure(() => decodeExactDecimal(Number.NaN));
  assertExactnessFailure(() => decodeExactDecimal(null));
});

test("first-party exact numeric policies reject unsafe raw values instead of stringifying them", () => {
  for (const [policy, databaseType] of [
    [postgresTypePolicy, "int8"],
    [mysqlTypePolicy, "BIGINT"],
    [mariaDbTypePolicy, "BIGINT"],
    [mssqlTypePolicy, "bigint"],
  ] as const) {
    assert.equal(policy.decode(databaseType, "9223372036854775807"), 9223372036854775807n);
    assertExactnessFailure(() => policy.decode(databaseType, Number.MAX_SAFE_INTEGER + 1));
  }
  for (const [policy, databaseType] of [
    [postgresTypePolicy, "numeric"],
    [mysqlTypePolicy, "DECIMAL"],
    [mariaDbTypePolicy, "DECIMAL"],
    [oracleTypePolicy, "NUMBER"],
  ] as const) {
    assert.equal(policy.decode(databaseType, "12345678901234567890.1234"), "12345678901234567890.1234");
    assertExactnessFailure(() => policy.decode(databaseType, 1234567890123456.75));
  }
  assert.equal(mssqlTypePolicy.decode("decimal", 12.5), 12.5);
});

test("SQLite integer mode makes its exactness boundary explicit", () => {
  assert.equal(typePolicyForIntegerMode("bigint").decode("INTEGER", "9223372036854775807"), 9223372036854775807n);
  assert.equal(typePolicyForIntegerMode("number").decode("INTEGER", 42n), 42);
  assertExactnessFailure(() => typePolicyForIntegerMode("number").decode("INTEGER", 9007199254740992n));
  assert.equal(typePolicyForIntegerMode("number").decode("INTEGER", "9007199254740991"), Number.MAX_SAFE_INTEGER);
});
