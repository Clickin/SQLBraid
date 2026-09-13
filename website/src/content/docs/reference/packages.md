---
title: Package map
description: Find the SQLBraid package that owns each concern.
---

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts and Standard Schema-facing types |
| `@sqlbraid/template` | Tagged templates, directives, rendering, structural fragments |
| `@sqlbraid/runtime` | Execution, mapping, result-kind checks, transactions, streaming |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` adapter; `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` adapter; `/inspector` |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite` adapter; `/inspector` |
| `@sqlbraid/compiler` | TypeScript discovery and guarded-template lowering |
| `@sqlbraid/metadata` | DB-fact snapshots, validation, identity, drift |
| `@sqlbraid/codegen` | Metadata + TypePolicy to Row/Insert/Update declarations |
| `@sqlbraid/tooling` | Shared config/workspace evidence and semantic indexes |
| `@sqlbraid/operations` | Fingerprints and declaration manifests |
| `@sqlbraid/cli` | Codegen, inspect, diagnostics, drift, and command-line fallback |
| `@sqlbraid/language-server` | Standard stdio LSP integration |

Runtime packages do not acquire metadata, codegen, compiler, or editor dependencies. Install tooling packages only in development/build environments.

The dependency direction is:

```text
core / compiler / metadata / codegen
                 ↓
             tooling
             ↙     ↘
           CLI      LSP
                      ↑
                VS Code client
```
