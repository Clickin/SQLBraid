# SQLBraid reference lock

- Product: SQLBraid
- Clean-room reference: `external SQL reference` public behavior and documentation.
- Reference URL: https://github.com/external SQL reference
- Locked from: `PLAN.md` capability contract, 2026-09-10 plan date.
- Production dependency on `SQLBraid external reference`: none.

## Capability baseline

| Area | PostgreSQL | MySQL | SQLite |
| --- | --- | --- | --- |
| SQL-first tagged templates | required | required | required |
| `/*@braid ...*/` dynamic templates | required | required | required |
| Offline schema snapshots | required | required | required |
| Sound result/bind inference | required | required | required |
| Runtime/static type-policy parity | required | required | required |
| Explicit unknown for opaque semantics | required | required | required |
| Native runtime adapter | `pg` | `mysql2` | `node:sqlite` |

This file records the independent implementation baseline. Detailed feature parity is tracked by executable fixtures as dialect work lands.
