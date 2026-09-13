---
title: Roadmap
description: Separate shipped behavior from candidates that need their own design and evidence.
---

## Shipped in 0.1.0

The release surface includes SQL-first templates, safe binds, dynamic `@braid`, result contracts, Standard Schema mapping, physical connection leasing, transactions/savepoints, streams, observers, metadata v1, deterministic codegen, standard LSP, CLI JSON fallback, and a thin VS Code client.

## Post-release candidates

These are not current APIs and must not be copied into production code as if they were supported:

- Oracle/node-oracledb and additional first-party drivers;
- application input mapping and explicit codec contracts;
- optional database verification and richer SQL diagnostics;
- cancellation, bulk/pipeline operations, query transformation, routing/retry, and OpenTelemetry integration;
- a transaction-profile API for explicit isolation/session behavior.

A candidate becomes public only after its dialect/driver/runtime semantics, regression coverage, package metadata, and release evidence are independently complete. The launch does not promise Oracle, SQL Server, or a generic transaction profile.
