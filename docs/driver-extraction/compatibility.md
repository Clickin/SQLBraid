# Driver extraction compatibility

This is an implementation inventory and extraction assessment, not a support promotion.
Exact certified tuples remain in `support/targets/`.
Only pg and node:sqlite have experimental adapters.
Other rows describe existing SQLBraid code, not implemented experimental features.
Difficulty is an engineering assessment, not a measured migration estimate.

## Driver matrix

| Existing driver             | Native binding and ownership                                | Existing extensions and representation concerns                                                                                     | Classification / difficulty                                                      | Experimental status                                                 |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| PostgreSQL / pg             | `$N`; physical client or pool lease                         | Parser profiles; array rows; pg-cursor; abort terminates client; prepared-loop bulk; OUT rows and transaction-scoped refcursors     | Adaptable native dispatch; coupled full executor / medium                        | Materialized SELECT/DML, direct/pool, explicit transactions         |
| PostgreSQL / Neon WebSocket | Reuses pg executor; pooler configuration matters            | Transaction-mode poolers restrict preparation; retains pg execution structure                                                       | Adaptable dispatch; coupled pooler policy / medium                               | Not extracted                                                       |
| PostgreSQL / postgres.js    | `$N`, optional parameter OIDs; reserved connection          | Cursor streaming; prepared-loop bulk; reset/discard commands; no active cancellation or routines                                    | Adaptable native execution; coupled result/profile/reset policy / medium         | Not extracted                                                       |
| PostgreSQL / Neon HTTP      | Stateless full-response array queries                       | No pinned session, callback transaction, stream, or active cancellation; remote transaction batch for bulk                          | Adaptable query transport; different ownership model / medium                    | Not extracted                                                       |
| PostgreSQL / PGlite         | `$N`, optional OIDs; serialized in-process instance         | SQL transactions/savepoints and prepared-loop bulk; no stream, cancellation, or routines                                            | Adaptable materialized execution / medium                                        | Not extracted                                                       |
| MySQL / mysql2              | `?`; physical prepared Execute; direct/pool                 | Field-based normalization; raw Execute stream; abort destroys; prepared-loop bulk; emitted routine sets but no OUT carriers         | Coupled protocol, cleanup and conversion / high                                  | Not extracted                                                       |
| MariaDB connector           | `?`; native execute/batch; direct/pool                      | Metadata-driven rows; streaming uses text protocol with restricted binds; abort destroys; emitted sets, no OUT/INOUT                | Coupled transport-dependent parameter rules / high                               | Not extracted                                                       |
| SQLite / node:sqlite        | Positional binds; synchronous prepare/all/run; direct       | Bigint/array reads for SQLBraid; native iterator; no active cancellation; Deno streaming disabled                                   | Portable native materialization; application-specific projection / low for slice | Materialized SELECT/DML and explicit transactions; no pool invented |
| SQLite / better-sqlite3     | Positional binds; synchronous physical database             | Statement-local safe integers; BLOB handling; native iterate; prepared-loop bulk                                                    | Adaptable native materialization / medium                                        | Not extracted                                                       |
| SQLite / libSQL             | Client request with `intMode: "string"`; transaction handle | Transaction continuity can switch to dedicated handle; no pinned session or stream; local-file insert-ID fidelity limit             | Coupled ownership and transport evidence / high                                  | Not extracted                                                       |
| SQLite / WASM OO1           | Prepare/bind/step; owned statements                         | Exact integer reads use C API and statement pointer; stream finalizes; bulk reuses statement                                        | Adaptable native interface; coupled memory cleanup / medium                      | Not extracted                                                       |
| Cloudflare D1               | `?N`; raw response includes column-name header              | No pinned session, callback transaction, stream, cancellation, or routine; native batch; Number fidelity limits                     | Adaptable materialized API; distinct capabilities / medium                       | Not extracted                                                       |
| Oracle / node-oracledb Thin | Typed `:N` binds; direct/pool                               | Fetch handlers; NUMBER/LOB/temporal handling; ResultSet stream; break/drop; executeMany; OUT/INOUT; REF CURSOR and implicit results | Coupled typed transport and resource materialization / high                      | Not extracted                                                       |
| SQL Server / Tedious        | Typed `@pN` request; serialized connection                  | Precision/scale; bounded row events; request cancellation; prepare/execute/unprepare; native procedure OUTPUT/RETURN; no cursor OUT | Coupled request/event protocol and result channels / high                        | Not extracted                                                       |
| Bun.SQL / PostgreSQL        | Native value-template; reserved server connection           | No stream, active cancellation, or routine channels; native result metadata and ambiguous numeric shapes                            | Coupled native-template safety / high                                            | Not extracted                                                       |
| Bun.SQL / MySQL             | Native value-template; reserved server connection           | Driver reuse and result metadata differ from mysql2; unsupported paths remain explicit                                              | Coupled native-template safety / high                                            | Not extracted                                                       |
| Bun.SQL / MariaDB           | Native value-template; reserved server connection           | Separate tested database tuple; not inferred from MySQL host compatibility                                                          | Coupled native-template safety / high                                            | Not extracted                                                       |
| Bun.SQL / SQLite            | Native value-template; direct database                      | Native numeric/result evidence differs from node:sqlite; no fabricated stream/cancel support                                        | Coupled transport and representation / high                                      | Not extracted                                                       |

## Source evidence

The investigation inspected implementation imports, native calls, cleanup, and state ownership in these files:

- `packages/postgres/src/pg/executor.ts`, `pg/types.ts`, `common/binding.ts`, `common/results.ts`, and `common/type-overrides.ts`.
- `packages/postgres/src/neon.ts`, `postgres-js/executor.ts`, `neon-http/executor.ts`, and `pglite/executor.ts`.
- `packages/mysql/src/mysql2.ts` and `packages/mariadb/src/mariadb.ts`.
- `packages/sqlite/src/node-sqlite.ts`, `better-sqlite3.ts`, `libsql.ts`, `d1.ts`, and `wasm.ts`.
- `packages/oracle/src/oracledb.ts`, `packages/mssql/src/tedious.ts`, and `packages/bun-sql/src/index.ts`.
- Driver package manifests, `tests/certification/targets/inventory.ts`, and `tests/certification/contracts.ts`.

The runtime owns operation leasing, context checks, transaction scopes, and stream tracking.
Adapters own native conversion, cancellation, cursor/request cleanup, and physical discard.
The experimental lifecycle rejects overlap. It does not replace SQLBraid's serialized queues.

## Driver differences that must survive a larger extraction

### Transport and parameters

Do not translate all binding into a portable question-mark string.
PostgreSQL ordinals, MySQL positional Execute, Oracle named typed binds, Tedious requests,
and Bun value templates are different transport mechanisms.
SQLBraid's current binding description preserves these differences before acquisition.
The experiment accepts already-parameterized native text and supports only its two positional forms.

Bun can retain a native template or synthesize one from logical segments.
Those segments ensure every interpolated item is a value, not native structural SQL.
A text-only extension must not reconstruct that guarantee by parsing placeholders.
Native value-template support needs a separate optional input form and security fixtures.

### Values and metadata

Native driver values and SQLBraid's canonical values are different layers.
Exact numeric strings, parsed versus text JSON, temporal precision, and binary buffers need separate evidence.
The independent slice preserves configured native values and driver-specific column metadata.
The stable adapter still owns TypePolicy normalization and safe property projection.

An unsafe Number cannot become exact through `String(number)` or `BigInt(number)`.
SQLite and D1 transport limits must remain explicit.
Column metadata may describe a database type without proving the fidelity of the transported value.
Native object rows may overwrite duplicate labels. SQLBraid's duplicate-label checks remain unchanged.

### Prepared execution and counts

SQLBraid prepared handles preserve logical shape and render once.
Native reuse belongs to the adapter; a logical name does not promise a server statement of the same name.
The pg bulk cache also coordinates private pg parsed-statement registries.
That implementation detail is not a stable driver-neutral feature.

Command counts and generated values vary. The independent pg adapter exposes affected rows only for
native INSERT, UPDATE, DELETE, and MERGE command results. SELECT row count is not affected rows.
PostgreSQL has no generic native insert-ID channel. SQLite exposes its native last-insert-rowid value.
No extraction may invent a generated value from an unrelated result column.

### Streams, cancellation, transactions and discard

A live cursor holds physical ownership until cleanup completes.
An early MySQL stream return drains, while an abort destroys or discards.
PostgreSQL cancellation terminates a client. Oracle and Tedious expose different native cancellation primitives.
A synchronous SQLite method does not imply safe asynchronous cancellation.

Transaction continuity is stronger than JavaScript object identity.
A libSQL transaction handle can establish continuity while an HTTP request client cannot promise a pinned session.
Nested savepoints use the same resource. Unsupported isolation or read-only options must reject.
A failed commit has uncertain outcome; never automatically retry it or advertise a healthy connection.
Cleanup failure must poison or discard before another borrower can execute.

### Routines and result sets

Keep scalar outputs, cursor outputs, emitted result sets, and return status separate.
PostgreSQL refcursors require an existing transaction.
Oracle OUT ordinals must not shift with intervening IN values.
MySQL emitted sets do not establish OUT-carrier identity.
Tedious exposes real OUTPUT and RETURN metadata; it must not invent wrapper status.
The experimental interface supports none of these channels and rejects multiple pg result payloads.
No buffered or emulated fallback is included.

## Regression risks and verification

| Risk                                   | Existing evidence to preserve                                                  | Experimental evidence                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Root transaction escape or wrong lease | Runtime boundary and transaction-boundary suites; PostgreSQL `w01`             | Explicit single-lease lifecycle and Kysely transaction check              |
| Commit, rollback, release failure      | Runtime poison/discard and pool-initialization suites                          | Packed fault checks preserve failures and discard                         |
| Early stream return or mapping failure | `pv15-runtime`, `pv15-sqlite`, streaming conformance, real pg capability tests | Stream absent and capability false; no replacement claim                  |
| Cancellation with reusable pool        | Real PostgreSQL abort/discard tests and runtime portability                    | Pre-aborted/live signals reject before I/O; no cancellation support claim |
| Exact integer or hostile row labels    | Native SQLite and PostgreSQL representation suites                             | Native behavior demonstrated separately; stable projection unchanged      |
| Prepared shape or binding identity     | Runtime boundary, binding, prepared and bulk suites                            | Not implemented; no fake preparation                                      |
| Routines and multiple result sets      | Existing routine suites for relevant databases                                 | Explicitly unsupported                                                    |
| Packed dependency leakage              | Runtime-only packed gate and package validation                                | Isolated tarball consumer rejects SQLBraid package dependencies           |

See [verification](./verification.md) for commands actually run and their results.
Unit faults establish state transitions. Real database examples establish native execution and resource handling.
Neither alone establishes every supported database/runtime tuple.
