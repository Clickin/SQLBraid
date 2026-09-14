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

## Required external administration

Only after the final exact revision has passed all automated gates and received
explicit user acceptance may a maintainer:

1. configure and verify npm trusted publishing/OIDC and provenance;
2. publish the intended prerelease packages in dependency order using the
   immutable release workflow;
3. inspect package integrity, `next`/`latest` dist-tags, and provenance;
4. create the intended GitHub release/VSIX attachment;
5. dispatch Pages deployment with `deploy=true`, if requested.

No local command, docs update, historical workflow, or support-matrix prose is
an authorization for those actions. Never publish a tuple or package that the
fresh exact-final evidence did not exercise.
