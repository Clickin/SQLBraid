import { executeCertificationCase } from "./cases.js";
import { isWellKnownCapabilityId, type EnvironmentCapability } from "@sqlbraid/core";
import { CERTIFICATION_TARGET_TUPLES } from "./contracts.js";
import { isSourceSha, REQUIRED_API_CAPABILITY_IDS, REQUIRED_CASE_IDS, type CertificationArtifact, type CertificationCaseId, type CertificationCaseResult, type CertificationMeasuredTuple, type CertificationRunOptions, type CertificationTarget, type ExpectedCapabilityContract } from "./types.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
  return value;
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

function errorResult(id: CertificationCaseId, message: string): CertificationCaseResult {
  return { status: "fail", name: id, error: message };
}

/** Runs all common cases in the target's own realm; it performs no artifact I/O. */
export async function certifyTarget(target: CertificationTarget, options: CertificationRunOptions = {}): Promise<CertificationArtifact> {
  if (!target.id.trim()) throw new Error("Certification target id must be non-empty.");
  if (!isSourceSha(target.sourceSha)) throw new Error("Certification sourceSha must be a full 40-character SHA.");
  if (options.candidate !== undefined && options.candidate.sourceSha !== target.sourceSha) throw new Error(`Certification candidate source SHA does not match ${target.id}.`);
  if (!target.allowCustomCapabilities) {
    for (const feature of REQUIRED_API_CAPABILITY_IDS) {
      if (!Object.hasOwn(target.expectedCapabilities, feature)) throw new Error(`Certification target ${target.id} is missing required capability ${feature}.`);
    }
    for (const feature of Object.keys(target.expectedCapabilities)) {
      if (!isWellKnownCapabilityId(feature)) throw new Error(`Certification target ${target.id} declares unknown capability ${feature}.`);
    }
  }
  const fixture = await target.createFixture();
  const cases = {} as Record<CertificationCaseId, CertificationCaseResult>;
  try {
    const environment = await fixture.db.environment();
    const expected = declaredContract(target.expectedCapabilities);
    const measured: CertificationMeasuredTuple = {
      database: { ...environment.database, versionStatus: environment.database.version === undefined ? "unknown" : "measured" },
      driver: environment.driver,
      runtime: environment.runtime,
    };
    const pinned = CERTIFICATION_TARGET_TUPLES[target.id] ?? {
      database: { product: environment.database.product, ...(environment.database.version === undefined ? {} : { version: environment.database.version }), edition: environment.database.edition ?? "unknown", versionStatus: measured.database.versionStatus },
      driver: { id: environment.driver.id, package: "unknown", version: environment.driver.version ?? "unknown", profile: environment.driver.profile ?? "unknown" },
      runtime: { id: environment.runtime.id, version: environment.runtime.version ?? "unknown" },
    };
    const declarationError = equalContract(environment.capabilities, expected)
      ? undefined
      : `CAP001 declaration mismatch for ${target.id}.`;
    for (const id of REQUIRED_CASE_IDS) {
      if (declarationError && id !== "CAP001") {
        cases[id] = errorResult(id, declarationError);
        continue;
      }
      const caseFixture = id === "CAP001" ? fixture : await target.createFixture();
      try {
        cases[id] = await executeCertificationCase(target, caseFixture, id, options);
      } finally {
        if (caseFixture !== fixture) await caseFixture.close?.();
      }
    }
    if (declarationError) cases.CAP001 = errorResult("CAP001", declarationError);
    return {
      schemaVersion: 1,
      target: target.id,
      sourceSha: target.sourceSha,
      provenance: { schemaVersion: 1, target: target.id, sourceSha: target.sourceSha, measured, pinned, ...(options.candidate === undefined ? {} : { candidate: options.candidate }) },
      cases,
      expectedCapabilities: target.expectedCapabilities,
      expectedTransactionOptions: target.expectedTransactionOptions,
      ...(target.expectedGuardedCases === undefined ? {} : { expectedGuardedCases: target.expectedGuardedCases }),
      declaredCapabilities: environment.capabilities,
    };
  } finally {
    await fixture.close?.();
  }
}
