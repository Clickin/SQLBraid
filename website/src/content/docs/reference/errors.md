---
title: Diagnostics and error codes
description: Stable SQLBraid codes and the boundary each one protects.
---

SQLBraid errors expose a stable `code` where the failure is generated. Driver errors retain their original identity.

| Code | Meaning |
| --- | --- |
| `BRAID_RESULT_KIND` | Declared result kind disagreed with adapter result after execution. |
| `BRAID_RESULT_VALIDATION` | Query-bound or execution-level Standard Schema validation failed. |
| `BRAID_TX_SCOPE` | A root/parent/sibling transaction handle escaped the active scope. |
| `BRAID_TX_CLOSED` | A transaction handle was used after its callback ended. |
| `BRAID_CONNECTION_POISONED` | Uncertain transaction control poisoned the physical resource. |
| `BRAID_STREAM_SCOPE` | Streaming attempted overlapping or same-resource work. |
| `BRAID_REENTRY` | Direct physical resource was re-entered concurrently. |
| `BRAID_RESULT_COLUMNS` | Adapter returned duplicate result labels. |
| `BRAID_CALL_UNSUPPORTED` | Adapter does not expose routine calls. |
| `BRAID_STREAM_UNSUPPORTED` | Adapter does not expose a streaming protocol. |
| `BRAID_PREPARED_NAME` | Prepared query name is empty or duplicated. |
| `BRAID_PREPARED_SHAPE` | A prepared query rendered a different structural shape. |
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
