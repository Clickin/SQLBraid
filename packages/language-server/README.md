# @sqlbraid/language-server

SQL-aware Language Server Protocol support for TypeScript projects.

```sh
npm install @sqlbraid/language-server
npx sqlbraid-language-server --config sqlbraid.config.mjs
```

```ts
import { startStdioLanguageServer } from "@sqlbraid/language-server/stdio";

startStdioLanguageServer();
```

Configure `sqlbraid-language-server` as a stdio server in an LSP client. It
reads LSP JSON-RPC messages from stdin and writes responses to stdout; it is
not an interactive shell. The command accepts an optional `--config` path.

For embedded integrations, the root export provides `createLanguageService`,
`discoverQueries`, `sourcePosition`, and `startStdioLanguageServer`. The
`@sqlbraid/language-server/stdio` subpath provides the stdio server entrypoint
and its stream/options types. Language features include diagnostics, hover,
completion, definitions, references, document and workspace symbols, and
signature help, using metadata supplied by the project.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
