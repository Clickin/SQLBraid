# @sqlbraid/metadata

Types and utilities for SQLBraid database metadata snapshots: validation,
JSON parsing, canonicalization, hashing, identity, and drift comparison.

```sh
npm install @sqlbraid/metadata
```

```ts
import { readFile } from "node:fs/promises";
import {
  hashSnapshot,
  parseSnapshotJson,
  snapshotIdentity,
  validateSnapshot,
} from "@sqlbraid/metadata";

const snapshot = parseSnapshotJson(await readFile("metadata.json", "utf8")); // supplied snapshot
validateSnapshot(snapshot);
console.log(snapshotIdentity(snapshot), hashSnapshot(snapshot));
```

`MetadataSnapshot` contains namespaces, database types, relations, routines,
server details, and snapshot metadata. `MetadataInspector` is the small
interface for packages that obtain a snapshot. Use `diffSnapshots(before, after)`
to inspect changes; invalid input raises `SnapshotValidationError` with
structured diagnostics.

See the [metadata model guide](https://clickin.github.io/SQLBraid/metadata/models/)
and the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
