---
title: Portable agent skill
description: Install the SQLBraid guidance for application development in compatible coding agents.
---

SQLBraid ships an official portable Agent Skill at [`skills/sqlbraid/`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid). The skill teaches an agent the SQLBraid rules that it cannot safely infer from general SQL knowledge:

- result kinds;
- value interpolation and structural interpolation;
- the scope of physical connections;
- adapter capabilities;
- metadata evidence;
- code generation.

Install it with the standard `skills` CLI:

```sh
npx skills add Clickin/SQLBraid --skill sqlbraid
```

The skill is for application development. Its default workflow is:

- Keep ordinary SQL as SQL. Do not translate it into an ORM or a query-builder DSL.
- Use `sql.rows`, `sql.command` or `sql.call` to keep the intended result kind.
- Treat ordinary interpolation as a value bind. For identifiers and SQL structure, use explicit structural helpers.
- Keep the transaction and session pinning and the real capabilities of the selected adapter.
- When semantic project evidence is available, use the SQLBraid LSP or the JSON CLI inspection.
- Treat metadata as open-world positive evidence. It is not a complete catalog.
- Change the configuration or the metadata, then generate the models again. Run `sqlbraid codegen --check`. Do not edit generated output manually.

The detailed rules for queries, the runtime and tooling are in `skills/sqlbraid/references/`. Compatible agents load them only when the task needs them.

SQLBraid does not require MCP. LSP, CLI inspection and the portable skill are independent integration surfaces.

For agents without the skill, the documentation site also publishes an `llms.txt` index and raw Markdown versions of the documentation pages. Each documentation build generates these artifacts. Thus, `/latest` follows the current docs, and `/v/<version>` stays tied to the immutable release snapshot.

Authors of drivers and executors must also read the [driver-author binding guide](/SQLBraid/agents/driver-author/) before they implement a custom transport.
