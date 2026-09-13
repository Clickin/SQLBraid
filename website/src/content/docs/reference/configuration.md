---
title: Configuration
description: Configure codegen targets without adding runtime configuration dependencies.
---

SQLBraid discovers one of these executable config names:

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
    targets: [{
      name: "main",
      metadata: "./db/main.metadata.json",
      outFile: "./src/generated/database.ts",
      typePolicy,
    }],
  },
});
```

Paths are relative to the config file. TypeScript configs are not supported. Config code runs as trusted Node application code in a disposable worker; this bounds module-cache lifetime but is not a sandbox.

The tooling workspace discovers TypeScript project context from `tsconfig.json`; VS Code separately uses SQLBraid config and package dependency evidence to decide whether to start a client. The language server watches SQLBraid config names, `tsconfig*.json`, `package.json`, and supported source extensions—not every unrelated file. Metadata and generated evidence are restatted when a workspace request refreshes; arbitrary metadata JSON files do not have dedicated file watchers. Runtime packages do not read this configuration.
