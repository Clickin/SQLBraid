# Driver extraction decision

## Decision

**Keep integrated with SQLBraid because extraction cost exceeds reuse potential.**

Do not publish the experimental package. Do not treat its name as a product commitment.
Keep this branch as an executable investigation, not a proposal to migrate every stable driver.
The experiment demonstrates an independent input/output interface. It does not demonstrate enough shared implementation to justify a new maintained library.

## Evidence

### An independent interface is feasible

The private `@execution-lab/driver` package accepts ordinary SQL text and parameters.
It imports no SQLBraid facade, template, compiler, runtime, or core package.
Its packed consumer executes SELECT and DML, explicit transactions, rollback, and cleanup.
The consumer passed on Node 24.22.0 and 22.18.0 with pg 8.23.0 and native node:sqlite.

A Kysely 0.29.7 adapter retains the built-in PostgreSQL compiler.
It passes SQL and parameters unchanged, pins one lease for a transaction, and preserves native rows.
The executed demo proves commit, rollback, DML counts, and cleanup without upstream changes.
Technical adoption is possible. Demand from an independent maintainer remains unproven.

### A small interface does not extract most driver behavior

The PostgreSQL shared helper is a direct dispatch wrapper.
It does not remove the substantial parser, normalization, cursor, cancellation, routine, or reuse implementation.
The SQLite shared materializer has more substance: preparation, metadata inspection, row reads, and command execution.
It still leaves exact numeric policy, row projection, streaming, bulk, and runtime ownership outside.

A full extraction would need to separate SQLBraid binding and representation policy from every native transport.
Oracle typed binds, Tedious requests, MariaDB streaming, libSQL transaction handles, and Bun value templates cannot be hidden behind identical text calls.
The [compatibility matrix](./compatibility.md) records these differences.

### Lifecycle reuse has a cost

The minimal prototype rejects overlapping operations and owns explicit connection cleanup.
It adds transaction state, poisoning, release rollback, and error aggregation.
SQLBraid already implements richer lifecycle behavior, including async-context checks and tracked streams.
Kysely also owns acquisition and transaction orchestration.
Moving the managed layer would require consumers to accept another lifecycle policy or maintain translation code.

The prototype does not replace SQLBraid's existing safety implementation.
Stable queues, mapper release order, prepared shapes, cancellation, routines, and stream cleanup remain in place.
Keeping two permanent lifecycle layers without a second committed consumer would add maintenance work rather than remove it.

### Compatibility evidence is positive but bounded

Before extraction, 104 applicable test files and 1,473 tests passed.
After extraction, the full Vitest run passed 133 files and 1,809 tests, including real database suites.
The packed prototype passed 14 lifecycle fault checks and real PostgreSQL, SQLite, and Kysely examples.
Stable packed-package validation passed for 22 packages.
Exact runtime portability passed under Node 22.18.0, Bun 1.3.14, and Deno 2.9.3.

The first portability attempt on Node 24.22.0 failed the gate's exact version assertion.
The required Node binary resolved that environment mismatch; the assertion was not changed.
See [verification](./verification.md) for the precise commands, configurations, and unrun aggregate gates.
No result promotes a support tuple or authorizes a release.

### Performance does not provide a publication case

Seven-round, same-process measurements preserved the baseline row projector.
Current SQLBraid deltas ranged from -3.47% to +2.11%; the run found no consistent stable-path slowdown.
The full experimental bridge was 19.06% slower than baseline for PostgreSQL's 10,000-row result.
That bridge includes a separate fixture projector, so this is not a pure dispatch-cost measurement.
The raw SQLite UPDATE wrapper added 0.195 microseconds, or 13.35%.
With matched normalization, SQLite UPDATE overhead was about 0.11 microseconds, or 6.50%.
Native pg pool acquire/release gained about 0.192 microseconds of experimental lease work.

These results show a working interface, not zero-cost abstraction.
Network/server variation limits PostgreSQL attribution, and batch heap deltas do not measure allocated bytes per query.
See [performance](./performance.md) and its raw samples for variability, representations, GC, and stage diagnostics.
Performance is not the main reason to keep integration local; limited shared implementation and unproven demand are stronger reasons.

## What this branch contains

| Area                               | Files                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports                            | `docs/driver-extraction/architecture.md`, `api.md`, `compatibility.md`, `performance.md`, `decision.md`, `ecosystem.md`, `verification.md` |
| Raw measurements                   | `docs/driver-extraction/performance-results.json`                                                                                          |
| Independent prototype              | `experiments/driver-extraction/package.json`, `src/types.ts`, `src/lifecycle.ts`, `src/pg.ts`, `src/sqlite.ts`, `src/index.ts`             |
| Packed consumer and checks         | `tests/driver-extraction/runner.mjs`, `pg.mjs`, `sqlite.mjs`, `faults.mjs`, `kysely.mjs`                                                   |
| Reproducible benchmark             | `tests/driver-extraction/benchmark.mjs`                                                                                                    |
| Stable native dispatch integration | `packages/postgres/src/pg/executor.ts`, `packages/sqlite/src/node-sqlite.ts`                                                               |
| Workspace orchestration            | Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsdown.config.ts`, `tests/package.json`, `.oxlintrc.json`                   |

The source-sharing imports are experiment-only. They are bundled into stable artifacts and add no runtime dependency.
The experimental workspace is outside the stable release inventory and has `private: true`.
No stable package version or export map changed. Nothing was published or tagged.

## Limitations

- Only pg and node:sqlite are implemented in the independent package.
- Streaming, cancellation, prepared execution, savepoints, bulk, routines, and multiple result sets are absent.
- Live AbortSignals reject before I/O; they do not cancel native work.
- Native values retain native fidelity limits. The package does not promise SQLBraid's exact numeric strings.
- Object rows retain native duplicate-label behavior. Positional results need explicit driver configuration.
- SQL transaction-control text must use the lifecycle methods; the package does not parse arbitrary SQL to detect misuse.
- Raw native calls and unrelated wrappers must not run concurrently with an experimental lease.
- The benchmark bridge is fixture-focused, not a replacement SQLBraid adapter.
- Kysely execution was exercised, but its streaming, cancellation, controlled savepoints, and full introspection surface were not.
- Workstation timings are not a cross-platform performance certification.
- The ignored baseline build snapshots must be regenerated before benchmarking from a fresh checkout.

## Conditions for reconsideration

Reconsider independent publication only when a real external consumer commits to the interface and maintenance model.
First demonstrate reuse of a substantial implementation beyond a native dispatch wrapper.
Then prove two different transports, policy-neutral metadata, native value fidelity, and complete lifecycle cleanup.
Measure any additional layer with matched representations and preserve the current SQLBraid public API.

Do not add those extensions to this prototype merely to make extraction appear more valuable.
