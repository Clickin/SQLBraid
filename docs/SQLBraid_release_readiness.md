# SQLBraid 0.1.0 release readiness

This file separates repository evidence from maintainer actions outside the
repository. It contains no credentials or registry tokens.

## Current evidence boundary

[Versioned support records](../support/targets/) identify the certified
implementation revision and immutable workflow evidence for each exact tuple.
A changed checkout does not inherit that revision's certification. Runtime,
Documentation, and Release must also pass on the exact final delivery revision,
including evidence-only changes; implementation progress alone is not proof.

The support manifest and executable CI are the only support evidence sources.
An Official label requires an exact database, driver, profile, runtime, and
capability tuple. An unverified server line, runtime, profile option, or
neighboring adapter remains Compatible, Pending, Conditional, Unknown, or
Unsupported as appropriate. D1's managed SQLite version remains unreported;
that fact must not be upgraded by prose. Free-only reproducible environments
remain the release policy.

## Phase-J contract to release

Before a release decision, review the following public contracts against the
implementation and executable evidence:

- `db.session(callback)` pins one provider lease; nested session work reuses it.
- `db.tx(callback)` pins or reuses the physical lease, supports nested savepoints,
  and `db.tx(options, callback)` accepts only supported
  `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable`, and
  `readOnly` combinations. Nested explicit options are rejected.
- `ExecutionOptions`, `RowValidationOptions`, and `StreamOptions` put
  `AbortSignal` and schema options at the end of every operation. Active
  cancellation is capability-driven; unsupported cancellation throws
  `UnsupportedFeatureError` with `BRAID_CANCEL_UNSUPPORTED` before I/O.
- Prepared zero-input/input factories render per execution, lock logical result
  kind and metadata shape, and expose only kind-appropriate operations. A shape
  change fails before I/O.
- `QueryExecutor` methods uniformly use `(statement, binding?, options?)`;
  `bulk` and transaction controls are optional capabilities. Providers and
  leases expose the same immutable binding adapter identity.
- Missing stream, call, routine-channel, hint, or transaction capabilities use
  `UnsupportedFeatureError` and stable `BRAID_*` codes rather than fake fallback.
- Environment capability keys are canonical: `statement.prepare`,
  `statement.stream`, `statement.bulk`, `transaction`,
  `transaction.savepoint`, `routine.out`, `routine.result-sets`,
  `routine.out-cursor`, and `routine.return-value`.
- Bun's adapter uses an explicit user-selected dialect; Deno reuses existing
  adapters where their public APIs work. Neither statement promotes a new
  tuple or invents a dialect.

## Automated release gates

Run the repository's current runtime, package/export, docs, translation, and
immutable release workflows on one clean exact final revision. The docs gate
must run `node scripts/validate-translations.mjs`; every English page has a
Korean entry in `website/translation-registry.json`, and every tracked entry's
`sourceDigest` matches the current English bytes. Update the Korean prose and
registry digest together; do not add blanket opt-outs for ordinary changes.

The docs gate must also build the bilingual site and check internal links and
anchors. The release gate must inspect packed package contents, exports,
dependencies, and hashes. A successful validation does not deploy Pages, publish
npm packages, mutate tags/dist-tags, or authorize a release.

## Candidate identity is not publication authorization

**A version tag identifies an immutable candidate. Tag push does not publish.**
The Release workflow distinguishes four explicit dispatch modes:

| Mode | Purpose | External mutation |
| --- | --- | --- |
| `certify` (default) | Complete release DAG, immutable candidate validation, pnpm publication dry-run | None |
| `pack-only` | Candidate validation without publication rehearsal; not full certification | None |
| `bootstrap-rc0` | One-time first publication of `v0.1.0-rc.0` | Explicitly authorized package publication |
| `publish` | Normal publication from the exact workspace version tag | Explicitly authorized package publication |

A `v*` push runs Release certification, Runtime portability, and Documentation
validation. It cannot publish packages, change registry dist-tags, create a
GitHub Release, deploy Pages, or publish to VS Code Marketplace. Branch pushes
and pull requests are not publication authorization either.

Both mutating modes require `workflow_dispatch` from the exact version tag,
tag-target/checkout identity, synchronized first-party versions, a clean tree,
and all current-run certification jobs. Before mutation,
`scripts/assert-release-workflows.mjs` requires completed successful Runtime
portability and Documentation runs for the exact SHA **and the same tag**.
Only push-triggered runs qualify; rerun a failed tag run rather than substituting
a manual branch dispatch with a colliding ref name.
Other branches/tags, earlier/later revisions, queued/in-progress, cancelled,
failed, and skipped runs do not qualify. The check is bounded, not a polling
loop; dispatch again after the missing workflows finish.

## Pack once, validate once, publish those bytes

Release preparation creates one candidate set per workflow run. Its manifest
records source SHA, package names/versions, tarball filenames, SHA-256,
SHA-512 integrity, and current-run identity. Validation checks the candidate
and records a matching pack-check stamp. Publication downloads those artifacts,
checks their identity/hashes/stamp and dependency-derived order, then publishes
each `.tgz` directly. It does not rebuild or repack package source.

If a publication has an uncertain network outcome, an already-existing
package/version is accepted only when registry integrity exactly matches the
validated candidate. Different bytes fail immediately.

Prereleases use `next` and never change `latest`. Stable releases first publish
under `release-<version>`; only after the entire set's versions and integrity
are verified may `latest` advance. Both paths reject dist-tag downgrades.

## Publication credentials and permissions

`package.json#packageManager` pins pnpm. Publication and publication dry-run use
that pnpm's native tarball publisher, not `npm publish`; no npm CLI upgrade is
part of release. Normal publication uses pnpm native npm Trusted Publishing
with provenance and job-local `id-token: write`. It receives no
`NODE_AUTH_TOKEN`, `NPM_TOKEN`, or bootstrap token, and cannot silently fall back
to a static credential.

`bootstrap-rc0` is the only static-token first-publication path. Its final
mutation job alone receives `NPM_BOOTSTRAP_TOKEN`, via registry authentication
configuration that does not print the expanded secret. Identity and permissions
for the complete package set are checked before publishing the first package.
Only this exact `0.1.0-rc.0` bootstrap may omit provenance. Build, test, and
certification jobs never receive that credential.

Validation has `contents: read`; cross-workflow verification additionally needs
`actions: read`. OIDC write permission belongs only to normal publication.
Any draft GitHub Release creation is a separate `contents: write` job after
successful explicitly dispatched publication. Pages requires its own manual
`deploy=true` authorization; Marketplace publication is not part of this flow.

### Pinned pnpm capability evidence

The pnpm 12.3.4 implementation, not npm CLI parity, defines the release client:

- [`publish_tarball`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/publish.rs)
  reads the supplied tarball directly; native flags include `--dry-run`,
  `--tag`, `--access`, and `--provenance`.
- [The packed publisher](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/publish_packed_pkg.rs)
  returns before registry upload on dry-run. Real provenance generation uses
  those tarball bytes.
- [Native OIDC exchange](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/oidc/auth_token.rs)
  obtains a package-scoped registry token. Publication stays one tarball per
  invocation; batch/workspace publishing is not used.
- [`dist-tag`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/dist_tag.rs)
  supports registry tag updates but only configured authentication, not native
  OIDC exchange. OIDC tag repair/promotion therefore uses narrow repository-owned
  registry requests with package-scoped exchange credentials. Package
  publication itself remains pnpm-native.
- [`whoami`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/whoami.rs)
  natively resolves configured authentication and reads `/-/whoami`.

The [npm Registry API](https://api-docs.npmjs.com/) documents package-scoped OIDC
exchange tokens for package publishing and management. A non-mutating dry-run
proves command/tarball behavior, not that an unconfigured npm Trusted Publisher
will authorize a future real publication.

Packed-consumer compatibility checks may still use `npm install` in disposable
consumer directories. Those checks deliberately exercise npm consumers of pnpm
artifacts; they are not publication, registry administration, or an npm CLI
Trusted Publishing dependency. Release mutation jobs do not run those checks.

### Former npm CLI operations

| Previous operation | Current implementation |
| --- | --- |
| `npm publish`, including dry-run | Pinned `pnpm publish <validated.tgz>`; ordinary publication adds `--provenance` |
| `npm view` | Native `pnpm view ... --json` for package existence, integrity, and dist-tags |
| `npm dist-tag add` | Native `pnpm dist-tag add` with an explicit tag for bootstrap; package-scoped OIDC registry PUT for normal publication |
| `npm whoami` | Native `pnpm whoami` in bootstrap preflight only |
| `npm access ls-packages` | Native `pnpm access list packages <user> --json` |
| `npm org ls` | Bootstrap-only `GET /-/org/sqlbraid/user`; checks the authenticated user's exact creation role |
| Token-grant verification | Bootstrap-only `GET /-/npm/v1/tokens`; uniquely identifies the current token and requires active, non-readonly, automation-enabled package-write grants for All packages |
| `npm config get registry`, `npm ping` | Native `pnpm config get registry`, `pnpm ping` |
| npm CLI version check/upgrade | Removed; exact executable version is checked against `package.json#packageManager` |

No npm CLI operation remains in the release script. pnpm action setup reads the
same `packageManager` field rather than separate workflow version constants.
Bootstrap requires write access to every existing package and organization
creation rights for missing scoped packages; the missing unscoped `sqlbraid`
name is checked for availability. Account ACLs alone are insufficient: the
[registry token metadata](https://api-docs.npmjs.com/#tag/Tokens/operation/listTokens)
must uniquely identify the supplied token by its documented redacted identifier,
with `package`/`write` permission and an All packages (`package`/`*`) grant.
Missing, ambiguous, expired, revoked, readonly, or narrower token evidence fails
before the first upload. This deliberately requires All packages for first
creation of unscoped `sqlbraid`; an organization-only token is insufficient.
Registry authorization/availability errors fail closed. Registry policy and
permissions can still change after preflight; publication is not transactional.

## Maintainer sequence: first RC and later releases

The following are maintainer actions, **not** actions performed by certification:

1. Freeze the source SHA and wait for Runtime portability. Optionally dispatch
   **Actions → Release → Run workflow → branch → `certify`**.
2. Configure `NPM_BOOTSTRAP_TOKEN` as a repository Actions secret with permission
   to create all intended packages and write existing packages: select **All
   packages**, **Read and write** (not stage-only), and automation/2FA bypass,
   with a short expiry. Its read-only token metadata must be available to the
   credential itself or preflight will reject. Do not put it in normal
   publication environments.
3. Create and push `v0.1.0-rc.0` at the frozen SHA. Wait for that tag's Runtime,
   Documentation, and Release certification runs to succeed.
4. Explicitly select **Actions → Release → Run workflow → ref
   `v0.1.0-rc.0` → mode `bootstrap-rc0`**. CLI equivalent:
   `gh workflow run release.yml --ref v0.1.0-rc.0 -f release_mode=bootstrap-rc0`.
   This constructs and certifies a fresh current-run immutable candidate before
   publishing its exact tarballs under `next`; it does not touch `latest`.
5. Inspect registry integrity and dist-tags. Configure npm Trusted Publishers
   for **every** package, identifying `Clickin/SQLBraid`, `release.yml`, and any
   configured publication environment. Remove/disable the bootstrap credential
   when no longer needed.
6. For `0.1.0-rc.1`, synchronize versions, freeze the source, push its version
   tag, and wait for tag certification. Then explicitly select **Release →
   Run workflow → ref `v0.1.0-rc.1` → mode `publish`** (or
   `gh workflow run release.yml --ref v0.1.0-rc.1 -f release_mode=publish`).
   Verify provenance, exact integrity, `next`, and unchanged `latest`.
7. Stable `0.1.0` uses the same **tag → certify → explicit publish** sequence,
   with delayed whole-set promotion to `latest`.
8. Review any draft GitHub Release separately. Dispatch Pages with `deploy=true`
   only if deployment is intended. Do not infer Marketplace authorization.

No local command, docs update, historical workflow, or support-matrix prose
authorizes publication. Never publish a tuple or package that fresh exact-final
evidence did not exercise. Use workflow run records and immutable artifacts,
not moving “latest successful SHA” constants in this document.
