# SQLBraid tooling evidence

Use SQLBraid's semantic evidence instead of reconstructing SQL or database facts when working in an existing SQLBraid project.

## Discovery

Look for `sqlbraid.config.mjs`, `sqlbraid.config.js`, `sqlbraid.config.cjs`, existing SQLBraid imports, and `package.json` dependencies. Do not switch dialects or adapters because another package happens to support the same database.

## LSP first

When a standard language server is available, use ordinary LSP diagnostics, hover, completion, definition, references, document symbols, workspace symbols, and signature help where offered.

## CLI fallback

When LSP is unavailable, use the JSON inspection surface:

```sh
sqlbraid inspect query --file <path> --line <1-based> --column <1-based> --json
sqlbraid inspect symbol <name> --json
sqlbraid inspect diagnostics --file <path> --json
```

Pass `--config <path>` when configuration discovery is ambiguous. These commands use the same semantic core as the LSP. `sqlbraid check` additionally reports ordinary TypeScript errors.

## Metadata is open-world

Treat metadata as positive evidence, not a closed-world catalog. Absence of a relation, column, routine, type, built-in, extension object, runtime UDF, temporary object, or CTE is not sufficient evidence that SQL is invalid.

Do not replace explicit SQLBraid evidence with a stronger inference from generic SQL knowledge.

## Generated models

Generated model files are derived artifacts. Change configuration, filters, overrides, or source metadata, run `sqlbraid codegen`, then run:

```sh
sqlbraid codegen --check
```

Do not hand-edit generated models as the primary fix.

## Keep four axes independent

- **Dialect:** SQL surface, lexical rules, quoting, and primitive database semantics.
- **Driver:** value-binding transport, placeholders/native request construction, reuse, and result normalization.
- **Execution runtime:** physical lease ownership, transaction pinning, savepoints, and scope. Node/Bun/Deno host compatibility is separate deployment evidence.
- **Transaction profile:** explicit transaction/isolation behavior.

A dialect does not prove a driver. A driver does not prove a dialect. Neither alone proves transaction semantics or runtime compatibility. Report or change each axis only when its evidence is explicit.
