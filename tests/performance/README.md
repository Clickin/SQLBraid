# SQLBraid execution benchmarks

These benchmarks use built JavaScript packages. They do not measure TypeScript transpilation or compiler startup during query execution.
Benchmark dependencies belong to the private `@sqlbraid/tests` package. They do not enter published runtime dependencies.

## Prepare

Use the repository's Node and pnpm versions. Install the exact lockfile, then build:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run docs:snippets
```

Start a separate PostgreSQL database. Do not point the suite at an application database.

```sh
docker run --detach --name sqlbraid-perf-200 \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=sqlbraid_perf \
  --env POSTGRES_PASSWORD=sqlbraid_perf \
  --env POSTGRES_DB=sqlbraid_perf postgres:17.6

docker exec sqlbraid-perf-200 pg_isready -U sqlbraid_perf -d sqlbraid_perf
export SQLBRAID_PERF_URL='postgres://sqlbraid_perf:sqlbraid_perf@127.0.0.1:55432/sqlbraid_perf'
```

The credentials above are public, local test credentials. The port binds only to loopback.
The PostgreSQL suite owns its deterministic benchmark fixture. Connection establishment and fixture setup occur outside measured queries.

## Run

Run from the repository root. Do not run builds, tests, profiles, or other benchmarks concurrently with a measurement.

```sh
pnpm benchmark:performance --suite micro --rounds 5 --time 100 --warmup 100 \
  --out docs/performance/results/local-micro
pnpm benchmark:performance --suite postgres --rounds 5 --time 100 --warmup 100 \
  --out docs/performance/results/local-postgres
```

`--time` is a target in milliseconds, not a fixed measurement duration.
A 16-invocation pilot chooses between 16 and 8,192 measured invocations. Tinybench then performs the requested `--warmup` before measurement.
The sample cap prevents large raw files for near-empty operations. Large-result cases can exceed the target duration.
Each round starts a fresh process and warms each case again.

Use `--list` to list cases. It still initializes and verifies suite setup, including the database fixture.
Use `--filter` with a regular expression to select workloads. For `micro`, `--profile smoke` selects a smaller cardinality matrix.

```sh
pnpm benchmark:performance --suite micro --list
pnpm benchmark:performance --suite micro --filter '^micro/observer/' \
  --rounds 7 --time 150 --warmup 100 --out docs/performance/results/observer
bun tests/performance/run.mjs --suite micro --profile smoke \
  --rounds 3 --time 25 --warmup 25 --out docs/performance/results/bun
```

Do not compare Bun and Node as if they were repeated measurements of the same runtime.

## Read the output

Each run writes these files below `--out`:

- `<suite>-<round>.json.gz`: environment, suite metadata, measured order, statistics, and every sorted latency sample in milliseconds.
- `<suite>-summary.json`: per-case summaries across independent processes.

`docs/performance/results/` is local generated output and is excluded from Git.
Reports and benchmark source stay in Git. Ignoring results does not delete existing local measurements.
To share the raw evidence, attach that directory separately.

The summary reports the median of round means, median P50/P95, the range of round means, and their sample standard deviation.
The reported P95 uses the nearest rank in each round's sorted samples, then takes the median across rounds.
It is not a percentile of pooled samples. Tinybench's P99 field is not used as P95.
Throughput is the reciprocal of mean invocation latency. Concurrent and grouped cases identify their operations per invocation.
Do not call a batch invocation's latency the latency of one query.

Case order uses a deterministic shuffle with `--seed` plus the round index.
Verification runs outside timing. It checks output values, SQL where applicable, and lifecycle invariants.
There is no explicit GC in normal runs. Tinybench timer overhead is not subtracted.
Timer warnings remain in the raw output. Very small fake-driver baselines are lower bounds near timer resolution.

Regenerate summaries from unchanged raw samples, or check the statistics:

```sh
node tests/performance/summarize.mjs docs/performance/results/baseline
node --test tests/performance/harness.test.mjs
```

The categories are separate:

- `logical`: natural library APIs that return equivalent values. Generated SQL can differ.
- `equivalent-sql`: equivalent SQL, parameters, and representation, with documented driver-path differences.
- `micro`: no-network stages or complete runtime execution against a deterministic executor.
- `lifecycle`, `writes`, `streaming`, and `startup`: separate operations, not interchangeable SELECT latency measurements.

Read suite metadata before comparing implementations. In particular, SQLBraid's default exact integers are strings.
An explicit SQL cast or a non-default temporal/JSON profile must not be presented as default behavior.

## Profile separately

Select exactly one case. The profiler excludes suite setup and performs a warmup before recording.

```sh
pnpm benchmark:performance:profile --suite micro \
  --filter '^micro/observer/parameters-1/none$' --iterations 30000 \
  --mode cpu --out docs/performance/results/profiles
pnpm benchmark:performance:profile --suite micro \
  --filter '^micro/observer/parameters-1/none$' --iterations 30000 \
  --mode allocation --out docs/performance/results/profiles
```

Open `.cpuprofile` files in Chrome DevTools. The adjacent JSON files list self-time frames.
Allocation profiles use `.heapprofile.gz`; decompress them before loading.
Archived summary files can retain the original decompressed `profile` path.
The heap sampler includes objects collected by both minor and major GC. Its byte estimates are not retained heap measurements.
Profiling changes performance. Never mix profiler-enabled timings into normal benchmark summaries.
The diagnostic loop includes an `await` for every invocation, including synchronous cases.

## Alternate baseline and candidate builds

Before a runtime edit, preserve its built package:

```sh
mkdir -p tests/performance/.builds/baseline/runtime
cp -R packages/runtime/dist tests/performance/.builds/baseline/runtime/
cp packages/runtime/package.json tests/performance/.builds/baseline/runtime/
```

Apply one runtime change and rebuild. Then run:

```sh
node tests/performance/compare.mjs --suite micro --filter '^micro/observer/' \
  --rounds 7 --time 150 --warmup 100 --out docs/performance/results/paired
```

This runner alternates baseline-first and candidate-first process pairs.
A Node resolve hook selects the saved runtime artifact, including imports made by driver factories.
It does not modify package files between measurements. The raw environment records hashes of the selected built artifacts.
By default, only the runtime package is replaced.
For PostgreSQL edits, save `packages/postgres/dist` and its manifest in the same way.
Select that snapshot with `--package postgres --baseline <snapshot-directory>`.
Other packages remain unchanged in each pair.

Compare paired round means and their variation. Do not subtract unrelated average round-trip latencies and call the difference an exact stage cost.
Keep the baseline commit, source-change identity, and built artifact hashes with results.

## Scope

`micro.mjs` uses the current executor/provider interfaces and the actual built PostgreSQL adapter.
Its fake native client returns pre-parsed rows. It does not model wire decoding, sockets, or database scheduling.
The stage metadata identifies costs that remain combined behind bundled private functions.

`postgres.mjs` uses published competitor releases. Read its SQL and parser metadata before interpreting ratios.
The suite does not certify database capabilities or promote support labels.
Machine-specific measurements belong in `docs/performance/`, not the main README.
