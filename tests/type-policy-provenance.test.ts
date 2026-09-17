import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalPolicyJson,
  loadFirstPartyPolicies,
  typePolicyDigest,
  validateFirstPartyPolicies,
  validateTypePolicy,
} from "../scripts/type-policy-provenance.mjs";

test("first-party provenance enumerates source policy/profile exports", async () => {
  const result = await validateFirstPartyPolicies();
  assert.ok(result.records.length >= 6);
  assert.equal(new Set(result.records.map((record) => record.policy.id)).size, result.records.length);
  assert.ok(result.records.every((record) => record.sourcePath.includes("/src/type-policy.ts")));
  assert.ok(result.records.every((record) => /^[0-9a-f]{64}$/u.test(record.policy.hash)));
});

test("canonical digest ignores runtime policy functions and ordering", async () => {
  const records = await loadFirstPartyPolicies();
  const policy = records[0]!.policy;
  const reordered = {
    id: policy.id,
    mappings: [...policy.mappings].reverse(),
    decode: () => "different runtime closure",
    encode: () => "different runtime closure",
  };
  assert.equal(typePolicyDigest(policy), typePolicyDigest(reordered));
  assert.equal(canonicalPolicyJson(policy), canonicalPolicyJson(reordered));
});

test("valid mapping mutations cannot retain a stale provenance hash", async () => {
  const records = await loadFirstPartyPolicies();
  const policy = records[0]!.policy;
  const outputIndex = policy.mappings.findIndex((mapping) => !mapping.numeric);
  assert.notEqual(outputIndex, -1, `${policy.id} must expose a non-numeric mapping for outputType coverage`);
  const outputMutation = {
    ...policy,
    mappings: policy.mappings.map((mapping, index) =>
      index === outputIndex
        ? { ...mapping, outputType: mapping.outputType === "unknown" ? "string" : "unknown" }
        : mapping,
    ),
  };
  assert.notEqual(typePolicyDigest(outputMutation), policy.hash);
  assert.throws(() => validateTypePolicy(outputMutation), /TYPE_POLICY_HASH_MISMATCH/u);

  const numericIndex = policy.mappings.findIndex((mapping) => mapping.numeric);
  assert.notEqual(numericIndex, -1, `${policy.id} must expose a numeric mapping for provenance coverage`);
  const fidelityMutation = {
    ...policy,
    mappings: policy.mappings.map((mapping, index): typeof mapping =>
      index === numericIndex
        ? {
            ...mapping,
            numeric: {
              ...mapping.numeric!,
              fidelity: mapping.numeric!.fidelity === "lossless" ? "guarded" : "lossless",
            },
          }
        : mapping,
    ),
  };
  assert.throws(() => validateTypePolicy(fidelityMutation), /TYPE_POLICY_HASH_MISMATCH/u);
  const representationMutation = {
    ...policy,
    mappings: policy.mappings.map((mapping, index): typeof mapping =>
      index === numericIndex
        ? {
            ...mapping,
            numeric: {
              ...mapping.numeric!,
              representation: mapping.numeric!.representation === "string" ? "number" : "string",
            },
          }
        : mapping,
    ),
  };
  assert.throws(() => validateTypePolicy(representationMutation), /TYPE_POLICY_(HASH_MISMATCH|NUMERIC)/u);
});
