---
title: Row, Insert, and Update models
description: Learn the generated declarations and their conservative evidence rules.
---

`generateModels(metadata, options)` is pure and offline. It returns standalone TypeScript source, model names, diagnostics, the provenance of the metadata and the policy, and an options hash.

Take a table with a numeric identity `id`, a required `email` and no evidence of generated or non-writable columns. For this table, codegen emits:

```ts
export interface UsersRow {
  id: string;
  email: string;
}

export interface UsersInsert {
  id?: string;
  email: string;
}

export interface UsersUpdate {
  id?: string;
  email?: string;
}
```

- **Row** uses the TypePolicy `outputType`. Database nullability adds `| null`.
- **Insert** uses `inputType`. Nullable, default and identity columns are optional. Columns that are proven non-insertable or generated are omitted.
- **Update** uses `inputType`. The included properties are optional. Columns that are proven non-updatable or generated are omitted. Identity alone does not exclude a column.

Exact integer and decimal output types are canonical `string`. Approximate binary
types are `number`. Generated models do not silently decode exact strings to
`bigint` or a decimal object.

Views, materialized views, foreign relations and virtual relations get only Row models. Unknown relation kinds with columns get a Row model and a warning. Unsupported or unproven types stay `unknown`, never `any`. Inspect the diagnostics before you use the generated source.

Native parsed JSON roots use `unknown`, unless the selected profile proves a
narrower root shape. Scalar mappings also do not recursively certify arrays,
ranges, composites, objects, `sql_variant`, vectors or other containers. Before
you generate a nested application type, you need evidence for that container.

Column names stay exact database keys. When necessary, they are quoted TypeScript properties. Namespace evidence and stable identity suffixes prevent collisions. The deterministic output does not depend on the capture timestamps of the metadata or on the insertion order of objects.
