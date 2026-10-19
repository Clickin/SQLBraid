// Alternates a baseline build (tests/performance/.builds/mariadb-baseline/mariadb) and the current build with a fake MariaDB connection that returns 10,000 rows.
import { createRenderedStatement } from "@sqlbraid/core";
import * as next from "@sqlbraid/mariadb";
import * as nextAdapter from "@sqlbraid/mariadb/mariadb";
import * as baseAdapter from "./.builds/mariadb-baseline/mariadb/mariadb.js";
import * as baseRoot from "./.builds/mariadb-baseline/mariadb/index.js";

const meta = [
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
].map(([name, type]) => ({ name, type }));
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
const rs = createRenderedStatement({
  segments: ["SELECT 1"],
  parameters: [],
  dialectId: "mariadb",
  resultKind: "rows",
});
const make = (adapter, root) => {
  const connection = { execute: async () => [rows, meta], beginTransaction() {}, commit() {}, rollback() {} };
  const executor = adapter.createMariaDbExecutor(connection, { profile: root.MARIADB_NATIVE });
  const description = executor.statementBinding.describe(rs, { dialectId: "mariadb", requestedReuse: "reuse" });
  return () => executor.query(rs, description);
};
const variants = { base: make(baseAdapter, baseRoot), next: make(nextAdapter, next) };
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
const per = { base: [], next: [] };
for (let round = 0; round < 15; round += 1) {
  for (const name of round % 2 ? ["next", "base"] : ["base", "next"]) {
    for (let i = 0; i < 20; i += 1) await variants[name]();
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) await variants[name]();
    per[name].push((performance.now() - start) / 100);
  }
}
const deltas = per.base.map((value, index) => value - per.next[index]);
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
