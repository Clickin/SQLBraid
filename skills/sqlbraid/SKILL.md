---
name: sqlbraid
description: Use SQLBraid's standard LSP or CLI JSON tooling when working in SQLBraid TypeScript projects. Trigger for SQLBraid diagnostics, SQL hover/navigation/completion, metadata inspection, generated-model changes, codegen checks, or questions about dialect, driver, runtime, and transaction profiles.
---

# SQLBraid

Use the project's SQLBraid evidence instead of reconstructing SQL or database facts.

## Workflow

1. Find project evidence in `sqlbraid.config.mjs`, `sqlbraid.config.js`, `sqlbraid.config.cjs`, or `package.json` dependencies.
2. **LSP first:** when a standard language server is available, use ordinary LSP diagnostics, hover, completion, definition, references, document symbols, workspace symbols, and signature help where offered.
3. **CLI fallback:** when LSP is unavailable, use `sqlbraid inspect query --file <path> --line <1-based> --column <1-based> --json`, `sqlbraid inspect symbol <name> --json`, or `sqlbraid inspect diagnostics --file <path> --json`. Pass `--config <path>` when discovery is ambiguous. These use the same semantic core as LSP; `sqlbraid check` additionally reports ordinary TypeScript errors.
4. Treat metadata as open-world positive evidence. A missing relation, column, routine, type, built-in, extension object, runtime UDF, temporary object, or CTE is not proof that SQL is invalid. Do not infer a stronger fact when SQLBraid evidence is present.
5. Generated model files are derived artifacts. Change configuration or metadata, run `sqlbraid codegen`, then run `sqlbraid codegen --check`; never edit generated models manually.

## Four independent axes

Keep these facts separate in notes, diagnostics, and decisions:

- **Dialect:** SQL surface, lexical rules, quoting, and primitive database semantics.
- **Driver:** value-only binding transport, placeholders/native request construction, reuse, and result normalization. Logical `RenderedStatement` segments and atomic parameters remain transport-neutral.
- **Execution runtime:** physical lease ownership, transaction pinning, savepoints, and scope. Node/Bun/Deno host compatibility is separately tested deployment evidence.
- **Transaction profile:** explicit transaction/isolation behavior; do not infer it from a dialect or driver name.

A dialect does not prove a driver. A driver does not prove a dialect. Neither alone proves transaction semantics. Report each axis only when its evidence is explicit.
