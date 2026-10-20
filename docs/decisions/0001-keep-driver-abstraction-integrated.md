# ADR-0001: Keep the Database Driver Abstraction Integrated

- Status: Accepted
- Date: 2026-10-20
- Scope: SQLBraid database execution architecture

## Context

SQLBraid was influenced by MyBatis. MyBatis uses JDBC to standardize database
execution beneath its SQL mapping features. JavaScript has database abstraction
projects, but no equivalent broadly adopted driver standard across its SQL libraries.
SQLBraid therefore implements its own database driver integration layer.

Knex, Kysely, Drizzle, and Prisma also maintain execution abstractions.
SQLBraid investigated extracting a reusable execution interface to reduce duplicated
integration work without requiring its SQL templates, compiler, or public database API.
The experiment compared a minimal driver SPI with a managed execution layer.

## Decision

Retain the current integrated SQLBraid driver architecture.
Do not publish `@execution-lab/driver` as an independent OSS package.
Do not introduce the experimental interface into the stable public API.

Extraction is technically feasible, but the demonstrated code reuse does not justify
an independently maintained package. This decision concerns the current implementation
and evidence. It does not prohibit extraction if requirements change.

## Alternatives Considered

| Alternative                               | Trade-off                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent minimal driver SPI            | Accepts ordinary SQL and parameters. The prototype worked, but shared little substantial driver logic and added another interface to maintain.                                          |
| Independent managed execution layer       | Could share more transaction and cleanup logic. It requires a broader separation of policies and can overlap with consumer-owned lifecycle behavior. This benefit was not demonstrated. |
| Existing integrated SQLBraid architecture | Retains driver policies and lifecycle behavior with their implementations, without another public interface. Other libraries cannot reuse a standalone SQLBraid driver package.         |

## Evidence

### Architectural findings

Independent PostgreSQL and SQLite execution worked, including packed examples.
Kysely integration worked without adopting SQLBraid's template syntax or compiler.
PostgreSQL shared primarily dispatch; SQLite shared primarily materialization.
Most database-specific policies and lifecycle behavior remained outside the extracted interface.
Technical feasibility did not establish demand for a separately maintained package.

### Functional verification

These results belong to the preserved experiment, not to a new release certification.

| Check                            | Recorded result                                    |
| -------------------------------- | -------------------------------------------------- |
| Baseline applicable suites       | 104 files, 1,473 tests passed                      |
| Full post-change Vitest suite    | 133 files, 1,809 tests passed                      |
| Prototype lifecycle fault checks | 14 passed                                          |
| Packed demonstrations            | PostgreSQL, SQLite, and Kysely passed              |
| Prototype Node.js versions       | 22.18.0 and 24.22.0 passed                         |
| Stable package validation        | 22 packages passed                                 |
| Portability checks               | Node.js 22.18.0, Bun 1.3.14, and Deno 2.9.3 passed |

The complete `test:all` orchestration was not executed.
The verification record identifies the commands that ran and the remaining gaps.

### Performance observations

The benchmark used seven rounds on one workstation, with warmup and reported variability.

| Comparison                                                 | Observation                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Full bridge, PostgreSQL 10,000 rows versus baseline        | 19.06% slower. This includes fixture normalization and is **not pure dispatch overhead**. |
| Experimental raw SQLite UPDATE versus native               | Approximately 0.195 μs additional time (+13.35%).                                         |
| Experimental PostgreSQL pool acquire/release versus native | Approximately 0.192 μs additional time.                                                   |
| Existing SQLBraid shared-dispatch paths versus baseline    | Changes ranged from −3.47% to +2.11%, without consistent slowdown.                        |

Network and server variability limit PostgreSQL attribution.
Heap and GC observations do not establish allocated bytes per query.
These results do not establish a universal abstraction penalty or a performance benefit from extraction.

### Unsupported and unverified claims

The prototype does not support streaming, cancellation, prepared statements,
savepoints, bulk operations, routines, or multiple result sets.
Its native value handling does not promise SQLBraid's representation policy.
The experiment did not establish independent consumer adoption, complete Kysely
feature compatibility, or cross-platform performance guarantees.

## Consequences

Positive consequences:

- No additional independent package maintenance.
- No new public compatibility surface.
- Existing driver policies and lifecycle behavior remain colocated with their implementations.
- SQLBraid can improve its existing runtime without maintaining another API.

Negative consequences:

- Other libraries cannot directly depend on a standalone SQLBraid driver package.
- Some driver integration work remains duplicated across the ecosystem.
- SQLBraid retains responsibility for its database-specific adapters.

## Conditions for Reconsideration

Reconsider extraction when concrete requirements and evidence support it:

- Independent external consumers request the driver interface for identified integration needs.
- At least two unrelated consumers can reuse substantial driver logic, not merely dispatch.
- Streaming, transactions, prepared execution, and resource lifecycle semantics can be shared without duplicating policy.
- Performance and allocation overhead can be measured independently of fixture normalization.
- A stable public interface is feasible without exposing SQLBraid-specific query IR.

These are technical evidence requirements, not adoption forecasts.

## References

The [evidence branch](https://github.com/Clickin/SQLBraid/tree/evidence/driver-abstraction-extraction)
is a frozen snapshot. Future experiments must use separate branches.
The exact evidence commit is
[`527cc3a3c1a4baf2e292fc4fdd07e258b0003885`](https://github.com/Clickin/SQLBraid/commit/527cc3a3c1a4baf2e292fc4fdd07e258b0003885).
The links below remain pinned to that commit:

- [Architecture and dependency analysis](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/architecture.md)
- [API proposal](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/api.md)
- [Driver compatibility matrix](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/compatibility.md)
- [Performance report](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/performance.md)
- [Raw benchmark measurements](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/performance-results.json)
- [Final assessment](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/decision.md)
- [Ecosystem research](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/ecosystem.md)
- [Verification record](https://github.com/Clickin/SQLBraid/blob/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/docs/driver-extraction/verification.md)
- [Experimental implementation](https://github.com/Clickin/SQLBraid/tree/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/experiments/driver-extraction)
- [Packed examples, integration checks, and lifecycle tests](https://github.com/Clickin/SQLBraid/tree/527cc3a3c1a4baf2e292fc4fdd07e258b0003885/tests/driver-extraction)
