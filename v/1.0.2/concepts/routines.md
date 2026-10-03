# Routine calls

> Write stored-procedure calls with explicit declarations for output, return values and heterogeneous result sets.

Use `sql.call` when a database routine has more channels than an ordinary row query. A call result has three independent channels:

- `output`: named scalar OUT and INOUT values;
- `resultSets`: ordered, materialized row sets. Each set can have a different row type;
- `returnValue`: an optional return or status value of the routine, when the driver exposes one.

Ordinary row operations accept one result set only. `db.all`, `db.one`,
`db.maybeOne` and ordinary `db.execute` allow one row result set at most.
`db.call` is the explicit boundary for many result sets. It returns many ordered
routine result sets.

## Declare the application result

Attach Standard Schema validators at the query boundary:

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const refresh = sql.call({
  procedure: {
    name: "dbo.refresh_accounts",
    parameterNames: ["accountId", "generatedAt"],
  },
  output: OutputSchema,
  resultSets: [UserSchema, PaymentSchema] as const,
  returnValue: ReturnCodeSchema,
})`
  ${accountId} ${sql.out("generatedAt", mssqlParameter.datetime2())}
`;

const result = await db.call(refresh);
result.output.generatedAt;
result.resultSets[0].rows[0]; // UserSchema output
result.resultSets[1].rows[0]; // PaymentSchema output
result.returnValue;
```

`resultSets` is a tuple declaration. The actual count must match the declared count. Each row is mapped with the schema at the same position. If you do not need query-bound schemas, you can use a bare `sql.call\`...\``. Runtime mapping occurs after the adapter has read and closed all materialized routine resources. Thus, an async schema mapper does not keep a database lease.

A routine call without a result-set declaration still returns `resultSets`. It is not a single-row generic. Scalar cursor values are never left in `output`.

## Mark parameter directions

Ordinary interpolation is an IN value. Helpers that are only for routines make the direction and the output names explicit:

```ts
const call = sql.call({
  procedure: {
    name: "dbo.reconcile",
    parameterNames: ["accountId", "state", "message"],
  },
  output: OutputSchema,
})`
  ${accountId}
  ${sql.inOut("state", "pending", mssqlParameter.nvarchar(50))}
  ${sql.out("message", mssqlParameter.nvarchar(200))}
`;
```

- `sql.out(name, hint?)` uses a logical `null` placeholder.
- `sql.inOut(name, value, hint?)` carries an initial value.
- Output names must not be empty and must be unique.
- With `sql.rows` or `sql.command`, OUT and INOUT parameters are rejected before database I/O. A direction does not give structural SQL semantics.
- If the database requires a type descriptor, use the hint factory of the adapter.
- The direction and the output name are part of the prepared shape identity.

For PostgreSQL, `outputName` renames a positional CALL output. It does not select
a carrier column by name. This is also true when it matches a different database
OUT name.

## Result-set ordering and cleanup

The normalized order is:

1. explicit OUT/INOUT cursor result sets in parameter order;
2. implicit result sets in driver order;
3. emitted SELECT result sets in driver order.

Adapters that expose only emitted sets return those sets in server order. SQLBraid fetches or drains each set. It closes each cursor, ResultSet and request resource. Only then does it release or discard a physical lease. `db.all()` is buffered on purpose and uses application memory in proportion to the row count. Routine result sets are materialized in the same explicit way. Raw driver objects, portal names and protocol carrier rows do not escape into the application result.

Oracle CLOB and NCLOB outputs become strings. BLOB outputs become bytes. The
adapter reads and destroys returned Lobs before the lease release. If one output
fails, the adapter still closes the sibling Lobs and ResultSets that it did not
visit.

## Database-specific boundaries

| Database                      | Routine behavior                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`             | Scalar OUT values come from the `CALL` output row. Mark refcursor OUT with `postgresParameter.refcursor()`; SQLBraid fetches and closes each transaction-bound portal and removes it from `output`. INOUT and refcursor INOUT are rejected with `BRAID_CALL_OUT_UNSUPPORTED`. A refcursor call requires an existing `db.tx(...)` scope; SQLBraid never creates a hidden transaction.                     |
| MySQL / `mysql2`              | Emitted heterogeneous SELECT result sets are supported. Prepared CALL OUT/INOUT is rejected with `BRAID_CALL_OUT_UNSUPPORTED`: mysql2 3.x exposes no proven public discriminator for the protocol's extra OUT carrier, so SQLBraid does not guess a carrier row. Stored functions cannot emit result sets.                                                                                               |
| MariaDB / Connector/Node.js   | Emitted heterogeneous SELECT result sets are supported. Prepared CALL OUT/INOUT is rejected with `BRAID_CALL_OUT_UNSUPPORTED`: Connector/Node.js does not expose a proven public OUT carrier for prepared calls. Stored functions cannot emit result sets.                                                                                                                                               |
| Oracle / `node-oracledb` Thin | Scalar OUT/IN OUT binds, explicit `SYS_REFCURSOR`/REF CURSOR outputs, and implicit results are normalized into `output` and `resultSets`. Every live `ResultSet` is closed before lease release. Use `oracleParameter.refCursor()` for cursor outputs.                                                                                                                                                   |
| SQL Server / Tedious          | Ordinary SELECTs become emitted result sets and scalar OUTPUT values become `output`. To receive a T-SQL integer RETURN status, supply explicit `procedure: { name, parameterNames }` metadata in the `sql.call` declaration; SQLBraid does not parse arbitrary `EXEC` text to guess procedure identity. `CURSOR VARYING OUTPUT` is rejected as an application cursor (`BRAID_CALL_CURSOR_UNSUPPORTED`). |
| SQLite adapters               | `db.call()` / `routine.call` is unsupported. This is an adapter API boundary, not a restriction on SQLite SQL. Scalar/aggregate/window functions registered with SQLite are used inside ordinary SQL; virtual-table/table-valued extensions are ordinary `sql.rows(...)` queries.                                                                                                                        |

SQL Server example with explicit native procedure metadata:

```ts
const refresh = sql.call({
  procedure: {
    name: "dbo.refresh_accounts",
    parameterNames: ["accountId"],
  },
  resultSets: [AccountSchema] as const,
})`${accountId}`;
```

The procedure metadata is an explicit seam to the native driver. It is not a general stored-procedure DSL. The ordered names must match the call parameters. With native procedure metadata, the template contains only parameter interpolations, whitespace and commas. The driver calls the named procedure. Thus, `EXEC` text and other SQL text are rejected before I/O with `BRAID_CALL_PROCEDURE_INVALID`. They are not silently ignored.

## Routine streaming

SQLBraid exposes only the materialized `db.call()`. `callStream()` is reserved and not implemented. It is not a 1.0.0 API that you can call. For ordinary queries that produce rows, and for set-returning functions, use `db.stream(sql.rows(...))`. Routine cursor result sets are not independent row streams.

Read [SQL tags and result kinds](/SQLBraid/v/1.0.2/concepts/sql-tags.md), [streaming](/SQLBraid/v/1.0.2/runtime/streaming.md) and [diagnostics](/SQLBraid/v/1.0.2/reference/errors.md).
