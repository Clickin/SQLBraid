---
title: Dynamic @braid directives
description: Keep conditional SQL next to the statement while preserving lazy evaluation.
---

The v1 directives are `if`, `choose`, `when`, `otherwise`, `where`, `set`, and `trim`.

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

`where` adds `WHERE` only when a child emits SQL and strips a leading `AND` or `OR`. `set` does the same for update assignments and throws `BRAID_EMPTY_SET` when no assignment remains. `trim` accepts explicit `prefix`, `prefixOverrides`, `suffix`, and `suffixOverrides` attributes.

## Branches are lazy

**This guarantee requires SQLBraid compiler lowering.** Plain JavaScript, `tsc`, and runtime tag calls evaluate every `${...}` before invoking the tag. Install `@sqlbraid/cli`, build guarded source with `npx sqlbraid build --file src/query.ts --out-file build/query.js`, then run the generated JavaScript.

After lowering, a guarded interpolation is captured only when its branch is active. This matters when a branch reads a value that is expensive, stateful, or invalid in the current request:

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

The compiler lowers guarded templates to explicit capture statements. `loadPrivatePolicy()` is not evaluated when `includePrivate` is false. A guarded template cannot be lowered when a top-level `await` or `yield` appears in the guarded expression context; the compiler reports `BRAID_ASYNC_CONTEXT` instead of changing evaluation order.

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

`sql.list([])` fails closed with `BRAID_EMPTY_LIST`. Choose the caller-authored
branch (`if`, `choose`, or an explicit early return) for the empty case; SQLBraid
does not rewrite an empty list to `IN (NULL)` or invent a strategy.
