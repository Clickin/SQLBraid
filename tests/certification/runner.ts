import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { PUBLIC_ERROR_DEFINITIONS, type EnvironmentCapability } from "@sqlbraid/core";
import { REQUIRED_CASE_IDS, type CertificationAggregate, type CertificationAggregateOptions, type CertificationArtifact, type CertificationCaseId, type CertificationCaseResult, type CertificationTarget, type ExpectedCapability, type ExpectedCapabilityContract } from "./types.js";
export { certifyTarget } from "./execute.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function isRegisteredUnsupportedPair(feature: string, code: string): boolean {
  return PUBLIC_ERROR_DEFINITIONS.some((definition) =>
    definition.owner === "UnsupportedFeatureError"
    && definition.code === code
    && definition.features?.includes(feature),
  );
}

function equalContract(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function declaredContract(expected: ExpectedCapabilityContract): Readonly<Record<string, EnvironmentCapability>> {
  return Object.fromEntries(Object.entries(expected).map(([key, value]) => {
    const { unsupportedCode: _unsupportedCode, ...declaration } = value;
    return [key, declaration];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapability(value: unknown): value is EnvironmentCapability {
  if (!isRecord(value)) return false;
  return (value.status === "guaranteed" || value.status === "guarded" || value.status === "unsupported")
    && (value.canonical === undefined || value.canonical === "string" || value.canonical === "number" || value.canonical === "Uint8Array")
    && (value.rawRepresentations === undefined || Array.isArray(value.rawRepresentations))
    && (value.conditionCode === undefined || typeof value.conditionCode === "string");
}

function assertArtifactShape(value: unknown): asserts value is CertificationArtifact {
  assert.ok(isRecord(value), "Certification artifact must be an object.");
  assert.equal(value.schemaVersion, 1, "Unsupported certification artifact schema.");
  assert.equal(typeof value.target, "string", "Certification artifact target must be a string.");
  assert.equal(typeof value.sourceSha, "string", "Certification artifact sourceSha must be a string.");
  assert.ok(isRecord(value.cases), "Certification artifact cases must be an object.");
  assert.ok(isRecord(value.expectedCapabilities), "Certification artifact expectedCapabilities must be an object.");
  assert.ok(isRecord(value.expectedTransactionOptions), "Certification artifact expectedTransactionOptions must be an object.");
  assert.ok(isRecord(value.declaredCapabilities), "Certification artifact declaredCapabilities must be an object.");
  for (const [id, result] of Object.entries(value.cases)) {
    assert.ok(isRecord(result), `Invalid certification case ${id}.`);
    assert.equal(typeof result.status, "string", `Certification case ${id} has no status.`);
    assert.equal(typeof result.name, "string", `Certification case ${id} has no name.`);
    if (result.feature !== undefined) assert.equal(typeof result.feature, "string", `Certification case ${id} feature must be a string.`);
    if (result.rejectionFeature !== undefined) assert.equal(typeof result.rejectionFeature, "string", `Certification case ${id} rejectionFeature must be a string.`);
    if (result.code !== undefined) assert.equal(typeof result.code, "string", `Certification case ${id} code must be a string.`);
    if (result.error !== undefined) assert.equal(typeof result.error, "string", `Certification case ${id} error must be a string.`);
  }
  for (const [key, status] of Object.entries(value.expectedTransactionOptions)) {
    assert.ok(status === "guaranteed" || status === "unsupported", `Invalid transaction option status for ${key}.`);
  }
  for (const [feature, capability] of Object.entries(value.expectedCapabilities)) {
    assert.ok(isRecord(capability), `Invalid expected capability ${feature}.`);
    assert.ok(isCapability(capability), `Invalid declared fields for expected capability ${feature}.`);
    if (capability.unsupportedCode !== undefined) assert.equal(typeof capability.unsupportedCode, "string");
  }
  for (const [feature, capability] of Object.entries(value.declaredCapabilities)) assert.ok(isCapability(capability), `Invalid declared capability ${feature}.`);
}

export function validateCertificationArtifact(
  artifact: unknown,
  options: Pick<CertificationAggregateOptions, "sourceSha" | "requiredCaseIds"> & { readonly expectedCapabilities?: ExpectedCapabilityContract; readonly expectedTransactionOptions?: CertificationAggregateOptions["requiredTargetOptionContracts"][string] },
): void {
  assertArtifactShape(artifact);
  assert.equal(artifact.sourceSha, options.sourceSha, `Certification artifact ${artifact.target} has the wrong source SHA.`);
  if (options.expectedCapabilities !== undefined) {
    assert.ok(equalContract(artifact.expectedCapabilities, options.expectedCapabilities), `Certification artifact ${artifact.target} expected capability contract differs from the independent target contract.`);
  }
  if (options.expectedTransactionOptions !== undefined) {
    assert.ok(equalContract(artifact.expectedTransactionOptions, options.expectedTransactionOptions), `Certification artifact ${artifact.target} expected transaction option contract differs from the independent target contract.`);
  }
  const required = options.requiredCaseIds ?? REQUIRED_CASE_IDS;
  const actualIds = Object.keys(artifact.cases).sort();
  assert.deepEqual(actualIds, [...required].sort(), `Certification artifact ${artifact.target} has an incomplete or unexpected case set.`);
  assert.ok(equalContract(declaredContract(artifact.expectedCapabilities), artifact.declaredCapabilities), `Certification artifact ${artifact.target} has a capability declaration mismatch.`);
  for (const id of required) {
    const result: CertificationCaseResult | undefined = artifact.cases[id];
    assert.ok(result, `Certification artifact ${artifact.target} is missing ${id}.`);
    assert.ok(!["skip", "skipped"].includes((result as { readonly status: string }).status), `${artifact.target}/${id} may not be skipped.`);
    assert.ok(result.status === "pass" || result.status === "pass-unsupported", `${artifact.target}/${id} did not pass: ${result.error ?? result.status}`);
    if (result.status === "pass-unsupported") {
      assert.equal(typeof result.feature, "string", `${artifact.target}/${id} unsupported evidence lacks a feature.`);
      assert.equal(typeof result.code, "string", `${artifact.target}/${id} unsupported evidence lacks a code.`);
      const capability: ExpectedCapability | undefined = artifact.expectedCapabilities[result.feature!];
      const optionStatus = artifact.expectedTransactionOptions[result.feature! as keyof typeof artifact.expectedTransactionOptions];
      assert.ok(capability?.status === "unsupported" || optionStatus === "unsupported", `${artifact.target}/${id} is marked unsupported for a supported capability.`);
      const rejectionFeature: string = result.rejectionFeature ?? result.feature!;
      assert.ok(isRegisteredUnsupportedPair(rejectionFeature, result.code!), `${artifact.target}/${id} has an unregistered unsupported feature/code pair.`);
      if (result.rejectionFeature === undefined && capability?.unsupportedCode !== undefined) {
        assert.equal(result.code, capability.unsupportedCode, `${artifact.target}/${id} has an unexpected target-declared unsupported code.`);
      }
    }
  }
}

export function aggregateCertificationArtifacts(
  artifacts: readonly CertificationArtifact[],
  options: CertificationAggregateOptions,
): CertificationAggregate {
  const required = options.requiredCaseIds ?? REQUIRED_CASE_IDS;
  const expectedTargets = [...options.requiredTargets].sort();
  const actualTargets = artifacts.map((artifact) => artifact.target).sort();
  assert.deepEqual(actualTargets, expectedTargets, "Certification target set is incomplete or contains an unexpected target.");
  for (const target of expectedTargets) assert.ok(options.requiredTargetContracts[target], `Missing independent expected contract for ${target}.`);
  for (const target of expectedTargets) assert.ok(options.requiredTargetOptionContracts[target], `Missing independent transaction option contract for ${target}.`);
  const targets: Record<string, CertificationArtifact> = {};
  for (const artifact of artifacts) {
    if (targets[artifact.target]) throw new Error(`Duplicate certification target ${artifact.target}.`);
    validateCertificationArtifact(artifact, {
      sourceSha: options.sourceSha,
      requiredCaseIds: required,
      expectedCapabilities: options.requiredTargetContracts[artifact.target],
      expectedTransactionOptions: options.requiredTargetOptionContracts[artifact.target],
    });
    assert.ok(equalContract(artifact.expectedCapabilities, options.requiredTargetContracts[artifact.target]!), `Certification artifact ${artifact.target} expected contract is not independently approved.`);
    targets[artifact.target] = artifact;
  }
  return { schemaVersion: 1, sourceSha: options.sourceSha, targets };
}

export async function writeCertificationArtifact(path: string, artifact: CertificationArtifact): Promise<void> {
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function writeCertificationAggregate(path: string, aggregate: CertificationAggregate): Promise<void> {
  await writeFile(path, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
}

export function expectedDeclaration(contract: ExpectedCapabilityContract): Readonly<Record<string, EnvironmentCapability>> {
  return declaredContract(contract);
}

export function capabilityContractsEqual(
  left: Readonly<Record<string, EnvironmentCapability>>,
  right: Readonly<Record<string, EnvironmentCapability>>,
): boolean {
  return equalContract(left, right);
}

export function unsupportedCode(feature: string, contract: ExpectedCapabilityContract): `BRAID_${string}` | undefined {
  const capability: ExpectedCapability | undefined = contract[feature];
  return capability?.unsupportedCode;
}
