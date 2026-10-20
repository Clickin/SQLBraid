# Driver extraction investigation

Status: experimental. Baseline: `a99811f82ca80c0a230975fef82ddfda5c925e71`.
Branch: `experiment/driver-abstraction-extraction`.
No package publication or stable version change is authorized.

## Initial decision, before implementation

Prototype a minimal physical driver SPI, not a second SQLBraid runtime.
The seam is native SQL text, ordered parameters, native rows, and native metadata.
The SQL generator owns placeholders. The driver owns parameter transport.
The experiment must not parse SQL to recover template segments.

The existing `QueryExecutor` is not independent. Its input is `RenderedStatement`.
Its mandatory stream and call methods also require explicit unsupported implementations.
The existing binding SPI uses SQLBraid hints, result declarations, fingerprints, and diagnostics.
Moving those interfaces unchanged would move coupling, not remove it.

Extract only the native materialized dispatch operations for pg and node:sqlite.
SQLBraid keeps binding, parser configuration, row projection, and lifecycle orchestration.
Both consumers use the same native dispatch implementation.
The experimental package must have no dependency on SQLBraid packages.
Stable packages bundle the shared source for this experiment; they do not acquire a private runtime dependency.
This is a removable source-sharing experiment, not a proposed publication arrangement.

## Classified dependency map

An arrow in the Dependencies column means an import or a runtime call.
Classification concerns the current implementation, not the name of a type.

| Module                                                      | Dependencies and state ownership                                                                   | Classification       | Extraction action                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `core/executor.ts`                                          | `binding`, `statement`, `query`, `routine`, `environment`; no connection state                     | Adaptable            | Replace statement input and separate optional extensions                 |
| `core/statement.ts`, `core/binding.ts`                      | Rendered segments, hints, directions, result kind; binding identity and literalization             | Coupled              | Keep in SQLBraid                                                         |
| `core/query.ts`, `core/database.ts`                         | Template IR, result declarations, Standard Schema, scoped database methods                         | Application-specific | Keep in SQLBraid                                                         |
| `core/driver.ts`                                            | Result property safety, projection and cleanup helpers                                             | Adaptable            | Reuse only where semantics match; do not import core into experiment     |
| `runtime/state.ts`                                          | WeakMap keyed by physical ownership; direct and transaction queues; async context; poisoned state  | Coupled              | Preserve existing runtime ownership unchanged                            |
| `runtime/operations/lease.ts`                               | Provider acquisition, binding identity, capability checks, pinned resource and release             | Adaptable            | Ownership rules are reusable; implementation assumes runtime scope state |
| `runtime/operations/materialized.ts`                        | Query preparation, observers, execution, release, result-kind checks, schema mapping               | Coupled              | Do not move orchestration wholesale                                      |
| `runtime/operations/stream.ts`                              | Stream state, iterator cleanup, lease lifetime, mapping and observers                              | Coupled              | Leave stable stream path unchanged                                       |
| `runtime/index.ts` transaction/session paths                | Scoped database construction, async context, savepoint nesting, observer events and poison/discard | Coupled              | Preserve; do not duplicate in the minimal SPI                            |
| `postgres/pg/executor.ts` native query dispatch             | Physical pg client and native request/result; SQLBraid policy is applied around dispatch           | Portable             | Extract native dispatch; retain normalization outside                    |
| `postgres/common/binding.ts`                                | Rendered statement identity, hint checks, transport and reuse description                          | Coupled              | Keep SQLBraid-specific lowering outside                                  |
| `postgres/common/results.ts`, type overrides and TypePolicy | OIDs, positional rows, exact numeric representation, JSON and temporal profiles                    | Adaptable            | Native metadata crosses seam; consumer selects decoding                  |
| `sqlite/node-sqlite.ts` native prepare/all/run              | Statement metadata, optional integer/array modes, native synchronous methods                       | Portable             | Extract execution without imposing string conversion                     |
| `sqlite/node-sqlite.ts` result projection                   | Duplicate-label checks, bigint-to-string conversion, result-kind errors                            | Application-specific | Keep in SQLBraid                                                         |
| Driver environment and capabilities                         | Physical feature support plus representation profiles and certification evidence                   | Adaptable            | Separate executable features from certification and application policy   |
| Metadata inspectors                                         | Optional metadata snapshots, database catalog queries and tooling imports                          | Application-specific | Keep optional; not part of first slice                                   |
| Compiler/template/facade                                    | Authoring, directives, result declarations and public composition                                  | Application-specific | Never import from the independent package                                |

The source reading includes `core/executor.ts`, `core/query.ts`, `core/binding.ts`,
`runtime/state.ts`, `runtime/operations/lease.ts`, and transaction cleanup in `runtime/index.ts`.
The physical execution reading includes the full pg materialized, stream, routine, bulk and pool paths,
and node:sqlite query, stream, bulk and transaction-control paths.
[The driver matrix](./compatibility.md) covers the remaining first-party implementations.

## Alternative A: minimal physical SPI

A connection executes SQL and exposes native rows and column metadata.
An acquired connection has explicit `begin`, `commit`, `rollback`, and `release` operations.
A provider only acquires exclusive leases. Direct construction transfers ownership to the wrapper.
A consumer awaits each operation. Overlap fails instead of relying on undocumented driver concurrency.
Transactions do not create another query language or database facade.

Optional extensions remain absent until implemented: stream, prepare, savepoint, cancel, bulk, routine, and schema inspection.
Capabilities describe implemented behavior, not server syntax in general.
A signal is rejected before execution when cancellation is unavailable.
Native values are not normalized to SQLBraid's representations.

## Alternative B: managed execution layer

A managed layer accepts the same SQL and parameters but also owns root operations,
transaction callbacks, session callbacks, nested savepoints, stream tracking, and asynchronous cleanup.
It needs physical ownership identities, context propagation, queues, handle expiry, poison states,
error aggregation, and release-before-mapping rules.
It could preserve more runtime code after removing Query, mapper, observer and binding dependencies.
It would also duplicate lifecycle behavior that Kysely and other consumers already own.

| Criterion                       | Minimal SPI                                                                    | Managed layer                                               |
| ------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Consumer knowledge              | SQL, parameters, native values, exclusive lease and explicit transaction state | Those items plus scope, nesting, context and cleanup policy |
| Implementation cost             | Small dispatch extraction and explicit lease state                             | Significant runtime decomposition and compatibility work    |
| Reuse by SQL generators         | Direct; caller keeps compilation and lifecycle                                 | Possible, but lifecycle ownership can conflict              |
| Existing SQLBraid code retained | Most stays unchanged; native dispatch shared                                   | More orchestration can move, with broader regression risk   |
| Allocation risk                 | One result envelope; no row copies required                                    | Context, scope, observer and queue allocations              |
| Native fidelity                 | Caller-configured parser and raw metadata                                      | Requires policy-neutral mapping seams                       |

## Provisional selection

Choose A. The two native drivers provide a real varying seam without speculative extensions.
Keep SQLBraid's safety implementation in place. Do not route its transactions through a second scope manager.
The experiment must measure the shared dispatch path and a full experimental connection bridge separately.
This avoids presenting a thin dispatch move as proof that the whole runtime can be extracted.

Early ecosystem evidence supports this choice. Kysely already owns acquisition and transaction callbacks.
Its driver can consume SQL and parameters without adopting another compiler.
Prisma's typed positional result protocol needs additional mapping.
Knex clients and Drizzle sessions include higher-level compilation or schema responsibilities.
See [the source-backed comparison](./ecosystem.md) for details and citations.

The experiment will not establish ecosystem demand. A second consumer demonstrates technical compatibility,
not willingness to replace a maintained native adapter.

## What the prototype actually reuses

The private workspace is `experiments/driver-extraction`, outside the stable `packages/*` release inventory.
The package has no production dependencies.
Stable adapters import shared source, which the build bundles into their existing artifacts.
No stable package gains an experimental runtime dependency or export.

SQLite shares native preparation, column inspection, `all()`, and `run()`.
Static hooks retain SQLBraid's duplicate-label check and native integer/array configuration.
SQLBraid still owns row projection and exact string normalization.

PostgreSQL shares only `executePgQuery`, a direct native dispatch helper.
That helper adds no Promise or row copy.
It is a shallow seam, not a substantial extraction of PostgreSQL integration.
The independent wrapper still needs its own lifecycle and transaction-option handling.
Moving SQLBraid's full pg executor would also move binding, error, representation, routine, and cancellation dependencies.
This limited reuse weighs against a separate published library.

## Exercised Kysely integration

`tests/driver-extraction/kysely.mjs` supplies a JavaScript driver while retaining Kysely's PostgreSQL compiler,
adapter, and introspector. The bridge and its value/signal helpers occupy about 80 source lines before demo setup.
The demo runs against the packed independent artifact with Kysely 0.29.7 and pg 8.23.0.

The executed checks prove parameter binding, native numeric rows, DML bigint counts,
one lease per transaction, commit, rollback after a uniqueness error, and stale-handle rejection.
The bridge rejects unsupported transaction settings and streaming.
It range-checks Number counts before bigint conversion and does not invent a PostgreSQL insert identifier.
It closes the dedicated pool when Kysely destroys the driver.

The bridge does not prove Kysely streaming, cancellation, controlled savepoints, or every introspection path.
It has not replaced Kysely's native driver or established demand for that replacement.
Its materialized path adds a result envelope and the experimental lease state checks.
The performance report measures the physical SPI and a SQLBraid bridge, not Kysely end-to-end overhead.
