// DB-free per-cell cost of TypePolicy.decode for each first-party adapter.
import { performance } from "node:perf_hooks";

const cases = {
  postgres: [
    await import("@sqlbraid/postgres"),
    [
      ["int4", 5],
      ["text", "x"],
      ["int8", "9007199254740993"],
      ["numeric", "1.5"],
      ["timestamptz", "2026-01-01"],
      ["bool", true],
      ["float8", 1.25],
      ["jsonb", "{}"],
    ],
  ],
  sqlite: [
    await import("@sqlbraid/sqlite"),
    [
      ["INTEGER", 5],
      ["TEXT", "x"],
      ["REAL", 1.5],
      ["BLOB", new Uint8Array(1)],
    ],
  ],
  mysql: [
    await import("@sqlbraid/mysql"),
    [
      ["INT", 5],
      ["VARCHAR", "x"],
      ["BIGINT", "9007199254740993"],
      ["DECIMAL", "1.5"],
      ["DATETIME", "2026-01-01"],
      ["DOUBLE", 1.25],
      ["JSON", "{}"],
    ],
  ],
  mariadb: [
    await import("@sqlbraid/mariadb"),
    [
      ["INT", 5],
      ["VARCHAR", "x"],
      ["BIGINT", "9007199254740993"],
      ["DECIMAL", "1.5"],
      ["DATETIME", "2026-01-01"],
      ["DOUBLE", 1.25],
      ["JSON", "{}"],
    ],
  ],
  oracle: [
    await import("@sqlbraid/oracle"),
    [
      ["NUMBER", "5"],
      ["VARCHAR2", "x"],
      ["DATE", new Date(0)],
      ["BINARY_DOUBLE", 1.25],
    ],
  ],
  mssql: [
    await import("@sqlbraid/mssql"),
    [
      ["int", 5],
      ["nvarchar", "x"],
      ["bigint", "9007199254740993"],
      ["datetime2", new Date(0)],
      ["float", 1.25],
    ],
  ],
};
const N = 2_000_000;
for (const [name, [mod, cells]] of Object.entries(cases)) {
  const policy = name === "postgres" ? mod.typePolicyForProfile() : mod.typePolicy;
  const out = [];
  for (const [type, value] of cells) {
    let sink = 0;
    for (let i = 0; i < 200_000; i += 1) sink += policy.decode(type, value) === undefined ? 1 : 0;
    const times = [];
    for (let r = 0; r < 5; r += 1) {
      const t = performance.now();
      for (let i = 0; i < N; i += 1) sink += policy.decode(type, value) === undefined ? 1 : 0;
      times.push(((performance.now() - t) * 1e6) / N);
    }
    times.sort((a, b) => a - b);
    out.push(`${type}=${times[2].toFixed(1)}ns`);
    if (sink < 0) console.log(sink);
  }
  console.log(name.padEnd(8), out.join("  "));
}
