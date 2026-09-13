# 0.1.0 public API freeze audit

Initial audit baseline: `1615311149cce6290976df3ed6e63e41dfe795d7`; PV13 extends the inventory from `d111e116d66ce9fc1b060881778ab1845874ef57`. All 16 npm packages and every manifest export subpath are inventoried below. This is an API classification, not a claim that release CI or registry publication has passed.

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

**Application:** `CallQuery`, `CommandExecutionResult`, `CommandQuery`, `CommandResult`, `Database`, `DatabaseOptions`, `ExecutableQuery`, `ExecutionEvent`, `ExecutionObserver`, `ExecutionResultOf`, `PreparedQuery`, `Query`, `QueryErrorEvent`, `QueryErrorStage`, `QueryExecutionResult`, `QueryMappedEvent`, `QueryReadyEvent`, `QueryResultEvent`, `QueryResultKind`, `QueryRow`, `RenderLimits`, `RoutineCallResult`, `RoutineResultSet`, `RowQuery`, `RowValidationOptions`, `RowsExecutionResult`, `RowsTag`, `SqlFragment`, `SqlRenderError`, `SqlTag`, `StandardSchemaV1`, `StreamEndEvent`, `StreamOptions`, `StreamStartEvent`, `TransactionEvent`, `TransactionEventPhase`.

**SPI:** `ConnectionLease`, `ConnectionProvider`, `Dialect`, `DialectLexicalProfile`, `QueryExecutor`, `RenderedQuery`, `TypeMapping`, `TypePolicy`.

**PV13 Application:** `BoundParameter`, `ParameterTypeHint` and `SqlTag.bind(value, hint)`.

**PV13 Advanced:** `createBoundParameter`, `createParameterTypeHint`, `isBoundParameter` share branded wrapper validation across template/compiler and first-party hint factories. `RenderedQuery.parameterHints` and executor/observer hint metadata are aligned with values.

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

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`.

## @sqlbraid/mysql/mysql2

**Application:** `createMysql2Database`, `createMysql2PoolDatabase`.

**SPI:** `Mysql2ConnectionLike`, `Mysql2FieldLike`, `Mysql2PoolConnectionLike`, `Mysql2PoolLike`, `Mysql2ResultHeader`, `createMysql2Executor`, `createMysql2PoolProvider`.

**Advanced:** `Mysql2DatabaseOptions`.

## @sqlbraid/mysql/inspector

**Advanced:** `createMysqlInspector`.

## @sqlbraid/operations

**Advanced:** `QueryManifest`, `QueryManifestEvidence`, `createManifest`, `createManifestFromEvidence`, `fingerprintQuery`, `fingerprintTemplate`, `templateFamilyFingerprint`, `templateFamilyFingerprintOf`.

## @sqlbraid/oracle

**Application:** `sql`, `oracleParameter`, `OracleNumberInput`, `OracleBinaryInput`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`. This root is portable and does not load node-oracledb.

## @sqlbraid/oracle/oracledb

**Application:** `createOracledbDatabase`, `createOracledbPoolDatabase`.

**SPI:** `OracleMetaDataLike`, `OracleResultSetLike`, `OracleExecuteResultLike`, `OracleBindLike`, `OracleExecuteOptionsLike`, `OracleConnectionLike`, `OraclePoolConnectionLike`, `OraclePoolLike`, `OracleDriverLike`, `createOracledbExecutor`, `createOracledbPoolProvider`.

**Advanced:** `OracleDatabaseOptions`.

## @sqlbraid/oracle/inspector

**SPI:** `OracleInspectorConnectionLike`.

**Advanced:** `createOracleInspector`.

## @sqlbraid/mssql

**Application:** `sql`, `mssqlParameter`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`. This root is portable and does not load Tedious.

## @sqlbraid/mssql/tedious

**Application:** `createTediousDatabase`, `createTediousPoolDatabase`.

**SPI:** `TediousColumnMetadataLike`, `TediousColumnLike`, `TediousRequestLike`, `TediousConnectionLike`, `TediousPoolConnectionLike`, `TediousPoolLike`, `createTediousExecutor`, `createTediousPoolProvider`.

**Advanced:** `TediousDatabaseOptions`, `TediousExecutorOptions`.

## @sqlbraid/mssql/inspector

**Advanced:** `createMssqlInspector`.

## @sqlbraid/postgres

**Application:** `sql`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`.

## @sqlbraid/postgres/pg

**Application:** `createPgDatabase`, `createPgPoolDatabase`.

**SPI:** `PgClientLike`, `PgFieldLike`, `PgPoolClientLike`, `PgPoolLike`, `PgResultLike`, `createPgExecutor`, `createPgPoolProvider`.

**Advanced:** `PgDatabaseOptions`.

## @sqlbraid/postgres/inspector

**Advanced:** `createPostgresInspector`.

## @sqlbraid/runtime

**Application:** `DatabaseCardinalityError`, `DatabaseResultKindError`, `DatabaseResultValidationError`, `DatabaseScopeError`, `createDatabase`, `createPooledDatabase`.

## @sqlbraid/sqlite

**Application:** `sql`.

**Advanced:** `createSqlTag`, `dialect`, `typePolicy`.

## @sqlbraid/sqlite/node-sqlite

**Application:** `createNodeSqliteDatabase`.

**SPI:** `SqliteColumnLike`, `SqliteDatabaseLike`, `SqliteStatementLike`, `createNodeSqliteExecutor`.

## @sqlbraid/sqlite/inspector

**Advanced:** `createSqliteInspector`.

## @sqlbraid/template

**Application:** `SqlRenderError`, `sql`.

**Advanced:** `SqlTagOptions`, `StructuralAnalysis`, `StructuralVariant`, `analyzeStructuralVariants`, `assertDirectiveCondition`, `capture`, `createSqlTag`, `guarded`, `parseTemplate`, `postgresDialect`, `renderTemplateIr`, `renderVariants`.

## @sqlbraid/tooling

**Application:** `defineConfig`.

**Advanced:** `CONFIG_NAMES`, `Cancellation`, `CodegenTargetConfig`, `CompletionItem`, `ConfigurationCancellationError`, `ConfigurationError`, `HoverResult`, `LanguageServiceOptions`, `LoadedConfig`, `Location`, `Position`, `QuerySymbol`, `SignatureResult`, `SourceDocument`, `SqlBraidConfig`, `SqlBraidLanguageService`, `ToolingDiagnostic`, `ToolingTarget`, `ToolingWorkspace`, `WorkspaceCancellationError`, `WorkspaceOptions`, `WorkspaceSymbol`, `createLanguageService`, `createWorkspace`, `loadConfig`, `validateConfig`.

