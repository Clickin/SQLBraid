# SQLBraid for VS Code

Write SQL. Keep TypeScript.

A thin client for the standard SQLBraid language server. Native TypeScript support remains enabled; SQLBraid contributes Braid/overlay diagnostics and metadata-backed SQL completion, hover, definition, references and symbols. Missing metadata means unresolved evidence, not invalid SQL.

## Requirements and activation

VS Code 1.121.0 or newer. The tested 1.121.0 host contains Node 22.22.1, satisfying SQLBraid tooling's Node 22.18.0 floor. The extension uses the editor's Node executable and bundles matching SQLBraid 0.1.0 CLI/server packages; it does not select a global server.

The server starts for TypeScript/TSX documents only in projects containing `sqlbraid.config.mjs`, `.js` or `.cjs`, or a SQLBraid dependency in `package.json`. Config is executable trusted Node code, not sandboxed data. Do not open untrusted SQLBraid configs expecting isolation.

## Commands

- **SQLBraid: Generate Models** runs configured codegen.
- **SQLBraid: Check Generated Models** checks freshness without writes.
- **SQLBraid: Reload Project** reloads project evidence and restarts its client.

Definitions prefer actual current generated models, then metadata JSON. Stale generated files are never assigned fabricated locations. Change metadata/config and regenerate instead of editing derived models manually.

## Repository validation

From the repository root:

```bash
pnpm run build
pnpm run test:vscode
pnpm run pack:check
```

The host gate runs real editor activation, SQL hover/navigation, generation/check/reload and TypeScript coexistence. The package gate builds a VSIX and verifies that its entrypoint and matching CLI/server dependencies are present. It also exercises packed external tooling consumers; it does not publish the extension.

Agents should use standard LSP first, or `sqlbraid inspect query|symbol|diagnostics --json`. The portable instructions are in `skills/sqlbraid/SKILL.md` in the repository.
