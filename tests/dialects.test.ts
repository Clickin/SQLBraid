import assert from "node:assert/strict";
import { test } from "vitest";
import { parameterizedSql } from "@sqlbraid/core";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as sqlite } from "@sqlbraid/sqlite";

test("dialects own identifier rendering while transports own placeholders", () => {
  const pg = postgres`SELECT ${1}, ${2}`.render();
  assert.deepEqual(pg.segments, ["SELECT ", ", ", ""]);
  assert.deepEqual(
    pg.parameters.map(({ value }) => value),
    [1, 2],
  );
  assert.equal(
    parameterizedSql(pg, (index) => `$${index}`),
    "SELECT $1, $2",
  );
  const my = mysql`SELECT ${1}, ${2}`.render();
  assert.deepEqual(my.segments, ["SELECT ", ", ", ""]);
  assert.deepEqual(
    my.parameters.map(({ value }) => value),
    [1, 2],
  );
  assert.equal(
    parameterizedSql(my, () => "?"),
    "SELECT ?, ?",
  );
  const sq = sqlite`SELECT ${1}`.render();
  assert.deepEqual(sq.segments, ["SELECT ", ""]);
  assert.deepEqual(
    sq.parameters.map(({ value }) => value),
    [1],
  );
  assert.equal(
    parameterizedSql(sq, () => "?"),
    "SELECT ?",
  );
  assert.deepEqual(mysql`SELECT ${mysql.ident("a`b")}`.render().segments, ["SELECT `a``b`"]);
});
