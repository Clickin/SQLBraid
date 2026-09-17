# VS Code extension

> Use SQLBraid's thin TypeScript client without replacing built-in TypeScript support.

The `extensions/vscode` package is a thin client for the standard SQLBraid language server. It targets VS Code `>=1.121.0`, starts only for config/dependency-proven SQLBraid projects, and keeps built-in TypeScript support enabled.

The extension contributes:

- SQLBraid diagnostics and semantic navigation;
- **Generate Models**;
- **Check Generated Models**;
- **Reload Project**.

No semantic engine lives in the extension. The VSIX contains matching
`1.0.0` server/CLI dependencies with version checks and does not silently
select a global or workspace server.

For a clean test profile, install the packaged VSIX, open a project that imports one of the SQLBraid tags, and confirm TypeScript/TSX language support still comes from the built-in TypeScript extension. If the project has metadata/codegen config, run Generate Models and then Check Generated Models from the command palette.

The language client uses workspace-relative file selectors so a TypeScript file outside the workspace is not accidentally treated as project evidence.
