# SQLBraid 0.1.0 release readiness

This document records what the repository automates and what a maintainer must configure outside the repository. It contains no credentials or registry tokens.

## Automated release path

`.github/workflows/release.yml` has two safe entry points:

- `workflow_dispatch` with `dry-run` runs every release gate, packs immutable tarballs, and runs `npm publish --dry-run` against those tarballs. `pack-only` runs the same gates and preserves the validated tarballs without contacting npm for publication.
- A `v*` tag runs the same gates, asserts that the tag points at the tested `HEAD`, preserves the tarballs and VSIX as a workflow artifact, and only then invokes `npm publish --provenance` in dependency-derived topological order. The final step creates a **draft** GitHub Release with the VSIX attached.

The workflow is pinned to Node 22.18.0, pnpm 12.3.4, Bun 1.3.14, and Deno 2.9.3. It uses GitHub-hosted runners, PostgreSQL and MySQL service containers, the real SQLite gate, packed runtime checks, the VS Code host gate, packed examples, package hygiene, and the website build before any publish step.

`scripts/release.mjs` refuses unsynchronized versions, dirty trees, dependency cycles, missing package tarballs, changed validated tarballs, workspace dependency leakage, missing package README/LICENSE files, and a tag that does not point at `HEAD`. The publish mode refuses to run outside GitHub Actions.

## Required external administration

Before the first final tag workflow run, a maintainer must complete these steps in the npm and GitHub UIs:

1. Create or verify the `@sqlbraid` npm organization and all first-party package names. At the time of writing, registry lookup/authentication has not established that any package is published; treat first publication as unbootstrapped until an administrator confirms otherwise.
2. For every package, confirm public access is allowed and repository metadata resolves to `Clickin/SQLBraid`. The package manifests and tarball checks enforce this identity.
3. Configure npm Trusted Publishing for each package using the GitHub owner `Clickin`, repository `SQLBraid`, and the workflow filename `release.yml` (the repository file is `.github/workflows/release.yml`). Leave the environment field unset: this workflow does not select a named environment. npm's current trusted-publisher configuration requires npm CLI >=11.5.1 and Node >=22.14, and the workflow installs npm 11.5.1 before dry-run/final publication.
4. In npm's current publishing settings, explicitly enable the direct npm publish action for the trusted publisher. New configurations may default to a staged-publish action; the release workflow invokes direct `npm publish` and will fail closed if that action is not enabled.
5. Confirm GitHub Actions is allowed to write packages/releases and that the repository's Actions policy permits the pinned actions used by the workflows. The final job requests `id-token: write` for OIDC and `contents: write` for the draft Release.
6. GitHub Pages is enabled with **GitHub Actions** as the source/build type. `.github/workflows/docs-pages.yml` builds `website/` with the frozen lockfile and deploys the Pages artifact. Verify the successful deployment at `https://clickin.github.io/SQLBraid/`.
7. If Marketplace distribution is desired, register and verify the `sqlbraid` publisher and its ownership in the Visual Studio Marketplace. A GitHub Release VSIX is the documented fallback; the npm/docs release does not depend on Marketplace administration.

Current operator checks are intentionally treated as unready external state: `npm whoami` returned `E401`, each `@sqlbraid/*` registry lookup returned `E404`, and the Marketplace `sqlbraid` publisher lookup returned `404`. These observations do not create credentials or claim ownership; an administrator must complete and re-check the setup above.

## Maintainer preflight

- Run `workflow_dispatch` in `dry-run` mode on the exact candidate commit.
- Download the preserved artifact and inspect `release-manifest.json`, tarball SHA-256 values, package order, and `sqlbraid.vsix`.
- Review the draft release notes in `docs/SQLBraid_0.1.0_release_notes.md` and replace only factual release evidence (tag/SHA/run links) after the final run.
- Create the `v0.1.0` tag only after the dry-run is green. Do not publish packages manually from a laptop; a missing trusted-publisher setup should fail the workflow rather than prompt for a credential.
