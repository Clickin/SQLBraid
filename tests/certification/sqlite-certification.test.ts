import assert from "node:assert/strict";
import { test } from "vitest";
import { certifyTarget, validateCertificationArtifact } from "./runner.js";
import { betterSqlite3CertificationTarget } from "./targets/sqlite-better-sqlite3.js";
import { libsqlCertificationTarget } from "./targets/sqlite-libsql.js";
import { nodeSqliteCertificationTarget } from "./targets/sqlite-node-sqlite.js";
import { REQUIRED_CASE_IDS } from "./types.js";

for (const target of [nodeSqliteCertificationTarget, betterSqlite3CertificationTarget, libsqlCertificationTarget]) {
  test(`RC3 certifies every common case for ${target.id}`, async () => {
    const artifact = await certifyTarget(target);
    validateCertificationArtifact(artifact, { sourceSha: target.sourceSha });
    assert.deepEqual(Object.keys(artifact.cases).sort(), [...REQUIRED_CASE_IDS].sort());
    assert.equal(artifact.cases.CAP001.status, "pass");
    assert.equal(artifact.cases.CAP002.status, "pass");
  }, 120_000);
}
