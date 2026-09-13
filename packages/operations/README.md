# @sqlbraid/operations

Shared operation and execution-result helpers for SQLBraid database queries.

```sh
npm install @sqlbraid/operations
```

```ts
import type { QueryManifest } from "@sqlbraid/operations";
declare const manifest: QueryManifest;
void manifest;
```

Use this package for integrations that consume SQLBraid operation manifests and execution metadata. It does not expose raw driver cursors, requests, or routine carrier packets; applications receive normalized rows, `output`, heterogeneous `resultSets`, and optional `returnValue` through runtime contracts.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
