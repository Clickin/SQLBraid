# Contributing to SQLBraid

SQLBraid is a SQL-first toolkit. A contribution must obey these rules:

- Keep user-authored SQL as opaque text.
- Keep driver boundaries thin.
- Use explicit result and transport rules. Do not emulate SQL grammar.

Before you change execution, driver, compiler or package boundaries, read the
[contributor mental model](./docs/mental-model.md). It explains these topics:

- the `core → template → runtime → adapter` flow;
- the ownership of physical resources;
- the separate static-tooling plane.

A Korean version is in [`docs/mental-model.ko.md`](./docs/mental-model.ko.md).

Write documentation in the style that
[`docs/writing-style.md`](./docs/writing-style.md) defines.

## Requesting or adding database support

A support request does not oblige maintainers to buy, host or operate the
requested database environment. If an Official gate is not practical, or if the
evidence has expired, maintainers can classify a target as **Compatible**,
**Historical** or **Unsupported**.

A pull request that requests a new **Official** target must include all of these
items:

- A reproducible setup at zero cost. It must not need a paid license, a paid
  cloud database, a private runner or a server that a maintainer owns.
- The exact database product, version and edition.
- The exact driver package and version, with the selected profile and options.
- A `support/targets/<target>.json` manifest with honest capability statuses and
  conditions.
- Structured numeric rules in the target manifest: `semantics`, canonical
  `representation` and transport `fidelity`. Where they apply, also include
  explicit parsed/lossless JSON profiles and native/lossless temporal profiles.
- Capability tests in `tests/db/<dialect>/capabilities.test.ts`. Each test has a
  stable literal ID in the form `<dialect>.<capability>`. The tests examine the
  native SQL transport and the returned values of the target. They do not test
  SQL grammar that SQLBraid does not own.
- The matching `support/test-registry.json` entries, and English and Korean
  labels in `support/capabilities.json`.
- A CI configuration that runs the same capability suite on the declared target.
  It must record the workflow and the command.
- The constraints of the driver profile and the known exclusions.
- Green evidence, equivalent to a release, at the exact source commit.

Adapter code alone does not make an Official support claim. If reproducibility
at zero cost stops, downgrade the target from Official to Compatible or
Historical. Keep the implementation separate from the certification claim.

Do not add SQL grammar feature IDs for one database to the support taxonomy.
SQLBraid does not certify a DBMS grammar that it does not own. Use these common
capability families:

- SQL transparency;
- generated structure;
- result;
- numeric;
- data representation;
- DML returning;
- execution;
- routine;
- metadata.

Keep native `MERGE` claims separate from native UPSERT/REPLACE/ON CONFLICT
claims.

## Changes to support data

Before you request a review, run the support validator from the repository root:

```sh
node scripts/validate-support.mjs
```

Each target must have these items:

- exact versions;
- a package or adapter name;
- labels in two languages;
- structured numeric semantics, representation and fidelity;
- container classifications;
- machine-linked evidence.

A conditional claim requires a condition code from the catalog. Keep the
evidence status `pending` until the matching final CI run exists. Do not infer
an Official claim from a local run, a different revision or a compatible driver.

## Pull request checklist

- [ ] I kept native SQL opaque. I did not add a grammar-specific public capability.
- [ ] I updated the support manifest, capability catalog and test registry when support data changed.
- [ ] I used exact database, driver and runtime versions. If I did not know a version, I downgraded the target.
- [ ] For an Official request, I supplied reproducibility at zero cost and the exact CI command or workflow.
- [ ] I added capability tests with stable literal IDs and checked the registry links.
- [ ] I supplied English and Korean labels for new capabilities or conditions.
- [ ] I recorded evidence at the exact source commit. I did not claim CI runs that do not exist.
- [ ] I ran the focused checks for my change, including `node scripts/validate-support.mjs`.
