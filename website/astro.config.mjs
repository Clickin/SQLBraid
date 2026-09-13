import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://clickin.github.io/SQLBraid",
  base: "/SQLBraid",
  integrations: [
    starlight({
      title: "SQLBraid",
      description: "Write SQL. Keep TypeScript. Skip the query-builder translation layer.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Clickin/SQLBraid" }],
      sidebar: [
        { label: "Get started", items: [
          { label: "Five-minute SQLite", link: "/getting-started/sqlite/" },
          { label: "PostgreSQL", link: "/getting-started/postgres/" },
          { label: "MySQL", link: "/getting-started/mysql/" },
        ] },
        { label: "Core concepts", items: [
          { label: "SQL tags and result kinds", link: "/concepts/sql-tags/" },
          { label: "Safe binds", link: "/concepts/safe-binds/" },
          { label: "Dynamic @braid", link: "/concepts/dynamic-braid/" },
          { label: "Structural SQL fragments", link: "/concepts/structural-fragments/" },
          { label: "Standard Schema mapping", link: "/concepts/result-mapping/" },
        ] },
        { label: "Runtime", items: [
          { label: "Direct connections and pools", link: "/runtime/direct-pools/" },
          { label: "Transactions and savepoints", link: "/runtime/transactions/" },
          { label: "Streaming", link: "/runtime/streaming/" },
          { label: "Prepared queries", link: "/runtime/prepared/" },
          { label: "Execution observers", link: "/runtime/observers/" },
          { label: "Future transaction profiles", link: "/runtime/transaction-profiles/" },
        ] },
        { label: "Metadata and codegen", items: [
          { label: "Inspectors and snapshots", link: "/metadata/inspectors/" },
          { label: "Codegen configuration", link: "/metadata/config/" },
          { label: "Row / Insert / Update models", link: "/metadata/models/" },
          { label: "Overrides and filters", link: "/metadata/overrides/" },
          { label: "codegen --check in CI", link: "/metadata/ci/" },
        ] },
        { label: "Agents and editors", items: [
          { label: "Agent-native LSP", link: "/agents/lsp/" },
          { label: "CLI inspect fallback", link: "/agents/cli/" },
          { label: "Portable skill", link: "/agents/skill/" },
          { label: "VS Code extension", link: "/agents/vscode/" },
        ] },
        { label: "Reference", items: [
          { label: "Package map", link: "/reference/packages/" },
          { label: "Runtime and driver support", link: "/reference/support/" },
          { label: "Diagnostics and error codes", link: "/reference/errors/" },
          { label: "Configuration", link: "/reference/configuration/" },
          { label: "Troubleshooting", link: "/reference/troubleshooting/" },
        ] },
        { label: "Release", items: [
          { label: "0.1.0 notes", link: "/release/notes/" },
          { label: "Current limitations", link: "/release/limitations/" },
          { label: "Roadmap", link: "/release/roadmap/" },
        ] },
      ],
    }),
  ],
});
