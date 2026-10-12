# Driver expansion design: postgres.js, Neon, PGlite, PlanetScale HTTP

Status: steps 0 to 4a are built. Step 4b is rejected (see section 7). This page is not a support claim and not a release claim. Four `support/targets/` records exist for the new adapters (`neon`, `postgres-js`, `pglite`, `neon-http`). Each has status `compatible`. Their evidence points to commit `43171a2` on `main` (Runtime portability, Documentation site and Driver certification runs). Support labels come only from `support/targets/` after exact-revision CI evidence.

Rules that apply: `AGENTS.md` sections 8, 10, 11 and 14, and `docs/driver-author-guide.md`.

## 1. Scope and order

| Step | Driver                                                        | Dialect  | Subpath                          | Planned label          |
| ---- | ------------------------------------------------------------- | -------- | -------------------------------- | ---------------------- |
| 0    | Shared pg-family code (refactor only)                         | postgres | internal                         | none                   |
| 1    | `@neondatabase/serverless` Pool/Client over WebSocket (spike) | postgres | `@sqlbraid/postgres/neon`        | Compatible             |
| 2    | `postgres` (postgres.js)                                      | postgres | `@sqlbraid/postgres/postgres-js` | Official, if CI passes |
| 3    | `@electric-sql/pglite`                                        | postgres | `@sqlbraid/postgres/pglite`      | Official, if CI passes |
| 4a   | `@neondatabase/serverless` `neon()` over HTTP                 | postgres | `@sqlbraid/postgres/neon-http`   | Compatible             |
| 4b   | `@planetscale/database`                                       | mysql    | none                             | Rejected               |

Decisions:

- Use subpaths of the existing dialect package, like `./pg`. Do not add a package for each driver. Driver packages are optional peers. Do not bundle them (AGENTS section 14).
- Do not raise the `node >=16.20.2` floor of `@sqlbraid/postgres` or `@sqlbraid/mysql`. Each driver states its own Node requirement in its target record (AGENTS section 10). The npm `engines` fields on 2026-10-11 were: postgres.js `>=12`, `@neondatabase/serverless` 1.2.0 `>=19.0.0`, `@planetscale/database` 2.0.0 `>=22`, and none for `@electric-sql/pglite` 0.5.8. The PGlite package declares no floor, so test the real floor in the compatibility cell.
- Vercel Postgres is out of scope. It is a Neon wrapper.
- CockroachDB and Cloudflare Hyperdrive need no adapter. They need only a certification cell for `pg` or postgres.js.
- Labels stay Compatible when the only evidence is a local proxy (Neon, PlanetScale). Official needs the real service or the real engine in CI.

## 2. Step 0: share the pg-family code

`packages/postgres/src/pg.ts` has 1062 lines and mixes four things: the binding adapter, the executor, the pool provider and the pg-specific parts. Three new drivers must not copy it (AGENTS section 14: no parallel implementations).

Move into `packages/postgres/src/internal/`, with no public export change:

- `pgStatementBinding` and the hint handling. Every new Postgres driver uses `text-positional` with `$n`.
- The transaction control SQL: `BEGIN` with options, `SAVEPOINT`, and the check that `COMMIT` reporting `ROLLBACK` is an error.
- The error mapping and the `pgOidTypes` table.
- `pgEnvironmentFor`. It hard-codes `driver.id = "pg"`. Add a `driverId` parameter.
- The prepared-loop bulk helper.

Add `driverId` to `PgExecutorOptions`. Then step 1 can reuse `createPgPoolProvider` without a fork.

Gate: the existing `pg` suites (`tests/db/postgres`) pass without edits. The public API audit shows no change.

## 3. Step 1: Neon over WebSocket (spike)

The Neon README describes `Pool` and `Client` as a drop-in replacement for node-postgres, on which they are based. The physical-client check in `packages/postgres/src/pg.ts` (line 275) is duck typing: it needs `escapeIdentifier` and `escapeLiteral` functions. It does not use `instanceof`. Thus `createPgPoolProvider(pool)` may accept Neon objects as they are. The spike must confirm it.

Spike questions. Answer each with a test against a real server before any code ships:

1. Does `pool.connect()` return a client that passes the `PgClientLike` physical-client check?
2. Does `pg-cursor` work on a Neon client? If not, `statement.stream` is Unsupported for this driver. Do not buffer.
3. Does `statement.cancel` hold? The pg adapter cancels by destroying the physical connection (`pg.physical-connection-destroy`). Check that `end()` on the WebSocket does the same.
4. Which Node WebSocket constructor does Neon need (`ws`)? It must be an explicit user option. Do not import `ws` for the user.
5. What does the Neon wire layer do to int8, numeric, json and timestamp parsing? The `pg-lossless-text` profile must still hold.
6. Do named prepared statements work? The Neon pooled endpoint uses PgBouncer in transaction mode, which can break them. The `pg` environment declares `statement.prepare` as guaranteed. Test the pooled endpoint and the direct endpoint separately. Do not inherit the claim before the test passes.

Outcome A (all pass): the adapter is a thin factory over the shared code. It sets `driver.id = "neon-serverless"` and takes its own target record.

Outcome B (stream or cancel fails): declare those capabilities `unsupported` in the environment. Do not simulate them.

Evidence: Testcontainers Postgres with the Neon WebSocket proxy. This is local-proxy evidence, so the label is Compatible.

## 4. Step 2: postgres.js

postgres.js is a client with a built-in pool. A `sql` object is not one physical connection. AGENTS section 8.1 forbids using it as a `QueryExecutor`.

Design:

- Provider: `createPostgresJsProvider(sql, options)`. `acquire()` calls `sql.reserve()` and returns a lease. `release()` calls `reserved.release()`. The README documents both methods. The README does not document how to discard a reserved connection that is poisoned. Answer that in the spike.
- Root operations: acquire, run, release, then map (AGENTS section 8.4).
- Transactions: `begin()`, `commit()` and `rollback()` run as plain SQL on the reserved connection. Do not use `sql.begin(fn)`. It owns its own callback and cannot map to `db.tx`.
  - Risk: postgres.js raises `UNSAFE_TRANSACTION` ("Only use sql.begin or max: 1") for raw transaction statements. The README does not say whether a reserved connection is exempt.
  - Spike question 1: does `BEGIN` through `reserved.unsafe()` work? If it does not, this design changes. The fallback is a dedicated `postgres(url, { max: 1 })` client for each transaction lease. Decide after the test.
- Statements: `reserved.unsafe(text, values, { prepare })`. Values are bound by the driver. The binding adapter is the shared `text-positional` one. `reuse` maps to the `prepare` option. Prepared-name aliasing rules in the driver-author guide section 2 apply. Use unnamed, driver-owned reuse. Do not pass SQLBraid names to the server.
- Types: postgres.js parses values with its own `types` option. Set parsers so that int8, numeric, json, jsonb and temporal types stay text under the `pg-lossless-text` profile. Reject a `parserProfile` that conflicts, as `pg` does.
- Result shape: use `result.count`, `result.command` and `result.columns` for the command and row classification. The README documents `columns[].type` as the PostgreSQL OID, which `pgOidTypes` uses.
- Stream: native `.cursor(batchSize)` on the unsafe query. On `break`, close the cursor, then release the lease.
- Cancel: do not use `query.cancel()`. The README states that it opens a second connection with a protocol-level cancel, that cancellation is not guaranteed, and that it can cancel another query. Destroy the physical connection, as `pg` does. Find out in the spike how to end one reserved connection.
- Routine call: reuse the `pg` approach (SQL `CALL`, OUT row, refcursor `FETCH` inside a transaction) through the shared code. Add a test for it. Do not copy the claim without proof.
- Bulk: `prepared-loop`, as `pg`. Do not claim atomicity.
- Runtime: Node first. Deno and Bun need exact tuples and their own cells (`postgres-deno` exists for `pg`).

Capabilities (target): same as `pg` except where the spike disproves one. Write the exact table from test results, not from this page.

Evidence: Testcontainers `postgres:16.4-alpine`, the same image as the `pg` target, plus the shared `tests/db/postgres` suites run with a driver parameter.

## 5. Step 3: PGlite

PGlite is Postgres compiled to WASM. It has one connection in one process, and it runs in Node and in the browser.

Design:

- Executor, not provider. One `PGlite` instance is one physical resource. `createPgliteExecutor(pg)` gives `ownershipKey: pg`. `session.pinned` and `transaction` hold because there is one connection.
- Exclusive ownership: PGlite has its own internal queue. If the application also calls the instance directly, those calls can interleave inside a SQLBraid transaction. State in the docs that the instance belongs to SQLBraid while the database exists. Do not try to detect misuse.
- Transactions: run `BEGIN`, `COMMIT` and `ROLLBACK` as SQL on the serialized executor. Do not use `pg.transaction(cb)`. Same reason as postgres.js.
- Types: PGlite has `parsers` and `serializers` options. The defaults convert some types (for example int8) to JavaScript values. Override them so the output matches the selected representation profile. Test int8 above `Number.MAX_SAFE_INTEGER`, numeric scale, json text and timestamps.
- Result shape: `rows`, `fields[].dataTypeID` and `affectedRows`. Use `rowMode: "array"` if duplicate column names need it. Check that.
- Stream and cancel: no native cursor and no cancel are known. Declare `statement.stream` and `statement.cancel` `unsupported` unless the spike finds a bounded native primitive. Do not buffer.
- Routine call: single connection, so refcursors work in a transaction. Test before claiming.
- Environment: `database.product = "postgres"`, `edition = "pglite"`. The server version comes from the probe statement. Extensions are out of scope.
- Browser: allowed only through the existing rule that the browser path has no Node shims. No change to the runtime packages.

Evidence: in-process, no container. A pinned PGlite version and a pinned Node version make an exact tuple. This is the one new driver that can reach Official without a service. A browser cell is a separate decision.

## 6. Step 4a: Neon over HTTP

`neon(url)` sends each query as one HTTP request. There is no connection to pin.

Capabilities:

- `session.pinned`: unsupported.
- `transaction` (interactive `db.tx(fn)`): unsupported. `sql.transaction([...])` takes a fixed list of statements. It cannot run application code between statements.
- `statement.bulk`: supported as `remote-batch` through `sql.transaction`. This is atomic on the server. Report it in the execution mode. Do not generalize it to root bulk for other drivers.
- `statement.stream`, `statement.cancel` (active signal), `routine.*`: unsupported with the stable `BRAID_*` errors.
- `statement.prepare`: unsupported, or logical only. Decide from the driver behavior.

Use `neon(url, { fullResults: true })` so the adapter gets `rows` and node-postgres style metadata. The Neon docs state that `fullResults` and `arrayMode` exist on both `neon()` and its `query()` property. The docs also state that `transaction()` runs a fixed list of queries in one non-interactive transaction and accepts `isolationMode`, `readOnly` and `deferrable`. Test that the batch rolls back as a whole. Use the `query(text, params)` form, not the tagged template. SQLBraid renders the statement itself.

Provider shape: a stateless executor. Every call is its own lease. A root `db.tx()` must fail with `UnsupportedFeatureError` before I/O.

The representation of values depends on the HTTP JSON transport. Declare the exact types that survive. Reject the others. Do not stringify a value that is already rounded (AGENTS section 8.4).

Evidence: a local Neon HTTP proxy in Testcontainers. Label Compatible.

## 7. Step 4b: PlanetScale HTTP

**Rejected on 2026-10-12.** The original plan below is kept as history. See section 11 for the reason.

Dialect: MySQL (`@sqlbraid/mysql` type policy). Subpath: `@sqlbraid/mysql/planetscale`.

- Transport: `?` text-positional. Use `conn.execute(sql, values)`.
- Transactions: `conn.transaction(async (tx) => ...)` gives one session over HTTP. Use it for `db.tx`. Run `SAVEPOINT` statements through `tx.execute`. Check isolation and read-only support with a test. Declare each option `unsupported` until proved.
- The README documents `conn.transaction(async (tx) => ...)` as the transaction API, and it rolls back on an unhandled error. The callback form means the adapter must hold the Promise of the callback open while SQLBraid runs the application code. This is the hardest part. Prove commit, rollback and cleanup-error paths with tests before any other work. If the shape does not fit, declare `transaction` unsupported and ship the stateless executor only.
- `session.pinned`: only if the transaction handle can serve a session without a transaction. Expect unsupported.
- Stream, cancel, routine call: unsupported.
- Values: the driver converts column values to JavaScript types by default and has a `cast` option for custom conversion. Keep exact numerics as strings. Check how it returns BIGINT, DECIMAL, JSON and DATETIME.
- The `@planetscale/database` README states that PlanetScale Postgres is reached with the Neon serverless driver. That path belongs to steps 1 and 4a. It is not this adapter.
- `@planetscale/database` 2.0.0 declares `node >=22`. State this floor in the target record.

Evidence: PlanetScale has no local server. The nearest local option is a Vitess container with an HTTP proxy. If that is not practical, publish the adapter as Custom/Compatible with explicit exclusions. Do not claim more.

## 8. Work per driver

Each driver, in the same change:

1. Adapter code under the subpath, with `exports` entry, optional peer dependency and `peerDependenciesMeta`.
2. `support/targets/<id>.json` with exact versions, exclusions and CI references.
3. `support/runtime-compatibility.json` cell with exact Node and driver versions. Smoke test in plain JavaScript on the packed tarball.
4. `tests/package.json` dev dependency. `scripts/validate-dependency-ownership.mjs` must pass.
5. `tests/db/postgres` (or `mysql`) suite parameterized by driver. Reuse conformance. Do not copy suites.
6. `docs-claims.test.ts` entries for each documented behavior. `scripts/ci-plan.mjs` must select them.
7. Docs: README, `docs/public-api-audit.md`, `docs/driver-author-guide.md` driver notes, `docs/mental-model.md` and `docs/mental-model.ko.md`, website pages in both languages, adapter tables. Run `pnpm run docs:snippets`.
8. Gates: `fmt:check`, `lint`, `typecheck`, `build`, `test`, DB gates, `test:consumer`, `pack:check`. Report any gate that cannot run as not run.

Add the new subpaths to the runtime-only packed gate. The runtime roots must still install without any of these drivers.

## 9. Risks

| Risk                                                         | Step | Response                                                            |
| ------------------------------------------------------------ | ---- | ------------------------------------------------------------------- |
| `sql.reserve()` cleanup on error leaves a bad connection     | 2    | Discard the lease on any cleanup failure. Test it.                  |
| Driver default parsers lose int8 or numeric precision        | 2, 3 | Override parsers for the profile. Fixture tests above 2^53.         |
| Application calls the PGlite instance during `db.tx`         | 3    | Document exclusive ownership. No detection.                         |
| `conn.transaction(cb)` does not map to an open-ended `db.tx` | 4b   | Prove with tests first. Fall back to stateless.                     |
| Local proxy hides real service behavior                      | 1, 4 | Keep the label Compatible. Name the proxy in the target record.     |
| PGlite needs a newer Node than 16.20.2                       | 3    | State the driver floor in the target. Do not change package floors. |
| Refactor changes `pg` behavior                               | 0    | No public API change. Run the full existing `pg` suites first.      |

## 10. Open items for the maintainer

- Does step 4a (Neon HTTP) belong in 1.x, given its narrow capabilities? The default here is yes, as Compatible.
- Is a browser cell for PGlite in scope for the first release? The default here is no.
- Can the project pay for a real Neon project in CI? The default here is no, so Neon stays Compatible.

## 11. Outcome of the spikes (2026-10-12)

Each adapter was tested against a real PostgreSQL 16.4 container. Neon used a local WebSocket proxy or a local HTTP proxy.

| Step | Result                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Shared code is in `packages/postgres/src/common/`. The `pg` suites pass without edits.                                                                |
| 1    | Neon `Pool` works through `createPgPoolProvider` without a fork. The pooled-endpoint PgBouncer question is open, so `statement.prepare` is `guarded`. |
| 2    | Raw `BEGIN` works on a reserved connection (the `UNSAFE_TRANSACTION` guard accepts `sql.reserved`). Cancel and discard need workarounds, see below.   |
| 3    | PGlite works as a serialized executor. Streaming and cancellation are unsupported.                                                                    |
| 4a   | Neon HTTP works as a stateless executor with atomic `remote-batch` bulk.                                                                              |
| 4b   | Rejected. See section 7.                                                                                                                              |

postgres.js findings that changed the design:

- A cold `sql.reserve()` never settles when `fetch_types` is off. The provider runs `SELECT 1` before each reserve.
- postgres.js does not expose the physical connection. Terminating the backend from the same connection raised an uncaught `57P01` error. A discarded lease runs `ROLLBACK` and `DISCARD ALL` instead.
- `query.cancel()` can reach a later statement. The adapter declares `statement.cancel` unsupported.
- Routine calls are not implemented for postgres.js, PGlite and Neon HTTP.

Step 4b is rejected because `@planetscale/database` 2.0.0 does not bind parameters. Its README states that `execute` does not interpolate query parameters, and that a caller must escape values into the SQL text. An adapter would have to build literals on the client. AGENTS section 6 requires bound parameters, and the red team report lists client-side interpolation in the MariaDB stream path as a Medium finding. Revisit the step only if the driver offers server-side binding.

Done after the spikes (2026-10-12):

- `support/targets/` records for the four adapters, with status `compatible` and evidence `pending`. Each profile (`neon-lossless-text`, `postgres-js-lossless-text`, `pglite-lossless-text`, `neon-http-lossless-text`) shares the committed `postgres-lossless-text` TypePolicy. `scripts/validate-support.mjs` now checks the exported-descriptor rule for the profile that the package exports under the same ID, so that several driver profiles can share one policy.
- `support/test-registry.json` entries and the conditions `neon.pooler-transaction-mode`, `neon-http.stateless-requests` and `neon-http.non-interactive-transaction`.
- The four transports are in the transaction and resource matrix (`tests/contracts/matrix.json`), with boundary tests for the fake native layer and integration tests on a real PostgreSQL 16.4 container. PGlite uses a fresh instance for each fixture, because a poisoned instance stays poisoned. Neon HTTP has only `cancellation.pre-io` and `metadata.affected-rows` evidence, because it has no transaction, stream or cancel.
- The matrix work found one defect in the postgres.js provider: `acquire()` did not release the reservation when lease setup failed. It does now, and `tests/pool-init-failure.test.ts` covers it.
- postgres.js keeps the physical connection after a discarded lease (it runs `ROLLBACK` and `DISCARD ALL`). The shared integration scenario `transaction.caught-error-terminal-outcome` has a harness flag `discardClosesPhysical` for this case.
- The environment of each adapter reports the profile ID `pg-lossless-text`, not the profile ID in its target record. No check compares the two yet.

- `support/runtime-compatibility.json` has three cells: `node-16-20-2-postgres-js-3-4-9`, `node-22-18-0-neon-serverless-1-2-0` and `node-22-18-0-pglite-0-5-8`. They install the packed tarballs with the exact driver version. The PGlite smoke runs real SQL. The postgres.js and Neon smokes build the providers and adapters without a database, so they prove install and adapter checks, not queries. Neon HTTP shares the Neon cell. Each cell passed locally under its exact Node version.

Not done yet:

- `docs-claims` tests for the documented behavior.
- Evidence for the Neon pooled endpoint with PgBouncer.
- The Bun and Deno runtime cells for Neon and PGlite.
