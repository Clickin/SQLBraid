import assert from "node:assert/strict";
import { test } from "vitest";
import { discoverQueries } from "@sqlbraid/compiler";
import { sql as mssql } from "@sqlbraid/mssql";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as oracle } from "@sqlbraid/oracle";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as sqlite } from "@sqlbraid/sqlite";
import { hasSqlKeyword, LEXICAL_PROFILES } from "../packages/bun-sql/src/lexical.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

test("trim keeps a PostgreSQL standard string that ends in a backslash", () => {
  assert.equal(
    postgres`UPDATE t /*@braid set*/ path = 'C:\\', /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET path = 'C:\\' WHERE id = 1",
  );
});

test("trim reads a PostgreSQL dollar-quoted string as one token", () => {
  assert.equal(
    postgres`UPDATE t /*@braid set*/ note = $$it's$$, /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET note = $$it's$$ WHERE id = 1",
  );
  assert.equal(
    postgres`UPDATE t /*@braid set*/ note = $tag$a,$tag$, /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET note = $tag$a,$tag$ WHERE id = 1",
  );
});

test("trim reads a SQL Server bracket identifier as one token", () => {
  assert.equal(
    mssql`UPDATE t /*@braid set*/ [it's] = 1, /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET [it's] = 1 WHERE id = 1",
  );
});

test("trim reads an Oracle q-quote as one token", () => {
  assert.equal(
    oracle`UPDATE t /*@braid set*/ note = q'[it's]', /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET note = q'[it's]' WHERE id = 1",
  );
});

test("trim keeps backslash escapes where the dialect has them", () => {
  assert.equal(
    mysql`UPDATE t /*@braid set*/ note = 'it\\'s', /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET note = 'it\\'s' WHERE id = 1",
  );
  assert.equal(
    postgres`UPDATE t /*@braid set*/ note = E'it\\'s', /*@braid end*/ WHERE id = 1`.render().segments.join(""),
    "UPDATE t SET note = E'it\\'s' WHERE id = 1",
  );
});

test("a PostgreSQL escape string hides a directive marker after an escaped quote", () => {
  assert.equal(
    postgres`SELECT E'it\\'s /*@braid where*/' AS marker`.render().segments.join(""),
    "SELECT E'it\\'s /*@braid where*/' AS marker",
  );
});

test("a PostgreSQL escape string rejects an interpolation after an escaped quote", () => {
  const value = 1;
  assert.throws(() => postgres`SELECT E'a\\' ${value} b'`.render(), hasCode("BRAID_HOLE_CONTEXT"));
});

test("the compiler reports the same escape string context", () => {
  const parsed = discoverQueries(
    "import {sql} from '@sqlbraid/postgres'; const value = 1; const q=sql`SELECT E'a\\\\' ${value} b'`;",
    "fixture.ts",
    { moduleSpecifier: "@sqlbraid/postgres" },
  );
  assert.equal(parsed.diagnostics[0]?.code, "BRAID_HOLE_CONTEXT");
});

test("an E before a quote starts an escape string only as its own token", () => {
  const value = 1;
  assert.deepEqual(postgres`SELECT xe'a\\' , ${value}`.render().parameters.length, 1);
});

test("other dialects keep their handling of E before a quote", () => {
  const value = 1;
  assert.equal(mssql`SELECT E'a\\' , ${value}`.render().parameters.length, 1);
  assert.equal(sqlite`SELECT E'a\\' , ${value}`.render().parameters.length, 1);
});

test("Bun.SQL keyword detection skips a PostgreSQL escape string", () => {
  assert.equal(hasSqlKeyword("UPDATE t SET a = E'it\\'s RETURNING x'", "RETURNING", LEXICAL_PROFILES.postgres), false);
  assert.equal(hasSqlKeyword("UPDATE t SET a = 'C:\\' RETURNING x", "RETURNING", LEXICAL_PROFILES.postgres), true);
});
