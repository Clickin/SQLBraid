# @sqlbraid/language-server

SQL-aware Language Server Protocol support for TypeScript projects.

```sh
npm install @sqlbraid/language-server
npx sqlbraid-language-server
```

Configure this command as a stdio server in your LSP client. It waits for LSP
JSON-RPC messages on stdin; it is not an interactive shell or help command.

The package exports `createLanguageService` for embedded integrations and `startStdioLanguageServer` from `@sqlbraid/language-server/stdio` for LSP clients. See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
