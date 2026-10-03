---
title: Overrides and filters
description: Narrow generated relations and resolve type evidence explicitly.
---

Codegen options keep relation selection, naming and type representation separate:

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
only a decision about the emitted TypeScript. It cannot make a parsed or native
value lossless. It cannot certify a container.

- The filters include namespace and relation inclusion and exclusion, and relation `kinds`.
- Naming supports relation model names and row, insert and update suffixes.
- Type overrides are resolved independently for input and output. The precedence is: column override, then database-type override, then TypePolicy.

Invalid or colliding explicit names produce error diagnostics. Codegen does not silently change the requested name. Conflicting normalized policy entries produce `CODEGEN_AMBIGUOUS_TYPE_MAPPING`, and the affected type stays `unknown`. Overrides affect only the generated TypeScript. They do not transform the values that a driver returns.
