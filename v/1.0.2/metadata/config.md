# Codegen configuration

> Generate deterministic TypeScript models from a metadata snapshot.

Install `@sqlbraid/cli`, `@sqlbraid/codegen`, the selected dialect and the driver in your tooling project. Create an executable Node config (`.mjs`, `.js` or `.cjs`):

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

Run this command from the project that contains the config:

```bash
sqlbraid codegen
sqlbraid codegen --config ./sqlbraid.config.mjs
sqlbraid codegen --target main --check
sqlbraid codegen --json
```

The metadata and output paths are relative to the config file.

- Repeat `--target` to select many targets.
- Validation completes for each selected target before any output is written.
- Generated files that do not change keep their mtime.
- The JSON result reports `written` only after the I/O is successful.

The config is trusted Node code that the CLI executes. It is not a sandbox. If the project needs schema changes that people can review, keep the metadata and the generated output under version control.

The selected TypePolicy is a representation profile. It is not a cosmetic
codegen option. Use the same PostgreSQL, mysql2 or MariaDB profile descriptor at
runtime and in this config. Native JSON roots stay `unknown` on purpose, unless a
declaration for the driver narrows them. A manual output override changes only
the emitted TypeScript. It does not change runtime decoding.
