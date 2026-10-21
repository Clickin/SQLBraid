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
pnpm exec sqlbraid codegen
pnpm exec sqlbraid codegen --config ./sqlbraid.config.mjs
pnpm exec sqlbraid codegen --target main --check
pnpm exec sqlbraid codegen --json
```

The metadata and output paths are relative to the config file.

- Repeat `--target` to select many targets.
- Validation completes for each selected target before any output is written.
- Generated files that do not change keep their mtime.
- The JSON result reports `written` only after the I/O is successful.

The config is trusted Node code that the CLI executes. It is not a sandbox. If the project needs schema changes that people can review, keep the metadata and the generated output under version control.

`TypePolicy` defines how database column types map to TypeScript types. Pass the same PostgreSQL, mysql2, or MariaDB profile descriptor in your codegen config that you pass to the database factory at runtime. Native JSON columns default to `unknown` unless narrowed by a type override, and type overrides affect only the emitted TypeScript declarations—not runtime decoding.
