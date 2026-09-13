# @sqlbraid/tooling

Node-first semantic tooling shared by the SQLBraid CLI and language server.

```sh
npm install @sqlbraid/tooling
```

```ts
import { createWorkspace } from "@sqlbraid/tooling";
const workspace = createWorkspace({ rootPath: process.cwd() });
```

Use this package to embed SQLBraid project analysis in editor or automation tools. See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
