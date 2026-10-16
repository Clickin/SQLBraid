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

`DatabaseResultValidationError` (code `BRAID_RESULT_VALIDATION`) reports the validation stage (`query` or `execution`) and the failing row index. Its message never includes raw row values or bind parameters, while its `issues` property preserves the validator's issue list verbatim. Because some validation libraries attach the raw input value to each issue, redact `issues` before logging if rows contain sensitive data. Result mapping always transforms one row into one value—SQLBraid does not hydrate relations, maintain identity maps, or assemble object graphs.

Input parameter handling is intentionally minimal:

- Ordinary `${value}` interpolations are passed directly to the driver as bound parameters; SQLBraid does not include a custom input-codec layer.
- Exact numeric bind fidelity depends on the target driver's capabilities.
- `undefined` IN parameters fail before connection acquisition (`BRAID_BIND_VALUE_UNSUPPORTED`), while `null` binds as SQL `NULL`.
- JSON, date/time, and binary input values follow the target driver's native binding conventions.
