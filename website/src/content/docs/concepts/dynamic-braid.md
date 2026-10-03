---
title: Dynamic @braid directives
description: Keep conditional SQL next to the statement and keep lazy evaluation.
---

The v1 directives are `if`, `choose`, `when`, `otherwise`, `where`, `set` and `trim`.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

- `where` adds `WHERE` only when a child emits SQL. It removes a leading `AND` or `OR`.
- `set` does the same for update assignments. If no assignment remains, it throws `BRAID_EMPTY_SET`.
- `trim` accepts the explicit attributes `prefix`, `prefixOverrides`, `suffix` and `suffixOverrides`.

## Branches are lazy

**This guarantee requires SQLBraid compiler lowering.** Plain JavaScript, `tsc` and runtime tag calls evaluate each `${...}` before they call the tag. To get lazy branches, do these steps:

1. Install `@sqlbraid/cli`.
2. Build the guarded source with `npx sqlbraid build --file src/query.ts --out-file build/query.js`.
3. Run the generated JavaScript.

After lowering, a guarded interpolation is captured only when its branch is active. This is important when a branch reads a value that is expensive, has state or is invalid in the current request:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid if ${includePrivate}*/
    /*@braid if ${loadPrivatePolicy()}*/
      WHERE visibility = 'private'
    /*@braid end*/
  /*@braid end*/
`;
```

The compiler lowers guarded templates to explicit capture statements. When `includePrivate` is false, `loadPrivatePolicy()` is not evaluated. The compiler cannot lower a guarded template if a top-level `await` or `yield` occurs in the guarded expression context. In that case, the compiler reports `BRAID_ASYNC_CONTEXT`. It does not change the evaluation order.

## Choose branches

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/ ORDER BY name /*@braid end*/
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC /*@braid end*/
    /*@braid otherwise*/ ORDER BY id /*@braid end*/
  /*@braid end*/
`;
```

Only the first true `when` renders. SQLBraid does not parse or semantically validate the database-specific SQL inside a branch.

`sql.list([])` fails closed with `BRAID_EMPTY_LIST`. For the empty case, write
your own branch: `if`, `choose` or an explicit early return. SQLBraid does not
rewrite an empty list to `IN (NULL)`. It does not invent a strategy.
