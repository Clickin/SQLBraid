# codegen --check in CI

> Keep generated models synchronized. Do not edit derived files manually.

Generated models are derived artifacts. Change the metadata snapshot or the config. Run codegen. Then make CI the authority that checks if the output is current.

Install the optional CLI before you run these commands:

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid codegen
sqlbraid codegen --check
```

A stale or missing output is a CI failure. Run the check after changes to the metadata or the config, and before packaging. If a build system needs the target status in a machine-readable format, use `--json`.

The CLI validates all selected targets before it writes any output. Thus, one valid target cannot hide a malformed snapshot or type policy in a different target. The CLI also checks globally for collisions of the final Row, Insert and Update names. On Windows, the output collision keys are case-folded.

Do not change generated declarations manually. If a model is wrong, correct the inspector evidence, the selected TypePolicy, the filters, the naming or the override. Then generate again. Codegen does not infer arbitrary `SELECT` or `JOIN` results. Declare those row types where you write the query.

CI must select the same representation profile as the runtime. A changed JSON,
temporal or numeric option is a different profile. It needs its own TypePolicy
provenance and evidence. A green freshness check alone does not certify that
mismatch.
