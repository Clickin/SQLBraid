---
title: Portable agent skill
description: Give coding agents the same SQLBraid workflow across harnesses.
---

The repository ships the portable skill at [`skills/sqlbraid/SKILL.md`](https://github.com/Clickin/SQLBraid/blob/main/skills/sqlbraid/SKILL.md). It encodes the evidence discipline rather than a proprietary agent protocol.

The short version:

- Find `sqlbraid.config.mjs`, `.js`, `.cjs`, or package dependencies first.
- Use standard LSP when the harness supports it.
- Use `sqlbraid inspect ... --json` when it does not.
- Treat metadata as open-world positive evidence: absence is not proof of invalid SQL.
- Keep dialect, driver, execution runtime, and transaction profile as independent axes.
- Change config or metadata before regenerating models; run `sqlbraid codegen --check`.

SQLBraid does not require MCP. An agent can use ordinary LSP transport or invoke the CLI in a disposable project environment.
