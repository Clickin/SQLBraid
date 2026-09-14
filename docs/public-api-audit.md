# 0.1.0 public API freeze audit

> PV14–PV16 delta (exact-revision verification pending): the execution SPI has cut over from
> `RenderedQuery` to immutable `RenderedStatement` (`segments` plus atomic
> `parameters`). Core now owns `parameterizedSql`,
> `createRenderedStatement`, and `createStatementBindingDescription`; drivers
> own `StatementBindingAdapter` materialization and named adapter exports.
> PV16 adds homogeneous `db.bulk()`, bulk binding/observer contracts, MariaDB,
> SQLite WASM/D1 subpaths and Oracle row-returning OUT parameters.
> This note records the intended API boundary, not a new SHA, CI result,
> runtime support label, or publication. Preserve the historical inventory and
> provenance below until the exact final revision is audited.

Initial audit baseline: `1615311149cce6290976df3ed6e63e41dfe795d7`; PV13 extends the inventory from `d111e116d66ce9fc1b060881778ab1845874ef57e`; PV15 starts at `2aa3067dcf0c03ccde58a2eca2940c383a73729e`. PV16 adds the MariaDB package and Browser/Cloud SQLite subpaths. All 18 npm packages and every manifest export subpath are inventoried below. This is an API classification, not a claim that release CI or registry publication has passed.

- **Application**: documented application authoring/execution/configuration API.
- **SPI**: documented low-level physical driver, provider, dialect, representation or inspector contract.
- **Advanced**: intentionally supported compiler/IR/metadata/codegen/evidence integration. These are not required for ordinary queries.

The template IR is dynamic Braid structure, not a SQL AST or semantic resolver. `capture`/`guarded` and `assertDirectiveCondition` support compiler-generated lowering. Structural variant helpers remain explicitly bounded advanced tooling, not a SQL proof mechanism. Language-server root service/type reexports are the existing embedded-server integration; the `/stdio` subpath is the transport integration. CLI `runCli` is the shared process-facing entry for the scoped executable and unscoped wrapper; `/config` intentionally shares the tooling configuration contract, including loading and validation for Node tooling. Driver `*Like` contracts and executor/provider factories are intentional custom-integration SPIs. No transaction-profile or isolation-selection API exists in 0.1.0.

`SqlBraidLanguageService.references(...)` is asynchronous: embedded consumers must await its `Promise<readonly Location[]>`. It scans the current project file index lazily, prefers open unsaved documents, and checks cancellation between files without making cache capacity a coverage limit.

## @sqlbraid/cli

**Advanced:** `runCli(argv)` invokes command parsing and preserves CLI error/exit-code handling in the current process. It is shared by both executable packages, not a second semantic engine.

## sqlbraid

Executable convenience wrapper; no named application exports and no driver dependency. Runtime/application APIs remain scoped under `@sqlbraid/*`.

## @sqlbraid/cli/config

**Application:** `defineConfig`.

**Advanced:** `CONFIG_NAMES`, `CodegenTargetConfig`, `ConfigurationCancellationError`, `ConfigurationError`, `LoadedConfig`, `SqlBraidConfig`, `loadConfig`, `validateConfig`.

## @sqlbraid/codegen

**Application:** `generateModels`.

**Advanced:** `CodegenDiagnostic`, `CodegenNamingOptions`, `CodegenOptions`, `CodegenRelationFilter`, `CodegenResult`, `CodegenTypeOverride`, `CodegenTypeOverrides`, `GeneratedRelationModel`.

## @sqlbraid/compiler

**Advanced:** `BindingSite`, `CompileDiagnostic`, `DetailedCheckResult`, `DiscoveredQuery`, `OverlayOptions`, `OverlayQueryType`, `SourceAnalysisResult`, `SourceMapOrigin`, `SourceRange`, `TransformedSource`, `TypeScriptCheckOptions`, `TypeScriptProjectContext`, `VirtualTypeScriptOverlay`, `checkProject`, `checkSource`, `checkSourceDetailed`, `createProjectContext`, `createVirtualOverlay`, `discoverQueries`, `emitSource`, `sourcePosition`, `transformSource`.

## @sqlbraid/core

**PV15 Application:** `RoutineContract`, `RoutineParameter`,
`RoutineParameterDirection`, `RoutineProcedure`, `RoutineSchema`,
`RoutineResultFromContract`, `RoutineResultSetTuple`, `RoutineMappingError`,
`RoutineMappingLocation`, `SqlTag.out()` and `SqlTag.inOut()`.
`RoutineCallResult<Output, Sets, ReturnValue>` replaces the single-row generic;
`CallQuery<Result>` carries the complete result contract.

**PV15 SPI:** `DriverRoutineResult`, `DriverRoutineResultSet`,
`RoutineResultSource`, `DriverCapabilityErrorCode`. `QueryExecutor.stream()` and `call()` are required
capability methods. Raw source metadata is not copied into application result sets.

**PV15 Advanced:** `createRoutineOutParameter`, `createRoutineInOutParameter`,
`isRoutineParameter`.

**Application:** `CallQuery`, `CommandExecutionResult`, `CommandQuery`, `CommandResult`, `Database`, `DatabaseOptions`, `ExecutableQuery`, `ExecutionEvent`, `ExecutionObserver`, `ExecutionResultOf`, `PreparedQuery`, `Query`, `QueryErrorEvent`, `QueryErrorStage`, `QueryExecutionResult`, `QueryMappedEvent`, `QueryReadyEvent`, `QueryResultEvent`, `QueryResultKind`, `QueryRow`, `RenderLimits`, `RoutineCallResult`, `RoutineResultSet`, `RowQuery`, `RowValidationOptions`, `RowsExecutionResult`, `RowsTag`, `SqlFragment`, `SqlRenderError`, `SqlTag`, `StandardSchemaV1`, `StreamEndEvent`, `StreamOptions`, `StreamStartEvent`, `TransactionEvent`, `TransactionEventPhase`.

PV18 command metadata keeps `CommandResult.insertId?: string` for exact
database-generated identities. `affectedRows`, `rowCount`, procedure status,
and bulk input counts remain safe operational `number` values; a custom
executor cannot satisfy this public SPI with an unsafe identity Number.

**SPI:** `ConnectionLease`, `ConnectionProvider`, `Dialect`, `DialectLexicalProfile`, `QueryExecutor`, `RenderedStatement`, `RenderedParameter`, `ParameterTransportKind`, `StatementBindingAdapter`, `StatementBindingContext`, `StatementBindingDescription`, `BindingDescription`, `LiteralizeOptions`, `LiteralizedSqlResult`, `TypeMapping`, `TypePolicy`.

**PV13 Application:** `BoundParameter`, `ParameterTypeHint` and `SqlTag.bind(value, hint)`.

**PV14 Advanced (pending):** `createBoundParameter`, `createParameterTypeHint`,
`isBoundParameter`, `createRenderedStatement`, `parameterizedSql`, and
`createStatementBindingDescription`. Observer parameterized/literalized SQL and
values/hints/maps are derived views; no parallel mutable statement arrays remain.

**PV16 Application:** `BulkResult`.

**PV16 SPI:** `RenderedBulk`, `BulkBindingDescription`, `BulkExecutionMode`,
`BulkExecutionResult`, `createRenderedBulk`, and `createBulkBindingDescription`. `QueryExecutor.bulk`
and `StatementBindingAdapter.describeBulk` are optional capabilities; bulk
materialization remains pre-acquire and command-only.

**Advanced:** `BindNode`, `ChooseNode`, `ChooseWhen`, `FragmentNode`, `IdentifierNode`, `IfNode`, `ListNode`, `RawNode`, `SQL_FRAGMENT`, `SourceRange`, `SqlTagLike`, `TemplateIr`, `TemplateNode`, `TextNode`, `TrimAttributes`, `TrimNode`.

## @sqlbraid/language-server

**Advanced:** `Cancellation`, `CompletionItem`, `HoverResult`, `LanguageServiceOptions`, `Location`, `LspStreams`, `QuerySymbol`, `SignatureResult`, `SourceDocument`, `SqlBraidLanguageService`, `StdioLanguageServerOptions`, `ToolingTarget`, `ToolingWorkspace`, `WorkspaceOptions`, `WorkspaceSymbol`, `createLanguageService`, `discoverQueries`, `sourcePosition`, `startStdioLanguageServer`.

## @sqlbraid/language-server/stdio

**Advanced:** `LspStreams`, `StdioLanguageServerOptions`, `startStdioLanguageServer`.

## @sqlbraid/metadata

**SPI:** `MetadataInspector`.

**Advanced:** `CURRENT_FORMAT_VERSION`, `ColumnSnapshot`, `ConstraintSnapshot`, `IndexSnapshot`, `MetadataSnapshot`, `NamespaceSnapshot`, `RelationSnapshot`, `RoutineArgument`, `RoutineArgumentMode`, `RoutineResult`, `RoutineSnapshot`, `ServerEvidence`, `SnapshotDiagnostic`, `SnapshotDrift`, `SnapshotMetadata`, `SnapshotValidationError`, `TypeKind`, `TypeSnapshot`, `canonicalizeSnapshot`, `diffSnapshots`, `hashSnapshot`, `parseSnapshotJson`, `snapshotIdentity`, `validateSnapshot`.

## @sqlbraid/mysql

**Application:** `sql`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`,
`typePolicyForProfile`, `representationProfiles`, `Mysql2JsonProfile`,
`Mysql2TemporalProfile`, `Mysql2RepresentationProfile`, `Mysql2ProfileOptions`,
`Mysql2ConnectionOptions`,
`MYSQL2_LOSSLESS_TEXT`, `MYSQL2_NATIVE`, `MYSQL2_JSON_TEXT`,
`MYSQL2_DATE_TEXT`.

PV18 profile descriptors are immutable and pair stable `id`, JSON/temporal
selection, TypePolicy provenance, and (for driver subpaths) connection options.
The default is the fidelity-first lossless-text profile; native/compatibility
profiles have their own TypePolicy and codegen mapping.

## @sqlbraid/mysql/mysql2

**PV15 SPI:** `Mysql2RawStreamLike`, `Mysql2RawCommandLike`,
`Mysql2RawConnectionLike`, `Mysql2FieldPayload`, `Mysql2Parameter`.
`Mysql2ExecutorOptions.streamHighWaterMark` bounds native delivery.

**Application:** `createMysql2Database`, `createMysql2PoolDatabase`.

**SPI:** `Mysql2ConnectionLike`, `Mysql2FieldLike`, `Mysql2PoolConnectionLike`, `Mysql2PoolLike`, `Mysql2ResultHeader`, `createMysql2Executor`, `createMysql2PoolProvider`, `mysql2StatementBinding` (PV14 pending verification).

**Advanced:** `Mysql2DatabaseOptions`.

**PV16 SPI:** `Mysql2PreparedStatementLike`. Bulk requires both connection
`prepare()` and `unprepare()` so closed handles cannot remain in mysql2's cache.

## @sqlbraid/mysql/inspector

**Advanced:** `createMysqlInspector`.

## @sqlbraid/mariadb

**Application:** `sql`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`,
`typePolicyForProfile`, `representationProfiles`, `MariaDbJsonProfile`,
`MariaDbTemporalProfile`, `MariaDbRepresentationProfile`, `MariaDbProfileOptions`,
`MariaDbConnectionOptions`,
`MARIADB_LOSSLESS_TEXT`, `MARIADB_NATIVE`, `MARIADB_JSON_TEXT`,
`MARIADB_DATE_TEXT`.

The MariaDB fidelity-first descriptor records `bigintAsNumber: false`,
`decimalAsNumber: false`, `insertIdAsNumber: false`, `autoJsonMap: false`,
`dateStrings: true`, and `timezone: "Z"`. Its native convenience profile is
separate evidence; mysql2-on-MariaDB is best-effort compatibility.

## @sqlbraid/mariadb/mariadb

**Application:** `createMariaDbDatabase`, `createMariaDbPoolDatabase`.

**SPI:** `MariaDbConnectionLike`, `MariaDbPoolConnectionLike`,
`MariaDbPoolLike`, `MariaDbFieldLike`, `MariaDbStreamLike`,
`createMariaDbExecutor`, `createMariaDbPoolProvider`,
`mariaDbStatementBinding`.

**Advanced:** `MariaDbExecutorOptions`, `MariaDbDatabaseOptions`.

## @sqlbraid/operations

**Advanced:** `QueryManifest`, `QueryManifestEvidence`, `createManifest`, `createManifestFromEvidence`, `fingerprintQuery`, `fingerprintTemplate`, `templateFamilyFingerprint`, `templateFamilyFingerprintOf`.

## @sqlbraid/oracle

**Application:** `sql`, `oracleParameter`, `OracleNumberInput`, `OracleBinaryInput`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`. This root is portable and does not load node-oracledb.

## @sqlbraid/oracle/oracledb

**Application:** `createOracledbDatabase`, `createOracledbPoolDatabase`.

**SPI:** `OracleMetaDataLike`, `OracleResultSetLike`, `OracleExecuteResultLike`, `OracleBindLike`, `OracleExecuteOptionsLike`, `OracleConnectionLike`, `OraclePoolConnectionLike`, `OraclePoolLike`, `OracleDriverLike`, `createOracledbExecutor`, `createOracledbPoolProvider`, `createOracledbStatementBinding`, `oracledbStatementBinding` (PV14 pending verification).

**Advanced:** `OracleDatabaseOptions`.

**PV16 SPI:** `oracleOutputOrdinals` maps rendered parameter positions to native
OUT ordinals shared by routine and materialized DML-returning execution.

## @sqlbraid/oracle/inspector

**SPI:** `OracleInspectorConnectionLike`.

**Advanced:** `createOracleInspector`.

## @sqlbraid/mssql

**Application:** `sql`, `mssqlParameter`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`. This root remains
portable and does not load Tedious. Native DECIMAL/NUMERIC/MONEY exact output
is unsupported when Tedious returns JavaScript Number; exact input uses a
character hint plus authored SQL CAST/CONVERT.

## @sqlbraid/mssql/tedious

**Application:** `createTediousDatabase`, `createTediousPoolDatabase`.

**SPI:** `TediousColumnMetadataLike`, `TediousColumnLike`, `TediousRequestLike`, `TediousConnectionLike`, `TediousPoolConnectionLike`, `TediousPoolLike`, `createTediousExecutor`, `createTediousPoolProvider`, `createTediousStatementBinding`, `tediousStatementBinding` (PV14 pending verification).

**Advanced:** `TediousDatabaseOptions`, `TediousExecutorOptions`.

## @sqlbraid/mssql/inspector

**Advanced:** `createMssqlInspector`.

## @sqlbraid/postgres

**Application:** `sql`, `postgresParameter.refcursor()`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`,
`typePolicyForProfile`, `representationProfiles`, `PgJsonProfile`,
`PgTemporalProfile`, `PgRepresentationProfile`, `PgRepresentationProfileOptions`.

PostgreSQL profile descriptors include `pg-lossless-text`, `pg-native`,
`pg-json-native-temporal-text`, and `pg-json-text-temporal-native`. Native JSON
maps to `unknown`; native
date/timestamp/timestamptz map to `Date`, while native time/timetz remain text
and interval remains open. Runtime and codegen must reuse the selected
descriptor.

## @sqlbraid/postgres/pg

**PV15 SPI:** `PgCursorLike`, `PgCursorFactory`, `PgExecutorOptions`.
The optional pg-cursor peer is loaded only for streaming; `streamBatchSize`
bounds cursor reads. Public cursor callback metadata drives row normalization.

**Application:** `createPgDatabase`, `createPgPoolDatabase`.

**SPI:** `PgClientLike`, `PgFieldLike`, `PgPoolClientLike`, `PgPoolLike`, `PgResultLike`, `createPgExecutor`, `createPgPoolProvider`, `pgStatementBinding` (PV14 pending verification).

**Advanced:** `PgDatabaseOptions`.

## @sqlbraid/postgres/inspector

**Advanced:** `createPostgresInspector`.

## @sqlbraid/runtime

**Application:** `DatabaseCardinalityError`, `DatabaseResultKindError`, `DatabaseResultValidationError`, `DatabaseScopeError`, `createDatabase`, `createPooledDatabase`.

## @sqlbraid/sqlite

**Application:** `sql`, `createSqliteWasmDatabase`, `createD1Database`.

**PV18 representation:** SQLite INTEGER storage is normalized to canonical
decimal `string`; native bigint is an internal transport detail, not a public
integer mode or TypePolicy selector. D1 remains guarded to the JavaScript
safe-integer range.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`.

## @sqlbraid/sqlite/node-sqlite

**Application:** `createNodeSqliteDatabase`.

**SPI:** `SqliteColumnLike`, `SqliteDatabaseLike`, `SqliteStatementLike`, `createNodeSqliteExecutor`, `nodeSqliteStatementBinding` (PV14 pending verification).

## @sqlbraid/sqlite/wasm

**Application:** `createSqliteWasmDatabase`.

**SPI:** `SqliteWasmDatabaseLike`, `SqliteWasmStatementLike`,
`createSqliteWasmExecutor`, `sqliteWasmStatementBinding`.

## @sqlbraid/sqlite/d1

**Application:** `createD1Database`.

**SPI:** `D1DatabaseLike`, `D1PreparedStatementLike`, `createD1Executor`,
`d1StatementBinding`.

## @sqlbraid/sqlite/inspector

**Advanced:** `createSqliteInspector`.

## @sqlbraid/template

**Application:** `SqlRenderError`, `sql`.

**Advanced:** `SqlTagOptions`, `StructuralAnalysis`, `StructuralVariant`, `analyzeStructuralVariants`, `assertDirectiveCondition`, `capture`, `createSqlTag`, `guarded`, `parseTemplate`, `postgresDialect`, `renderTemplateIr`, `renderVariants`.

## @sqlbraid/tooling

**Application:** `defineConfig`.

**Advanced:** `CONFIG_NAMES`, `Cancellation`, `CodegenTargetConfig`, `CompletionItem`, `ConfigurationCancellationError`, `ConfigurationError`, `HoverResult`, `LanguageServiceOptions`, `LoadedConfig`, `Location`, `Position`, `QuerySymbol`, `SignatureResult`, `SourceDocument`, `SqlBraidConfig`, `SqlBraidLanguageService`, `ToolingDiagnostic`, `ToolingTarget`, `ToolingWorkspace`, `WorkspaceCancellationError`, `WorkspaceOptions`, `WorkspaceSymbol`, `createLanguageService`, `createWorkspace`, `loadConfig`, `validateConfig`.

## @sqlbraid/vite

**Application:** default `sqlbraid()` Vite plugin, `SqlBraidViteOptions`,
`FilterPattern`.

**Advanced:** `transformSource`, `CompileDiagnostic`, `SourceMap`,
`TransformSourceOptions`, `TransformSourceResult` reexports from the compiler.
These are build-tool APIs; Vite/React/TanStack are not runtime dependencies.

