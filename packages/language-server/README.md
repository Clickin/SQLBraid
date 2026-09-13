# @sqlbraid/language-server

SQL-aware Language Server Protocol support for TypeScript projects.

```sh
npm install @sqlbraid/language-server
npx sqlbraid-language-server
```

Configure this command as a stdio server in your LSP client. It waits for LSP JSON-RPC messages on stdin; it is not an interactive shell or help command. The package exports `createLanguageService` for embedded integrations and `startStdioLanguageServer` from `@sqlbraid/language-server/stdio` for LSP clients.

Signature help and routine metadata remain positive evidence. The language server does not invent `sql.call` result-set schemas or alter runtime capability limits such as PostgreSQL transaction-bound refcursors, MySQL OUT/INOUT rejection, Oracle ResultSet cleanup, or SQL Server cursor-output limitations.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
