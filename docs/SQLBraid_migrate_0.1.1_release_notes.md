# @sqlbraid/migrate 0.1.1 candidate notes

This is a security patch candidate for `@sqlbraid/migrate@0.1.1`.
These notes do not claim npm publication or final release certification.
The candidate tag is `migrate-v0.1.1`. Other packages keep their current versions.

## Security fixes

The Vite plugin rejects public asset links to migration directories, files or parent directories.
Previously, Vite could serve the linked SQL over HTTP and copy it into client build output.
The development guard now checks both project paths and `publicDir` paths on each request.
This also blocks public links added after the server starts.

The candidate includes earlier fixes for case variants and symbolic links in development requests.
It also rejects mistyped migration filenames instead of silently skipping them.
Generated manifests remain trusted build output. The runtime does not calculate their SQL checksums again.

Rebuild affected client output and remove previously exposed SQL files.
If those files contained secrets, review the exposure and cached copies separately.
Updating the package does not remove existing deployed files.

## Compatibility

There are no public API, dependency range or Node engine changes.
Projects that expose migration SQL through `publicDir` now fail before the server starts or the build copies assets.
Move those files outside the public asset tree.
Ordinary public files and links remain supported.

## Validation and release sequence

Local validation passed before candidate creation:

- `pnpm run test:all`, including 1,650 Vitest tests, browser, D1, VS Code and 21 packed packages;
- the final Vite migration suite, with eight tests;
- type checking, build, documentation snippets, formatting and lint.

Run Release certification and Runtime portability on the immutable candidate tag.
Use their exact source SHA and validated tarballs for staging.
Do not substitute the earlier local checks for final candidate evidence.

Staging requires public versions of the candidate's exact workspace dependencies.
These include `@sqlbraid/core@1.0.4`, `@sqlbraid/template@1.0.3` and `@sqlbraid/metadata@1.0.3`.
The published semver lower bounds do not bypass that release evidence rule.
After staging, a maintainer reviews the artifacts and approves publication interactively.

See the [release procedure](SQLBraid_release_readiness.md),
[security review](security-review-2026-10-10.ko.md) and
[migration tool comparison](migration-security-comparison.ko.md).
