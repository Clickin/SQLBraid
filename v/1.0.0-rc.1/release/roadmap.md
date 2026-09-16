# Roadmap

> Separate current behavior from candidates that need their own design and evidence.

## Current pre-release surface

The current API includes SQL-first templates, safe binds, dynamic `@braid`,
result contracts, Standard Schema mapping, physical lease/session ownership,
transaction/savepoint scopes, capability-driven cancellation, prepared input and
zero-input factories, streams, observers, metadata, deterministic codegen,
standard LSP, CLI JSON inspection, a thin VS Code client, native DML-returning
contracts, homogeneous command bulk, MariaDB, Browser SQLite WASM, D1, and
representation-profile contracts, plus optional OpenTelemetry DB client spans
and duration metrics.

The [runtime and driver support matrix](/SQLBraid/v/1.0.0-rc.1/reference/support.md) records
support labels for the exact database/driver/profile/runtime/capability tuple
and its revision and workflow evidence. A neighboring version or package
installation is not certification. Final exact-SHA Runtime, Docs, and Release
gates and explicit release authorization remain separate requirements.

Profile descriptors pair driver options, raw/canonical representation, and
TypePolicy provenance; runtime and codegen must reuse the same descriptor.
Container behavior is not recursively inferred. Support labels remain
revision-specific and capability-driven.

## Future candidates

These are not current APIs and must not be copied into production code as if
supported:

- broader database/server-line and additional first-party driver evidence;
- application input mapping and explicit codec contracts;
- optional database verification and richer SQL diagnostics;
- pipeline/COPY/LOAD DATA operations, query transformation, and routing/retry;
- richer container/JSON/temporal representation evidence.

Cancellation, sessions, transaction options, prepared input factories, and
bulk/stream support are current contracts; they are not roadmap candidates.
Missing capabilities remain explicit `UnsupportedFeatureError` failures rather
than hidden fallback. A candidate becomes an Official support claim only after
its dialect/driver/runtime semantics, executable coverage, package metadata,
translations, and exact release evidence are complete.

Pages deployment and release history require explicit authorization. No tag,
npm publication, or Pages deployment is implied by this roadmap.
