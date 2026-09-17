---
title: Standard Schema result mapping
description: Validate and transform rows without coupling SQLBraid to one schema library.
---

SQLBraid depends on the Standard Schema protocol, not on a particular validator. A schema can be bound to a query:

```ts
import * as v from "valibot";
import { sql } from "sqlbraid/postgres";

const EventSchema = v.object({
  id: v.pipe(v.string(), v.transform(Number)),
  payload: v.string(),
});

const events = sql.rows(EventSchema)`
  SELECT id, payload FROM events
`;
const rows = await db.all(events);
```

The schema output becomes the query row type. Mapping applies consistently to `all`, `one`, `maybeOne`, `batch`, prepared queries, streams, and transaction-scoped operations. An execution-level schema is additive:

```ts
await db.all(events, { schema: ExtraSchema });
```

Exact database numerics arrive as strings; approximate IEEE values arrive as
numbers. Choose application semantics in the schema rather than changing the
driver profile:

```ts
const Account = v.object({
  id: v.pipe(v.string(), v.transform(BigInt)),
  amount: v.string(), // or v.transform(value => new Decimal(value))
});
```

`Decimal`/Money objects are application choices and are not SQLBraid
dependencies. A schema cannot recover precision already lost by a parsed JSON
number or a native temporal `Date`. For JSON nested numerics, use a
lossless-text profile and an application-selected parser; for fractional or
offset temporal fidelity, use a tested text profile or an authored SQL
conversion.

Routine contracts map their channels independently. `sql.call({ output,
resultSets: [UserSchema, PaymentSchema] as const, returnValue })` applies the
output schema to the scalar object, each tuple schema to rows in its matching
result set, and the return schema to the actual return/status value. When a
`returnValue` schema is declared, successful `db.call()` results have a required
`returnValue` property with that schema's output type; a missing driver channel
fails with `BRAID_CALL_RETURN_UNSUPPORTED`. When the selected target explicitly
marks `routine.return-value` unsupported, the same error is rejected before
lease acquisition. Bare and no-return-schema contracts keep the property
optional. Cursor
outputs are removed from scalar `output`; adapters consume and close their
resources before asynchronous mapping begins. A result-set count mismatch is
`BRAID_CALL_RESULT_SETS`, and a failed routine location is reported by
`BRAID_CALL_MAP`.

The pipeline is:

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError` uses code `BRAID_RESULT_VALIDATION`, reports the query or execution stage and row index, and does not dump raw rows or binds. Mapping is one row to one row: SQLBraid does not hydrate relations, maintain identity maps, or assemble object graphs.

The input side is deliberately smaller in 0.1.0. Ordinary value interpolation
remains a driver-bound value; there is no universal application input codec
framework yet. Exact numeric bind fidelity is a separate driver capability, and
`undefined` ordinary IN values fail before acquisition while `null` means SQL
`NULL`. Driver-specific JSON, temporal, and binary conventions remain the
driver's responsibility.
