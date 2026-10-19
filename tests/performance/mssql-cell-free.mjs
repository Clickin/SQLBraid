// Alternates a baseline build (tests/performance/.builds/mssql-baseline/mssql) and the current build with a fake Tedious connection that returns 10,000 rows.
import { createRenderedStatement } from "@sqlbraid/core";
import * as nextAdapter from "@sqlbraid/mssql/tedious";
import * as baseAdapter from "./.builds/mssql-baseline/mssql/tedious.js";

const columns = [
  ["id", "IntN", 4],
  ["name", "NVarChar", 0],
  ["amount", "FloatN", 8],
  ["big", "IntN", 8],
  ["note", "NVarChar", 0],
  ["flag", "IntN", 1],
  ["a", "NVarChar", 0],
  ["b", "NVarChar", 0],
  ["c", "IntN", 4],
  ["d", "FloatN", 8],
].map(([colName, name, dataLength]) => ({ colName, type: { name }, dataLength }));
const rows = Array.from({ length: 10000 }, (_, i) =>
  [i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7].map((value, index) => ({
    value,
    metadata: columns[index],
  })),
);
const rs = createRenderedStatement({ segments: ["SELECT 1"], parameters: [], dialectId: "mssql", resultKind: "rows" });
const make = (adapter) => {
  const connection = {
    execSql(request) {
      queueMicrotask(() => {
        request.emit("columnMetadata", columns);
        for (const row of rows) request.emit("row", row);
        request.emit("done", rows.length);
        request.callback(undefined, rows.length);
      });
    },
    beginTransaction() {},
    commitTransaction() {},
    rollbackTransaction() {},
    saveTransaction() {},
  };
  const executor = adapter.createTediousExecutor(connection);
  const description = executor.statementBinding.describe(rs, { dialectId: "mssql", requestedReuse: "reuse" });
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
