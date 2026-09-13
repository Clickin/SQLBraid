# @sqlbraid/codegen

Generate TypeScript models from SQLBraid metadata snapshots.

```sh
npm install @sqlbraid/codegen @sqlbraid/metadata @sqlbraid/postgres
```

```ts
import { generateModels } from "@sqlbraid/codegen";
import { parseSnapshotJson } from "@sqlbraid/metadata";
import { typePolicy } from "@sqlbraid/postgres";

const snapshot = parseSnapshotJson(json);
const result = generateModels(snapshot, { typePolicy });
console.log(result.source);
```

Use this package when database metadata is already available; inspectors live in the database dialect packages. Generated row types do not infer arbitrary routine result-set tuples; declare `sql.call({ resultSets: [...] as const })` contracts at the query boundary.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
