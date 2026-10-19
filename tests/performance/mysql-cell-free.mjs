// Alternates a baseline build (tests/performance/.builds/mysql-baseline/mysql) and the current build with a fake mysql2 connection that returns 10,000 rows.
import { createRenderedStatement } from "@sqlbraid/core";
import * as next from "@sqlbraid/mysql";
import * as nextAdapter from "@sqlbraid/mysql/mysql2";
import * as baseAdapter from "./.builds/mysql-baseline/mysql/mysql2.js";
import * as baseRoot from "./.builds/mysql-baseline/mysql/index.js";
const cols = [
  ["id", "LONG"],
  ["name", "VAR_STRING"],
  ["amount", "DOUBLE"],
  ["big", "LONGLONG"],
  ["note", "VAR_STRING"],
  ["flag", "TINY"],
  ["a", "VAR_STRING"],
  ["b", "VAR_STRING"],
  ["c", "LONG"],
  ["d", "DOUBLE"],
];
const fields = cols.map(([name, type]) => ({ name, type }));
const rows = Array.from({ length: 10000 }, (_, i) => [
  i,
  `n${i}`,
  i / 3,
  String(i * 1000),
  `note ${i}`,
  i % 2,
  "a",
  "b",
  i,
  i / 7,
]);
const rs = createRenderedStatement({ segments: ["SELECT 1"], parameters: [], dialectId: "mysql", resultKind: "rows" });
const make = (adapter, root) => {
  const connection = { execute: async () => [rows, fields], beginTransaction() {}, commit() {}, rollback() {} };
  const executor = adapter.createMysql2Executor(connection, { profile: root.MYSQL2_NATIVE });
  const description = executor.statementBinding.describe(rs, { dialectId: "mysql", requestedReuse: "reuse" });
  return () => executor.query(rs, description);
};
const variants = { base: make(baseAdapter, baseRoot), next: make(nextAdapter, next) };
const median = (a) => a.toSorted((x, y) => x - y)[a.length >> 1];
const per = { base: [], next: [] };
for (let r = 0; r < 15; r++)
  for (const k of r % 2 ? ["next", "base"] : ["base", "next"]) {
    for (let i = 0; i < 20; i++) await variants[k]();
    const t = performance.now();
    for (let i = 0; i < 100; i++) await variants[k]();
    per[k].push((performance.now() - t) / 100);
  }
const deltas = per.base.map((v, i) => v - per.next[i]);
console.log(
  "base ms",
  median(per.base).toFixed(3),
  " next ms",
  median(per.next).toFixed(3),
  " paired base-next ms",
  median(deltas).toFixed(3),
  " next faster in",
  deltas.filter((d) => d > 0).length,
  "/ 15 rounds",
);
