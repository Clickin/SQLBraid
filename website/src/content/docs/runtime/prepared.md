---
title: Prepared queries
description: Reuse a stable SQLBraid query shape without promising native driver preparation.
---

Register a named row-query factory:

```ts
const byId = db.prepare("user-by-id", () => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${userId}
`);

const user = await byId.maybeOne();
const all = await byId.all();
```

The factory is evaluated for each execution and renders once. SQLBraid records
the first logical shape (`resultKind`, canonical `segments`, and ordered hint
signature) as the shape lock. If a later execution changes that logical shape,
it throws `BRAID_PREPARED_SHAPE` before driver I/O. Changing values alone does
not change shape. Physical `$1`, `?`, `:1`, or `@p1` placeholder spelling is
transport-specific and does not participate in shape identity. Names must be
non-empty and unique (`BRAID_PREPARED_NAME`).

Prepared events expose the SQLBraid shape-lock name and effective binding plan
to observers. The driver chooses whether `auto`, `simple`, or `reuse` becomes
effective; runtime does not add a universal prepared cache. “Prepared” here
means a stable application query shape; it does not promise a native prepared
statement or server-side plan.
