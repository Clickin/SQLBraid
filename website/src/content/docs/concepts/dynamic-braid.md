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

## `set` and `trim`

`set` builds the assignment list of an UPDATE. Write a trailing comma after each assignment. `set` removes the last one:

```ts
const update = sql.command`
  UPDATE users
  /*@braid set*/
    /*@braid if ${newName != null}*/ name = ${newName}, /*@braid end*/
    /*@braid if ${newAge != null}*/ age = ${newAge}, /*@braid end*/
  /*@braid end*/
  WHERE id = ${userId}
`;
// newName = "Ada", newAge = null  ->  UPDATE users SET name = ? WHERE id = ?
// newName = null,  newAge = null  ->  throws BRAID_EMPTY_SET before the database call
```

`trim` is the general form. `where` and `set` are `trim` with fixed attributes. Use `trim` for other cases, such as a parenthesized list:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE role IN
  /*@braid trim prefix="(" suffix=")" suffixOverrides=","*/
    /*@braid if ${roleA != null}*/ ${roleA}, /*@braid end*/
    /*@braid if ${roleB != null}*/ ${roleB}, /*@braid end*/
  /*@braid end*/
`;
// roleA = "x", roleB = "y"   ->  ... WHERE role IN (?, ?)
// roleA = "x", roleB = null  ->  ... WHERE role IN (?)
```

Rules for the attributes:

- `prefix` and `suffix` are added as written. Add the spaces yourself: `prefix="WHERE "`. Without the space, the result is `WHEREid = ?`.
- `prefixOverrides` and `suffixOverrides` list the tokens to remove, separated by `|`: `prefixOverrides="AND |OR "`. The match is not case sensitive. Only the first and the last token of the content are checked.
- If the content is empty, `trim` outputs nothing. It does not add the `prefix` or the `suffix`. In the list example above, if both roles are `null`, the SQL is `WHERE role IN` and the database rejects it. Guard that case with an outer `if`.

## Branches are lazy

**This guarantee requires SQLBraid compiler lowering.** Plain JavaScript, `tsc` and runtime tag calls evaluate each `${...}` before they call the tag. To get lazy branches, do these steps:

1. Install `@sqlbraid/cli` as a development dependency and `@sqlbraid/template` as a dependency. The generated code imports its helpers from `@sqlbraid/template`.
2. Build the guarded source with `pnpm exec sqlbraid build --file src/query.ts --out-file build/query.js`.
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

## What the compiler does

The compiler does **not** expand the SQL branches. It does not build one SQL string for each combination of conditions. It does not run your conditions at build time. SQL text and bound values are always made at runtime, from the values of that call.

The compiler changes only **when each `${...}` expression is evaluated**. In plain JavaScript, every `${...}` runs before the tag function is called. After lowering, an expression runs only if its branch is active, and it runs only once. This is a simplified view of the result for the query above:

<!-- doc-snippet: skip -->

```js
sql.rows(strings, (read) => {
  if (read(0, () => includePrivate)) {
    // inside the active branch only:
    if (read(1, () => loadPrivatePolicy())) {
      /* ... */
    }
  }
});
```

The runtime then renders the SQL and the parameter list from the directives and from the values that were evaluated.

| The compiler does                                                  | The compiler does not do                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Skip `${...}` in inactive branches and evaluate each one only once | Generate SQL variants or run conditions during the build |
| Keep the order of evaluation, lexical `this` and source maps       | Parse or check the SQL inside a branch                   |
| Keep the type of a query-bound Standard Schema mapper              | Transpile TypeScript or JSX (your bundler does this)     |
| Report `BRAID_ASYNC_CONTEXT` when it cannot lower a template       | Check types for you (use `sqlbraid check`)               |

Without the compiler, the SQL result is the same. Only the evaluation time of the JavaScript expressions differs. If the expressions in inactive branches are cheap and safe, you do not need the compiler.

## Choose branches

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/ ORDER BY name
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC
    /*@braid otherwise*/ ORDER BY id
  /*@braid end*/
`;
```

Only the first true `when` renders. SQLBraid does not parse or semantically validate the database-specific SQL inside a branch.

`sql.list([])` fails closed with `BRAID_EMPTY_LIST`. For the empty case, write
your own branch: `if`, `choose` or an explicit early return. SQLBraid does not
rewrite an empty list to `IN (NULL)`. It does not invent a strategy.
