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

The factory is evaluated for each execution. SQLBraid records the first rendered structure as the shape lock. If a later execution changes its rendered structure, it throws `BRAID_PREPARED_SHAPE`. Names must be non-empty and unique (`BRAID_PREPARED_NAME`).

Prepared events expose the SQLBraid shape-lock name to observers. “Prepared” here means a stable application query shape; it does not promise a native prepared statement or server-side plan.
