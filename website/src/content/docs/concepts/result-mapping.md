---
title: Standard Schema result mapping
description: Validate and transform rows without coupling SQLBraid to one schema library.
---

SQLBraid depends on the Standard Schema protocol. It does not depend on one validator. You can bind a schema to a query:

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

The output of the schema becomes the row type of the query. Mapping applies in the same way to `all`, `one`, `maybeOne`, `batch`, prepared queries, streams and operations in a transaction scope. A schema at the execution level is applied in addition:

```ts
await db.all(events, { schema: ExtraSchema });
```

Exact database numerics arrive as strings. Approximate IEEE values arrive as
numbers. Select the application semantics in the schema. Do not change the
driver profile:

```ts
const Account = v.object({
  id: v.pipe(
    v.string(),
    v.transform((value) => BigInt(value)),
  ),
  amount: v.string(), // or v.transform(value => new Decimal(value))
});
```

`Decimal` and Money objects are choices of the application. They are not
SQLBraid dependencies. A schema cannot recover precision that a parsed JSON
number or a native temporal `Date` already lost.

- For numerics nested in JSON, use a lossless-text profile and a parser that the
  application selects.
- For fractional or offset temporal fidelity, use a tested text profile or a
  conversion in your SQL.

Routine declarations map their channels independently.
`sql.call({ output, resultSets: [UserSchema, PaymentSchema] as const, returnValue })`
applies:

- the output schema to the scalar object;
- each tuple schema to the rows in the matching result set;
- the return schema to the actual return or status value.

If a `returnValue` schema is declared, a successful `db.call()` result has a
required `returnValue` property with the output type of that schema. If the
driver channel is missing, the call fails with `BRAID_CALL_RETURN_UNSUPPORTED`.
If the selected target explicitly marks `routine.return-value` unsupported, the
same error occurs before lease acquisition. Bare declarations and declarations
without a return schema keep the property optional.

Cursor outputs are removed from the scalar `output`. Adapters read and close
their resources before the asynchronous mapping starts. A mismatch of the
result-set count is `BRAID_CALL_RESULT_SETS`. `BRAID_CALL_MAP` reports the
location of a failed routine mapping.

The pipeline is:

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError` uses the code `BRAID_RESULT_VALIDATION`. It reports the stage (query or execution) and the row index. It does not dump raw rows or binds. Mapping is one row to one row. SQLBraid does not hydrate relations, keep identity maps or assemble object graphs.

The input side is smaller in 1.0.0. This is intentional.

- Ordinary value interpolation stays a value that the driver binds. There is no
  universal input codec framework for applications yet.
- The fidelity of exact numeric binds is a separate driver capability.
- Ordinary `undefined` IN values fail before acquisition. `null` means SQL `NULL`.
- The driver stays responsible for its own JSON, temporal and binary conventions.
