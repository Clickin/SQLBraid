# @sqlbraid/tooling

Node-first semantic tooling shared by the SQLBraid CLI and language server.

```sh
npm install @sqlbraid/tooling
```

```ts
import { createWorkspace } from "@sqlbraid/tooling";
const workspace = createWorkspace({ rootPath: process.cwd() });
```

Use this package to embed SQLBraid project analysis in editor or automation tools. It does not execute database queries or change `sql.call` routine contracts; runtime packages own physical leases, streaming, and routine result mapping.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
