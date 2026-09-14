## Summary

<!-- What changed, and which SQLBraid responsibility layer does it affect? -->

## Support expansion (complete when applicable)

- Target ID(s):
- Database product/version/edition:
- Driver package/version/profile:
- Runtime/version:
- Support status requested: Compatible / Historical / Official / Unsupported
- Zero-cost reproducibility URL:
- CI workflow and exact command:

### Required evidence

- [ ] This request does not assume SQLBraid maintainers will purchase or operate a database environment.
- [ ] `support/targets/*.json` records exact database, driver, and runtime versions.
- [ ] The driver package/adapter, transport, stream, bulk strategy, raw representations, and exclusions are recorded.
- [ ] New capability IDs use the common taxonomy, not database grammar feature names.
- [ ] Capability tests are literal `<dialect>.<capability>` titles in `tests/db/<dialect>/capabilities.test.ts`.
- [ ] `support/test-registry.json` links every claimed capability to its real test title/file.
- [ ] English and Korean labels are present for every new capability or condition.
- [ ] Official claims have zero-cost setup, release-blocking CI, and green same-commit evidence.
- [ ] Local or historical evidence is marked pending/historical; no CI run or support label is inferred.

## Verification

```sh
node scripts/validate-support.mjs
```

- [ ] I ran the focused checks relevant to this change.
- [ ] I did not publish packages, create tags, or modify CI without describing the reason above.

## Notes / limitations

<!-- Include known profile constraints, unsupported combinations, or evidence gaps. -->
