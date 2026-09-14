---
title: Roadmap
description: Separate current behavior from candidates that need their own design and evidence.
---

## Candidate surface for 0.1.0

The release surface includes SQL-first templates, safe binds, dynamic `@braid`, result contracts, Standard Schema mapping, physical connection leasing, transactions/savepoints, streams, observers, metadata v1, deterministic codegen, standard LSP, CLI JSON fallback, a thin VS Code client, native DML-returning contracts, homogeneous command bulk, MariaDB, Browser SQLite WASM, D1, and explicit PV17 value-fidelity profiles.

PV17 starts from `dccb69763e9e4a070280cf580d8f7b76368ec3d5`. Final exact-SHA
Runtime, Docs and Release dry-run evidence is pending; the [support
matrix](/SQLBraid/reference/support/) must not promote changed profiles before
those gates. Certification covers exact profiles, not future versions; RC
publication still requires user acceptance and explicit release authorization.

## Post-release candidates

These are not current APIs and must not be copied into production code as if they were supported:

- broader Oracle/server-line and additional first-party driver evidence;
- application input mapping and explicit codec contracts;
- optional database verification and richer SQL diagnostics;
- cancellation, pipeline/COPY/LOAD DATA operations, query transformation, routing/retry, and OpenTelemetry integration;
- a transaction-profile API for explicit isolation/session behavior.

A candidate becomes an Official support claim only after its dialect/driver/runtime semantics, regression coverage, package metadata, and exact release evidence are independently complete. No publication or support label is implied by this roadmap.

The docs-pages workflow validates automatically on push. Pages deployment and
history updates require an explicit `workflow_dispatch` with `deploy=true`.
