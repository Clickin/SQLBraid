---
title: CLI inspect fallback
description: Use bounded JSON inspection when an agent harness has no LSP client.
---

The CLI and the LSP server share the same tooling semantics. In CLI commands, positions start at 1.

Install the optional CLI in the project that runs these commands:

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

The config is executable Node code, and `inspect` runs the config that it finds. Thus, discovery starts at the directory of `--file` and stops at the current directory. It never runs a config above the current directory. If `--file` is outside the current directory, the command fails with exit code 2. Run inspect commands only in a repository that you trust.

If the discovery of the repository is ambiguous, use `--config ./sqlbraid.config.mjs`. The JSON output is focused and bounded. Unresolved query evidence has the value `resolved: false`. This does not claim that the SQL is invalid.

A normal workflow is:

1. Find the project config and the metadata evidence.
2. If LSP requests are available, use them first.
3. If not, use one of the JSON inspection commands above.
4. If the metadata or the config changes, run `sqlbraid codegen`. Then run `sqlbraid codegen --check`.
5. Treat generated files as derived files. Do not edit them manually.

`sqlbraid check` can add ordinary TypeScript diagnostics. The inspect operations give only SQLBraid evidence.
