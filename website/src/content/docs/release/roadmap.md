---
title: Roadmap
description: Separate current behavior from candidates that need their own design and evidence.
---

## Candidate surface for 0.1.0

The release surface includes SQL-first templates, safe binds, dynamic `@braid`, result contracts, Standard Schema mapping, physical connection leasing, transactions/savepoints, streams, observers, metadata v1, deterministic codegen, standard LSP, CLI JSON fallback, a thin VS Code client, native DML-returning contracts, homogeneous command bulk, MariaDB, Browser SQLite WASM, D1, and explicit PV18 profile-coherent value-fidelity contracts.

PV18 starts from `2119d9676b05fb2531eaf7aac1ef37741600ba40`. Stage A
implementation revision `53db135bd156b6d65dc91785a671dec5249c95d4` has passed
all three Runtime, Docs, and Release gates for Stage A. The [support
matrix](/SQLBraid/reference/support/) records the revision-specific evidence
and promotes the eight exact profiles to Official for Stage A. D1 remains
Compatible. Later revisions require separate Stage B exact-final SHA verification; certification
covers exact profiles, not future versions; RC publication still requires user
acceptance and explicit release authorization.

Profile descriptors pair driver options, raw/canonical representation, and
TypePolicy provenance. Codegen must reuse the selected runtime descriptor.
Container support is deliberately non-recursive; common scalar/array evidence
may be promoted independently of rare composites, objects, variants, or
vectors. None of these docs imply Stage B completion or RC readiness for a later
revision.

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
