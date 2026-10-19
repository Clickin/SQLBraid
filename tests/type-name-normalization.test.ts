import assert from "node:assert/strict";
import { test } from "vitest";
import { ResultExactnessError } from "@sqlbraid/core";
import { MARIADB_LOSSLESS_TEXT, MARIADB_NATIVE } from "@sqlbraid/mariadb";
import { MYSQL2_LOSSLESS_TEXT, MYSQL2_NATIVE } from "@sqlbraid/mysql";
import { typePolicy as mssql } from "@sqlbraid/mssql";
import { typePolicy as oracle } from "@sqlbraid/oracle";
import { representationProfiles as pgProfiles } from "@sqlbraid/postgres";

test("Oracle decoder treats canonical and spelled-out type names alike", () => {
  for (const name of ["NUMBER", " number ", "Number"]) {
    assert.equal(oracle.decode(name, "12.50"), "12.50");
    assert.throws(
      () => oracle.decode(name, 1.5),
      (error: unknown) => error instanceof Error,
    );
  }
  assert.equal(oracle.decode("DOUBLE PRECISION", "1.5"), "1.5");
  assert.equal(oracle.decode("double   precision", "1.5"), "1.5");
  assert.equal(oracle.decode("VARCHAR2", 1), 1);
  assert.equal(oracle.decode("constructor", 1), 1);
  assert.equal(oracle.decode("NUMBER", null), null);
});

test("SQL Server decoder treats canonical and spelled-out type names alike", () => {
  for (const name of ["int", " INT ", "Int"]) assert.equal(mssql.decode(name, 5), "5");
  for (const name of ["decimal", " DECIMAL ", "numeric", "Money"]) {
    assert.throws(
      () => mssql.decode(name, 1.5),
      (error: unknown) => error instanceof ResultExactnessError,
    );
  }
  assert.throws(
    () => mssql.decode("float", "x"),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  assert.equal(mssql.decode("nvarchar", "x"), "x");
  assert.equal(mssql.decode("constructor", 1), 1);
  assert.equal(mssql.decode("int", null), null);
  assert.equal(mssql.decode("Int", undefined), undefined);
  assert.throws(
    () => mssql.decode("Decimal", 1),
    (error: unknown) => error instanceof ResultExactnessError && error.message.includes("SQL Server Decimal "),
  );
  assert.throws(
    () => mssql.decode(" Float ", Number.NaN),
    (error: unknown) => error instanceof ResultExactnessError && error.message.includes("SQL Server  Float  "),
  );
});

test("MySQL decoder treats canonical and spelled-out type names alike", () => {
  const text = MYSQL2_LOSSLESS_TEXT.typePolicy;
  const native = MYSQL2_NATIVE.typePolicy;
  for (const name of ["INT", " int ", "Int", "LONGLONG", "bigint"]) assert.equal(text.decode(name, 5), "5");
  for (const name of ["DECIMAL", " decimal ", "NEWDECIMAL"]) {
    assert.throws(
      () => text.decode(name, 1.5),
      (error: unknown) => error instanceof ResultExactnessError,
    );
  }
  for (const name of ["DATETIME", " datetime ", "Timestamp", "DATE"]) {
    assert.throws(
      () => text.decode(name, new Date(0)),
      (error: unknown) => error instanceof ResultExactnessError,
    );
    assert.throws(
      () => native.decode(name, "2026-01-01"),
      (error: unknown) => error instanceof ResultExactnessError,
    );
    assert.equal(text.decode(name, null), null);
    assert.equal(native.decode(name, undefined), undefined);
  }
  assert.throws(
    () => text.decode("json", {}),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  assert.deepEqual(native.decode("json", { a: 1 }), { a: 1 });
  assert.throws(
    () => native.decode(" time ", 1),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  assert.equal(text.decode("VARCHAR", 1), 1);
  assert.equal(text.decode("constructor", 1), 1);
  assert.equal(text.decode("INT", null), null);
});

test("MariaDB decoder treats canonical and spelled-out type names alike", () => {
  const text = MARIADB_LOSSLESS_TEXT.typePolicy;
  const native = MARIADB_NATIVE.typePolicy;
  for (const name of ["INT", " int ", "BIGINT", "bigint"]) assert.equal(text.decode(name, 5), "5");
  for (const name of ["DECIMAL", " decimal "]) {
    assert.throws(
      () => text.decode(name, 1.5),
      (error: unknown) => error instanceof ResultExactnessError,
    );
  }
  for (const name of ["DATETIME", " datetime ", "date"]) {
    assert.throws(
      () => text.decode(name, new Date(0)),
      (error: unknown) => error instanceof ResultExactnessError,
    );
    assert.throws(
      () => native.decode(name, "2026-01-01"),
      (error: unknown) => error instanceof ResultExactnessError,
    );
    assert.equal(text.decode(name, null), null);
  }
  assert.equal(text.decode("VARCHAR", 1), 1);
  assert.equal(text.decode("constructor", 1), 1);
});

test("PostgreSQL decoder treats spelled-out type names alike for every profile", () => {
  const [text, native] = [pgProfiles[0]!.typePolicy, pgProfiles[1]!.typePolicy];
  for (const name of ["int4", " INT4 ", "Int8", "bigint"]) assert.equal(text.decode(name, 5), "5");
  for (const name of ["numeric", " NUMERIC ", "decimal"]) {
    assert.equal(text.decode(name, "1.50"), "1.50");
    assert.throws(
      () => text.decode(name, 1.5),
      (error: unknown) => error instanceof ResultExactnessError,
    );
  }
  assert.throws(
    () => text.decode("money", "$1.00"),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  assert.equal(text.decode("money", null), null);
  for (const name of ["timestamptz", " TIMESTAMPTZ ", "date"]) {
    assert.throws(
      () => text.decode(name, new Date(0)),
      (error: unknown) => error instanceof ResultExactnessError,
    );
    assert.throws(
      () => native.decode(name, "2026-01-01"),
      (error: unknown) => error instanceof ResultExactnessError,
    );
  }
  assert.throws(
    () => text.decode("jsonb", {}),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  assert.deepEqual(native.decode("jsonb", { a: 1 }), { a: 1 });
  assert.equal(text.decode("text", 1), 1);
  assert.equal(text.decode("constructor", 1), 1);
});
