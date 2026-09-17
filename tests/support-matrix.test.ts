import assert from "node:assert/strict";
import { test } from "vitest";
import {
  loadSupportMatrix,
  projectSupportMatrixRow,
  supportMatrixColumns,
  supportMatrixStatus,
} from "../website/src/lib/support-matrix.js";

const data = loadSupportMatrix();

test("database projection exposes only the intended support columns and real target values", () => {
  assert.deepEqual(supportMatrixColumns("database", "en"), [
    "Target",
    "Database",
    "Driver",
    "Runtime",
    "Support status",
    "Exact numeric",
    "JSON",
    "Temporal",
    "Transaction",
    "Streaming",
  ]);

  const target = data.targets.find((candidate) => candidate.id === "postgres-pg-node-16-4");
  assert.ok(target);
  const cells = projectSupportMatrixRow(data, "database", { target }, "en");
  assert.equal(cells.length, 10);
  assert.deepEqual(cells.slice(0, 5), [
    target.id,
    [target.database.product, target.database.version, target.database.edition].filter(Boolean).join(" "),
    `${target.driver.id}@${target.driver.version}`,
    `${target.runtime.id}@${target.runtime.version}`,
    supportMatrixStatus(target.status, "en"),
  ]);
  assert.equal(
    cells[5],
    [target.numeric["exact-integer"], target.numeric["exact-decimal"]]
      .map((contract) => `${contract.representation} · ${contract.fidelity} · ${contract.profile}`)
      .join(" / "),
  );
  assert.match(cells[6], /Guaranteed/);
  assert.match(cells[7], /Guaranteed/);
  assert.match(cells[8], /Guaranteed/);
  assert.match(cells[9], /Guaranteed/);
});

test("driver projection retains raw/canonical representation and policy evidence", () => {
  assert.deepEqual(supportMatrixColumns("driver", "en"), [
    "Driver",
    "Version",
    "Target",
    "Runtime",
    "Profile",
    "Driver raw integer",
    "Driver raw decimal",
    "Driver raw JSON",
    "Driver raw temporal",
    "SQLBraid canonical",
    "TypePolicy",
    "Required options",
    "Streaming",
    "Routines",
    "Bulk",
    "Excluded profiles",
  ]);

  const target = data.targets.find((candidate) => candidate.id === "better-sqlite3-node-22-18-0");
  assert.ok(target);
  const cells = projectSupportMatrixRow(data, "driver", { target }, "en");
  assert.equal(cells.length, 16);
  assert.deepEqual(cells.slice(0, 5), [
    target.driver.id,
    target.driver.version,
    target.id,
    `${target.runtime.id}@${target.runtime.version}`,
    target.driver.profile,
  ]);
  assert.equal(cells[5], target.driver.driverRawRepresentations?.integer);
  assert.equal(cells[6], target.driver.driverRawRepresentations?.decimal);
  assert.equal(
    cells[9],
    [
      target.driver.sqlbraidRepresentations?.integer,
      target.driver.sqlbraidRepresentations?.decimal,
      target.driver.sqlbraidRepresentations?.json,
      target.driver.sqlbraidRepresentations?.temporal,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  assert.equal(cells[10], `${target.typePolicy?.id}@${target.typePolicy?.hash}`);
  assert.equal(cells[11], JSON.stringify(target.driver.requiredOptions));
  assert.equal(cells[12], target.driver.stream);
  assert.equal(cells[13], target.driver.routine);
  assert.equal(cells[14], target.driver.bulk);
  assert.equal(cells[15], target.driver.exclusions?.join(", "));
});

test("capability projection preserves evidence details without changing vocabulary", () => {
  const target = data.targets.find((candidate) => candidate.id === "postgres-pg-node-16-4");
  assert.ok(target);
  const capability = target.capabilities["sql.native-transparency"];
  assert.ok(capability);
  const cells = projectSupportMatrixRow(
    data,
    "capability",
    {
      target,
      capabilityId: "sql.native-transparency",
      capability,
    },
    "en",
  );
  assert.equal(cells[0], data.capabilities.find((entry) => entry.id === "sql.native-transparency")?.labels.en);
  assert.equal(cells[1], target.id);
  assert.equal(cells[2], "Guaranteed");
  assert.equal(cells[3], "—");
  assert.deepEqual(cells[4].split(", "), capability.testIds);
  assert.equal(cells[5], [target.ci?.command, target.ci?.workflow].filter(Boolean).join(" · "));
});
