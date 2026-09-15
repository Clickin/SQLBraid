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
The normal Release workflow choices are:

| Mode | Purpose | External mutation |
| --- | --- | --- |
| `certify` (default) | Complete release DAG, immutable candidate validation, and pnpm stage-publication dry-run | None |
| `pack-only` | Pack and inspect a candidate without publication rehearsal; not full certification | None |
| `stage` | Publish the validated immutable `.tgz` files to npm's staging area | Staged package records only |

The one-time RC0 bootstrap is complete and is not a normal or repeatable mode.
The former direct `publish` mode is removed: direct live publication is
disabled. A `v*` push runs Release certification, Runtime portability, and
Documentation validation only. It cannot publish packages, approve staged
packages, change registry dist-tags, create a GitHub Release, deploy Pages, or
publish to VS Code Marketplace. Branch pushes and pull requests are not
publication authorization either.

The `stage` mutation requires `workflow_dispatch` from the exact version tag,
tag-target/checkout identity, synchronized first-party versions, a clean tree,
and all current-run certification jobs. Before mutation,
`scripts/assert-release-workflows.mjs` requires completed successful Runtime
portability and Documentation runs for the exact SHA **and the same tag**.
Only push-triggered runs qualify; rerun a failed tag run rather than substituting
a manual branch dispatch with a colliding ref name. Other branches/tags,
earlier/later revisions, queued/in-progress, cancelled, failed, and skipped runs
do not qualify. The check is bounded, not a polling loop; dispatch again after
the missing workflows finish.

## Pack once, validate once, stage those bytes

Fresh release preparation creates one candidate set per workflow run. Its
manifest records source SHA, package names/versions, tarball filenames, SHA-256,
SHA-512 integrity, and candidate-producer identity. Validation checks the
candidate, records a matching pack-check stamp, and preserves the
`release-candidate-validated` artifact. An explicit recovery may instead
restore that exact validated artifact from a prior run; it rechecks identity
and hashes without repacking. The `stage` mutation downloads the resulting
validated artifact, then invokes pnpm **12.3.4** stage publishing once for each
exact `.tgz`. It never rebuilds or repacks package source, and it never approves
a stage.

The underlying command is pnpm's native stage publisher, with
`--json --provenance --tag <tag> --access public --no-git-checks
--ignore-scripts` (and `--dry-run` for certification). The tarball path is the
validated file, not a package directory. Its per-package shape is:

```sh
pnpm stage publish <validated-package-version.tgz> \
  --json --reporter=silent --provenance --tag <tag> --access public \
  --no-git-checks --ignore-scripts --npmrc-auth-file /dev/null \
  --registry https://registry.npmjs.org/
```

The command's native staging endpoint keeps the package out of the public
registry until a human approves it.

Certification invokes `node scripts/release.mjs --mode stage-dry-run`; only the
explicitly dispatched mutation invokes `node scripts/release.mjs --mode stage`.

The script writes `staged-publication.json` in the artifact directory even when
staging stops part-way through. It records candidate manifest identity, the
before-publication `latest` snapshots, package stage IDs and registry records
as they become available, and explicit `approvalCommands` grouped by dependency
layer. Every report has `mode: "fresh"` or `mode: "reconcile"` and retains the
current run ID/attempt. A partial report is evidence of partial staging, not
approval.
The workflow always uploads that report alongside `release-manifest.json` as
`release-staged-publication`; successful staging also attaches these files and
the compact `release-evidence.json` to the approval-pending draft GitHub
Release. Save the durable summary with them: post-approval verification needs
neither the tarballs nor an unexpired Actions artifact.

Before an upload, the script checks public package integrity and the requested
dist-tags. It intentionally does not read npm's staged-package listing or
download staged tarballs: those maintainer-authenticated reads are outside
GitHub Actions' OIDC capability. A mismatch, unexpected tag movement, or
unavailable registry read fails closed. pnpm obtains its own short-lived OIDC
credential for each upload; no static token or in-memory registry credential is
used.

An upload intent and any returned stage ID are written before follow-up
verification. A network failure retains `pending` evidence and never triggers
an automatic second upload. On retry, an exact public version is reused; a
retained unresolved intent or stage ID requires human authenticated
reconciliation. Dispatches for the same tag serialize staging. Do not delete
partial evidence or approve partial layers to work around an ambiguous result.
The workflow does not claim to have tested real npm OIDC permissions through a
dry-run or fake registry.

Fresh staging is the default: the current run's candidate manifest and
`runId`/`runAttempt` must match, and no prior publication report is imported.
Before a fresh upload, the stage job checks bounded authenticated Actions
run/job history for another non-skipped staging job for the exact tag and
commit. A rerun (`runAttempt > 1`) also fails before upload when no prior
evidence is supplied. This prevents a blank new artifact directory from
turning an earlier uncertain or failed attempt into a second upload.
Cross-run recovery is an explicit workflow dispatch: provide the prior Release
run ID in `prior_run_id`. The workflow downloads that run's staged report and
validated candidate archive (including the original tarballs, VSIX, manifest,
and pack-check stamp), validates all hashes and identities, and passes the
report with `--prior-staged-publication`. No candidate or VSIX is repacked.
The original candidate run identity remains in the manifest; the new staged
report records the current run and retains a digest/link to the prior report.
`pending` or `staged` prior states are uncertain and fail closed without
another upload. An `absent` state may be staged after the normal registry
checks; an exact public state is reconciled without upload. If the prior
artifact is unavailable, corrupt, or from another candidate, stop for explicit
maintainer reconciliation rather than guessing absence. Actions never performs
authenticated staged-list reads, approval, or tag promotion on a maintainer's
behalf.

The validated `release-manifest.json` includes every package and the VSIX:
filename, SHA-256, SHA-512 integrity, extension version/publisher/name, and
the bundled `@sqlbraid/cli` and `@sqlbraid/language-server` versions. The
pack-check stamp repeats that VSIX identity. A later Marketplace publication
must use those exact bytes and never rebuild the extension.

Prereleases stage under `next` and must leave `latest` unchanged. Stable
releases stage first under temporary `release-<version>`; after every package
is approved and integrity/provenance checks pass, a human may safely promote
`latest`. The script does not mutate `latest` or any other dist-tag. If a
network outcome is uncertain, an already-existing package/version is accepted
only when registry integrity exactly matches the validated candidate and its
requested release tag is correct. Missing or stale tags on an exact public
version require maintainer reconciliation; the workflow never repairs them
automatically. Different bytes fail immediately.

## Publication credentials and permissions

`package.json#packageManager` pins pnpm to 12.3.4. Staging and its dry-run use
pnpm's native tarball publisher, not `npm publish`; no npm CLI upgrade is part
of release. Configure npm Trusted Publisher for every package with:

- organization/user: `Clickin`;
- repository: `SQLBraid`;
- workflow filename: `release.yml`;
- environment: **empty** (the repository's `.github/workflows/release.yml`
  has no `environment:` setting); and
- Allowed publishing action: staged publishing only (`npm stage publish`).

Do not enable direct `npm publish`. The stage job receives only the OIDC
`id-token: write` permission needed for the staged exchange and provenance; it
receives no `NODE_AUTH_TOKEN`, `NPM_TOKEN`, or bootstrap token, and cannot fall
back to a static credential. Approval is a separate human action in an
interactive terminal and is never run by Actions. Pages requires its own
manual `deploy=true` authorization; Marketplace publication is not part of
this flow.

### Pinned pnpm capability evidence

The pnpm 12.3.4 implementation, not npm CLI parity, defines the release client:

- [`publish_tarball`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/publish.rs)
  reads the supplied tarball directly; native flags include `--dry-run`,
  `--tag`, `--access`, and `--provenance`.
- [`stage publish`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/stage.rs)
  delegates to that same tarball-aware publish pipeline with the staging
  endpoint; `stage list`, `stage view`, and `stage download` read the
  registry's `-/stage` API.
- [`stage approve`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/stage/approve.rs)
  downloads every selected tarball before approval, derives dependency order
  from those manifests, and POSTs approvals sequentially through one OTP/web
  authentication session. A multi-ID approval is therefore dependency-ordered
  but **not atomic**: a registry-level error can skip one package and its
  dependents, while transport or interactive web-auth errors that escape that
  classification can abort the batch after prior approvals.
  Use the generated dependency-layer commands explicitly rather than collapsing
  all IDs into one command.
- [The packed publisher](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/publish_packed_pkg.rs)
  returns before registry upload on dry-run. Real provenance generation uses
  those tarball bytes.
- [Native OIDC exchange](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/oidc/auth_token.rs)
  obtains a package-scoped registry token. Publication stays one tarball per
  invocation; batch/workspace publishing is not used.
- [`dist-tag`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/dist_tag.rs)
  supports registry tag updates but only configured authentication, not native
  OIDC exchange. The release flow does not invoke it: stable `latest`
  promotion is a human action after verification, and package publication
  itself remains pnpm-native.
- [`whoami`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/whoami.rs)
  natively resolves configured authentication and reads `/-/whoami`.

The [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
documents the repository/workflow/environment match and stage-only Allowed
publishing action. The [staged publishing documentation](https://docs.npmjs.com/staged-publishing/)
documents human approval and its 2FA/proof-of-presence
boundary. A non-mutating dry-run proves command/tarball behavior, not that an
unconfigured npm Trusted Publisher will authorize a future real staging run.

Packed-consumer compatibility checks may still use `npm install` in disposable
consumer directories. Those checks deliberately exercise npm consumers of pnpm
artifacts; they are not publication, registry administration, or an npm CLI
Trusted Publishing dependency. Release mutation jobs do not run those checks.

### Removed direct and bootstrap paths

`bootstrap-rc0` is historical: RC0 was bootstrapped once and must not be
repeated. `publish` and `npm publish` are not aliases for `stage publish`;
direct live publication is disabled. There is no automated `dist-tag` promotion,
and no Actions approval job. The only supported mutation is staged publication,
followed by human `pnpm stage approve` commands and verification. The
`verify-published` helper reports manual stable-`latest` promotion commands; it
does not execute them.

## Maintainer sequence: RC1 and later releases

The following are maintainer actions, **not** actions performed by certification:

1. RC0 bootstrap is already complete. Do not create a token, rerun a bootstrap,
   or treat RC0's historical evidence as evidence for RC1.
2. For a corrected candidate, synchronize versions, prepare and freeze the
   exact source SHA, and create/push a **new** tag (for example
   `v0.1.0-rc.2`). Never reuse or move `v0.1.0-rc.1` after a post-tag fix.
   This tag-triggered run is **certification-only**.
   Wait for its Runtime, Documentation, and Release certification gates; this
   page makes no promise of a new green SHA or substitute evidence.
3. Verify the exact SHA before mutation: tag target, checked-out commit,
   candidate manifest identity, and the matching certification
   artifacts must all agree. Then explicitly dispatch the stage mode from that
   exact new tag: **Actions → Release → Run workflow → ref `<new-candidate-tag>` →
   release_mode `stage`**. CLI equivalent:

   ```sh
   gh workflow run release.yml --ref <new-candidate-tag> -f release_mode=stage
   ```

   This runs the complete current-run certification DAG, verifies exact-tag-SHA
   Runtime and Documentation evidence, verifies candidate hashes, then stages
   validated tarballs in dependency order using OIDC. It records the stage IDs
   returned by `stage publish` but does **not** list, view, or download staged
   packages with the OIDC credential, and does **not** approve them. Those
   read/approval operations remain in the maintainer's authenticated review
   boundary.

4. Review `staged-publication.json` and each registry stage record. Confirm
   candidate identity, exact tarball hashes, stage IDs, provenance, `next`, and
   the unchanged `latest` snapshots. Run each generated `approvalCommands`
   dependency layer in order from a human interactive terminal, for example:

   ```sh
   pnpm stage approve <stage-id> [<stage-id> ...] --registry https://registry.npmjs.org/
   ```

   Do not collapse dependency layers, and never run approval in Actions. A
   partial/non-atomic approval must be stopped and reconciled from the report
   and stage records before continuing. Immediately before approval, recheck
   current dist-tags and stop if `next` has advanced past this prerelease.
   Approval applies the tag selected at staging time; certification cannot lock
   registry channels during a later human approval session.
5. Verify the approved publication without the original workflow or tarballs:

   ```sh
   node scripts/release.mjs --mode verify-published \
     --manifest release-manifest.json \
     --staged-publication staged-publication.json
   ```

   The helper uses the candidate manifest and stage evidence to check exact
   integrity, tags, public provenance metadata, and `latest`. It proves current
   public state, not approval history: after human reconciliation it can verify
   all public packages using an earlier partial report as the immutable baseline.
   It never approves anything. For RC1, `next` must point to the approved packages
   and `latest` must remain unchanged.
6. For a stable version, stage under `release-<version>`. After every stage is
   approved and verification passes, execute the helper's reported manual
   `latest` promotion commands, then optionally rerun verification with
   `--require-latest`. The helper never performs this promotion.
7. A draft GitHub Release created after staging is explicitly
   **approval-pending**. Review it separately; it is not a public-release
   authorization and never causes automatic stage approval or `latest`
   promotion. Its body is the versioned release notes, and an RC version is
   marked `prerelease`; stable versions are not. It carries the compact
   `release-evidence.json` summary in addition to the candidate manifest,
   VSIX, and staged report. This summary retains the source commit, artifact
   hashes, support-evidence file hashes/target IDs, stage IDs, requested tags,
   and current/prior run identities after 14-day Actions artifacts expire.
   Dispatch Pages with `deploy=true` only if deployment is intended. After all
   npm approvals and public verification succeed, finalize and publish the
   GitHub Release manually as appropriate. Do not infer Marketplace
   authorization.

Freeze the exact source commit before creating a candidate tag. A `v*` tag is
an immutable operational identity and must be created once; do not move or
delete it to incorporate a fix. If any fix is needed after tagging, increment
the prerelease (`rc.2`, `rc.3`, and so on), create a new tag, and rerun all
exact-final gates. Configure a repository tag ruleset manually for `v*` with
both **restrict updates** and **restrict deletions** enabled, allowing only
the minimum maintainer/emergency bypass; do not add workflow credentials to
mutate tags. Release preflight also rejects a tag-push event whose prior SHA
differs from the checked-out candidate.

Certification commands, docs updates, historical workflows, and support-matrix
prose do not authorize staging or approval. Only the explicitly dispatched
`stage` mutation and human-reviewed `pnpm stage approve` commands do so. Never
publish a tuple or package that fresh exact-final evidence did not exercise.
Use workflow run records and immutable artifacts, not moving “latest successful
SHA” constants in this document.
