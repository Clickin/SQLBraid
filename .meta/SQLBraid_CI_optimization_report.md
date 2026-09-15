# SQLBraid CI optimization report

## Final SHAs

- Starting SHA: `e8f555e6a68b8f66b2fb2e907b41f6538d2f9c3d`
- Implementation commits:
  - `99201c9` — parallel development/release DAGs, shard aggregation, planner, build artifact
  - `516287c` — available `actions/download-artifact@v8.0.1`
  - `af83655` — Bun.SQL report preservation
  - `32bece7` — release WASM browser runtime installation
  - `39846da` — common Vitest shard report emission
  - `c871697` — parallel isolated PV17 benchmark families
- Final validated implementation SHA: `c871697b5588a228644eba7fcc523cd29be2b999`
- Evidence/report-only HEAD: `b0faa33b7b16c614cd2ba92ad07f002758329942`

Validation runs:

- Development: [34911145127](https://github.com/Clickin/SQLBraid/actions/runs/34911145127)
- Release dry-run: [34911186052](https://github.com/Clickin/SQLBraid/actions/runs/34911186052)
- Baseline development: [34886850177](https://github.com/Clickin/SQLBraid/actions/runs/34886850177)
- Baseline release dry-run: [34886849250](https://github.com/Clickin/SQLBraid/actions/runs/34886849250)

## Structural changes

Old development critical path:

```text
install -> typecheck -> build -> full Vitest -> Node 24 test:all
        -> browser -> D1 -> TanStack Start -> VS Code -> pack:check -> packed Node
```

New development DAG:

```text
plan -> prepare/install/typecheck/build:packages -> prepared dist artifact
                                                ├─ common/unit + CLI
                                                ├─ DB matrix: PostgreSQL/MySQL/MariaDB/Oracle/MSSQL/SQLite
                                                ├─ browser + D1 + WASM
                                                ├─ VS Code
                                                ├─ package consumers + pack hygiene
                                                ├─ Node 24 compatibility
                                                ├─ packed Node/Bun/Deno
                                                └─ Bun.SQL
                                                         ↓
                                              support-evidence aggregation
                                                         ↓
                                                   ci-required
```

Changes:

- Split `build:packages` and `build:vscode`; local aggregate `build` remains.
- Preparation builds packages once and uploads only generated `dist` trees. Downstream jobs still install frozen dependencies and restore the exact artifact.
- Real DB projects run on independent runners with `fail-fast: false`; project-level `fileParallelism: false` is unchanged.
- Browser/D1/WASM pays for Playwright only in its own lane.
- VS Code and package/consumer validation are independent jobs.
- Required TanStack Start CI was removed; `test:tanstack-start` remains available as a manual/local fixture.
- Development Node 24 runs focused compatibility coverage; release Node 24 retains full Vitest coverage.
- Packed runtime jobs reuse prepared package output and set `SQLBRAID_USE_PREBUILT_DIST=true`; runtime tarballs remain adapter-owned and are still validated independently.
- `scripts/merge-vitest-results.mjs` requires every expected shard, rejects failed/missing/conflicting inputs, namespaces observations, and preserves the existing support-evidence schema.
- `scripts/ci-plan.mjs` is fail-open: unknown/base-resolution failures select all lanes. `ci-required` is always present and checks selected versus skipped jobs.
- pnpm cache order is explicit: pnpm setup, then setup-node with `cache: pnpm` and `cache-dependency-path`.
- Development concurrency cancels obsolete runs. Release has no cancellation policy.
- Release builds and packs one immutable candidate, validates that candidate in parallel lanes, and final dry-run certification consumes the already-validated artifact.
- `actions/download-artifact` uses official available `v8.0.1`; upload remains `v7.0.1`.

## Before/after metrics

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Full development wall clock | 13m58s, run 34886850177 | 4m18s, run 34911145127 | -9m40s / -69% |
| Development critical path | Node 22 serial job, 13m54s | Package/pack lane plus `ci-required`, 4m18s total | -69% |
| Full Vitest-equivalent coverage | 72 files / 538 tests in the serial Node job | 78 files / 606 passed assertions across raw shards | +6 files / +68 assertions |
| Preparation install | ~21s historical baseline | 3s cached install in final preparation job | -18s |
| Preparation typecheck | ~11s historical baseline | 12s | effectively flat; moved once |
| Package build | ~13s historical baseline | 13s | flat; moved once |
| Common/unit lane | part of serial 265s full Vitest | 1m43s, run 34911145127 | isolated critical work |
| Slowest real DB lane | serialized inside full Vitest | Oracle 1m52s in final development run | parallelized |
| Browser/D1/WASM lane | serial after Node 24 full suite | ~1m03s | parallelized |
| Package validation | serial ~90s historical | ~3m19s final pack/consumer lane | independent; pack remains dominant lane |
| Packed runtime lanes | serial Node/Bun/Deno composition | max lane ~1m20s | parallelized |
| Estimated development runner minutes | 18.6, run 34886850177 | 19.3, run 34911145127 | +4% |
| Release dry-run wall clock | 32m19s, run 34886849250 | 7m38s, run 34911186052 | -24m41s / -76% |
| Release benchmark job | 9m52s before family fix, run 34907992816 | 5m03s after family fix, run 34911186052 | -49% |
| Estimated release runner minutes | 32.2 baseline | 29.9 after family fix | -7% |

The final release run is exact-SHA based and passed all lanes, including Node 22, Node 24, browser/WASM, VS Code, package/VSIX, Bun/Deno/Node packed runtimes, Bun.SQL, PostgreSQL current-target evidence, benchmarks, and final npm publication dry-run. No package was published and no tag/release was created.

## Support evidence equivalence

Old and new final support-profile target IDs are identical:

```text
bun-sql-mariadb
bun-sql-mysql
bun-sql-postgres
bun-sql-sqlite
d1-cloudflare-workerd-2026-07-30
mariadb-connector-node-11-8-9
mssql-tedious-developer-node-2022-cu18
mysql-mysql2-node-8-4-2
oracle-oracledb-thin-node-23-9
postgres-pg-node-16-4
sqlite-node-sqlite-node-22-18-0
sqlite-wasm-browser-3-53-4
```

`diff` of old run `34886850177` and final development run `34906400256` support evidence was empty for both target IDs and `exactTupleObserved` values. The benchmark-only final SHA preserves that topology.

Aggregation tests in `tests/ci-optimization.test.ts` cover:

- failed shard rejection;
- missing shard rejection;
- conflicting duplicate result rejection;
- identical duplicate result deduplication;
- registry matching from passed assertions only;
- observation tuple matching;
- default PostgreSQL versus `postgres-current` selection.

## PV17 benchmark diagnosis and fix

The long-running command was not primarily blocked on a busy wait or forced GC. The workload is intentionally large:

- 3 transport families: Number, BigInt, string;
- 6 transforms per family;
- 9 materialized cases per family at 100,000 rows;
- 6 streamed cases per family at 1,000,000 rows;
- one warmup plus three measured iterations.

That is roughly 119 million row values processed before checksum/validation overhead. The old `PV18_ISOLATION=family` path used `spawnSync`, so the three independent transport families ran serially.

Measured probes:

- Reduced deterministic profile (`1000` materialized / `10000` streamed, one warmup, one repeat): 72 workloads passed in ~0.8s with family isolation and ~1.6s with single-process isolation.
- One full-size transport family, one measured repeat: ~37.4s.
- Three full-size families launched concurrently, one measured repeat: ~41.7s wall clock, instead of a serial lower bound near 112s.
- Forced GC was not the main issue: one full-size family with `--expose-gc` was ~37.4s versus ~37.0s without it.

Fix: replace synchronous child-process launches with asynchronous `spawn` plus `Promise.all` for `PV18_ISOLATION=family`. The families remain isolated processes, output ordering remains deterministic, checksum assertions remain unchanged, and `PV18_ISOLATION=none` remains sequential. The release benchmark job fell from 9m52s to 5m03s.

## Remaining bottlenecks

- Development: package/VSIX pack hygiene is now the slowest lane at roughly 3m19s.
- Release: Node 22 and Node 24 full Vitest lanes are roughly 5–6m; package validation is roughly 3m; final release certification is under one minute.
- The benchmark is no longer the dominant release critical path, but it remains the largest single release job at roughly 5m after family parallelism.

No further optimization is justified without changing benchmark methodology or reducing measured workload size, which would weaken release evidence.
