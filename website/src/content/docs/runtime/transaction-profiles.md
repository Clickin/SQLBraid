---
title: Future transaction profile architecture
description: A conceptual boundary reserved for future isolation/session APIs, not a 0.1.0 feature.
---

:::caution Concept only
Nothing on this page is an existing SQLBraid API. Do not pass `isolation`, `transactionProfile`, or similar options to 0.1.0 factories; they are intentionally not accepted.
:::

SQLBraid already separates four concerns:

1. **Dialect** — SQL surface, placeholders, quoting, and primitive database semantics.
2. **Driver** — protocol bridge and result normalization (`pg`, `mysql2`, `node:sqlite`).
3. **Execution runtime** — physical lease ownership, transaction pinning, savepoints, and scope on Node/Bun/Deno.
4. **Transaction profile** — a future explicit description of isolation/session behavior.

A future profile could describe supported isolation/session operations and their evidence without making a dialect or driver name imply them. That design must account for database defaults, pool lease setup, savepoint behavior, failure/poisoning, and combinations such as a PostgreSQL dialect through a custom driver.

For 0.1.0, the practical rule is simpler: `db.tx` pins one physical connection and otherwise leaves isolation at the database/driver default. Explicit isolation setup must follow the selected database's ordering and physical-connection rules; see [transaction isolation defaults](/SQLBraid/runtime/transactions/#isolation-default). This conceptual page must not be read as a promise that a profile object, factory option, or cross-dialect isolation abstraction exists.
