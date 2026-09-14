# @sqlbraid/core

Public SQLBraid contracts for rendered statements, execution, leases, observers, Standard Schema mapping, streaming, and routine results.

```sh
npm install @sqlbraid/core
```

Adapter authors implement `QueryExecutor.query`, `QueryExecutor.stream`, and
`QueryExecutor.call` through the value-only `RenderedStatement` boundary. Every
operation uses `(statement, binding?, options?)`; `ExecutionOptions` carries an
optional `AbortSignal`, and row/stream options add Standard Schema validation.
`QueryExecutor.bulk` and `StatementBindingAdapter.describeBulk` are optional
command-only homogeneous DML capabilities. `QueryExecutor.call` returns
normalized internal `DriverRoutineResult`; application code receives
`RoutineCallResult<Output, Sets, ReturnValue>` with `output`, heterogeneous
`resultSets`, and an optional `returnValue` after runtime mapping.

`UnsupportedFeatureError` is the portable rejection type for missing
capabilities. It carries `feature`, a stable `BRAID_*` `code`, and `message`.
Active cancellation must be rejected before I/O with
`BRAID_CANCEL_UNSUPPORTED` when an adapter cannot cancel. Do not
buffer streams or guess routine carriers to fake an unsupported operation.

`TransactionOptions` contains `isolation` (`read-uncommitted`,
`read-committed`, `repeatable-read`, or `serializable`) and `readOnly`.
Adapters advertise which combinations they can honor; unsupported options
reject rather than silently changing an active transaction.

```ts
import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DriverRoutineResult,
  RenderedBulk,
  RoutineCallResult,
  QueryExecutor,
} from "@sqlbraid/core";
```

See the [driver-author guide](https://clickin.github.io/SQLBraid/dev/agents/driver-author/) and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
