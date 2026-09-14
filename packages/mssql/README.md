# @sqlbraid/mssql

Microsoft SQL Server dialect, Tedious adapter, routine support, and conservative catalog inspector for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";

const query = sql.rows<{ id: number }>`SELECT id FROM dbo.users`;
const db = createTediousDatabase(connection);
const rows = await db.all(query);
```

SQL Server DML returning uses native `OUTPUT` syntax and the materialized
`sql.rows` APIs. SQLBraid does not promise rollback-safe
`db.stream(sql.rows\`... OUTPUT ...\`)` behavior because SQL Server may emit
rows before a later statement failure.

The `./tedious` and `./inspector` entry points require the optional `tedious` peer; the portable root does not load a driver. Row streaming uses Tedious Request row events with bounded pause/resume; lease release waits for request completion or discards the physical connection on cancellation.

Routine calls support emitted heterogeneous result sets and scalar OUTPUT/INOUT parameters when explicit hints are supplied. A T-SQL integer RETURN status requires explicit native procedure metadata in the query contract, including the procedure name and ordered Tedious parameter names:

```ts
const query = sql.call({
  procedure: { name: "dbo.refresh_accounts", parameterNames: ["accountId"] },
  resultSets: [AccountSchema] as const,
})`${accountId}`;
```

Native procedure metadata requires a parameter-only template; `EXEC` text is
rejected rather than ignored.

`CURSOR VARYING OUTPUT` is not exposed as an application cursor: ordinary database APIs do not bind it as a client result cursor, so a cursor-output hint is rejected with `BRAID_CALL_CURSOR_UNSUPPORTED`. If a batch consumes a local cursor and emits `SELECT` rows, those are ordinary emitted result sets. Tedious output/return failures remain explicit; SQLBraid never guesses a procedure identity from arbitrary `EXEC` text.

See the [SQL Server setup](https://clickin.github.io/SQLBraid/getting-started/mssql/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).
