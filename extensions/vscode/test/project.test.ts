import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findProjectEvidence,
  hasSqlBraidDependency,
  isProjectEvidencePath,
  isSqlBraidLanguage,
} from "../src/project.js";

test("project evidence accepts every dependency section but rejects unrelated packages", () => {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(hasSqlBraidDependency({ [section]: { "@sqlbraid/template": "0.1.0" } }), true);
  }
  assert.equal(hasSqlBraidDependency({ dependencies: { "@other/sqlbraid-plugin": "0.1.0" } }), false);
  assert.equal(hasSqlBraidDependency({ dependencies: ["@sqlbraid/template"] }), false);
  assert.equal(hasSqlBraidDependency(undefined), false);
});

test("project evidence discovers config and package dependency roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlbraid-vscode-"));
  try {
    assert.equal(await findProjectEvidence(root), undefined);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@sqlbraid/core": "0.1.0" } }));
    assert.deepEqual(await findProjectEvidence(root), { kind: "dependency", path: join(root, "package.json") });
    await writeFile(join(root, "sqlbraid.config.cjs"), "module.exports = {};");
    assert.deepEqual(await findProjectEvidence(root), { kind: "config", path: join(root, "sqlbraid.config.cjs") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation remains scoped to TypeScript and TypeScript React documents", () => {
  assert.equal(isSqlBraidLanguage("typescript"), true);
  assert.equal(isSqlBraidLanguage("typescriptreact"), true);
  assert.equal(isSqlBraidLanguage("javascript"), false);
  assert.equal(isSqlBraidLanguage("sql"), false);
});

test("project evidence path matching is root-scoped", () => {
  const root = join(tmpdir(), "workspace");
  assert.equal(isProjectEvidencePath(join(root, "sqlbraid.config.js"), root), true);
  assert.equal(isProjectEvidencePath(join(root, "package.json"), root), true);
  assert.equal(isProjectEvidencePath(join(tmpdir(), "outside", "package.json"), root), false);
});

test("project evidence matching remains root-scoped for Windows-shaped paths", () => {
  const root = "C:\\workspace\\app";
  assert.equal(isProjectEvidencePath("C:\\workspace\\app\\package.json", root), true);
  assert.equal(isProjectEvidencePath("C:\\workspace\\other\\package.json", root), false);
});

