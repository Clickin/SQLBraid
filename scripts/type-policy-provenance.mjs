#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRST_PARTY_PACKAGES = ["postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql"];
const PROFILE_VALUES = ["text", "native"];
const HASH_RE = /^[0-9a-f]{64}$/u;
const NUMERIC_SEMANTICS = new Set(["exact-integer", "exact-decimal", "approximate-binary"]);
const NUMERIC_REPRESENTATIONS = new Set(["string", "number"]);
const NUMERIC_FIDELITIES = new Set(["lossless", "guarded", "lossy", "unsupported"]);

function failure(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function sortedObject(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failure("TYPE_POLICY_DECLARATIVE", "Non-finite numbers are not hashable.");
    return value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    failure("TYPE_POLICY_DECLARATIVE", "Policies may contain only JSON-like declarative values.");
  }
  if (seen.has(value)) failure("TYPE_POLICY_DECLARATIVE", "Circular policy declarations are not hashable.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((item) => sortedObject(item, seen));
  else {
    result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortedObject(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function mappingSortKey(mapping) {
  return JSON.stringify(sortedObject(mapping));
}

/** Return the only declaration covered by a TypePolicy provenance hash. */
export function canonicalPolicyContract(policy) {
  if (!policy || typeof policy !== "object") failure("TYPE_POLICY_SHAPE", "TypePolicy must be an object.");
  if (typeof policy.id !== "string" || policy.id.length === 0) failure("TYPE_POLICY_ID", "TypePolicy.id must be a non-empty string.");
  if (!Array.isArray(policy.mappings)) failure("TYPE_POLICY_MAPPINGS", `${policy.id}: mappings must be an array.`);
  const mappings = policy.mappings.slice().sort((a, b) => {
    const left = mappingSortKey(a);
    const right = mappingSortKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return sortedObject({ id: policy.id, mappings });
}

/** Stable JSON used by typePolicyDigest; exported so hash finalization is reproducible. */
export function canonicalPolicyJson(policy) {
  return JSON.stringify(canonicalPolicyContract(policy));
}

/** SHA-256 of sorted declarative {id,mappings}; functions and runtime closures are excluded. */
export function typePolicyDigest(policy) {
  return createHash("sha256").update(canonicalPolicyJson(policy), "utf8").digest("hex");
}

function validateMapping(policyId, mapping, index) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) failure("TYPE_POLICY_MAPPING", `${policyId}: mapping ${index} must be an object.`);
  for (const key of ["databaseType", "inputType", "outputType"]) {
    if (typeof mapping[key] !== "string" || mapping[key].length === 0) failure("TYPE_POLICY_MAPPING", `${policyId}: mapping ${index}.${key} must be a non-empty string.`);
  }
  if (typeof mapping.nullable !== "boolean") failure("TYPE_POLICY_MAPPING", `${policyId}: mapping ${index}.nullable must be boolean.`);
  if (mapping.numeric === undefined) return;
  const numeric = mapping.numeric;
  if (!numeric || typeof numeric !== "object" || Array.isArray(numeric)) failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index}.numeric must be an object.`);
  if (!NUMERIC_SEMANTICS.has(numeric.semantics)) failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index} has invalid numeric.semantics.`);
  if (!NUMERIC_REPRESENTATIONS.has(numeric.representation)) failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index} has invalid numeric.representation.`);
  if (!NUMERIC_FIDELITIES.has(numeric.fidelity)) failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index} has invalid numeric.fidelity.`);
  if (numeric.semantics === "approximate-binary" && numeric.representation !== "number") {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: approximate-binary mappings must use number representation.`);
  }
  if (numeric.semantics !== "approximate-binary" && numeric.representation !== "string") {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: exact numeric mappings must use string representation.`);
  }
  if (numeric.fidelity !== "unsupported" && mapping.outputType !== numeric.representation) {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index}.outputType must match numeric.representation.`);
  }
  if (numeric.binaryPrecision !== undefined && ![32, 64].includes(numeric.binaryPrecision)) {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: mapping ${index}.numeric.binaryPrecision must be 32 or 64.`);
  }
  if (numeric.semantics === "approximate-binary" && numeric.binaryPrecision === undefined) {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: approximate-binary mappings require binaryPrecision.`);
  }
  if (numeric.semantics !== "approximate-binary" && numeric.binaryPrecision !== undefined) {
    failure("TYPE_POLICY_NUMERIC", `${policyId}: exact numeric mappings cannot declare binaryPrecision.`);
  }
}

function validateFrozenPolicy(policy) {
  if (!Object.isFrozen(policy) || !Object.isFrozen(policy.mappings)) {
    failure("TYPE_POLICY_IMMUTABLE", `${policy.id}: policy and mappings must be frozen.`);
  }
  for (const mapping of policy.mappings) {
    if (!Object.isFrozen(mapping)) failure("TYPE_POLICY_IMMUTABLE", `${policy.id}: every mapping must be frozen.`);
    if (mapping.numeric !== undefined && !Object.isFrozen(mapping.numeric)) {
      failure("TYPE_POLICY_IMMUTABLE", `${policy.id}: every numeric contract must be frozen.`);
    }
  }
}

/** Validate a policy's declarative mapping contract and its committed hash. */
export function validateTypePolicy(policy, { expectedHash = policy?.hash, requireFrozen = false } = {}) {
  const contract = canonicalPolicyContract(policy);
  if (requireFrozen) validateFrozenPolicy(policy);
  const seenTypes = new Set();
  contract.mappings.forEach((mapping, index) => {
    validateMapping(contract.id, mapping, index);
    if (seenTypes.has(mapping.databaseType)) failure("TYPE_POLICY_MAPPING", `${contract.id}: duplicate databaseType ${mapping.databaseType}.`);
    seenTypes.add(mapping.databaseType);
  });
  if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) failure("TYPE_POLICY_HASH", `${contract.id}: hash must be a lowercase SHA-256 digest.`);
  const digest = typePolicyDigest(policy);
  if (digest !== expectedHash) failure("TYPE_POLICY_HASH_MISMATCH", `${contract.id}: expected ${expectedHash}, computed ${digest}.`);
  return { id: contract.id, hash: digest, mappings: contract.mappings };
}

function isPolicy(value) {
  return value && typeof value === "object" && typeof value.id === "string" && Array.isArray(value.mappings);
}

function isDescriptor(value) {
  return value && typeof value === "object" && isPolicy(value.typePolicy);
}

function addRecord(records, policy, metadata) {
  if (!isPolicy(policy)) return;
  records.push({ packageName: metadata.packageName, exportName: metadata.exportName, sourcePath: metadata.sourcePath, profileId: metadata.profileId ?? policy.id, policy, ...(metadata.profile ? { profile: metadata.profile } : {}) });
}

function collectExport(value, metadata, records, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (isPolicy(value)) addRecord(records, value, metadata);
  if (isDescriptor(value)) {
    if (!Object.isFrozen(value)) failure("TYPE_POLICY_IMMUTABLE", `${metadata.packageName}/${metadata.exportName}: profile descriptor must be frozen.`);
    if (value.connectionOptions && !Object.isFrozen(value.connectionOptions)) failure("TYPE_POLICY_IMMUTABLE", `${metadata.packageName}/${metadata.exportName}: connection options must be frozen.`);
    addRecord(records, value.typePolicy, { ...metadata, profileId: value.id, profile: value });
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (/representationProfiles/u.test(metadata.exportName) && !Object.isFrozen(value)) {
      failure("TYPE_POLICY_IMMUTABLE", `${metadata.packageName}/${metadata.exportName}: representationProfiles must be frozen.`);
    }
    value.forEach((item, index) => collectExport(item, { ...metadata, exportName: `${metadata.exportName}[${index}]` }, records, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (key === "mappings" || key === "numeric") continue;
      collectExport(child, { ...metadata, exportName: `${metadata.exportName}.${key}` }, records, seen);
    }
  }
}

async function loadSourceModule(packageName, root) {
  const sourcePath = join(root, "packages", packageName, "src", "type-policy.ts");
  const source = await readFile(sourcePath, "utf8");
  const temp = await mkdtemp(join(root, ".sqlbraid-policy-source-"));
  try {
    const corePath = join(root, "packages", "core", "src", "index.ts");
    const coreSource = await readFile(corePath, "utf8");
    const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: false };
    const coreOut = join(temp, "core.mjs");
    await writeFile(coreOut, ts.transpileModule(coreSource, { compilerOptions, fileName: corePath }).outputText);
    const policyOut = join(temp, `${packageName}.mjs`);
    let policyJavaScript = ts.transpileModule(source, { compilerOptions, fileName: sourcePath }).outputText;
    policyJavaScript = policyJavaScript.replaceAll('"@sqlbraid/core"', JSON.stringify(pathToFileURL(coreOut).href)).replaceAll("'@sqlbraid/core'", JSON.stringify(pathToFileURL(coreOut).href));
    await writeFile(policyOut, policyJavaScript);
    const module = await import(`${pathToFileURL(policyOut).href}?source=${Date.now()}`);
    return { module, sourcePath };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Load first-party policy/profile sources, never package dist artifacts. */
export async function loadFirstPartyPolicies({ root = scriptRoot, packages = FIRST_PARTY_PACKAGES } = {}) {
  const records = [];
  for (const packageName of packages) {
    const { module, sourcePath } = await loadSourceModule(packageName, root);
    for (const [exportName, value] of Object.entries(module)) {
      if (typeof value === "function" && /typePolicyFor(?:Profile|[A-Z].*Profile)$/u.test(exportName)) {
        for (const json of PROFILE_VALUES) for (const temporal of PROFILE_VALUES) {
          let selected;
          try { selected = value({ json, temporal }); } catch (error) { failure("TYPE_POLICY_PROFILE", `${packageName}/${exportName}(${json},${temporal}) failed: ${error.message}`); }
          collectExport(selected, { packageName, exportName: `${exportName}(${json},${temporal})`, sourcePath, profileId: selected?.id }, records);
        }
      } else {
        collectExport(value, { packageName, exportName, sourcePath }, records);
      }
    }
  }
  const byId = new Map();
  for (const record of records) {
    const prior = byId.get(record.policy.id);
    if (prior && prior.policy !== record.policy) {
      failure("TYPE_POLICY_ID", `Policy id ${record.policy.id} has multiple exported declarations.`);
    }
    if (!prior || (!prior.profile && record.profile)) byId.set(record.policy.id, record);
  }
  return [...byId.values()].sort((a, b) => a.policy.id.localeCompare(b.policy.id));
}

/** Validate every first-party source policy/profile and enforce unique IDs/digests. */
export async function validateFirstPartyPolicies(options = {}) {
  const records = await loadFirstPartyPolicies(options);
  if (records.length === 0) failure("TYPE_POLICY_EXPORTS", "No first-party TypePolicies were exported.");
  const hashes = new Map();
  for (const record of records) {
    const result = validateTypePolicy(record.policy, { requireFrozen: true });
    const prior = hashes.get(result.hash);
    if (prior && canonicalPolicyJson(prior.policy) !== canonicalPolicyJson(record.policy)) {
      failure("TYPE_POLICY_HASH", `Digest collision between ${prior.policy.id} and ${record.policy.id}.`);
    }
    hashes.set(result.hash, record);
  }
  return { records, policies: records.map((record) => record.policy), hashes: [...hashes.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await validateFirstPartyPolicies();
  for (const record of result.records) console.info(`${record.packageName}/${record.policy.id} ${record.policy.hash}`);
  console.info(`PASS ${result.records.length} first-party TypePolicy/profile provenance contracts`);
}
