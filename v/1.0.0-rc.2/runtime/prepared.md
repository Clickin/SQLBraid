# Prepared queries

> Reuse a stable SQLBraid query shape without promising native driver preparation.

Register a named input factory (required input by default):

```ts
const byId = db.prepare("user-by-id", (id: string) => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${id}
`);

const user = await byId.maybeOne("u_1");
const all = await byId.all("u_1", { schema: UserSchema });
for await (const row of byId.stream("u_1", { signal })) consume(row);
```

You may make the required-input contract explicit:

```ts
const byId = db.prepare(
  "user-by-id",
  (id: string) => sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`,
  { input: "required" },
);
```

Declare a zero-input factory explicitly with `{ input: "none" }`:

```ts
const users = db.prepare(
  "users",
  () => sql.rows<UserRow>`SELECT id, name FROM users`,
  { input: "none" },
);
await users.all({ signal });
```

The input shape is an explicit public contract rather than a guess from
`Function.length` or option-shaped input values. Optional, default, rest, and
wrapped one-input factories may declare `{ input: "required" }`. A required
input whose value is `undefined` is still an input; only the zero-input form
uses `PreparedQuery<never, Q>`. Pass one object when a query needs multiple
input fields:

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
the first logical shape—result kind, dialect, canonical `segments`, and ordered
hint/direction/output metadata—as the shape lock. Values may change. A later
shape change throws `BRAID_PREPARED_SHAPE` before driver I/O. Physical `$1`,
`?`, `:1`, and `@p1` placeholder spelling is transport-specific and never
changes shape identity. Names must be non-empty and unique (`BRAID_PREPARED_NAME`).

Prepared operations follow result kind:

- row queries expose `execute`, `all`, `one`, `maybeOne`, and `stream`;
- command and unknown queries expose `execute`;
- call queries expose `call`.

All operations take trailing options. Row operations accept schema and signal;
`stream` retains its physical lease through driver cleanup. An already-aborted
signal rejects with its `reason`; an active signal needs adapter cancellation and
otherwise fails before I/O with `UnsupportedFeatureError` /
`BRAID_CANCEL_UNSUPPORTED`.

Prepared means a stable SQLBraid application shape. The driver chooses whether
`auto`, `simple`, or `reuse` is effective; runtime does not add a universal
native prepared statement or server-plan cache. Prepared events expose the
shape-lock name and effective binding plan to observers.
