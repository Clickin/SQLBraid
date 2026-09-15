# SQLBraid public API audit

This inventory records the phase-J public boundary. It is an API classification,
not a publication or support claim. The last exact-SHA verification was revision
`8da8167e027320fcc9bb2aac16b0903c64147940` (Runtime
[34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046), Docs
[34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102),
Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)).
The current tree is newer and requires fresh evidence before labels change.

## Classification

- **Application** — intended query authoring, execution, mapping, and configuration API.
- **SPI** — physical driver, provider, binding, dialect, and evidence contracts.
- **Advanced** — compiler, metadata, codegen, tooling, and editor integration.

## `@sqlbraid/core`

**Application:** `CallQuery`, `CommandQuery`, `CommandResult`, `Database`,
`DatabaseOptions`, `ExecutableQuery`, `ExecutionEvent`, `ExecutionObserver`,
`ExecutionOptions`, `ExecutionResultOf`, `PreparedQuery`, `Query`,
`QueryExecutionResult`, `QueryResultKind`, `QueryRow`, `RowQuery`,
`RowValidationOptions`, `RowsExecutionResult`, `StreamOptions`, `TransactionOptions`,
`TransactionIsolation`, `RoutineCallResult`, `RoutineContract`,
`RoutineParameterDirection`, `RoutineProcedure`, `RoutineSchema`,
`RoutineResultFromContract`, `RoutineResultSet`, `RoutineResultSetTuple`,
`StandardSchemaV1`, `UnsupportedFeatureError`.

`Database` exposes `execute`, `all`, `one`, `maybeOne`, `call`, `batch`, `bulk`,
`prepare`, `stream`, `session`, and `tx`. All execution operations take trailing
options. Prepared queries are row-kind aware: row queries expose `execute`,
`all`, `one`, `maybeOne`, and `stream`; command/unknown queries expose `execute`;
call queries expose `call`. Input factories use
`prepare(name, (input) => query)` and zero-input factories use options as their
only execution argument.

**SPI:** `BindingDescription`, `BulkBindingDescription`, `BulkExecutionMode`,
`BulkExecutionResult`, `ConnectionLease`, `ConnectionProvider`, `Dialect`,
`DialectLexicalProfile`, `DriverRoutineResult`, `DriverRoutineResultSet`,
`EnvironmentCapability`, `EnvironmentOptions`, `EnvironmentSupportTarget`,
`QueryExecutor`, `RenderedBulk`, `RenderedParameter`, `RenderedStatement`,
`RoutineMappingLocation`, `RoutineResultSource`, `StatementBindingAdapter`,
`StatementBindingContext`, `StatementBindingDescription`, `TypeMapping`,
`TypePolicy`.

`QueryExecutor` methods use `(statement, binding?, options?)`; `bulk` is optional,
and transaction-control methods are optional capabilities. Provider and leases
must expose the same immutable statement-binding adapter identity. `UnsupportedFeatureError`
uses `(feature, code, message, options?)` with a `BRAID_${string}` code.

**Binding and render helpers:** `createBoundParameter`, `createBulkBindingDescription`,
`createParameterTypeHint`, `createRenderedBulk`, `createRenderedStatement`,
`createRoutineInOutParameter`, `createRoutineOutParameter`,
`createStatementBindingDescription`, `decodeExactDecimal`, `decodeExactInteger`,
`isBoundParameter`, `isRoutineParameter`, `normalizeExactInteger`,
`parameterizedSql`, `safeDatabaseCount`.

**Advanced template types:** `BindNode`, `ChooseNode`, `ChooseWhen`, `FragmentNode`,
`IdentifierNode`, `IfNode`, `ListNode`, `RawNode`, `RenderLimits`, `SQL_FRAGMENT`,
`SourceRange`, `SqlFragment`, `SqlRenderError`, `SqlTag`, `SqlTagLike`,
`TemplateIr`, `TemplateNode`, `TextNode`, `TrimAttributes`, `TrimNode`.

Canonical environment capability keys are `statement.prepare`,
`statement.stream`, `statement.bulk`, `transaction`, `transaction.savepoint`,
`routine.out`, `routine.result-sets`, `routine.out-cursor`, and
`routine.return-value`. Do not add old `execution.*` or `routine.resultsets`/
`routine.return-status` aliases.

## Dialect and driver packages

### `sqlbraid`

**Application:** the canonical runtime facade. The root re-exports common
contracts and runtime constructors without selecting a dialect. Combined
driver+dialect/query subpaths use the matching adapter:
`/pg`, `/mysql2`, `/mariadb`, `/node-sqlite`, `/sqlite-wasm`, `/d1`,
`/oracledb`, and `/tedious`. The `/bun-sql` subpath is a multi-dialect Bun.SQL
adapter; import `sql` from the selected dialect root and pass that dialect to
`createBunSqlDatabase`. Dialect-only subpaths
`/postgres`, `/mysql`, `/sqlite`, `/oracle`, and `/mssql` support custom
adapters. The facade has no CLI, database-driver, metadata, codegen, tooling,
compiler, editor, or Vite dependency.

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
const rows = await db.all(sql.rows`SELECT id FROM users`);
```

| Package | Application surface | SPI / advanced surface |
| --- | --- | --- |
| `@sqlbraid/postgres` | `sql`, `postgresParameter.refcursor()` | dialect, TypePolicy, representation profiles, `/pg`, `/inspector` |
| `@sqlbraid/mysql` | `sql` | dialect, TypePolicy, representation profiles, `/mysql2`, `/inspector` |
| `@sqlbraid/mariadb` | `sql` | dialect, TypePolicy, representation profiles, `/mariadb`, `/inspector` |
| `@sqlbraid/bun-sql` | `createBunSqlDatabase`, `createBunSqlProvider` | Bun.SQL multi-dialect adapter; requires a user-selected `postgres`, `mysql`, `mariadb`, or `sqlite` dialect |
| `@sqlbraid/sqlite` | `sql` | dialect, TypePolicy, `/node-sqlite`, `/wasm`, `/d1`, `/inspector` |
| `@sqlbraid/oracle` | `sql`, `oracleParameter` | portable dialect/TypePolicy, `/oracledb`, `/inspector` |
| `@sqlbraid/mssql` | `sql`, `mssqlParameter` | portable dialect/TypePolicy, `/tedious`, `/inspector` |

Portable dialect roots do not load optional native driver dependencies. A
subpath adapter must preserve the logical value boundary, expose a stable
binding adapter, and report unsupported capabilities explicitly. Bun's adapter
family accepts a user-selected PostgreSQL/MySQL/MariaDB/SQLite dialect; it does
not auto-detect. Deno uses existing driver subpaths where the driver API works.
These runtime statements are compatibility guidance, not Official support labels.

## Runtime and tooling packages

- `@sqlbraid/runtime`: `createDatabase`, `createPooledDatabase`,
  `DatabaseCardinalityError`, `DatabaseResultKindError`,
  `DatabaseResultValidationError`, and `DatabaseScopeError`.
- `@sqlbraid/template`: configured SQL tags, fragments, directives, and `sql.bind`.
- `@sqlbraid/compiler`: source analysis, diagnostics, lowering, source maps, and
  `transformSource`.
- `@sqlbraid/vite`: Vite pre-transform; Vite remains responsible for TS/JSX.
- `@sqlbraid/metadata`: snapshots, validation, hashing, drift, and inspectors' model.
- `@sqlbraid/codegen`: pure `generateModels` and deterministic model source.
- `@sqlbraid/tooling`: Node-first config/workspace/evidence services.
- `@sqlbraid/operations`: fingerprints and declaration manifests.
- `@sqlbraid/cli`: optional CLI process entry point; install it separately for
  codegen, inspect, diagnostics, and drift commands.
- `@sqlbraid/language-server`: embedded service and standard stdio LSP transport.

Runtime packages do not acquire metadata, compiler, codegen, tooling, editor, or
Vite dependencies. Metadata is open-world positive evidence; absent objects do
not become invalid-SQL diagnostics.

## Deliberate nonfeatures

There is no universal input codec, SQL/result rewriting interceptor, automatic
retry/router, hidden transaction, complete SQL grammar, ORM graph hydration,
universal prepared cache, or fabricated stream/call fallback. `db.environment()`
is observational and returns `compatible` when no exact verified target matches.
A neighboring runtime, server version, profile option, or local test cannot
promote an unverified tuple.
