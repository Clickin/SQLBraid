# @sqlbraid/operations

Manifest and fingerprint helpers for build, inspection, and deployment
integrations around SQLBraid queries.

```sh
npm install @sqlbraid/operations @sqlbraid/postgres
```

```ts
import { sql } from "@sqlbraid/postgres";
import {
  createManifest,
  fingerprintQuery,
  templateFamilyFingerprint,
} from "@sqlbraid/operations";

const query = sql.rows<{ id: string }>`SELECT id FROM users`;
const manifest = createManifest(query, {
  source: "src/queries/users.ts",
  resultType: "User",
});

console.log(manifest, fingerprintQuery(query), templateFamilyFingerprint(query));
```

`QueryManifest` records the value-sensitive `fingerprint`, the
template-shape `templateFamilyFingerprint`, the result kind, and optional
variant, source, and result-type fields. `fingerprintTemplate` and
`templateFamilyFingerprintOf` operate directly on a `TemplateIr` and values
when a query object is not available. The package does not execute queries.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
