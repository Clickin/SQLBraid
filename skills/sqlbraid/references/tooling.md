# SQLBraid tooling evidence

In an existing SQLBraid project, use the semantic evidence of SQLBraid. Do not reconstruct SQL or database facts yourself.

## Discovery

Look for `sqlbraid.config.mjs`, `sqlbraid.config.js`, `sqlbraid.config.cjs`, existing SQLBraid imports and `package.json` dependencies. Do not change the dialect or the adapter only because another package also supports the same database.

## LSP first

When a standard language server is available, use the LSP features that it offers: diagnostics, hover, completion, definition, references, document symbols, workspace symbols and signature help.

## CLI fallback

When LSP is unavailable, use the JSON inspection surface:

```sh
sqlbraid inspect query --file <path> --line <1-based> --column <1-based> --json
sqlbraid inspect symbol <name> --json
sqlbraid inspect diagnostics --file <path> --json
```

The config is executable code. Run these commands from the project directory of a trusted repository. Discovery stops at the current directory, and a `--file` outside the current directory fails.

If the configuration discovery is ambiguous, pass `--config <path>`. These commands use the same semantic core as the LSP. `sqlbraid check` also reports ordinary TypeScript errors.

## Metadata is open-world

Treat metadata as positive evidence. It is not a closed-world catalog. If a relation, column, routine, type, built-in, extension object, runtime UDF, temporary object or CTE is absent, this does not prove that the SQL is invalid.

Do not replace explicit SQLBraid evidence with a stronger inference from general SQL knowledge.

## Generated models

Generated model files are derived artifacts. Change the configuration, filters, overrides or source metadata. Run `sqlbraid codegen`. Then run:

```sh
sqlbraid codegen --check
```

Do not edit generated models manually as the primary fix.

## Keep four axes independent

- **Dialect:** the SQL surface, lexical rules, quoting and primitive database semantics.
- **Driver:** the value-binding transport, placeholders or native requests, reuse and result normalization.
- **Execution runtime:** the ownership of physical leases, transaction pinning, savepoints and scope. Host compatibility with Node, Bun and Deno is separate deployment evidence.
- **Transaction profile:** explicit transaction and isolation behavior.

A dialect does not prove a driver. A driver does not prove a dialect. Neither one alone proves transaction semantics or runtime compatibility. Report or change an axis only when its evidence is explicit.
