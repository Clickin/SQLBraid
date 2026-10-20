# Driver extraction performance

## Question

Does a policy-neutral physical connection interface add measurable cost beyond native dispatch?
Does sharing native materialization change SQLBraid's existing execution cost?
These are separate questions. A shallow shared helper does not measure a managed execution layer.

## Baseline and method

The baseline is `a99811f82ca80c0a230975fef82ddfda5c925e71`.
The baseline build passed its applicable suites before extraction.
The PostgreSQL and SQLite built outputs were saved before source changes.
The benchmark loads those saved adapters and the current adapters in one process.
Shared core, template, runtime, and TypePolicy code remains unchanged.

To regenerate the ignored baseline input, build that commit in a separate detached worktree with its frozen lockfile.
Copy the complete contents of its `packages/postgres/dist/` to
`tests/performance/.builds/extraction-baseline/postgres/` in the experimental worktree.
Copy `packages/sqlite/dist/` to the adjacent `sqlite/` directory.
Keep every generated sibling chunk. The benchmark does not build or fetch the baseline.

The benchmark is `tests/driver-extraction/benchmark.mjs`.
Run it with `pnpm run benchmark:driver-extraction` after building the packages.
Run it without other repository tests or database workload.
It creates disposable database resources; it does not require an application database.

Compare these paths:

1. Native driver execution, with positional rows and lossless integer transport configured for this fixture.
2. Baseline SQLBraid execution.
3. Experimental connection execution with the same native row mode and parser configuration.
4. Current SQLBraid with shared native dispatch and its existing representation policy.
5. SQLBraid through a separate experimental connection bridge.
6. Native and experimental execution with matched named-row normalization.

The SQLBraid bridge is a measurement adapter, not a migrated production path.
It must restore SQLBraid's exact integer representation before comparing results.
Native and experimental results need not have the same numeric representation as SQLBraid.
That difference prevents interpreting their total time difference as abstraction overhead alone.

Each case has 20 warmup calls per variant, seven rounds, and 150 ms timed batches.
Rounds rotate the first variant and reverse order on alternate rounds.
The report retains raw round samples, median, mean, population standard deviation, and variation.
Measure one-row, 100-row, and 10,000-row results to expose materialization cost.
Correctness assertions precede timing so a fast wrong path is not counted as an optimization.

## Stage interpretation

| Stage                  | Measurement meaning                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| Template rendering     | Query construction/rendering without database I/O                         |
| Parameter binding      | Binding description from a rendered statement                             |
| Connection acquisition | Native pool acquire/release versus experimental lease acquisition/release |
| Driver dispatch        | JavaScript wrapper and native call entry; included in execution samples   |
| Database execution     | Not separately observable from client wall time                           |
| Native materialization | Driver I/O plus result construction, not a wire-time subtraction          |
| Result transformation  | Consumer normalization measured separately where the harness isolates it  |
| Schema validation      | Not part of the execution comparison; no mapper is installed              |

PostgreSQL wall time includes container, network, server scheduling, and parsing variation.
Do not attribute that variation to the interface.
SQLite in-memory execution better exposes JavaScript overhead, but still includes SQLite work.

## Allocation and row shape

The independent common layer returns native row arrays without copying each row.
Column metadata is attached once to the result envelope, not once per row.
SQLBraid retains `preparePositionalResultProjector` and its existing shape-template strategy.
The extraction does not replace that projector or duplicate metadata per row.

Heap deltas under `--expose-gc` describe retained and transient heap observations.
They are not allocated-byte counts. Garbage collection can make a delta negative.
GC event duration and frequency can explain noise, but cannot assign every allocation to this interface.
No precise allocation profiler result is claimed without a corresponding captured measurement.

## Measured environment

Run: 2026-10-20, 00:27:56–00:30:12 UTC. All correctness checks and cleanup passed.
No other repository verification job ran during this benchmark.

| Item              | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Host              | Apple M4, macOS, arm64                                                                      |
| JavaScript        | Node 24.22.0, `--expose-gc`                                                                 |
| PostgreSQL        | 16.4, `postgres:16.4-alpine`, local disposable container                                    |
| PostgreSQL driver | pg 8.23.0                                                                                   |
| SQLite            | node:sqlite, SQLite 3.53.4, in-memory database                                              |
| Fixture           | Four columns; exact integer above `2^53`, text, nullable text, integer key                  |
| Execution         | Sequential, one pinned physical connection per engine; pool acquisition measured separately |

The raw report is [performance-results.json](./performance-results.json).
It contains every batch sample, operation count, mean, median, standard deviation, heap delta, and GC event.
Baseline and current use the same unchanged core/runtime dependencies, not separate dependency installations.

## End-to-end results

Values are **median microseconds per operation (round standard deviation)**, from seven timed batches.
Parentheses are variability, not confidence intervals. Positive deltas mean slower current SQLBraid.
Native and extracted columns omit named-row normalization. Compare them to each other, not as equivalent SQLBraid replacements.

| Engine / operation       |           Native | Baseline SQLBraid |       Extracted | Current SQLBraid |  SQLBraid bridge | Current vs baseline |
| ------------------------ | ---------------: | ----------------: | --------------: | ---------------: | ---------------: | ------------------: |
| PostgreSQL / 1 row       |    100.97 (4.06) |     120.98 (2.44) |   102.69 (2.70) |    118.38 (3.00) |    118.32 (8.13) |              -2.15% |
| PostgreSQL / 100 rows    |    143.24 (7.90) |     175.60 (8.21) |   145.79 (7.83) |    179.31 (6.77) |   184.42 (10.54) |              +2.11% |
| PostgreSQL / 10,000 rows | 2903.43 (103.89) |  3669.76 (180.90) | 2862.36 (75.78) | 3727.68 (204.32) | 4369.18 (209.21) |              +1.58% |
| PostgreSQL / point       |     93.58 (2.36) |     111.73 (1.78) |    95.01 (6.26) |    111.65 (1.75) |    108.55 (1.72) |              -0.07% |
| PostgreSQL / UPDATE      |   687.73 (36.68) |    717.33 (24.54) |  693.79 (12.21) |   701.20 (22.09) |   715.44 (26.24) |              -2.25% |
| SQLite / 1 row           |      3.87 (0.11) |      11.40 (0.34) |     3.94 (0.05) |     11.17 (0.18) |     11.16 (0.33) |              -2.07% |
| SQLite / 100 rows        |     21.42 (0.31) |      39.26 (0.37) |    21.65 (0.29) |     39.23 (0.34) |     38.12 (0.46) |              -0.07% |
| SQLite / 10,000 rows     |  1747.19 (18.73) |   2583.82 (28.10) | 1742.56 (16.35) |  2585.70 (36.15) |  2525.72 (35.64) |              +0.07% |
| SQLite / point           |      3.41 (0.06) |      10.75 (0.25) |     3.52 (0.02) |     10.38 (0.11) |     10.30 (0.28) |              -3.47% |
| SQLite / UPDATE          |      1.46 (0.03) |       8.07 (0.13) |     1.66 (0.03) |      7.83 (0.12) |      7.79 (0.20) |              -3.03% |

The full bridge is 19.06% slower than baseline SQLBraid for PostgreSQL's 10,000-row case.
It is 17.21% slower than current SQLBraid in that case.
This includes the fixture's separate normalization implementation, not only a dispatch wrapper.
The bridge is not uniformly slower across cases. Do not generalize this result into a universal interface penalty.

Current SQLBraid's observed deltas range from -3.47% to +2.11%.
The PostgreSQL increases are smaller than the recorded round deviations.
This run does not establish a consistent stable-adapter regression or a meaningful optimization.
It does establish that extraction is not automatically faster.

## Matched named-row normalization

Both paths below use the same fixture projector. Values again show median microseconds (round standard deviation).

| Engine / operation       | Native plus normalization | Extracted plus normalization | Extracted delta |
| ------------------------ | ------------------------: | ---------------------------: | --------------: |
| PostgreSQL / 1 row       |             101.63 (5.19) |                102.79 (1.39) |          +1.14% |
| PostgreSQL / 100 rows    |             164.42 (9.54) |                172.79 (9.62) |          +5.09% |
| PostgreSQL / 10,000 rows |           4454.14 (85.06) |              4432.57 (56.71) |          -0.48% |
| PostgreSQL / point       |              96.02 (0.66) |                 95.58 (2.56) |          -0.46% |
| PostgreSQL / UPDATE      |            689.64 (24.19) |               684.53 (24.44) |          -0.74% |
| SQLite / 1 row           |               4.49 (0.08) |                  4.51 (0.05) |          +0.45% |
| SQLite / 100 rows        |              30.35 (0.59) |                 29.95 (0.30) |          -1.32% |
| SQLite / 10,000 rows     |           2514.53 (32.60) |              2503.86 (38.19) |          -0.42% |
| SQLite / point           |               3.96 (0.09) |                  4.01 (0.05) |          +1.26% |
| SQLite / UPDATE          |               1.68 (0.03) |                  1.79 (0.03) |          +6.50% |

The raw SQLite UPDATE path adds 0.195 microseconds, or 13.35%, through the experimental connection.
With matched normalization it adds about 0.11 microseconds, or 6.50%.
The added Promise, state checks, and result envelope are not free on synchronous calls.
No optimization was added to hide that cost.

## Stage diagnostics

These are independent measurements, not an additive decomposition of the end-to-end samples.
The binding diagnostic measures the benchmark bridge's binder, not every stable adapter's validation and hint processing.
The transformation diagnostic repeatedly maps one cached native result.

| Engine / result          | Template + render | Describe + bind | Bind existing description | Native I/O + materialization | Cached result transformation |
| ------------------------ | ----------------: | --------------: | ------------------------: | ---------------------------: | ---------------------------: |
| PostgreSQL / 1 row       |             1.772 |           0.672 |                     0.099 |                      101.297 |                        0.246 |
| PostgreSQL / 10,000 rows |             1.755 |           0.683 |                     0.100 |                     2952.239 |                     1403.499 |
| SQLite / 1 row           |             2.167 |           0.682 |                     0.098 |                        3.872 |                        0.164 |
| SQLite / 10,000 rows     |             2.191 |           0.681 |                     0.098 |                     1766.419 |                      761.617 |

All values are median microseconds per operation.
Native pg pool acquire/release measured 0.774 microseconds, with a round deviation of 0.015.
Experimental acquire/release measured 0.966 microseconds, with a round deviation of 0.016.
That is about 0.192 microseconds of additional local lease work, not server connection establishment.
There is no SQLite pool acquisition measurement because node:sqlite has no native pool.

## Observed memory and GC

The process recorded 4,321 GC events with 8,948 ms total duration, including explicit collections outside timed batches.
The following counts include only events that started inside end-to-end timing windows.
Each cell aggregates 35 batches across five workloads. Different variants complete different operation counts.

| Engine / variant               | Median batch heap delta, KiB | GC events in timed batches | GC duration, ms |
| ------------------------------ | ---------------------------: | -------------------------: | --------------: |
| PostgreSQL / native            |                     11434.90 |                         39 |          168.73 |
| PostgreSQL / extracted         |                     12144.84 |                         38 |          169.19 |
| PostgreSQL / baseline SQLBraid |                     29703.99 |                         50 |          160.08 |
| PostgreSQL / current SQLBraid  |                     29965.63 |                         47 |          157.58 |
| PostgreSQL / bridge            |                     29747.41 |                         42 |          132.02 |
| SQLite / native                |                     37834.11 |                         21 |           22.86 |
| SQLite / extracted             |                     49242.45 |                         28 |          110.40 |
| SQLite / baseline SQLBraid     |                     39295.66 |                         98 |          228.88 |
| SQLite / current SQLBraid      |                     42399.59 |                         98 |          229.00 |
| SQLite / bridge                |                     49781.46 |                         98 |          214.28 |

These figures cannot prove allocated bytes per query or a memory leak.
They do show why a faster batch can have a larger heap delta: it executes more operations before the sample ends.
The source and identity checks establish no additional per-row copy in the independent layer.
They do not establish zero allocation: Promise state and result envelopes still allocate.

## Interpretation

The small shared helpers preserve the current row projector and show no consistent stable-path slowdown in this run.
The full bridge can be materially slower, and the synchronous UPDATE case exposes small absolute wrapper overhead.
Network and server variance dominate several PostgreSQL differences.
Do not present negative deltas as extraction speedups without independent repeated runs.

Performance does not justify publication by itself.
The central limitation remains shallow code reuse and the additional lifecycle and representation policies that a complete extraction would need.
