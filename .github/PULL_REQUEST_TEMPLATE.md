## Summary

<!-- What changed? Which SQLBraid responsibility layer does the change affect? -->

## Support expansion (complete if it applies)

- Target ID(s):
- Database product/version/edition:
- Driver package/version/profile:
- Runtime/version:
- Support status requested: Compatible / Historical / Official / Unsupported
- Zero-cost reproducibility URL:
- CI workflow and exact command:

### Required evidence

- [ ] This request does not expect SQLBraid maintainers to buy or operate a database environment.
- [ ] `support/targets/*.json` records the exact database, driver and runtime versions.
- [ ] The manifest records the driver package or adapter, transport, stream, bulk strategy, raw representations and exclusions.
- [ ] New capability IDs use the common taxonomy. They do not use feature names from a database grammar.
- [ ] Capability tests have literal `<dialect>.<capability>` titles in `tests/db/<dialect>/capabilities.test.ts`.
- [ ] `support/test-registry.json` links each claimed capability to its real test title and file.
- [ ] Each new capability or condition has an English label and a Korean label.
- [ ] Each Official claim has a setup at zero cost, release-blocking CI and green evidence from the same commit.
- [ ] Local or historical evidence has the status pending or historical. I did not infer a CI run or a support label.

## Verification

```sh
node scripts/validate-support.mjs
```

- [ ] I ran the focused checks for this change.
- [ ] I did not publish packages, create tags or change CI. If I did, I gave the reason above.

## Notes / limitations

<!-- Include known profile constraints, unsupported combinations and gaps in the evidence. -->
