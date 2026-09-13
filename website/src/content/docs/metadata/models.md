---
title: Row, Insert, and Update models
description: Understand the generated declarations and their conservative evidence rules.
---

`generateModels(metadata, options)` is pure and offline. It returns standalone TypeScript source, model names, diagnostics, metadata/policy provenance, and an options hash.

For a table with a numeric identity `id`, required `email`, and no generated/non-writable evidence, codegen emits:

```ts
export interface UsersRow {
  id: number;
  email: string;
}

export interface UsersInsert {
  id?: number;
  email: string;
}

export interface UsersUpdate {
  id?: number;
  email?: string;
}
```

- **Row** uses the TypePolicy `outputType`; database nullability adds `| null`.
- **Insert** uses `inputType`; nullable/default/identity columns are optional, while proven non-insertable/generated columns are omitted.
- **Update** uses `inputType`; included properties are optional, and proven non-updatable/generated columns are omitted. Identity alone is not a ban.

Views, materialized views, foreign, and virtual relations receive Row models only. Unknown relation kinds with columns receive a Row model plus a warning. Unsupported or unproven types remain `unknown`, never `any`; inspect diagnostics before consuming generated source.

Column names remain exact database keys as quoted TypeScript properties when needed. Namespace evidence and stable identity suffixes prevent collisions. Deterministic output does not depend on metadata capture timestamps or object insertion order.
