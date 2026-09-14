---
title: Roadmap
description: Separate current behavior from candidates that need their own design and evidence.
---

## Current pre-release surface

The current API includes SQL-first templates, safe binds, dynamic `@braid`,
result contracts, Standard Schema mapping, physical lease/session ownership,
transaction/savepoint scopes, capability-driven cancellation, prepared input and
zero-input factories, streams, observers, metadata, deterministic codegen,
standard LSP, CLI JSON inspection, a thin VS Code client, native DML-returning
contracts, homogeneous command bulk, MariaDB, Browser SQLite WASM, D1, and
representation-profile contracts.

The last exact-SHA verification retained for provenance is revision
`8da8167e027320fcc9bb2aac16b0903c64147940` with successful Runtime
([34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046)),
Documentation ([34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102)),
and Release ([34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)).
The current tree is newer and remains pending fresh exact-SHA gates. These links
are not a current support or publication claim.

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
- pipeline/COPY/LOAD DATA operations, query transformation, routing/retry, and
  OpenTelemetry integration;
- richer container/JSON/temporal representation evidence.

Cancellation, sessions, transaction options, prepared input factories, and
bulk/stream support are current contracts; they are not roadmap candidates.
Missing capabilities remain explicit `UnsupportedFeatureError` failures rather
than hidden fallback. A candidate becomes an Official support claim only after
its dialect/driver/runtime semantics, executable coverage, package metadata,
translations, and exact release evidence are complete.

Pages deployment and release history require explicit authorization. No tag,
npm publication, or Pages deployment is implied by this roadmap.
