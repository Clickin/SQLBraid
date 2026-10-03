---
title: Roadmap
description: Current behavior, and candidates that need their own design and evidence.
---

## Current 1.0.0 GA surface

The current API includes these items:

- SQL-first templates, safe binds and dynamic `@braid`;
- result declarations and Standard Schema mapping;
- ownership of physical leases and sessions;
- transaction and savepoint scopes;
- cancellation that depends on capabilities;
- prepared factories with input and without input;
- streams and observers;
- metadata, deterministic codegen, standard LSP, CLI JSON inspection and a thin VS Code client;
- native DML-returning declarations and homogeneous command bulk;
- MariaDB, Browser SQLite WASM and D1;
- representation-profile rules;
- optional OpenTelemetry DB client spans and duration metrics.

The [runtime and driver support matrix](/SQLBraid/reference/support/) records
support labels for each exact tuple of database, driver, profile, runtime and
capability, and its tested versions.

Profile descriptors pair the driver options, the raw and canonical
representation and the TypePolicy provenance. The runtime and codegen must use
the same descriptor. Container behavior is not inferred recursively. Support
labels stay specific to each revision and depend on capabilities.

## Future candidates

These are not current APIs. Do not copy them into production code as if they
were supported:

- evidence for more databases and server lines, and more first-party drivers;
- application input mapping and explicit codec rules;
- optional database verification and richer SQL diagnostics;
- pipeline, COPY and LOAD DATA operations, query transformation, and routing and retry;
- richer evidence for container, JSON and temporal representation.

Cancellation, sessions, transaction options, prepared input factories and bulk
and stream support are current features. They are not roadmap candidates.
Missing capabilities stay explicit `UnsupportedFeatureError` failures. There is
no hidden fallback. A candidate becomes an Official support claim only after
these items are complete: its dialect, driver and runtime semantics, executable
coverage, package metadata, translations and integration tests.
