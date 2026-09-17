---
title: Codegen configuration
description: Generate deterministic TypeScript models from a metadata snapshot.
---

Install `@sqlbraid/cli`, `@sqlbraid/codegen`, the selected dialect, and the driver in your tooling project. Create an executable Node config (`.mjs`, `.js`, or `.cjs`):

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicyForProfile } from "@sqlbraid/postgres";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });

export default defineConfig({
  codegen: {
    targets: [
      {
        name: "main",
        metadata: "./db/main.metadata.json",
        outFile: "./src/generated/database.ts",
        typePolicy,
        filters: { includeNamespaces: ["public"] },
      },
    ],
  },
});
```

Run from the project containing the config:

```bash
sqlbraid codegen
sqlbraid codegen --config ./sqlbraid.config.mjs
sqlbraid codegen --target main --check
sqlbraid codegen --json
```

Metadata and output paths are relative to the config file. Repeated `--target` selects targets. Validation completes for every selected target before output is written; unchanged generated files retain their mtime. The JSON result reports `written` only after successful I/O.

The config is trusted executable Node code, not a sandbox. Keep metadata and generated output under version control when the project needs reviewable schema changes.

The selected TypePolicy is a representation profile, not a cosmetic codegen
option. Reuse the same PostgreSQL/mysql2/MariaDB profile descriptor at runtime
and in this config. Native JSON roots intentionally remain `unknown` unless a
driver-specific contract narrows them; a manual output override changes emitted
TypeScript only and does not change runtime decoding.
