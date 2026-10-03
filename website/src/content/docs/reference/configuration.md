---
title: Configuration
description: Configure codegen targets. This adds no runtime configuration dependencies.
---

SQLBraid looks for one of these executable config names:

```text
sqlbraid.config.mjs
sqlbraid.config.js
sqlbraid.config.cjs
```

A config exports `defineConfig({ codegen: { targets } })`:

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/mysql";

export default defineConfig({
  codegen: {
    targets: [
      {
        name: "main",
        metadata: "./db/main.metadata.json",
        outFile: "./src/generated/database.ts",
        typePolicy,
      },
    ],
  },
});
```

Paths are relative to the config file. TypeScript configs are not supported. Config code runs as trusted Node application code in a disposable worker. This limits the lifetime of the module cache. It is not a sandbox.

- The tooling workspace finds the TypeScript project context from `tsconfig.json`.
- VS Code uses the SQLBraid config and the package dependencies, separately, to decide if it starts a client.
- The language server watches the SQLBraid config names, `tsconfig*.json`, `package.json` and the supported source extensions. It does not watch each unrelated file.
- When a workspace request refreshes, the metadata and generated evidence are checked again with `stat`. Arbitrary metadata JSON files do not have dedicated file watchers.
- Runtime packages do not read this configuration.
