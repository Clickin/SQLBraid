# @sqlbraid/codegen

Generate TypeScript models from SQLBraid metadata snapshots.

```sh
npm install @sqlbraid/codegen @sqlbraid/metadata @sqlbraid/postgres
```

```ts
import { generateModels } from "@sqlbraid/codegen";
import { parseSnapshotJson } from "@sqlbraid/metadata";
import { typePolicy } from "@sqlbraid/postgres";
import { readFile } from "node:fs/promises";

const snapshot = parseSnapshotJson(await readFile("metadata.json", "utf8"));
const result = generateModels(snapshot, { typePolicy });
console.log(result.source);
```

Use this package when database metadata is already available; inspectors live in the database dialect packages. See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
