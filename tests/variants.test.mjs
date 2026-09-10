import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStructuralVariants, renderVariants, sql } from '../dist/packages/template/src/index.js';

test('local where analysis avoids variant expansion', () => {
  const enabled = true;
  const query = sql`SELECT 1 /*@braid where*/ /*@braid if ${enabled}*/ AND id = ${1} /*@braid end*/ /*@braid end*/`;
  const analysis = analyzeStructuralVariants(query.ir);
  assert.equal(analysis.localClauseAnalysis, true);
  assert.equal(analysis.estimatedVariants, 2);
  assert.equal(query.render().variantFingerprint, 'if:0:1');
});

test('shape-changing variants are bounded', () => {
  const include = true;
  const query = sql`SELECT id /*@braid if ${include}*/, email /*@braid end*/ FROM users`;
  assert.equal(renderVariants(query.ir, query.values, { maxVariants: 2 }).length, 2);
  assert.throws(() => renderVariants(query.ir, query.values, { maxVariants: 1 }), (error) => error.code === 'BRAID_VARIANT_LIMIT');
});
