# 1.0.0-rc.2 release notes

> The SQLBraid 1.0 release candidate surface and its evidence boundary.

This is 1.0.0-rc.2 pre-release documentation. It does not authorize npm, GitHub, VS Code
Marketplace, or Pages publication.

The [runtime and driver support matrix](/SQLBraid/latest/reference/support.md) records
support labels for the exact database/driver/profile/runtime/capability tuple
and its revision and workflow evidence. A neighboring version or package
installation is not certification. Final exact-SHA Runtime, Docs, and Release
gates and explicit release authorization remain separate requirements.

## Included contract

- SQL-first templates, safe value binds, explicit `rows`, `command`, `call`,
  and `unknown` result kinds;
- bounded `@braid` directives and explicit structural fragments;
- Standard Schema query-bound and per-execution row mapping;
- direct physical executors and explicit provider/lease pool ownership;
- `db.session(callback)` lease pinning, nested session reuse, and `db.tx`;
- fixed transaction isolation literals plus `readOnly`, with malformed,
  unsupported, and nested option errors distinguished;
- trailing execution/row/stream options and capability-driven `AbortSignal`
  cancellation;
- zero-input and input prepared factories with one-render logical shape locks;
- native driver streams with cleanup before lease release, or explicit
  `BRAID_STREAM_UNSUPPORTED`;
- materialized routine `output`, ordered heterogeneous `resultSets`, optional
  `returnValue`, and explicit OUT/INOUT/cursor boundaries;
- homogeneous command-only bulk with pre-I/O validation and actual execution
  mode reporting;
- observe/fail-only execution observers and lazy diagnostic literalization;
- optional `@sqlbraid/opentelemetry` DB client spans and stable duration metrics,
  with SDK/exporter ownership kept in the application;
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL Server dialect roots with
  driver subpaths;
- Bun SQL's one adapter family with required user-selected PostgreSQL, MySQL,
  MariaDB, or SQLite dialect; no connection-based auto-detection;
- existing first-party driver adapters usable from Deno where their public API
  works, without a Deno-specific dialect;
- metadata, codegen, CLI JSON inspection, standard LSP, Vite lowering, and
  thin editor integration;
- exact database integers/decimals as canonical strings and approximate IEEE
  values as numbers, with independent JSON/temporal/container profiles.

## Explicit unsupported behavior

`UnsupportedFeatureError(feature, code, message, options?)` carries stable
`BRAID_*` codes. Active cancellation without physical driver support uses
`BRAID_CANCEL_UNSUPPORTED`; already-aborted signals preserve their `reason`.
Missing stream, routine, output, hint, transaction, or bulk support fails
explicitly instead of buffering, guessing carriers, ignoring hints, or creating
hidden transactions.

Canonical capability keys are:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## Deliberate nonfeatures

SQLBraid is not an ORM, complete SQL semantic compiler, universal input codec,
SQL/result rewriting interceptor, automatic retry/router, audit store, or
universal native prepared cache. It does not infer arbitrary SELECT/JOIN result
models or hydrate object graphs. DML `RETURNING`/`OUTPUT` is materialized unless
the selected adapter's exact evidence says otherwise. Metadata is open-world
positive evidence.

A release candidate requires one clean exact revision, executable tuple/capability
coverage, bilingual documentation freshness, package/export checks, and an
immutable release dry-run. User acceptance and explicit release authorization
are separate gates.

## npm and VS Code artifact guarantees

The **Release** workflow packs and validates npm tarballs. Its
`release-manifest.json` records package filenames, SHA-256 and SHA-512
integrity; `pack-check-success.json` binds package names and SHA-256 values to
the version and source commit. It sets `SQLBRAID_SKIP_VSIX=true`.
Prior-run recovery restores the original npm candidate, manifest, stamp and
prepared build, not a VSIX. The npm draft GitHub Release attaches the manifest,
staged-publication report and durable release-evidence summary, not an extension.

The separately dispatched **VS Code Release** workflow builds and validates
an exact VSIX, including extension identity, matching bundled CLI/language-server
versions and a clean editor-profile check. Packaging prints its SHA-256.
The `sqlbraid-vscode-<version>` artifact is retained for 14 days. Open VSX
trusted publishing consumes that artifact without rebuilding; Microsoft
Marketplace upload is a manual handoff of the same VSIX. Keep the VSIX and
its workflow identity separately: npm manifests, pack-check stamps and prior-run
recovery do not attest or recover it.

## Translation freshness

English pages are the source content and every tracked page has a Korean pair.
Change the English and Korean files in the same revision, preserve code/API
meaning in both languages, and run `node scripts/validate-translations.mjs`.
The translation registry records the English source digest; stale or missing
entries block the docs gate. Do not add an opt-out for an ordinary API change.
