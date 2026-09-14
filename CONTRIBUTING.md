# Contributing to SQLBraid

SQLBraid is a SQL-first toolkit. Contributions should preserve user-authored SQL as opaque text, keep driver boundaries thin, and prefer explicit result and transport contracts over SQL grammar emulation.

## Requesting or adding database support

A support request does not create a maintainer obligation to purchase, host, or operate the requested database environment. Maintainers may classify a target as **Compatible**, **Historical**, or **Unsupported** when an Official gate is not practical or evidence has expired.

A pull request requesting a new **Official** target must include all of the following:

- a zero-cost reproducible setup (no paid license, paid cloud database, private runner, or maintainer-owned server);
- the exact database product, version, and edition;
- the exact driver package and version, including the selected profile/options;
- a `support/targets/<target>.json` manifest with honest capability statuses and conditions;
- structured numeric contracts in the target manifest (`semantics`, canonical `representation`, and transport `fidelity`), plus explicit parsed/lossless JSON and native/lossless temporal profiles where applicable;
- capability tests in `tests/db/<dialect>/capabilities.test.ts` with stable literal IDs in the form `<dialect>.<capability>`; tests exercise the target's native SQL transport and returned values, not SQL grammar that SQLBraid does not own;
- the matching `support/test-registry.json` entries and English/Korean labels in `support/capabilities.json`;
- CI configuration that runs the same capability suite on the declared target and records the workflow/command;
- driver profile constraints and known exclusions;
- release-equivalent green evidence at the exact source commit.

Adapter code alone is not enough for an Official support claim. If zero-cost reproducibility disappears, downgrade the target from Official to Compatible or Historical and keep the implementation separate from the certification claim.

Do not add per-database SQL grammar feature IDs to the support taxonomy. SQLBraid does not certify a DBMS grammar it does not own. Use the common SQL transparency, generated-structure, result, numeric, data-representation, DML-returning, execution, routine, and metadata capability families. Keep native `MERGE` and native UPSERT/REPLACE/ON CONFLICT claims separate.

## Changes to support data

Run the support validator from the repository root before requesting review:

```sh
node scripts/validate-support.mjs
```

Every target must have exact versions, a package/adapter name, bilingual labels, structured numeric semantics/representation/fidelity, container classifications, and machine-linked evidence. Conditional claims require a catalogued condition code. Keep evidence status `pending` until the matching final CI run exists; never infer an Official claim from a local run, a different revision, or a compatible driver.

## Pull request checklist

- [ ] I preserved opaque native SQL and did not add a grammar-specific public capability.
- [ ] I updated the support manifest, capability catalog, and test registry when support data changed.
- [ ] I used exact database, driver, and runtime versions (or downgraded the target instead of guessing).
- [ ] I supplied zero-cost reproducibility and the exact CI command/workflow for any Official request.
- [ ] I added capability tests with literal stable IDs and verified registry linkage.
- [ ] I supplied both English and Korean labels for new capabilities or conditions.
- [ ] I recorded evidence at the exact source commit and did not claim unavailable CI runs.
- [ ] I ran the focused checks relevant to my change, including `node scripts/validate-support.mjs`.
