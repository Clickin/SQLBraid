---
title: VS Code extension
description: Use the thin TypeScript client of SQLBraid. Built-in TypeScript support stays enabled.
---

The `extensions/vscode` package is a thin client for the standard SQLBraid language server. It targets VS Code `>=1.121.0`. It starts only in projects that a config or a dependency identifies as SQLBraid projects. Built-in TypeScript support stays enabled.

The extension adds:

- SQLBraid diagnostics and semantic navigation;
- **Generate Models**;
- **Check Generated Models**;
- **Reload Project**.

The extension does not contain a semantic engine. The VSIX contains the server and CLI
packages at the exact version that the extension pins, with version checks. It does not silently
select a global server or a workspace server.

To test in a clean profile, do these steps:

1. Install the packaged VSIX.
2. Open a project that imports one of the SQLBraid tags.
3. Make sure that TypeScript/TSX language support still comes from the built-in TypeScript extension.
4. If the project has a metadata/codegen config, run **Generate Models** from the command palette. Then run **Check Generated Models**.

The language client uses file selectors that are relative to the workspace. Thus, a TypeScript file outside the workspace does not accidentally become project evidence.
