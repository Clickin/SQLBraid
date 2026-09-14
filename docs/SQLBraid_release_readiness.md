# SQLBraid 0.1.0 release readiness

This document records what the repository automates and what a maintainer must configure outside the repository. It contains no credentials or registry tokens.

### PV16 evidence status

PV16 adds named MariaDB, native dialect capability, bulk, Browser SQLite WASM,
and local D1 gates. The local working-tree checks below pass; exact-final-SHA CI
remains pending. This document makes no new Official support or publication
claim for those paths. The PostgreSQL minimum role remains 16.4; the separate
current capability role uses PostgreSQL 18.6. The Oracle provisioner is Oracle
Free 23.9, so it must not be cited as Oracle 19c evidence.

### PV16 local working-tree evidence — 2026-09-14

Base commit: `bf9d8f4379e53167d37601dd8c487654395ed296`. No PV16 commit, push,
tag or publication was performed. The package version remains `0.1.0-rc.0`.

- Frozen installation and `pnpm run test:all` passed: typecheck/build,
  58 Vitest files / 390 tests, all six local database suites, real Chromium
  WASM preview and ownership/bulk checks, local D1/workerd, packed TanStack Start
  dev/HMR/build/SSR, actual VS Code hosts, and 18-package hygiene/consumer checks.
- The real-engine bulk harness covers pg, mysql2, MariaDB, node:sqlite, Oracle,
  Tedious, SQLite WASM and D1. It caught mysql2 stale cached handles after
  statement close and Tedious stale Request errors during unprepare; both
  regressions now pass. Native bulk cleanup does not fabricate atomicity.
  Focused follow-up checks also passed positive/empty Oracle DELETE RETURNING
  and actual D1 `withSession("first-primary")` materialized query/native batch.
- PostgreSQL 16.4 and 18.6, MySQL 8.4.2, MariaDB 11.8.9, Oracle Free 23.9 and
  SQL Server 2022-CU18 were exercised. PostgreSQL 18 old/new and MERGE RETURNING
  use the separate current-version gate.
- Packed core/runtime/pg/mysql2 passed on Node 22.18.0, Bun 1.3.14 and
  Deno 2.9.3. Node/Deno node:sqlite passed; Bun's missing node:sqlite remains
  explicitly Unsupported. This does not certify MariaDB/Oracle/Tedious on Bun
  or Deno. The final reviewed mysql2 `node:buffer` import passed source/packed
  audits, typecheck and focused native regressions after the full-suite run.
- `pnpm run docs:build` passed four history checks, 85 pages and 4,054 local
  links/anchors. Packed SQLite/PostgreSQL/MySQL/codegen examples passed.
- SQLite's structural benchmark used N=1/10/100/1000: independent execution
  prepared N statements, bulk prepared one and ran N times. At N=1000 this local
  run measured 16.432 ms versus 4.061 ms; there is no timing pass threshold.
- All 18 packed tarballs passed `npm publish --dry-run --tag next --access public`.
  This is a non-publishing local check, not the immutable Release workflow.

Oracle 19c is blocked: no test endpoint is configured and the official 19.3
enterprise image manifest returns `unauthorized: Auth failed`. Runtime, Docs
and Release CI run IDs for the final changes do not exist yet. A maintainer
must provide the 19c test environment and obtain green same-revision CI after
review/commit before treating PV16 as RC-ready.

PV15 native streaming, routine contracts and Vite integration are in final verification
with verification pending on the exact final revision. RC publication remains
deferred until PV16 development, review and user acceptance are complete. This
readiness record therefore makes no new SHA, CI, runtime support, or package
version claim.

### PV15 local working-tree evidence

Baseline: `2aa3067dcf0c03ccde58a2eca2940c383a73729e`. The existing
`0.1.0-rc.0` candidate version is retained. All five real database suites pass,
including PostgreSQL/MySQL 100k-row streaming, native cleanup,
PostgreSQL refcursors, Oracle OUT cursors/implicit results and Tedious
OUTPUT/RETURN. The MySQL early-break drain deadlock was reproduced against
mysql2's native Readable and fixed without buffering.

Final standards/spec review regressions were reproduced and fixed: pending
PostgreSQL read abort/discard, positional CALL output aliases, Oracle LOB
materialization and close completion, Oracle ResultSet metadata precedence,
guarded routine-contract lowering, generated source-map origins, and aggregate
cleanup-error classification. Focused native PostgreSQL (5 tests) and Oracle
(8 tests) pass, including CLOB/BLOB OUT/INOUT. Public rebuilt-package smoke
checks confirm the previously eager routine bind is not evaluated, generated
locations point to the original query, and no live Oracle Lob escapes.

The final local `test:all` gate passed 344 tests plus the actual editor host,
finance fixture and all 17 packed consumers. This includes the final contract,
mapping, prepared-shape identity, Vite lazy-evaluation and review regressions.
Packed runtime/driver checks pass on Node 22.18.0,
Bun 1.3.14 and Deno 2.9.3, including native pg/mysql2 stream break, mapper and
consumer failure, pre-abort and active abort, transaction ownership and
connection reuse. SQLite passes on Node/Deno; Bun's missing `node:sqlite`
remains explicit. Oracle and Tedious are not thereby certified on Bun/Deno.
Packed examples pass. The bilingual docs build validates 77 pages and
3,358 links/anchors, with four historical-route checks.

The packed Node 24 TanStack Start finance gate passes Vite dev/build/HMR/SSR,
original-source maps and client/server dependency checks. An actual Chromium
session rendered and hydrated the Korean table and exact int64 value without
an application error boundary. Screenshot capture was unavailable; the browser
evidence is DOM/hydration, not a screenshot comparison.

These are working-tree results, not exact-SHA CI or publication evidence.
The final Runtime, Docs and Release dry-run links must refer to one immutable
revision. Historical PV14 evidence below is not reused to certify PV15.

### PV14 local working-tree evidence — 2026-09-13

The implementation was exercised on Node 22.18.0 from base
`bc3092b1d31f8fc5410e8b0b57554567477d1147`, with the existing rc.0 version
changes preserved. Local evidence includes frozen installation, type checking,
build, unit/CLI/consumer tests, all five real database suites, the VS Code host,
16 packed packages, and packed public examples. Node 22.18.0, Bun 1.3.14 and
Deno 2.9.3 passed the existing packed core/runtime/pg/mysql2 matrix; node:sqlite
passed on Node/Deno and remains unavailable on Bun. This does not extend
Oracle/Tedious support to Bun or Deno.

The bilingual documentation build validated 73 pages and 3,084 links/anchors.
All three complete custom-adapter snippets passed strict TypeScript checking.
An actual in-memory SQLite smoke exercised prepared single-render execution,
observer transport metadata, marker preservation, default redaction and inline
diagnostics. Standards/spec review findings for binding provenance, prepared
shape ordering and native value-only execution were addressed with regressions.

These results were collected from the working tree, not exact-SHA CI or immutable
release evidence. The final reviewed commit still needs its CI gates and
immutable release dry-run. No tag, release, npm publication or
dist-tag mutation was performed during local verification; maintainer/user acceptance remains
required before RC publication.

## Automated release path

`.github/workflows/release.yml` has two safe entry points:

- `workflow_dispatch` with `dry-run` runs every release gate, packs immutable tarballs, and runs `npm publish --dry-run` against those tarballs. `pack-only` runs the same gates and preserves the validated tarballs without contacting npm for publication.
- A `v*` tag runs the same gates, asserts that the tag version and commit match the checked-out `HEAD`, preserves the tarballs and VSIX as a workflow artifact, and only then invokes `npm publish --provenance` in dependency-derived topological order. Prereleases use the `next` dist-tag. A stable release is staged under `release-<version>`, verified for every package, and promoted to `latest` only after the complete set is present and exact. The final step creates a **draft** GitHub Release with the VSIX attached.

The workflow is pinned to Node 22.18.0, pnpm 12.3.4, npm 11.15.0, Bun 1.3.14, and Deno 2.9.3; the packed TanStack Start finance gate runs separately on Node 24.21.0. It uses GitHub-hosted runners, PostgreSQL and MySQL service containers, the real SQLite, Oracle, and SQL Server gates, packed runtime checks, the VS Code host gate, packed examples, package hygiene, and the website build before any publish step.

PV15 adds `@sqlbraid/vite`: 17 synchronized npm packages now require tarball,
README/LICENSE, export-resolution and provenance checks. Runtime-only installs
must exclude compiler, Vite, React, TanStack and metadata/tooling packages.
Workflow action pins were checked against official latest GitHub releases:
checkout 7.0.1, setup-node 7.0.0, pnpm/action-setup 6.1.0, setup-bun 2.2.0,
setup-deno 2.0.5, upload-artifact 7.0.1, configure-pages 6.0.0,
upload-pages-artifact 5.0.0 and deploy-pages 5.0.1.

`scripts/release.mjs` refuses unsynchronized versions, dirty trees, dependency cycles, missing package tarballs, changed validated tarballs, workspace dependency leakage, missing package README/LICENSE files, and a tag that does not point at `HEAD`. Publication is restart-safe: an existing `name@version` is skipped only when its registry `dist.integrity` exactly matches the validated tarball; mismatches fail closed. Final `publish` refuses to run outside GitHub Actions.

The local `scripts/npm-bootstrap-rc.mjs` command is the only laptop publication path. It accepts only `0.1.0-rc.0`, requires a clean `HEAD` matching the validated release manifest and pack-check stamp, checks `npm whoami`, the official registry, ping, and `@sqlbraid` write access, and publishes only with `--tag next`. It never publishes a stable version or uses `latest`.

## Required external administration

Before the first final tag workflow run, a maintainer must complete these steps in the npm and GitHub UIs:

1. Create or verify the `@sqlbraid` npm organization and all first-party package names. At the time of writing, registry lookup/authentication has not established that any package is published; treat first publication as unbootstrapped until an administrator confirms otherwise.
2. For every package, confirm public access is allowed and repository metadata resolves to `Clickin/SQLBraid`. The package manifests and tarball checks enforce this identity.
3. Configure npm Trusted Publishing for each package using the GitHub owner `Clickin`, repository `SQLBraid`, and the workflow filename `release.yml` (the repository file is `.github/workflows/release.yml`). Leave the environment field unset: this workflow does not select a named environment. npm's current trusted-publisher configuration requires npm CLI >=11.15.0 and Node >=22.14, and the workflow installs npm 11.15.0 before dry-run/final publication. The package must already exist, so complete and verify the local `rc.0` bootstrap first.
4. In npm's current publishing settings, explicitly enable the direct npm publish action for the trusted publisher. New configurations may default to a staged-publish action; the release workflow invokes direct `npm publish` and will fail closed if that action is not enabled.
5. Confirm GitHub Actions is allowed to write packages/releases and that the repository's Actions policy permits the pinned actions used by the workflows. The final job requests `id-token: write` for OIDC and `contents: write` for the draft Release.
6. GitHub Pages is enabled with **GitHub Actions** as the source/build type. `.github/workflows/docs-pages.yml` builds `website/` with the frozen lockfile and deploys the Pages artifact. Verify the successful deployment at `https://clickin.github.io/SQLBraid/`.
7. If Marketplace distribution is desired, register and verify the `sqlbraid` publisher and its ownership in the Visual Studio Marketplace. A GitHub Release VSIX is the documented fallback; the npm/docs release does not depend on Marketplace administration.

Current operator checks are intentionally treated as unready external state: `npm whoami` returned `E401`, each `@sqlbraid/*` registry lookup returned `E404`, and the Marketplace `sqlbraid` publisher lookup returned `404`. These observations do not create credentials or claim ownership; an administrator must complete and re-check the setup above.

## Maintainer preflight

### Manual rc.0 authentication and publication through pnpm

The maintainer handles browser login and 2FA; never paste credentials or OTPs into an agent session. Use pnpm to provision the same npm CLI version as CI, without adding npm to project dependencies:

```bash
pnpm dlx npm@11.15.0 login --registry=https://registry.npmjs.org/
pnpm dlx npm@11.15.0 whoami --registry=https://registry.npmjs.org/
```

Only after all candidate versions are synchronized to `0.1.0-rc.0`, committed, and the exact commit's immutable artifacts pass validation:

```bash
export SQLBRAID_RC_ARTIFACTS="/absolute/path/to/validated-rc.0-artifacts"
pnpm --package=npm@11.15.0 dlx --shell-mode \
  'node scripts/npm-bootstrap-rc.mjs --artifact-dir "$SQLBRAID_RC_ARTIFACTS"'
```

Do not pass artifacts from another version or revision to bootstrap. Do not push an `rc.0` tag first: a `v*` push triggers OIDC publication before the bootstrap/trust setup is ready. Do not bypass the validated publisher with `pnpm publish`. If interrupted, retry with the same validated artifacts; exact registry integrity is required before skipping a package.

### Candidate gates and trusted publishing

- Keep source manifests at the candidate version, then run `workflow_dispatch` in `pack-only` mode on the exact RC commit and download the preserved artifact.
- For the initial prerelease only, after the full pack validation succeeds, run `npm whoami`, `npm ping`, and `npm config get registry`, then use `scripts/npm-bootstrap-rc.mjs --artifact-dir <validated-artifacts>` while authenticated with 2FA. Review every `next` pointer and `dist.integrity`; do not use `latest`.
- Configure and verify Trusted Publishing for every package after `rc.0` exists. Run `workflow_dispatch`/tag `v0.1.0-rc.1` through the same gates and confirm provenance, exact integrity, `next -> rc.1`, and unchanged `latest`.
- Only after the RC OIDC run succeeds should the stable `v0.1.0` workflow be considered ready.
- Run `workflow_dispatch` in `dry-run` mode on the exact candidate commit.
- Download the preserved artifact and inspect `release-manifest.json`, tarball SHA-256 values, package order, and `sqlbraid.vsix`.
- Review the draft release notes in `docs/SQLBraid_0.1.0_release_notes.md` and replace only factual release evidence (tag/SHA/run links) after the final run.
- Create the `v0.1.0` tag only after the dry-run is green. Do not publish stable packages manually from a laptop; a missing trusted-publisher setup should fail the workflow rather than prompt for a credential.

At implementation time, `npm whoami` returned `E401` and registry lookups for the first-party packages returned `E404`; no RC, stable version, dist-tag, provenance, or Trusted Publisher is claimed here. An authenticated maintainer must perform and record those operational steps.
