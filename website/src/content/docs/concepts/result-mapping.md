---
title: Standard Schema result mapping
description: Validate and transform rows without coupling SQLBraid to one schema library.
---

SQLBraid depends on the Standard Schema protocol, not on a particular validator. A schema can be bound to a query:

```ts
import * as v from "valibot";
import { sql } from "@sqlbraid/postgres";

const EventSchema = v.object({
  id: v.number(),
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

Routine contracts map their channels independently. `sql.call({ output,
resultSets: [UserSchema, PaymentSchema] as const, returnValue })` applies the
output schema to the scalar object, each tuple schema to rows in its matching
result set, and the return schema to the optional return/status value. Cursor
outputs are removed from scalar `output`; adapters consume and close their
resources before asynchronous mapping begins. A result-set count mismatch is
`BRAID_CALL_RESULT_SETS`, and a failed routine location is reported by
`BRAID_CALL_MAP`.

The pipeline is:

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError` uses code `BRAID_RESULT_VALIDATION`, reports the query or execution stage and row index, and does not dump raw rows or binds. Mapping is one row to one row: SQLBraid does not hydrate relations, maintain identity maps, or assemble object graphs.

The input side is deliberately smaller in 0.1.0. Ordinary value interpolation remains a driver-bound value; there is no universal application input codec framework yet. Driver-specific JSON, temporal, and binary conventions remain the driver's responsibility.
