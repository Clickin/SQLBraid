# @sqlbraid/codegen

Generate TypeScript relation models from an existing SQLBraid metadata
snapshot. Database-specific packages are responsible for obtaining snapshots
and supplying a matching `TypePolicy`.

```sh
npm install @sqlbraid/codegen @sqlbraid/metadata @sqlbraid/postgres
```

```ts
import { readFile, writeFile } from "node:fs/promises";
import { generateModels } from "@sqlbraid/codegen";
import { parseSnapshotJson } from "@sqlbraid/metadata";
import { typePolicy } from "@sqlbraid/postgres";

const metadata = parseSnapshotJson(await readFile("metadata.json", "utf8")); // supplied snapshot
const result = generateModels(metadata, { typePolicy });
await writeFile("database.generated.ts", result.source, "utf8");
console.log(result.models, result.diagnostics);
```

`CodegenOptions` supports relation filters, naming suffixes and overrides for
database types or individual columns. `CodegenResult` includes generated source,
model names, diagnostics, and metadata/type-policy/options hashes. Generation
targets relations; routine result-set shapes remain explicit query contracts.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
