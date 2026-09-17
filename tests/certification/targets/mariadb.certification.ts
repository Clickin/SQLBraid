import assert from "node:assert/strict";
import { test } from "vitest";
import { certifyTarget } from "../runner.js";
import { createMariaDbCertificationTarget } from "./mariadb.js";
import { REQUIRED_CASE_IDS } from "../types.js";

test("rc3.mariadb.certification", async () => {
  const artifact = await certifyTarget(createMariaDbCertificationTarget());
  assert.equal(Object.keys(artifact.cases).length, REQUIRED_CASE_IDS.length);
  for (const id of REQUIRED_CASE_IDS) {
    assert.notEqual(artifact.cases[id]?.status, "fail", `${id}: ${artifact.cases[id]?.error ?? "failed"}`);
  }
});
