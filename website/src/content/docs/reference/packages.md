---
title: Package map
description: Find the SQLBraid package that owns each concern.
---

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts, Standard Schema-facing types, and rendered parameter metadata |
| `@sqlbraid/template` | Tagged templates, directives, rendering, structural fragments, and `sql.bind` |
| `@sqlbraid/runtime` | Execution, mapping, result-kind checks, transactions, streaming, and prepared shapes |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` adapter; `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` adapter; `/inspector` |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite` adapter; `/inspector` |
| `@sqlbraid/oracle` | Oracle dialect/TypePolicy and parameter hints; `/oracledb` adapter; `/inspector` |
| `@sqlbraid/mssql` | SQL Server dialect/TypePolicy and parameter hints; `/tedious` adapter; `/inspector` |
| `@sqlbraid/compiler` | TypeScript discovery and guarded-template lowering |
| `@sqlbraid/vite` | Vite 8 pre-transform for guarded-template lowering with source maps |
| `@sqlbraid/metadata` | DB-fact snapshots, validation, identity, and drift |
| `@sqlbraid/codegen` | Metadata + TypePolicy to Row/Insert/Update declarations |
| `@sqlbraid/tooling` | Shared config/workspace evidence and semantic indexes |
| `@sqlbraid/operations` | Fingerprints and declaration manifests |
| `@sqlbraid/cli` | Codegen, inspect, diagnostics, drift, and command-line fallback |
| `@sqlbraid/language-server` | Standard stdio LSP integration |
| `sqlbraid` | Unscoped CLI convenience package; provides the `sqlbraid` executable without database drivers |

The package set is 17 packages: 16 scoped runtime/tooling packages plus the unscoped CLI convenience package. Runtime packages do not acquire metadata, codegen, compiler, editor, or Vite dependencies. Install tooling packages only in development/build environments. The Oracle and SQL Server driver dependencies are kept out of their portable roots. `@sqlbraid/vite` keeps Vite as a peer and does not import a framework.

The dependency direction is:

```text
core / compiler / metadata / codegen
                 ↓
          tooling / vite
             ↙     ↘
           CLI      LSP
                      ↑
                VS Code client
```
