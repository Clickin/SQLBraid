---
title: CLI inspect fallback
description: Use bounded JSON inspection when an agent harness has no LSP client.
---

The CLI shares the tooling semantics used by the LSP server. Positions are 1-based in CLI commands:

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

Use `--config ./sqlbraid.config.mjs` when repository discovery is ambiguous. JSON is focused and bounded. Unresolved query evidence is reported as `resolved: false`; it is not an invalid-SQL claim.

A normal workflow is:

1. Discover the project config and metadata evidence.
2. Prefer LSP requests when available.
3. Fall back to one of the JSON inspection commands above.
4. If metadata or config changes, run `sqlbraid codegen` and then `sqlbraid codegen --check`.
5. Treat generated files as derived; never hand-edit them.

`sqlbraid check` can add ordinary TypeScript diagnostics, while inspect operations focus on SQLBraid evidence.
