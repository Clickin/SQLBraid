---
title: Diagnostics and error codes
description: Stable SQLBraid codes and the boundary each one protects.
---

SQLBraid runtime/compiler errors expose a `code` where provided by their error type. Thin adapter capability errors use the `BRAID_*` marker in the message; do not assume every adapter error has a `code` property. Driver errors retain their original identity.

Binding construction failures (placeholder generation, hint mapping, typed
request construction, or unsupported transport selection) use error stage
`"materialize"` and occur before lease acquisition or driver I/O. Driver/server/
network failures remain stage `"driver"`. A materialization error has
`executionStarted === false` and `executionCompleted === false`.

| Code | Meaning |
| --- | --- |
| `BRAID_RESULT_KIND` | Declared result kind disagreed with adapter result after execution. |
| `BRAID_RESULT_SETS_UNSUPPORTED` | An ordinary query or row stream returned additional statement/result sets, including materialized MySQL execution. `db.all`, `db.one`, `db.maybeOne`, and ordinary `db.execute` allow at most one row result set; use `db.call()` for multiple ordered routine result sets. |
| `BRAID_RESULT_VALIDATION` | Query-bound or execution-level Standard Schema validation failed. |
| `BRAID_TX_SCOPE` | A root/parent/sibling transaction handle escaped the active scope. |
| `BRAID_TX_CLOSED` | A transaction handle was used after its callback ended. |
| `BRAID_CONNECTION_POISONED` | Uncertain transaction control poisoned the physical resource. |
| `BRAID_STREAM_SCOPE` | Streaming attempted overlapping or same-resource work. |
| `BRAID_REENTRY` | Direct physical resource was re-entered concurrently. |
| `BRAID_RESULT_COLUMNS` | Adapter returned duplicate result labels. |
| `BRAID_CALL_UNSUPPORTED` | Adapter does not expose routine calls. |
| `BRAID_STREAM_UNSUPPORTED` | Adapter does not expose a streaming protocol. |
| `BRAID_CALL_RESULT_SETS` | A tuple routine contract declared a different number of result sets than the driver returned. |
| `BRAID_CALL_MAP` | A routine output, return value, or result-set row failed query-bound Standard Schema mapping; inspect its location. |
| `BRAID_CALL_CURSOR_TX_REQUIRED` | A PostgreSQL `refcursor` call requires an existing transaction-scoped database. |
| `BRAID_CALL_CURSOR` | A PostgreSQL refcursor output did not provide a usable portal name. |
| `BRAID_CALL_CURSOR_UNSUPPORTED` | The adapter cannot expose the requested cursor output as an application result set. |
| `BRAID_CALL_RETURN_UNSUPPORTED` | A query requested a return/status schema, but the driver call exposed no return/status channel. |
| `BRAID_RESOURCE_CLEANUP` | Closing, draining, or cancelling a driver resource failed; the physical lease is not treated as safely reusable. |
| `BRAID_INTEGER_MODE_UNSUPPORTED` | SQLite bigint mode needs `setReadBigInts` on Node, or the initialized `sqlite3` module and official OO1 statement on WASM. |
| `BRAID_PREPARED_NAME` | Prepared query name is empty or duplicated. |
| `BRAID_PREPARED_SHAPE` | A prepared query rendered a different structural shape. |
| `BRAID_BIND_HINT_CONTEXT` | A bound-value wrapper was used as a directive condition instead of a boolean expression. |
| `BRAID_BIND_HINT_UNSUPPORTED` | The adapter cannot honor the explicit type or one of its facets; execution is rejected before database I/O. |
| `BRAID_BIND_TYPE_REQUIRED` | Driver inference is ambiguous, including an untyped null in Oracle or SQL Server. |
| `BRAID_BIND_DECIMAL_EXACTNESS` | Tedious cannot safely encode the supplied decimal value through JavaScript numbers. |
| `BRAID_CALL_OUT_UNSUPPORTED` | The adapter cannot represent or safely identify the requested OUT/INOUT channel (for example MySQL's unproven prepared-CALL carrier). |
| `BRAID_EMPTY_LIST` | `sql.list([])` was used without an explicit empty strategy. |
| `BRAID_EMPTY_SET` | `@braid set` rendered no assignment. |
| `BRAID_DIALECT` | A fragment belongs to a different dialect. |
| `BRAID_ASYNC_CONTEXT` | Guarded lowering would change top-level await/yield evaluation context. |
| `BRAID_DIRECTIVE_UNTERMINATED` | A directive comment is missing its closing `*/`. |
| `BRAID_DIRECTIVE` | An `@braid` directive is empty or unknown. |
| `BRAID_CONDITION` | A guard does not contain exactly one interpolation with no additional text. |
| `BRAID_ATTRIBUTES` | Directive attributes are unsupported, malformed, or duplicated. |
| `BRAID_STRUCTURE` | Directive nesting or branch structure is invalid, including a missing `@braid end`. |
| `BRAID_HOLE_CONTEXT` | An interpolation appears inside a SQL literal or comment. |
| `BRAID_SQL_LEX` | A SQL literal or comment is unterminated. |
| `BRAID_ESCAPE` | A template contains an invalid cooked JavaScript escape. |
| `BRAID_DEPTH` | Template or rendered fragment nesting exceeds the configured limit. |
| `BRAID_STRUCTURE_LIMIT` | Rendered structural items exceed `maxStructuralItems`. |
| `BRAID_SQL_LIMIT` / `BRAID_BIND_LIMIT` | Rendered output exceeds configured limits. |

Compiler diagnostics include a source range and severity. CLI JSON uses 1-based positions; LSP uses standard 0-based positions. Do not turn missing metadata evidence into an invalid-SQL error: metadata is open-world.
