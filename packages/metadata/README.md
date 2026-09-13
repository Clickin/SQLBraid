# @sqlbraid/metadata

Types, validation, JSON parsing, hashing, and positive-evidence snapshots for SQLBraid database metadata.

```sh
npm install @sqlbraid/metadata
```

```ts
import { parseSnapshotJson, validateSnapshot } from "@sqlbraid/metadata";
```

Metadata can describe routine names, directions, and return shapes, but it is open-world evidence: missing facts do not prove invalid SQL and routine argument lists may be incomplete. Persist snapshots for code generation and tooling; runtime behavior remains the adapter contract.

See the [metadata documentation](https://clickin.github.io/SQLBraid/metadata/models/) and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
