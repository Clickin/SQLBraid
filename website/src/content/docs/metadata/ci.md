---
title: codegen --check in CI
description: Keep generated models synchronized without editing derived files by hand.
---

Generated models are derived artifacts. Change the metadata snapshot or config, run codegen, then make CI the freshness authority.

Install the optional CLI before running these commands:

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid codegen
sqlbraid codegen --check
```

A stale or missing output is a CI failure. Run the check after metadata/config changes and before packaging. Use `--json` when a build system needs machine-readable target status.

The CLI validates all selected targets before writing any output. This prevents one valid target from masking a malformed snapshot or type policy in another target. It also checks globally for final Row/Insert/Update name collisions; Windows output collision keys are case-folded.

Do not patch generated declarations manually. If a model is wrong, fix the inspector evidence, selected TypePolicy, filters, naming, or override and regenerate. Arbitrary `SELECT`/`JOIN` inference remains outside codegen; declare those row types at the query site.

CI must select the same representation profile used by runtime. A changed
JSON/temporal or numeric option is a different profile and requires its own
TypePolicy provenance and evidence; a green freshness check alone does not
certify that mismatch.
