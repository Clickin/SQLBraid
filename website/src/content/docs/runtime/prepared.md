---
title: Prepared queries
description: Reuse a stable SQLBraid query shape without promising native driver preparation.
---

Register a named input factory. By default, the input is required:

```ts
const byId = db.prepare(
  "user-by-id",
  (id: string) => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${id}
`,
);

const user = await byId.maybeOne("u_1");
const all = await byId.all("u_1", { schema: UserSchema });
for await (const row of byId.stream("u_1", { signal })) consume(row);
```

You can make the required input explicit:

```ts
const byId = db.prepare("user-by-id", (id: string) => sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`, {
  input: "required",
});
```

Declare a factory without input explicitly with `{ input: "none" }`:

```ts
const users = db.prepare("users", () => sql.rows<UserRow>`SELECT id, name FROM users`, { input: "none" });
await users.all({ signal });
```

The input shape is an explicit public rule. SQLBraid does not guess it from
`Function.length` or from input values that look like options.

- Optional, default, rest and wrapped one-input factories can declare
  `{ input: "required" }`.
- A required input with the value `undefined` is still an input. Only the form
  without input uses `PreparedQuery<never, Q>`.
- If a query needs many input fields, pass one object:

```ts
const byAccount = db.prepare(
  "account",
  (input: { accountId: string; includeClosed: boolean }) => sql.rows<UserRow>`
    SELECT id, name FROM accounts
    WHERE account_id = ${input.accountId}
      AND (closed = FALSE OR ${input.includeClosed})
  `,
);
await byAccount.all({ accountId: "a_1", includeClosed: false });
```

The factory is evaluated for each execution and renders once. SQLBraid records
the first logical shape as the shape lock: the result kind, the dialect, the
canonical `segments` and the ordered hint, direction and output metadata.

- Values can change.
- A later change of shape throws `BRAID_PREPARED_SHAPE` before driver I/O.
- The physical placeholder spelling `$1`, `?`, `:1` and `@p1` is specific to the
  transport. It never changes the shape identity.
- Names must not be empty and must be unique (`BRAID_PREPARED_NAME`).

Prepared operations follow the result kind:

- row queries expose `execute`, `all`, `one`, `maybeOne`, and `stream`;
- command and unknown queries expose `execute`;
- call queries expose `call`.

All operations take trailing options. Row operations accept a schema and a
signal. `stream` keeps its physical lease through the driver cleanup. If the
signal is already aborted, the operation rejects with its `reason`. An active
signal needs adapter cancellation. Without it, the operation fails before I/O
with `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`.

Prepared means a stable SQLBraid application shape. The driver selects if
`auto`, `simple` or `reuse` is effective. The runtime does not add a universal
native prepared statement or a server-plan cache. Prepared events expose the
name of the shape lock and the effective binding plan to observers.
