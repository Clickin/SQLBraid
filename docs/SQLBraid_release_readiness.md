# SQLBraid 1.0.0 release readiness

This file separates the evidence in the repository from the maintainer actions
outside the repository. It contains no credentials and no registry tokens.

The GA target is stable public interfaces. It is not universal driver
capabilities. This preparation does not claim fresh final certification. It does
not authorize tagging, staging, approval or publication.

- Prereleases stage under `next`.
- Stable releases stage under `latest`.
- Stage approval by a human is a separate maintainer action.

## Current evidence boundary

The [versioned support records](../support/targets/) identify, for each exact
tuple, the certified implementation revision and the immutable workflow
evidence. A changed checkout does not inherit the certification of that
revision. Runtime, Documentation and Release must also pass on the exact final
delivery revision. This includes changes to evidence only. Progress in the
implementation alone is not proof.

The support manifest and the executable CI are the only sources of support
evidence.

- An Official label requires an exact tuple of database, driver, profile,
  runtime and capability.
- An unverified server line, runtime, profile option or neighboring adapter
  stays Compatible, Pending, Conditional, Unknown or Unsupported, as applicable.
- The managed SQLite version of D1 stays unreported. Prose must not upgrade that
  fact.
- The release policy stays: only free reproducible environments.

## 1.0.0 stable interfaces

Before a release decision, compare these public interfaces with the
implementation and the executable evidence:

- `db.session(callback)` pins one provider lease. Nested session work uses the
  same lease.
- `db.tx(callback)` pins or reuses the physical lease and supports nested
  savepoints. `db.tx(options, callback)` accepts only supported combinations of
  `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable` and
  `readOnly`. Nested explicit options are rejected.
- `ExecutionOptions`, `RowValidationOptions` and `StreamOptions` put the
  `AbortSignal` and the schema options at the end of each operation. Active
  cancellation comes from capabilities. Unsupported cancellation throws
  `UnsupportedFeatureError` with `BRAID_CANCEL_UNSUPPORTED` before I/O.
- Prepared factories, with input or without input, render on each execution.
  They lock the logical result kind and the metadata shape. They expose only the
  operations that fit the kind. A change of shape fails before I/O.
- All `QueryExecutor` methods use `(statement, binding?, options?)`. `bulk` and
  the transaction controls are optional capabilities. Providers and leases
  expose the same immutable identity of the binding adapter.
- Missing stream, call, routine-channel, hint or transaction capabilities use
  `UnsupportedFeatureError` and stable `BRAID_*` codes. There is no fake
  fallback.
- The `CALL` sets that mysql2 emits are supported. OUT and INOUT descriptor
  carriers are not supported. SQLite `db.call` / `routine.call` is unsupported.
  This is not a restriction on the SQLite SQL that you write. `callStream` stays
  reserved and not implemented. It is not an available API.
- The environment capability keys are canonical: `statement.prepare`,
  `statement.stream`, `statement.bulk`, `transaction`,
  `transaction.savepoint`, `routine.out`, `routine.result-sets`,
  `routine.out-cursor` and `routine.return-value`.
- The Bun adapter uses a dialect that the user selects explicitly. Deno uses
  the existing adapters where their public APIs work. Neither statement promotes
  a new tuple or invents a dialect.

## Automated release gates

Run these current workflows of the repository on one clean exact final
revision: runtime, package/export, docs, translation and the immutable release
workflow.

The docs gate must run `node scripts/validate-translations.mjs`.

- Each English page has a Korean entry in `website/translation-registry.json`.
- The `sourceDigest` of each tracked entry matches the current English bytes.
- Update the Korean prose and the registry digest together. Do not add blanket
  opt-outs for ordinary changes.

The docs gate must also build the site in both languages. It must check the
internal links and anchors. The release gate must inspect the contents, exports,
dependencies and hashes of the packed packages.

A release validation job does not publish npm packages. It does not change tags
or dist-tags. It does not authorize a release. The separate Documentation
workflow deploys Pages on pushes to `main` and `v*`. Its manual dispatch only
validates by default. It requires `deploy=true` to deploy.

## Candidate identity is not publication authorization

**A version tag identifies an immutable candidate. A tag push does not publish.**
The normal modes of the Release workflow are:

| Mode                | Purpose                                                                                                         | External mutation           |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `certify` (default) | Complete release DAG, validation of the immutable candidate and a pnpm stage-publish dry-run                    | None                        |
| `pack-only`         | Pack and inspect a candidate without a publication rehearsal. This is not full certification.                   | None                        |
| `stage`             | Publish the validated immutable `.tgz` files to the npm staging area                                            | Staged package records only |
| `recover`           | Use current `main` tooling to stage an existing validated candidate again after explicit rejection confirmation | Staged package records only |

The one-time RC0 bootstrap is complete. It is not a normal mode and it is not
repeatable. The former direct `publish` mode is removed. Direct live publication
is disabled in release automation. A new npm package needs the separate
[human-first publication procedure](#first-publication-of-sqlbraidmigrate).

SQLBraid does not require lockstep npm package versions.

- A tag such as `v1.0.3` selects only the unscoped `sqlbraid` package.
- A tag such as `postgres-v1.0.3` or `opentelemetry-v1.1.0` selects only that
  `@sqlbraid/*` package. Do not use `sqlbraid-v*` for the facade.
- Thus, the unscoped `sqlbraid` facade needs a new version only when its own
  public facade surface or its dependency rules change. Its semver dependency
  ranges resolve ordinary compatible driver releases.

The existing `v1.0.0` and `v1.0.2` records keep their original coordinated
package sets. Recovery uses their validated manifests. Do not move those tags
or reinterpret their artifacts as facade-only releases.

A `v*` push runs Release certification, Runtime portability and Documentation
validation. The separate Documentation workflow also deploys Pages for that
facade tag. A package-specific `*-v*` tag runs Release certification and
Runtime portability. The Release DAG still contains its own documentation gate.
But package tags do not create documentation version archives.

None of these tag pushes do these things:

- publish packages;
- approve staged packages;
- change registry dist-tags;
- create a public GitHub Release.

The `stage` mutation has these requirements:

- a `workflow_dispatch` from `main`;
- an existing `candidate_tag` and its certified producer in `prior_run_id`;
- the original validated candidate archive, with matching tag, SHA and hashes;
- a clean tooling checkout and no previous mutation attempt for that candidate.

The `recover` mode separates the tooling checkout from the package source.
It requires a dispatch from `main`, an existing `candidate_tag`, a
`prior_run_id`, and `rejected_stages_confirmed: true`. It restores the original
validated archive instead of building or packing from `main`.
The original candidate must have successful release certification.

The selected package version must match the version in the tag. Unselected
internal workspace dependencies must already exist publicly, at the exact
workspace version that built the candidate. If not, release those dependencies
first.

Before the mutation, `scripts/assert-release-workflows.mjs` requires completed
successful Runtime portability evidence for the exact SHA and the same tag.
Facade `v*` releases also require the Documentation tag run. Only runs that
a push started are accepted.

## Pack once, validate once, stage those bytes

A fresh release preparation creates one candidate set for each workflow run. The
candidate still packs and validates each first-party npm package. Thus, the
export, dependency, facade, runtime and isolated-consumer checks still cover all
packages. Its manifest also records `releasePackages`: the subset that is
authorized for staging. Package-specific releases do not make the package
validation boundary weaker. They make only the mutation boundary smaller.

The manifest records these items:

- the source SHA;
- the package names and versions;
- the tarball filenames;
- SHA-256 and SHA-512 integrity;
- the identity of the candidate producer.

Validation checks the candidate. It records a matching pack-check stamp. It keeps
the `release-candidate-validated` artifact. An explicit recovery can restore
that exact validated artifact from a prior run. The recovery checks the identity
and the hashes again. It does not pack again.

The `stage` mutation downloads the validated artifact. Then it runs the pnpm
**12.3.4** stage publisher once for each exact `.tgz`. It never builds or packs
the package source again. It never approves a stage.

The command is the native stage publisher of pnpm, with
`--json --provenance --tag <tag> --access public --no-git-checks
--ignore-scripts`. Certification adds `--dry-run`. The tarball path is the
validated file, not a package directory. The command for each package has this
shape:

```sh
pnpm stage publish <validated-package-version.tgz> \
  --json --reporter=silent --provenance --tag <tag> --access public \
  --no-git-checks --ignore-scripts --npmrc-auth-file /dev/null \
  --registry https://registry.npmjs.org/
```

The native staging endpoint of the command keeps the package out of the public
registry until a human approves it.

Certification runs `node scripts/release.mjs --mode stage-dry-run`. Explicit
mutations use `scripts/release-recovery.mjs --mode stage` from `main`.

### The staged publication report

The script writes `staged-publication.json` in the artifact directory. It also
writes this file when staging stops before it is complete. The report records:

- the identity of the candidate manifest;
- the `latest` snapshots from before publication;
- the stage IDs and registry records of the packages, when they become available;
- explicit `approvalCommands`, grouped by dependency layer.

Each report has `mode: "fresh"` or `mode: "reconcile"`. It keeps the current run
ID and attempt. A partial report is evidence of partial staging. It is not
approval.

The workflow uploads that report with `release-manifest.json` as
`release-staged-publication`. A successful normal `stage` run also attaches
these files and `release-evidence.json` to an approval-pending draft GitHub
Release. Recovery preserves its evidence as artifacts; it does not create a
draft Release. Save the reports. Verification after approval needs neither
the tarballs nor an Actions artifact that has not expired.

### Registry checks and credentials

Before an upload, the script checks the integrity of the public package and the
requested dist-tags. It does not read the staged-package list of npm. It does not
download staged tarballs. These reads need maintainer authentication, which the
OIDC capability of GitHub Actions does not have. A mismatch, an unexpected tag
movement or an unavailable registry read makes the step fail closed. pnpm gets
its own short-lived OIDC credential for each upload. No static token or
in-memory registry credential is used.

The script writes an upload intent and each returned stage ID before the
follow-up verification.

- A network failure keeps `pending` evidence. It never starts a second upload
  automatically.
- On a retry, an exact public version is reused.
- A kept unresolved intent or stage ID needs reconciliation by a human with
  authentication.
- Dispatches for the same tag serialize staging.

Do not delete partial evidence. Do not approve partial layers to work around an
ambiguous result. The workflow does not claim that a dry-run or a fake registry
tested the real npm OIDC permissions.

### Fresh staging and recovery

Fresh staging runs from `main` with `release_mode=stage`, `candidate_tag` and
`prior_run_id`. The prior run identifies the certified candidate producer.
The manifest keeps that producer identity. No prior publication report is imported.

Before a fresh upload, the stage job checks a bounded part of the authenticated
Actions run and job history. It looks for another non-skipped staging job for the
exact tag and commit. A rerun (`runAttempt > 1`) also fails before upload when no
prior evidence is supplied. This prevents a blank new artifact directory from
turning an earlier uncertain or failed attempt into a second upload.

Older `main` runs can lack a candidate tag in their title. The history check
downloads their `release-staged-publication` artifact with authenticated `gh`.
It validates `recovery-evidence.json` against the run before comparing candidate
tags. A verified different candidate does not block a new release. Missing or
mismatched evidence still blocks staging.

Recovery across runs is an explicit workflow dispatch. Give the ID of the prior
Release run in `prior_run_id`. The workflow then does these steps:

1. It downloads the staged report of that run and the validated npm candidate
   archive. The archive includes the original tarballs, manifest and pack-check
   stamp.
2. It validates all hashes and identities.
3. It gives the report to the script with `--prior-staged-publication`.
4. It restores the original validated archive without building or packing again.

No npm candidate is packed again. This workflow does not include or recover a
VSIX.

The original identity of the candidate run stays in the manifest. The new staged
report records the current run. It keeps a digest of, and a link to, the prior
report.

- Without explicit rejection confirmation, a prior state of `pending` or
  `staged` fails closed without another upload.
- A prior state of `absent` can be staged after the normal registry checks.
- An exact public state is reconciled without upload.
- If the prior artifact is unavailable, corrupt or from another candidate, stop.
  A maintainer must reconcile explicitly. Do not guess that the package is
  absent.

Actions never does authenticated staged-list reads, approval or tag promotion
for a maintainer.

To retry rejected stages, first inspect npm staging with maintainer credentials.
Reject every prior staged candidate. Check that each uncertain upload has no
remaining stage. Then supply `candidate_tag` and `prior_run_id` from `main`.
Select `release_mode=recover` and set `rejected_stages_confirmed` to `true`.

This confirmation is a maintainer statement, not an automated registry check.
The new report preserves the prior package states and stage IDs.
Only copied `staged` and `pending` records become eligible for another upload.
The original candidate manifest, hashes and tarballs do not change.
Missing confirmation, mismatched evidence or conflicting public integrity still
blocks the upload. Rejecting stages alone does not reset the Actions history.

Staging errors include bounded, redacted causes and subprocess diagnostics.
An invalid pnpm response includes its redacted output. These diagnostics do not
authorize a retry or prove that an upload did not occur.

Both staging modes use tooling from `main`, even when the tag lacks a tooling
fix. The candidate tag and package version do not change. Do not move the tag.

### Recover with updated tooling from main

First merge the tooling fix into `main`. Inspect npm staging with maintainer
credentials. Reject all prior staged candidates and confirm that no uncertain
upload has a remaining stage.

Dispatch **Actions → Release → Run workflow** with these inputs:

- ref: `main`;
- `release_mode`: `recover`;
- `candidate_tag`: the original tag, for example `v1.0.2`;
- `prior_run_id`: the run that produced the partial staging report;
- `rejected_stages_confirmed`: `true`.

The selected prior run must retain `release-candidate-validated` and
`release-staged-publication`. Recovery restores those artifacts. It checks the
tag, source SHA, original certification and package hashes before staging.
It does not use the package contents of the tooling checkout.

A failed dependency check can stop staging before `staged-publication.json` exists.
For this case, use the failed staging run as `prior_run_id`.
The preserved artifact must contain the unchanged candidate manifest.
The failed run must identify this candidate and must have preserved its staging evidence successfully.
Recovery still requires an authenticated maintainer to confirm that no prior or uncertain stage remains.
It records `priorStagingJournal: "absent"` in `recovery-evidence.json` and the new staging report.
It does not invent a prior package state or stage ID.
A corrupt journal, changed manifest or failed artifact preservation blocks this recovery path.

Keep the candidate source SHA separate from the tooling SHA in recovery
records. A successful recovery still requires human review and npm approval.
Do not approve a partial recovery.

### npm and VSIX identities

The npm `release-manifest.json` records the filename, SHA-256 and SHA-512
integrity of each package tarball. Its `pack-check-success.json` stamp records
the package names and SHA-256 values, with the version and the source commit.
The Release workflow sets `SQLBRAID_SKIP_VSIX=true`. Neither record sets a VSIX
identity.

The **VS Code Release** workflow is dispatched independently. It builds its own
VSIX with `scripts/package-vscode.mjs`. That script validates these items:

- the name, publisher and version of the extension;
- the bundled `@sqlbraid/cli` and `@sqlbraid/language-server` versions;
- the required files and the license;
- the exact VSIX in a clean editor profile.

The script prints the SHA-256 and the identity of the VSIX. The workflow keeps
`sqlbraid-vscode-<version>.vsix` as the `sqlbraid-vscode-<version>` artifact for
14 days. Open VSX publication downloads that same artifact and uses trusted
publishing. The Microsoft Marketplace upload is a separate manual handoff of
those bytes. Neither path builds the VSIX again after validation. Keep that
artifact and its workflow identity separately. npm prior-run recovery, the npm
manifest and the npm pack-check stamp do not recover or attest the extension.

### Release channels

Prereleases stage under `next` and must not change `latest`. Stable releases
stage directly under `latest`. The requested dist-tag is part of the staged
publication. npm applies it when a maintainer approves the stage. There is no
separate dist-tag promotion step after approval.

If a network outcome is uncertain, an existing package/version is accepted only
in this condition: the registry integrity exactly matches the validated
candidate, and its requested release tag is correct. If an exact public version
has missing or stale tags, a maintainer must reconcile them. The workflow never
repairs them automatically. Different bytes fail immediately.

## Publication credentials and permissions

`package.json#packageManager` pins pnpm to 12.3.4. Staging and its dry-run use
the native tarball publisher of pnpm, not `npm publish`. An upgrade of the npm
CLI is not part of the release. Configure the npm Trusted Publisher for each
package with these values:

- organization/user: `Clickin`;
- repository: `SQLBraid`;
- workflow filename: `release.yml`;
- environment: **empty** (the `.github/workflows/release.yml` file of the
  repository has no `environment:` setting);
- Allowed publishing action: staged publishing only (`npm stage publish`).

Do not enable direct `npm publish` for the Trusted Publisher. The stage job gets
only the OIDC `id-token: write` permission that staged exchange and provenance
need. It gets no `NODE_AUTH_TOKEN`, `NPM_TOKEN` or bootstrap token. It cannot
fall back to a static credential.

Approval is a separate human action in an interactive terminal. Actions never
runs it. Pages requires its own manual `deploy=true` authorization. Marketplace
publication is not part of this flow.

### Pinned pnpm capability evidence

The pnpm 12.3.4 implementation defines the release client. Parity with the npm
CLI does not.

- [`publish_tarball`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/publish.rs)
  reads the supplied tarball directly. Its native flags include `--dry-run`,
  `--tag`, `--access` and `--provenance`.
- [`stage publish`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/stage.rs)
  sends the work to the same tarball-aware publish pipeline, with the staging
  endpoint. `stage list`, `stage view` and `stage download` read the `-/stage`
  API of the registry.
- [`stage approve`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/stage/approve.rs)
  downloads each selected tarball before approval. It gets the dependency order
  from those manifests. It sends the approvals one after the other through one
  OTP/web authentication session. Thus, an approval with many IDs follows the
  dependency order, but it is **not atomic**. A registry-level error can skip
  one package and its dependents. Transport errors or interactive web-auth
  errors outside that classification can stop the batch after earlier
  approvals. Use the generated commands for each dependency layer explicitly. Do
  not put all IDs into one command.
- [The packed publisher](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/publish_packed_pkg.rs)
  returns before the registry upload on a dry-run. Real provenance generation
  uses those tarball bytes.
- [The native OIDC exchange](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/publish/src/oidc/auth_token.rs)
  gets a registry token for one package. Publication stays one tarball for each
  invocation. Batch or workspace publishing is not used.
- [`dist-tag`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/dist_tag.rs)
  supports registry tag updates, but only with configured authentication. It
  does not support the native OIDC exchange. The release flow does not use it.
  The prerelease or stable channel is given to `stage publish` as `next` or
  `latest`. npm applies it when the stage that a human approved becomes public.
- [`whoami`](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/whoami.rs)
  resolves the configured authentication natively and reads `/-/whoami`.

The [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
describes the match of repository, workflow and environment, and the stage-only
Allowed publishing action. The
[staged publishing documentation](https://docs.npmjs.com/staged-publishing/)
describes human approval and its 2FA/proof-of-presence boundary. A dry-run that
changes nothing proves the behavior of the command and the tarball. It does not
prove that an unconfigured npm Trusted Publisher will authorize a future real
staging run.

Packed-consumer compatibility checks can still use `npm install` in disposable
consumer directories. These checks test npm consumers of pnpm artifacts on
purpose. They are not publication, not registry administration and not a
dependency on npm CLI Trusted Publishing. Release mutation jobs do not run these
checks.

### Removed direct and bootstrap paths

`bootstrap-rc0` is historical. RC0 was bootstrapped once. Do not repeat it.
`publish` and `npm publish` are not aliases for `stage publish`. Direct live
publication is disabled in Actions and the release scripts. There is no
automated `dist-tag` mutation and no approval job in Actions. The only supported
automated mutation is staged publication with its requested `next` or `latest`
channel. Human `pnpm stage approve` commands and verification follow it.

### First publication of @sqlbraid/migrate

The first publication of `@sqlbraid/migrate@0.1.0` must be a human action.
The existing RC0 prohibition does not prohibit this new package from being
published manually. It still prohibits restoring automated bootstrap or direct
publication modes. Do not publish an artificial lower version to bypass the
missing-package guard.

Certification can validate an absent package with a staged dry-run. That dry-run
does not authorize publication or prove registry permissions. The real staging
path rejects an absent package before any upload. Do not dispatch `stage` or
`recover` to create the package.

The migration release uses these dependency versions:

| Package                     | Prepared version | Reason                                                            |
| --------------------------- | ---------------- | ----------------------------------------------------------------- |
| `@sqlbraid/core`            | `1.0.3`          | Migration errors and per-operation reuse types                    |
| `@sqlbraid/runtime`         | `1.0.3`          | Per-operation simple execution                                    |
| `@sqlbraid/mysql`           | `1.0.3`          | Parameter-free migration statements use the text protocol         |
| `@sqlbraid/mssql`           | `1.0.3`          | Native batches preserve session state                             |
| `@sqlbraid/metadata`        | `1.0.3`          | Optional drift supports Node 16.20.2                              |
| `@sqlbraid/tooling`         | `1.0.3`          | Migration configuration and config path resolution                |
| `@sqlbraid/cli`             | `1.0.3`          | Migration commands                                                |
| `@sqlbraid/language-server` | `1.0.3`          | TypeScript config watching; matches the CLI bundled by the editor |
| `@sqlbraid/migrate`         | `0.1.0`          | First publication, performed manually                             |

Publish core before runtime, and runtime before the MySQL and SQL Server adapters.
Publish metadata and tooling before the migration CLI rollout.
Publish migrate manually before CLI. Existing packages use normal staged releases.
Template, operations, compiler and codegen need no new version for this release.
The language server is not a migration runtime prerequisite. The editor pins matching CLI and language-server versions.

The repository prepares these versions. It does not prove that npm already contains them.

1. Prepare a clean final revision and obtain separate publication authorization.
   Run the release gates and packed-consumer checks for that exact revision.
   Confirm that the packed dependencies, including `@sqlbraid/core` and
   `@sqlbraid/template`, resolve from npm without workspace links.
   Release those dependencies first if necessary. Do not release a dependent
   CLI version until the migration package is public.
2. For local inspection, build and pack without publication:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build:packages
   LOCAL_PACK_DIR="$(mktemp -d)"
   pnpm --filter @sqlbraid/migrate pack --pack-destination "$LOCAL_PACK_DIR"
   ```

   Inspect the tarball exports, declarations, dependencies, README and license.
   Test installation of that tarball in an isolated consumer.
   This local pack is not final certification evidence.

3. After separate authorization, create the immutable `migrate-v0.1.0`
   candidate tag. Wait for successful Release certification and Runtime
   portability for its exact SHA. The Release DAG includes documentation checks.
   Do not substitute `pack-only` for certification.
4. Download the certified bytes instead of publishing the local inspection pack:

   ```sh
   MIGRATE_RELEASE_DIR="$(mktemp -d)"
   gh run download <certified-run-id> --name release-candidate-validated \
     --dir "$MIGRATE_RELEASE_DIR/download"
   tar -xzf "$MIGRATE_RELEASE_DIR/download/release-candidate-validated.tar.gz" \
     -C "$MIGRATE_RELEASE_DIR"
   ```

   In `sqlbraid-release-artifacts/release-manifest.json`, identify the
   `@sqlbraid/migrate@0.1.0` entry. Confirm its source SHA, producer run and
   `releasePackages` selection. Compare its SHA-256 and SHA-512 integrity with
   the tarball. Keep the manifest, pack-check stamp and certification evidence.
   Set `MIGRATE_TARBALL` to the absolute path of that entry's `file`.
   Do not rebuild or repack these bytes.

5. In a human-controlled terminal, authenticate to npm as an authorized
   maintainer with 2FA. Keep credentials outside the repository and Actions.
   Confirm that the package is still absent. Stop if it already exists or the
   registry read fails for another reason.
6. The human performs this first publication of the validated tarball:

   ```sh
   pnpm whoami --registry https://registry.npmjs.org/
   pnpm publish "$MIGRATE_TARBALL" --access public --tag latest \
     --no-git-checks --ignore-scripts --registry https://registry.npmjs.org/
   pnpm view @sqlbraid/migrate@0.1.0 dist.integrity --json \
     --registry https://registry.npmjs.org/
   pnpm view @sqlbraid/migrate dist-tags --json \
     --registry https://registry.npmjs.org/
   ```

   Compare the public integrity with the saved manifest. Confirm `latest=0.1.0`.
   Save the publication receipt and verify an isolated npm-only installation.
   If the upload outcome is uncertain, inspect the registry before any retry.
   This local publication does not claim GitHub OIDC provenance. Do not invent
   staged evidence or use `verify-published` to claim staged-release provenance.

7. Configure this package's Trusted Publisher with the values above and
   **staged publishing only**. Subsequent new versions use the normal certified
   candidate, OIDC staging and human approval sequence. Do not restage `0.1.0`
   merely to create evidence. Do not add CI tokens or a first-publish fallback.

## Maintainer sequence: 1.0.0 and later releases

These steps are maintainer actions. Certification does **not** do them.

1. The RC0 bootstrap is historical and complete. Do not restore it or create
   an automation token. For an absent new package, use the human-first procedure
   above. Do not use older RC evidence as evidence for this candidate.
2. Create the candidate tag.
   - Change only the version of the package that needs a release and the
     dependency ranges that must change.
   - Use `v1.0.3` for `sqlbraid@1.0.3`, or `postgres-v1.0.3` for
     `@sqlbraid/postgres@1.0.3`.
   - Keep the existing coordinated release tags and their evidence unchanged.
   - Never reuse or move a candidate tag after a fix that follows the tag.

   This run, which the tag starts, does **certification only**. Wait for its
   Runtime, Documentation and Release certification gates. This page does not
   promise a new green SHA or substitute evidence.

3. Verify the candidate SHA before the mutation. The tag target, candidate
   manifest and certification artifacts must agree. Dispatch staging from
   `main`, not from the candidate tag:

   ```sh
   gh workflow run release.yml --ref main -f release_mode=stage \
     -f candidate_tag=<new-candidate-tag> -f prior_run_id=<certified-run-id>
   ```

   This run does these steps:
   - It restores the validated candidate from the certified run without repacking.
   - It verifies the required evidence for the exact tag SHA.
   - It verifies the complete candidate hashes.
   - It stages, with OIDC, only the `releasePackages` that the manifest selects.

   A new release uploads only the selected package. The run records the stage
   IDs that `stage publish` returns. It does **not** list, view or
   download staged packages with the OIDC credential. It does **not** approve
   them. These read and approval operations stay inside the authenticated review
   boundary of the maintainer.

4. Review `staged-publication.json` and each registry stage record. Confirm the
   candidate identity, the exact tarball hashes, the stage IDs, the provenance
   and the requested dist-tag: `next` for prereleases and `latest` for stable
   releases. Run each generated `approvalCommands` dependency layer in sequence,
   from an interactive terminal, as a human. For example:

   ```sh
   pnpm stage approve <stage-id> [<stage-id> ...] --registry https://registry.npmjs.org/
   ```

   - Do not combine dependency layers. Never run approval in Actions.
   - If an approval is partial or not atomic, stop. Reconcile it from the report
     and the stage records before you continue.
   - Immediately before approval, check the current dist-tags again. Stop on an
     unexpected movement. For a prerelease, stop if `next` has moved past that
     candidate.

   Approval applies the tag that was selected at staging time. Certification
   cannot lock registry channels during a later human approval session.

5. Verify the approved publication. You do not need the original workflow or the
   tarballs:

   ```sh
   node scripts/release.mjs --mode verify-published \
     --manifest release-manifest.json \
     --staged-publication staged-publication.json
   ```

   The helper uses the candidate manifest and the stage evidence. It checks the
   exact integrity, the tags, the public provenance metadata and the channel
   policy. It proves the current public state. It does not prove the approval
   history. After a human reconciliation, it can verify all public packages with
   an earlier partial report as the immutable baseline. It never approves
   anything.
   - Stable releases require that `latest` points to the approved version.
   - Prereleases require `next`. The helper also verifies that `latest` did not
     change.

6. A draft GitHub Release that staging creates is explicitly
   **approval-pending**. Review it separately. It does not authorize a public
   release. It never causes an automatic stage approval or a `latest` promotion.
   - Its body is the versioned release notes.
   - An RC version is marked `prerelease`. Stable versions are not.
   - It carries the compact `release-evidence.json` summary, the npm candidate
     manifest and the staged report. It does not carry a VSIX.
   - The summary keeps the source commit, the npm artifact hashes, the hashes and
     target IDs of the support-evidence files, the stage IDs, the requested tags
     and the identities of the current and prior runs. It stays after the
     Actions artifacts expire at 14 days.

   Pages deploys automatically on the documented `main`/tag push path. Use the
   manual `deploy=true` only when you intentionally dispatch the Documentation
   workflow. After all npm approvals and the public verification succeed,
   finalize and publish the GitHub Release manually, as applicable. Do not infer
   Marketplace authorization.

### Tag rules

Freeze the exact source commit before you create a candidate tag. Both `v*`
and `*-v*` tags are immutable operational identities. Create each tag once.
Do not move or delete it to add a fix. If package contents change after tagging,
select a new version and run all exact-final gates again. Tooling-only fixes
run from `main` with the original validated bytes and unchanged tag.

Configure repository tag rulesets for both `v*` and `*-v*` manually. Enable
**restrict updates** and **restrict deletions**. Permit only the minimum maintainer or
emergency bypass. Do not add workflow credentials that can change tags. Release
preflight also rejects a tag-push event whose prior SHA is different from the
checked-out candidate.

Certification commands, docs updates, historical workflows and support-matrix
prose do not authorize staging or approval. Only the explicitly dispatched
`stage` or `recover` mutation and the `pnpm stage approve` commands that a human
reviewed authorize them. Never publish a tuple or a package that exact-final
evidence did not test. Use workflow run records and immutable artifacts. Do not
put constants such as a "latest successful SHA" in this document.

## Immutable-candidate certification gate

Driver certification is a required gate that does not change anything. It runs
on the exact checked-out commit.

- `driver-certification.yml` builds the package `dist` once. It keeps the
  prepared archive and its SHA-256 identity.
- It runs the complete catalog from `tests/certification/contracts.ts` on
  Node 22.18.0, Deno 2.9.3, Bun 1.3.14, D1/workerd and browser WASM.
- Each target artifact records the measured environment tuple separately from
  the pinned expected tuple.
- The aggregation rejects missing, duplicate, skipped, wrong-SHA, wrong-tuple,
  forged-catalog and forged-candidate artifacts.
- The registries supply the required target and case counts. There is no fixed
  maximum.

The shared runtime, native-fault and OpenTelemetry suites produce a global
evidence shard for the same SHA. The final aggregate requires that shard and all
target artifacts.

Release certification downloads `release-prepared`. It verifies the candidate
manifest and the archive hashes. It restores only the prepared `dist` and runs
the same full matrix. It is a direct dependency of `release-final`. It does not
build or publish. Release staging and registry approval stay separate operations
that a human authorizes.

## Semantic behavior coverage

The database/version matrix stays mandatory. These files add to it:
`tests/contracts/catalog.json` and `tests/contracts/matrix.json`. They contain
named behavioral scenarios, canonical transport/profile targets and exclusions
that capabilities check. New transports and missing classifications fail
`pnpm run contracts:validate`. `support:validate` also runs that check.

Release has three checks that complement each other:

- The existing DB, browser and Bun jobs run semantic integration scenarios.
- The common job runs deterministic native-driver fault scenarios.
- `release-semantic-contracts` requires passed evidence for each applicable cell
  before `release-final` can run. This applies also when all DB jobs are green.

Evidence comes from individual passed assertions. It does not come from a
threshold of test counts or from the presence of a test file.

- Titles identify the transport, the scenario and the `integration` or
  `boundary` layer.
- Ownership markers separate direct transactions from pooled transactions.
- Report sidecars bind the report digest and the source SHA to the expected
  support targets.
- Expected bindings are not measured database/runtime evidence. The existing
  exact-tuple support and driver-certification gates stay required.
- Skipped tests, stale reports and unsupported exclusions cannot fill a required
  cell.

For a fast local fault loop, use `pnpm run test:contracts:boundary`. Real
database scenarios stay in the existing `test:db:*` projects. Local execution
and static matrix validation do not replace Release `certify` on the exact final
revision.

### Native failures that the semantic gate found

The Bun SQL lanes stay required. Native diagnostics separate fixes to adapter
ownership from capabilities that the pinned transport cannot give safely:

- Bun 1.3.14 PostgreSQL closes a discarded reserved connection. But the graceful
  `close()` of its pool can stay pending after an aborted transaction returns
  `ROLLBACK` from `COMMIT`. Keep that failed terminal outcome. Discard the
  reservation, not the owning pool. The pool that the caller owns must stay
  usable for fresh work. Its final shutdown uses an explicit positive native
  timeout (`client.close({ timeout: 1 })`) after those assertions. A native pool
  close without a limit is not evidence that SQLBraid still owns a lease. A
  comparison with Bun 1.4.2 does not change the pinned certification tuple.
- Bun 1.3.14 and 1.4.2 MySQL cache the failure of the first INSERT prepare in a
  read-only transaction. If the same statement is used again after an explicit
  `START TRANSACTION READ WRITE`, it still rejects with error 1792. The pinned
  MariaDB transport has the same failure. To prewarm the statement, change its
  SQL text or change the order of the access-mode scenario would hide the
  defect. It would not prove support.

The expanded native diagnostics in `tests/scripts/bun-sql-readonly-repro.mjs`
found no safe recovery in the same session through the public Bun 1.3.14 APIs.
The native constructor rejects `prepare: false`. Thus, Bun.SQL MySQL and MariaDB
declare `transaction.read-only` unsupported under the condition
`bun-sql.mysql-read-only-cache`.

- Both explicit `readOnly: true` and `readOnly: false` reject before acquisition
  and I/O, with `BRAID_TX_OPTION_UNSUPPORTED`.
- If you omit the option, the actual session default stays. This is not a forced
  read-write mode.
- Ordinary transactions and isolation stay supported.
- The access modes of Bun.SQL PostgreSQL and the representation-profile options
  do not change.

A native read-only rejection (errno 1792 / SQLSTATE 25006) can still occur under
an inherited session default. Mark that reservation for disposal after the
normal terminal cleanup of the owning scope. Do not release it as healthy. Do not
change the physical connection during the session. This is a containment rule.
It does not claim to repair the statement cache of Bun.

Keep the access-mode scenario ID and the applicability that capabilities check.
Test unsupported options before I/O. Keep all remaining real semantic cells. The
source and packed checks in `tests/scripts/bun-sql-matrix.mjs` and `db-bun-sql`
must test the resulting behavior. A passing historical capability artifact cannot
certify the changed revision. This page claims no new support label and no
passing final gate. Exact-final Runtime, Documentation and Release evidence is
still required.

Local libSQL has a different, explicit limitation. Its native ROWID metadata is
rounded before the client returns a bigint. Thus, the adapter omits the optional
`command.insertId` for file clients and clients with an unknown protocol. It
does not invent precision. It does not fail after a successful mutation. Its
checked metadata exclusions apply only to that unavailable channel. Native tests
still require exact `RETURNING` rows, successful mutations with large IDs and
correct bulk counts.
