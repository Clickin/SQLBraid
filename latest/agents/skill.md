# Portable agent skill

> Install SQLBraid's application-development guidance in compatible coding agents.

SQLBraid ships an official portable Agent Skill at [`skills/sqlbraid/`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid). The skill teaches an agent the SQLBraid-specific contracts it cannot safely infer from generic SQL knowledge: result kinds, value versus structural interpolation, physical connection scope, adapter capabilities, metadata evidence, and code generation.

Install it through the standard `skills` CLI:

```sh
npx skills add Clickin/SQLBraid --skill sqlbraid
```

The skill is intentionally application-focused. Its default workflow is:

- Keep ordinary SQL as SQL instead of translating it into an ORM or query-builder DSL.
- Use `sql.rows`, `sql.command`, or `sql.call` to preserve result intent.
- Treat ordinary interpolation as a value bind; use explicit structural helpers for identifiers and SQL structure.
- Preserve transaction/session pinning and the selected adapter's real capabilities.
- Use SQLBraid LSP or JSON CLI inspection when semantic project evidence is available.
- Treat metadata as open-world positive evidence rather than a complete catalog.
- Change configuration or metadata before regenerating models; run `sqlbraid codegen --check` instead of hand-editing generated output.

Detailed query, runtime, and tooling rules are bundled under `skills/sqlbraid/references/`, so compatible agents can load them only when the task needs them.

SQLBraid does not require MCP. LSP, CLI inspection, and the portable skill are independent integration surfaces.

For agents that have not installed the skill, the documentation site also publishes an `llms.txt` index and raw Markdown versions of documentation pages. These artifacts are generated with each documentation build, so `/latest` follows the current docs while `/v/<version>` remains tied to the immutable release snapshot.

Driver and executor authors should also read the [driver-author binding guide](/SQLBraid/latest/agents/driver-author.md) before implementing a custom transport.
