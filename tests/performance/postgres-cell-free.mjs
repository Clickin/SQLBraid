// Alternates a baseline build (tests/performance/.builds/postgres-baseline/postgres) and the current build with a fake pg client that returns 10,000 rows.
import { createRenderedStatement } from "@sqlbraid/core";
import * as next from "@sqlbraid/postgres";
import * as nextAdapter from "@sqlbraid/postgres/pg";
import * as baseAdapter from "./.builds/postgres-baseline/postgres/pg.js";
import * as baseRoot from "./.builds/postgres-baseline/postgres/index.js";

const fields = [
  ["id", 23],
  ["name", 25],
  ["amount", 701],
  ["big", 20],
  ["note", 25],
  ["flag", 21],
  ["a", 25],
  ["b", 25],
  ["c", 23],
  ["d", 701],
].map(([name, dataTypeID]) => ({ name, dataTypeID }));
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
  segments: ["SELECT 1"],
  parameters: [],
  dialectId: "postgres",
  resultKind: "rows",
});
const make = (adapter, root) => {
  const client = {
    escapeIdentifier: (value) => value,
    escapeLiteral: (value) => value,
    query: async () => ({ rows, fields, rowCount: rows.length, command: "SELECT" }),
  };
  const executor = adapter.createPgExecutor(client, { profile: root.representationProfiles[0] });
  const description = executor.statementBinding.describe(rs, { dialectId: "postgres", requestedReuse: "reuse" });
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
