// Alternates a baseline build (tests/performance/.builds/oracle-baseline/oracle) and the current build with a fake node-oracledb connection that returns 10,000 rows.
import { createRenderedStatement } from "@sqlbraid/core";
import * as nextAdapter from "@sqlbraid/oracle/oracledb";
import * as baseAdapter from "./.builds/oracle-baseline/oracle/oracledb.js";

const metaData = [
  ["ID", "NUMBER"],
  ["NAME", "VARCHAR2"],
  ["AMOUNT", "BINARY_DOUBLE"],
  ["BIG", "NUMBER"],
  ["NOTE", "VARCHAR2"],
  ["FLAG", "NUMBER"],
  ["A", "VARCHAR2"],
  ["B", "VARCHAR2"],
  ["C", "NUMBER"],
  ["D", "BINARY_DOUBLE"],
].map(([name, dbTypeName]) => ({ name, dbTypeName }));
const rows = Array.from({ length: 10000 }, (_, i) => [
  String(i),
  `n${i}`,
  i / 3,
  String(i * 1000),
  `note ${i}`,
  String(i % 2),
  "a",
  "b",
  String(i),
  i / 7,
]);
const rs = createRenderedStatement({
  segments: ["SELECT 1 FROM dual"],
  parameters: [],
  dialectId: "oracle",
  resultKind: "rows",
});
const make = (adapter) => {
  const connection = { execute: async () => ({ rows, metaData }), commit() {}, rollback() {} };
  const executor = adapter.createOracledbExecutor(connection);
  const description = executor.statementBinding.describe(rs, { dialectId: "oracle", requestedReuse: "reuse" });
  return () => executor.query(rs, description);
};
const variants = { base: make(baseAdapter), next: make(nextAdapter) };
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
