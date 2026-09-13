# @sqlbraid/core

Public SQLBraid contracts for rendered statements, execution, leases, observers, Standard Schema mapping, streaming, and routine results.

```sh
npm install @sqlbraid/core
```

Adapter authors implement `QueryExecutor.query`, `QueryExecutor.stream`, and `QueryExecutor.call` through the value-only `RenderedStatement` boundary. `QueryExecutor.call` returns normalized internal `DriverRoutineResult`; application code receives `RoutineCallResult<Output, Sets, ReturnValue>` with `output`, heterogeneous `resultSets`, and an optional `returnValue` after runtime mapping.

```ts
import type {
  DriverRoutineResult,
  RoutineCallResult,
  QueryExecutor,
} from "@sqlbraid/core";
```

See the [driver-author guide](https://clickin.github.io/SQLBraid/dev/agents/driver-author/) and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
