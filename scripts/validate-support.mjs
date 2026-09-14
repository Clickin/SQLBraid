#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv/dist/2020.js";
import ts from "typescript";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(code, detail) { throw Object.assign(new Error(`[${code}] ${detail}`), { code }); }
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

const numericCapabilities = new Map([
  ["numeric.exact-integer", "exact-integer"],
  ["numeric.exact-decimal", "exact-decimal"],
  ["numeric.approximate-float", "approximate-binary"],
  ["numeric.approximate-special", "approximate-binary"],
]);
const numericSemantics = new Set(["exact-integer", "exact-decimal", "approximate-binary"]);
const numericRepresentations = new Set(["string", "number"]);
const transportFidelity = new Set(["lossless", "guarded", "lossy", "unsupported"]);

/** Validate shape with JSON Schema, then resolve every claimed package, gate and test. */
export async function validateSupport({ root = scriptRoot } = {}) {
  const folder = join(root, "support");
  const schema = await json(join(folder, "schema.json"));
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat("uri", { type: "string", validate: (value) => { try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } } });
  try { ajv.addSchema(schema); } catch (error) { fail("SUPPORT_SCHEMA", error.message); }
  const catalog = await json(join(folder, "capabilities.json"));
  const targetFiles = (await readdir(join(folder, "targets"))).filter((f) => f.endsWith(".json")).sort();
  const targets = await Promise.all(targetFiles.map((f) => json(join(folder, "targets", f))));
  const registry = await json(join(folder, "test-registry.json"));
  const ids = new Set();
  for (const entry of [...(catalog.capabilities ?? []), ...(catalog.conditions ?? []), ...targets]) {
    const id = entry.id ?? entry.code;
    if (ids.has(id)) fail("SUPPORT_DUPLICATE_ID", `Duplicate ID ${id}.`);
    ids.add(id);
    if (entry.labels) for (const locale of ["en", "ko"]) {
      if (typeof entry.labels[locale] !== "string" || !entry.labels[locale].trim()) fail(`SUPPORT_LABEL_MISSING_${locale.toUpperCase()}`, `Missing ${locale} label for ${id}.`);
    }
  }
  const validate = ajv.getSchema(`${schema.$id}#/$defs/dataset`);
  if (!validate) fail("SUPPORT_SCHEMA", "Missing dataset schema.");
  if (!validate({ catalog, targets, testRegistry: registry })) {
    fail("SUPPORT_SCHEMA", ajv.errorsText(validate.errors, { separator: "\n" }));
  }
  const capabilities = new Set(catalog.capabilities.map((c) => c.id));
  const conditions = new Set(catalog.conditions.map((c) => c.code));
  const sourceCache = new Map();
  for (const [id, entry] of Object.entries(registry)) {
    let titles = sourceCache.get(entry.file);
    if (!titles) {
      let content;
      try { content = await readFile(join(root, entry.file), "utf8"); } catch { fail("SUPPORT_TARGET_MISSING_TEST", `${id}: missing ${entry.file}.`); }
      titles = new Set();
      const source = ts.createSourceFile(entry.file, content, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["skip", "skipIf", "todo"].includes(node.expression.name.text)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["test", "it"].includes(node.expression.text) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) titles.add(node.arguments[0].text);
        ts.forEachChild(node, visit);
      }
      visit(source);
      sourceCache.set(entry.file, titles);
    }
    if (!titles.has(entry.title)) fail("SUPPORT_TARGET_MISSING_TEST", `${id}: ${entry.file} has no active literal test ${entry.title}.`);
  }
  const workspace = await json(join(root, "package.json"));
  const packages = new Map();
  for (const directory of await readdir(join(root, "packages"))) {
    try { const manifest = await json(join(root, "packages", directory, "package.json")); packages.set(manifest.name, manifest); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const target of targets) {
    const packageParts = target.driver.package.split("/");
    const packageName = packageParts.slice(0, 2).join("/");
    const subpath = packageParts.length > 2 ? `./${packageParts.slice(2).join("/")}` : ".";
    if (!packages.get(packageName)?.exports?.[subpath]) fail("SUPPORT_TARGET_MISSING_PACKAGE", `${target.id}: no exported ${target.driver.package}.`);
    const command = /^pnpm run ([\w:-]+)$/u.exec(target.ci.command)?.[1];
    const registeredCommand = command ? Object.hasOwn(workspace.scripts ?? {}, command) : /^pnpm exec vitest run(?:\s|$)/u.test(target.ci.command) && Object.hasOwn(workspace.devDependencies ?? {}, "vitest");
    let workflow;
    try { workflow = await readFile(join(root, target.ci.workflow), "utf8"); } catch { fail("SUPPORT_TARGET_MISSING_CI", `${target.id}: workflow missing.`); }
    if (!registeredCommand || !workflow.includes(target.ci.command)) fail("SUPPORT_TARGET_MISSING_CI", `${target.id}: command is not registered in its workflow.`);
    const certified = target.status === "official" || target.status === "conditional";
    if (certified && !target.database.version) fail("SUPPORT_TARGET_UNKNOWN_VERSION", `${target.id}: certified targets require an exact database version.`);
    if (certified && !target.reproducibility.zeroCost) fail("SUPPORT_TARGET_NOT_ZERO_COST", `${target.id}: certified targets must be zero-cost reproducible.`);
    if (certified && !target.ci.releaseBlocking) fail("SUPPORT_TARGET_MISSING_CI", `${target.id}: certified target requires release-equivalent CI.`);
    if (certified && (target.evidence.status !== "verified" || !/^[a-f0-9]{40}$/u.test(target.evidence.commit ?? "") || !target.evidence.runs.some((r) => r.commit === target.evidence.commit && r.status === "passed" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/u.test(r.run ?? "") && r.workflow === target.ci.workflow))) fail("SUPPORT_TARGET_MISSING_EVIDENCE", `${target.id}: no verified exact-commit gate evidence.`);
    if (target.status === "conditional" && !conditions.has(target.conditionCode)) fail("SUPPORT_CAPABILITY_MISSING_CONDITION", `${target.id}: conditional target needs a catalog condition.`);
    for (const [kind, contract] of Object.entries(target.numeric)) {
      if (!numericSemantics.has(contract.semantics) || !numericRepresentations.has(contract.representation) || !transportFidelity.has(contract.fidelity)) {
        fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: invalid numeric contract for ${kind}.`);
      }
      if (contract.semantics !== kind) fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: ${kind} declares ${contract.semantics} semantics.`);
      const expectedRepresentation = contract.semantics === "approximate-binary" ? "number" : "string";
      if (contract.representation !== expectedRepresentation) fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: ${kind} must use ${expectedRepresentation} representation.`);

    }
    const numericContracts = Object.values(target.numeric);
    const numericProfiles = [...new Set(numericContracts.map((contract) => contract.profile).filter((profile) => profile !== undefined))];
    if (numericProfiles.length === 1 && numericContracts.every((contract) => contract.profile !== undefined) && target.driver.profile !== numericProfiles[0]) {
      fail("SUPPORT_NUMERIC_PROFILE", `${target.id}: driver profile ${target.driver.profile} disagrees with numeric profile ${numericProfiles[0]}.`);
    }
    for (const [id, claim] of Object.entries(target.capabilities)) {
      if (!capabilities.has(id)) fail("SUPPORT_UNKNOWN_CAPABILITY", `${target.id}: ${id} is not cataloged.`);
      if (claim.status === "guarded" && !claim.conditionCode) fail("SUPPORT_CAPABILITY_MISSING_CONDITION", `${target.id}: ${id} needs a condition.`);
      if (claim.conditionCode && !conditions.has(claim.conditionCode)) fail("SUPPORT_UNKNOWN_CONDITION", `${target.id}: unknown ${claim.conditionCode}.`);
      if (claim.status !== "unsupported" && !claim.testIds.length) fail("SUPPORT_TARGET_MISSING_TEST", `${target.id}: ${id} has no tests.`);
      for (const testId of claim.testIds) {
        if (!Object.hasOwn(registry, testId)) fail("SUPPORT_UNKNOWN_TEST", `${target.id}: unknown ${testId}.`);
        if (claim.status === "unsupported" && (registry[testId].outcome ?? "success") === "success") {
          fail("SUPPORT_UNSUPPORTED_SUCCESS", `${target.id}: unsupported ${id} is backed by success test ${testId}.`);
        }
      }
      const kind = numericCapabilities.get(id);
      if (kind) {
        const contract = target.numeric[kind];
        if (!contract || claim.semantics !== contract.semantics || claim.representation !== contract.representation || claim.fidelity !== contract.fidelity) {
          fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: ${id} does not match its TypePolicy numeric contract.`);
        }
        if (claim.semantics !== kind) fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: ${id} declares ${claim.semantics} semantics.`);
        const expectedRepresentation = kind === "approximate-binary" ? "number" : "string";
        if (claim.representation !== expectedRepresentation) fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: ${id} must use ${expectedRepresentation} representation.`);
        if (kind !== "approximate-binary" && claim.fidelity === "lossless" && claim.rawRepresentations?.some((value) => /(?:^|[\s/,(])number(?:$|[\s/),])/iu.test(value))) {
          fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: lossless ${id} cannot advertise a Number carrier.`);
        }
        if (claim.fidelity === "unsupported" && claim.status !== "unsupported") fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: unsupported ${id} must use unsupported status.`);
        if (claim.status === "unsupported" && claim.fidelity !== "unsupported") fail("SUPPORT_NUMERIC_FIDELITY", `${target.id}: unsupported ${id} must declare unsupported fidelity.`);
      }
    }
  }
  return { targets: targets.map((t) => t.id), capabilities: [...capabilities], conditions: [...conditions], tests: Object.keys(registry) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await validateSupport(); console.log(`Support dataset valid: ${result.targets.length} targets, ${result.capabilities.length} capabilities, ${result.tests.length} linked tests.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
