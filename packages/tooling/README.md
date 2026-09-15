# @sqlbraid/tooling

Node-first semantic project tooling shared by the SQLBraid CLI and language
server. It analyzes source and metadata; it does not execute database queries.

```sh
npm install @sqlbraid/tooling
```

```ts
import { resolve } from "node:path";
import { createWorkspace } from "@sqlbraid/tooling";

const fileName = resolve("src/query.ts");
const source = [
  'import { sql } from "@sqlbraid/postgres";',
  "const query = sql.rows`SELECT id FROM users`;",
].join("\n");

const workspace = createWorkspace({ rootPath: process.cwd() });
workspace.setDocument(fileName, source);
const service = await workspace.service();
const diagnostics = service.diagnostics(source, fileName);
const symbols = service.documentSymbols(source, fileName);
workspace.dispose();
console.log(diagnostics, symbols);
```

`createLanguageService` works directly with supplied source and metadata.
`createWorkspace` adds document tracking, configuration loading, invalidation,
and disposal. The service provides diagnostics, hover, completion, definitions,
references, document/workspace symbols, and signature help. Configuration
helpers include `defineConfig`, `validateConfig`, and `loadConfig`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
