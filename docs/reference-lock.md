# SQLBraid reference lock

- Product: SQLBraid
- Clean-room reference: `external SQL reference` public behavior and documentation.
- Reference URL: https://github.com/external SQL reference
- Locked reference commit: `38ea32b2a16fd79c5c6a58efbdf57446593584bd`
- Reviewed SQLBraid baseline: `166cd2ec6e9de7953d5ea9090513a1987993b9bb`
- Production dependency on `SQLBraid external reference`: none.

## Capability baseline

| Area | PostgreSQL | MySQL | SQLite |
| --- | --- | --- | --- |
| SQL-first tagged templates | implemented | implemented | implemented |
| `/*@braid ...*/` dynamic templates | implemented | implemented | implemented |
| Offline schema snapshots | partial | partial | partial |
| Sound result/bind inference | partial | partial | partial |
| Runtime/static type-policy parity | partial | partial | partial |
| Explicit unknown for opaque semantics | implemented | implemented | implemented |
| Native runtime adapter | partial (`pg` seam) | partial (`mysql2` seam) | verified (`node:sqlite` smoke) |
| Lazy compiled guarded templates | implemented (`compiler emit`) | implemented (`compiler emit`) | implemented (`compiler emit`) |
| Real LSP transport | implemented (stdio) | implemented (stdio) | implemented (stdio) |

## Deliberate boundaries

- Normal tagged-template execution is JavaScript-eager. Guarded nullable expressions are safe only through the compiler transform (`sqlbraid build` or `emitSource`); a bare untransformed template cannot retroactively make JavaScript interpolation lazy.
- Live PostgreSQL/MySQL inspector and protocol verification are not claimed by this revision. No production database was modified.
- SQLite ordinary-table dynamic storage typing remains conservative; the adapter does not infer a narrower type from declared affinity alone.
- Unsupported SQL grammar and missing snapshot evidence are errors/unknown, never exact inferred rows.

## Runtime support policy

- Every published SQLBraid package declares `engines.node >=22.18.0`.
- Build and CI currently run on Node 24.21.0; that validation environment is separate from the published runtime floor.

Detailed finding status is tracked in `planning/parity-status.json` and the executable regression matrix in `tests/remediation.test.ts`.
