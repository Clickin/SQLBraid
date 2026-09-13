---
title: 0.1.0 release notes
description: The SQL-first pre-release surface shipped for the September launch.
---

SQLBraid 0.1.0 is a public pre-release focused on a stable, SQL-first TypeScript contract.

## Included

- PostgreSQL, MySQL, and SQLite dialects with first-party `pg`, `mysql2`, and `node:sqlite` adapters;
- safe binds, explicit `rows`/`command`/`call` result kinds, structural fragments, and dynamic `@braid` directives;
- Standard Schema query-bound and execution-level row mapping;
- direct and pooled execution with physical connection leases;
- transactions, savepoints, streaming, prepared shape locks, and execution observers;
- optional metadata v1 snapshots, inspectors, deterministic Row/Insert/Update codegen, and `codegen --check`;
- standard stdio LSP, CLI JSON inspection, portable agent skill, and thin VS Code integration;
- Node 22.18.0 release target plus documented Bun/Deno evidence where supported.

## Upgrade discipline

Treat generated model files as derived artifacts. After metadata or config changes, run `sqlbraid codegen` and commit the result, then run `sqlbraid codegen --check`. Keep adapter direct-vs-pool factories aligned with the physical resource you own.

This site is the intended documentation target at `https://clickin.github.io/SQLBraid/`. A target URL is not a claim that a deployment or every release gate has completed.
