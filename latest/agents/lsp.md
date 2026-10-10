# Agent-native LSP

> Use the standard Language Server Protocol to get SQLBraid evidence in coding agents.

SQLBraid ships a standard stdio LSP server. It uses `vscode-languageserver`. It is not a protocol only for VS Code. To start it, run:

```bash
sqlbraid-language-server --config ./sqlbraid.config.mjs
```

The server executes the SQLBraid config as Node code. The LSP has no workspace trust signal. Thus, start the server only in a project that you trust. The VS Code extension runs only in a trusted workspace. For other editors, configure the client so that it does not start the server automatically in an untrusted folder.

If an agent harness supports LSP, use LSP first for diagnostics, hover, completion, definition, references, document and workspace symbols, and signature help.

| LSP operation  | SQLBraid evidence                                                            |
| -------------- | ---------------------------------------------------------------------------- |
| Diagnostics    | Braid errors and mapped TypeScript errors that exist only in the overlay     |
| Completion     | Metadata candidates, only in static SQL                                      |
| Hover          | Query declaration, binds, dialect and known metadata facts                   |
| Definition     | The current generated declaration or property, or the metadata JSON location |
| References     | Positive lexical identity; ambiguous CTE and alias occurrences are omitted   |
| Symbols        | Query units and filtered metadata or generated declarations                  |
| Signature help | Routines, only when `argumentsComplete: true`                                |

Metadata is open-world positive evidence. The server does not declare missing tables, columns, routines, types, extensions, temporary objects, runtime UDFs or CTEs invalid. In an uncertain lexical context, the server gives less information. It does not give SQL errors. The server does not reconstruct an arbitrary SQL AST. It does not infer the result types of arbitrary SELECT statements.

Navigation to generated code checks the current source. Stale or missing output never gets invented offsets. `sqlbraid codegen --check` stays the authority on whether output is current.

- The workspace indexes each current tsconfig source file.
- Reference requests load candidates only when necessary. They use open unsaved documents first. They check for cancellation between files.
- The caches of parsed analysis and disk sources stay bounded.
- Ordinary hover and completion do not read the complete project.

SQLBraid does not require MCP for agent integration. LSP is the primary standard interface. If the harness cannot use LSP, use the CLI JSON fallback.
