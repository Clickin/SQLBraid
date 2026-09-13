---
title: Agent-native LSP
description: Use standard language-server protocol for SQLBraid evidence in coding agents.
---

SQLBraid ships a standard stdio LSP server built on `vscode-languageserver`; it is not a VS Code-only protocol. Start it with:

```bash
sqlbraid-language-server --config ./sqlbraid.config.mjs
```

When an agent harness supports LSP, use LSP first for diagnostics, hover, completion, definition, references, document/workspace symbols, and signature help.

| LSP operation | SQLBraid evidence |
| --- | --- |
| Diagnostics | Braid errors and mapped overlay-only TypeScript errors |
| Completion | Metadata candidates in static SQL only |
| Hover | Query contract, binds, dialect, and known metadata facts |
| Definition | Current generated declaration/property or metadata JSON location |
| References | Positive lexical identity; ambiguous CTE/alias occurrences are omitted |
| Symbols | Query units and filtered metadata/generated declarations |
| Signature help | Routines only when `argumentsComplete: true` |

Metadata is open-world positive evidence. Missing tables, columns, routines, types, extensions, temporary objects, runtime UDFs, and CTEs are not declared invalid. Uncertain lexical contexts return less intelligence, not SQL errors. The server does not reconstruct an arbitrary SQL AST or infer arbitrary SELECT result types.

Generated navigation checks current source. Stale or missing output never receives invented offsets; `sqlbraid codegen --check` remains the freshness authority. The workspace indexes every current tsconfig source file. Reference requests load candidates lazily, prefer open unsaved documents, and check cancellation between files while parsed analysis and disk-source caches remain bounded. Ordinary hover/completion does not read the entire project.

SQLBraid does not require MCP for agent integration. LSP is the primary standard interface; use the CLI JSON fallback when the harness cannot speak LSP.
