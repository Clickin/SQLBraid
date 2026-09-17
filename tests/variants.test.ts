import assert from "node:assert/strict";
import { test } from "vitest";
import { analyzeStructuralVariants, renderVariants, sql } from "@sqlbraid/template";

function hasCode(code: string): (error: unknown) => boolean {
  return (error): error is { readonly code: string } =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

test("local where analysis avoids variant expansion", () => {
  const enabled = true;
  const query = sql`SELECT 1 /*@braid where*/ /*@braid if ${enabled}*/ AND id = ${1} /*@braid end*/ /*@braid end*/`;
  const analysis = analyzeStructuralVariants(query.ir);
  assert.equal(analysis.localClauseAnalysis, true);
  assert.equal(analysis.estimatedVariants, "linear");
  assert.equal(query.render().variantFingerprint, "if:0:1");
});

test("shape-changing variants are bounded", () => {
  const include = true;
  const query = sql`SELECT id /*@braid if ${include}*/, email /*@braid end*/ FROM users`;
  assert.equal(renderVariants(query.ir, query.values, { maxVariants: 2 }).length, 2);
  assert.throws(() => renderVariants(query.ir, query.values, { maxVariants: 1 }), hasCode("BRAID_VARIANT_LIMIT"));
});
