---
title: Overrides and filters
description: Narrow generated relations and resolve type evidence explicitly.
---

Codegen options separate relation selection, naming, and type representation:

```ts
const generated = generateModels(metadata, {
  typePolicy,
  filters: {
    includeNamespaces: ["public"],
    excludeRelations: ["public.internal_events"],
    kinds: ["table"],
  },
  naming: {
    relations: { "public.user_account": "User" },
    suffixes: { row: "Row", insert: "Insert", update: "Update" },
  },
  typeOverrides: {
    databaseTypes: {
      jsonb: { inputType: "unknown", outputType: "unknown" },
    },
    columns: {
      "public.events": {
        created_at: { outputType: 'import("./domain.js").CompactDateTime' },
      },
    },
  },
});
```

Pass the TypePolicy from the same runtime representation profile. An override is
an emitted-TypeScript decision only; it cannot make a parsed/native value
lossless or certify a container.

Available filters include namespace/relation inclusion and exclusion plus relation `kinds`. Naming supports relation model names and row/insert/update suffixes. Type overrides are independently resolved for input and output. Precedence is column override, database-type override, then TypePolicy.

Invalid or colliding explicit names produce error diagnostics instead of silently changing the requested name. Conflicting normalized policy entries produce `CODEGEN_AMBIGUOUS_TYPE_MAPPING`, and the affected type remains `unknown`. Overrides affect generated TypeScript only; they do not transform values returned by a driver.
