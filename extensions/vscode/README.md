# SQLBraid for VS Code

Write SQL. Keep TypeScript.

A thin client for the standard SQLBraid language server. Native TypeScript support stays enabled. SQLBraid adds these features:

- Braid and overlay diagnostics;
- SQL completion, hover, definition, references and symbols from metadata.

If metadata is missing, the evidence is unresolved. This does not mean that the SQL is invalid.

## Requirements and activation

The extension requires VS Code 1.121.0 or later. The tested 1.121.0 host contains Node 22.22.1. This satisfies the Node 22.18.0 floor of SQLBraid tooling. The extension uses the Node executable of the editor. It bundles the `@sqlbraid/cli` and `@sqlbraid/language-server` packages at the exact version that its `package.json` pins. It does not select a global server.

The server starts for TypeScript and TSX documents only in a project that has one of these:

- a `sqlbraid.config.mjs`, `.js` or `.cjs` file;
- a SQLBraid dependency in `package.json`.

The config is trusted Node code that the extension executes. It is not sandboxed data. Thus, the extension declares that it does not support untrusted workspaces. VS Code disables it in Restricted Mode, and it starts only after you trust the workspace. Do not trust a workspace that has an unknown SQLBraid config.

## Commands

- **SQLBraid: Generate Models** runs configured codegen.
- **SQLBraid: Check Generated Models** checks that generated files are current. It does not write files.
- **SQLBraid: Reload Project** reloads the project evidence and restarts the client.

Go to Definition uses the current generated models first. Then it uses the metadata JSON. The extension never gives a stale generated file an invented location. Do not edit the generated models manually. Change the metadata or the config, then generate the models again.

## Repository validation

From the repository root:

```bash
pnpm run build
pnpm run test:vscode
pnpm run pack:check
```

The host gate tests these items in a real editor:

- activation;
- SQL hover and navigation;
- generate, check and reload;
- coexistence with TypeScript.

The package gate builds a VSIX. It checks that the VSIX contains its entry point and the matching CLI and server dependencies. It also tests packed external tooling consumers. It does not publish the extension.

An agent must use standard LSP first, or `sqlbraid inspect query|symbol|diagnostics --json`. The portable instructions are in `skills/sqlbraid/SKILL.md` in the repository.
