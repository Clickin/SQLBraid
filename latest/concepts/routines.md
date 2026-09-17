# Routine calls

> Author stored-procedure calls with explicit output, return, and heterogeneous result-set contracts.

Use `sql.call` when a database routine has channels beyond an ordinary row query. A call result has three independent channels:

- `output`: named scalar OUT/INOUT values;
- `resultSets`: ordered, materialized row sets, each of which may have a different row type;
- `returnValue`: an optional routine return/status value when the driver exposes one.

Ordinary row operations are single-result-set boundaries: `db.all`, `db.one`,
`db.maybeOne`, and ordinary `db.execute` allow at most one row result set.
`db.call` is the explicit multiple-result-set boundary and returns multiple
ordered routine result sets.

## Declare the application contract

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

`resultSets` is a tuple contract: the actual count must match the declared count, and each row is mapped with its corresponding schema. A bare `sql.call\`...\`` is allowed when no query-bound schemas are needed. Runtime mapping happens after the adapter has consumed and closed all materialized routine resources, so an async schema mapper does not retain a database lease.

A routine call without a result-set contract still returns `resultSets`; it is not a single-row generic. Scalar cursor values are never left in `output`.

## Mark parameter directions

Ordinary interpolation is an IN value. Routine-only helpers make direction and output names explicit:

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

`sql.out(name, hint?)` uses a logical `null` placeholder; `sql.inOut(name, value, hint?)` carries an initial value. Output names must be non-empty and unique. OUT/INOUT parameters are rejected before database I/O when used with `sql.rows` or `sql.command`; direction does not grant structural SQL semantics. Use the adapter's hint factory when the database requires a type descriptor. Direction and output name participate in prepared shape identity.

For PostgreSQL, `outputName` renames a positional CALL output. It does not select
a carrier column by name, even when it matches a different database OUT name.

## Result-set ordering and cleanup

The normalized order is:

1. explicit OUT/INOUT cursor result sets in parameter order;
2. implicit result sets in driver order;
3. emitted SELECT result sets in driver order.

Adapters that expose only emitted sets return those sets in server order. SQLBraid fetches or drains every set, closes every cursor/ResultSet/request resource, and only then releases or discards a physical lease. `db.all()` is intentionally buffered and accepts O(row-count) application memory; routine result sets are materialized in the same explicit way. Raw driver objects, portal names, and protocol carrier rows do not escape the application result.

Oracle CLOB/NCLOB outputs become strings and BLOB outputs become bytes.
Returned Lobs are read and destroyed before lease release; a failure in one
output still closes unvisited sibling Lobs and ResultSets.

## Database-specific boundaries

| Database                      | Routine behavior                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`             | Scalar OUT values come from the `CALL` output row. Mark refcursor OUT with `postgresParameter.refcursor()`; SQLBraid fetches and closes each transaction-bound portal and removes it from `output`. INOUT and refcursor INOUT are rejected with `BRAID_CALL_OUT_UNSUPPORTED`. A refcursor call requires an existing `db.tx(...)` scope; SQLBraid never creates a hidden transaction.                  |
| MySQL / `mysql2`              | Emitted heterogeneous SELECT result sets are supported. Prepared CALL OUT/INOUT is rejected with `BRAID_CALL_OUT_UNSUPPORTED`: mysql2 3.x exposes no proven public discriminator for the protocol's extra OUT carrier, so SQLBraid does not guess a carrier row. Stored functions cannot emit result sets.                                                                                            |
| MariaDB / Connector/Node.js   | Emitted heterogeneous SELECT result sets are supported. Prepared CALL OUT/INOUT is rejected with `BRAID_CALL_OUT_UNSUPPORTED`: Connector/Node.js does not expose a proven public OUT carrier for prepared calls. Stored functions cannot emit result sets.                                                                                                                                            |
| Oracle / `node-oracledb` Thin | Scalar OUT/IN OUT binds, explicit `SYS_REFCURSOR`/REF CURSOR outputs, and implicit results are normalized into `output` and `resultSets`. Every live `ResultSet` is closed before lease release. Use `oracleParameter.refCursor()` for cursor outputs.                                                                                                                                                |
| SQL Server / Tedious          | Ordinary SELECTs become emitted result sets and scalar OUTPUT values become `output`. To receive a T-SQL integer RETURN status, supply explicit `procedure: { name, parameterNames }` metadata in the `sql.call` contract; SQLBraid does not parse arbitrary `EXEC` text to guess procedure identity. `CURSOR VARYING OUTPUT` is rejected as an application cursor (`BRAID_CALL_CURSOR_UNSUPPORTED`). |
| SQLite adapters               | `db.call()` / `routine.call` is unsupported. This is an adapter API boundary, not a restriction on SQLite SQL. Scalar/aggregate/window functions registered with SQLite are used inside ordinary SQL; virtual-table/table-valued extensions are ordinary `sql.rows(...)` queries.                                                                                                                     |

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

The procedure metadata is an explicit native-driver seam, not a general stored-procedure DSL. The ordered names must match the call parameters. With native procedure metadata, the template contains only parameter interpolations and whitespace: the driver invokes the named procedure, so `EXEC` text is rejected rather than silently ignored.

## Routine streaming

SQLBraid exposes materialized `db.call()` only. `callStream()` is reserved and unimplemented, not a callable 1.0.0 API. Use `db.stream(sql.rows(...))` for ordinary row-producing queries and set-returning functions. Routine cursor result sets are not independent row streams.

See [SQL tags and result kinds](/SQLBraid/latest/concepts/sql-tags.md), [streaming](/SQLBraid/latest/runtime/streaming.md), and [diagnostics](/SQLBraid/latest/reference/errors.md).
