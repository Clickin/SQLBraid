# @sqlbraid/core

The low-level contracts package for SQLBraid adapter and integration authors.
It defines query types, rendered statements, execution boundaries, result
mapping, observers, transactions, and capability errors; it does not connect
to a database.

```sh
npm install @sqlbraid/core
```

```ts
import type {
  Database,
  DriverRoutineResult,
  QueryExecutor,
  RenderedStatement,
  RoutineCallResult,
} from "@sqlbraid/core";
```

An adapter implements `QueryExecutor.query`, `stream`, and `call` using a
`RenderedStatement`. The statement has SQL `segments` and value-only
`parameters`; its optional `nativeTemplate` preserves native tagged-template
transport when an adapter supports it. `bulk` and transaction methods are
optional executor capabilities. `Database` is the application-facing contract
implemented by the runtime package.

`RoutineCallResult` represents normalized routine output as `output`, ordered
`resultSets`, and an optional `returnValue`. `ExecutionOptions` and
`RowValidationOptions` carry an optional `AbortSignal` and Standard Schema row
validation. Use `UnsupportedFeatureError` when an adapter cannot honor a
requested capability rather than silently changing the operation.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the
[routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
