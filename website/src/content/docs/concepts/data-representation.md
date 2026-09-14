---
title: Data representations and value fidelity
description: Preserve database value semantics at the driver boundary, then choose application types with Standard Schema.
---

SQLBraid preserves the value a selected driver/profile can actually carry. A
TypeScript type in `sql.rows<T>` does not convert a result, and SQLBraid does
not silently narrow an exact database value to JavaScript `number`.

## The value pipeline

```text
DB type and expression
  → driver/profile raw value
  → dialect TypePolicy normalization
  → plain normalized row
  → query-bound Standard Schema (optional)
  → application value
```

`TypeMapping.numeric` keeps three independent facts visible:

```ts
interface NumericTypeContract {
  semantics: "exact-integer" | "exact-decimal" | "approximate-binary";
  representation: "string" | "number";
  fidelity: "lossless" | "guarded" | "lossy" | "unsupported";
  binaryPrecision?: 32 | 64;
}
```

`semantics` describes the database domain. `representation` is SQLBraid's raw
application boundary. `fidelity` describes the selected driver/profile
transport. A database expression has its own result type; do not infer it only
from a source column. Aggregates, casts and arithmetic need the metadata and
profile evidence for that expression.

## Canonical numeric boundary

The portable rule is simple:

```text
exact integer or exact decimal → string
IEEE-754 approximate binary    → number
```

The JavaScript type does not change with the current value. `42` from an exact
`BIGINT` is still `"42"`, and a wide value is not sometimes a string. Exact
integer aliases, `BIGINT`, `DECIMAL`/`NUMERIC`, `MONEY`-style types and vendor
aliases are exact only when the driver can preserve them. An exact type exposed
as a lossy JavaScript `number` is `unsupported` (or explicitly `guarded`), not a
stringified exact result.

`decodeExactInteger` remains an opt-in application helper:

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(row.id, { min: 0n }); // bigint in this app
```

It does not change SQLBraid's canonical row type. `decodeExactDecimal` validates
exact decimal text and returns a string; use an application-selected Decimal,
BigInt, Money, or domain transform only after the row reaches the application
boundary. There is no global `numericMode` switch.

## Standard Schema application choices

Keep exact values as text when that is the domain contract:

```ts
const Row = v.object({ id: v.string(), amount: v.string() });
```

Opt into a BigInt identifier:

```ts
const Id = v.pipe(v.string(), v.transform(BigInt));
```

Or choose an arbitrary-precision decimal library in application code (the
library is documentation-only, not an SQLBraid dependency):

```ts
import Decimal from "decimal.js";
const Amount = v.pipe(v.string(), v.transform(value => new Decimal(value)));
```

A schema cannot recover digits a driver already rounded.

## Approximate binary values

`REAL`, `FLOAT`, `DOUBLE`, PostgreSQL `real`/`double precision`, Oracle
`BINARY_FLOAT`/`BINARY_DOUBLE`, and SQL Server `real`/`float` are approximate
binary domains. SQLBraid exposes a proven binary32 or binary64 value as
`number`; this is not an exact-decimal guarantee. Profiles record whether the
database normalizes `NaN`, infinities, or negative zero. A codegen diagnostic is
appropriate for an exact DB type with lossy/unsupported transport, not merely
for an approximate type.

## Driver profiles

The following is the current PV18 contract. The [support
matrix](/SQLBraid/reference/support/) remains the evidence source for each exact
database/runtime revision. Targets affected by the current API work remain
Pending or Compatible until fresh exact-SHA gates pass. A profile is the
complete driver configuration that changes result JavaScript types, not a
convenient label attached after the fact.

The first-party profile helpers keep runtime and codegen on the same contract:

```ts
const profile = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy: profile });
```

PostgreSQL exports `typePolicyForProfile` and `representationProfiles` from
`@sqlbraid/postgres`; mysql2 and MariaDB expose the same shape from their
portable roots. Each descriptor has a stable `id`, `json`, `temporal`,
`typePolicy`, and (where relevant) the exact `connectionOptions`. The default
is the lossless text profile. Native/compatibility profiles are separate
descriptors, not a second name for the default policy.

The current descriptor IDs are explicit: PostgreSQL uses
`pg-lossless-text`, `pg-native`, `pg-json-native-temporal-text`, and
`pg-json-text-temporal-native`; mysql2 uses `mysql2-lossless-text`,
`mysql2-native`, `mysql2-json-text`, and `mysql2-date-text`; MariaDB uses
the corresponding `mariadb-lossless-text`, `mariadb-native`,
`mariadb-json-text`, and `mariadb-date-text`.

At the driver boundary, **raw** means what the driver actually returned;
**canonical** means SQLBraid's post-`TypePolicy` application value. They are
not interchangeable. Exact string IDs and database-generated IDs are exact
database values and use canonical decimal text. `affectedRows`, `rowCount`,
and bulk input counts are operational counts and remain safe-integer-guarded
numbers.

| Target | Fidelity-first canonical output | Compatibility boundary |
| --- | --- | --- |
| PostgreSQL / `pg` | exact numerics → `string`; JSON/temporal text → `string`; floats → `number` | native JSON → `unknown`; native `date`/`timestamp`/`timestamptz` → `Date`; `time`/`timetz` remain `string`; `interval` is `unknown` |
| MySQL / `mysql2` | exact integer/`DECIMAL` → `string`; `jsonStrings`/`dateStrings` → `string` | native JSON/temporal are separate convenience profile; exact evidence does not transfer |
| MariaDB Connector | exact integer/`DECIMAL` → `string`; `autoJsonMap:false`/`dateStrings:true` → `string` | native JSON/temporal are separate convenience profile; exact evidence does not transfer |
| Node SQLite / WASM | INTEGER storage → `string`; REAL storage → `number` | native bigint is transport-only; D1 is guarded to the safe-integer range |
| Bun SQL 1.3.14 | PostgreSQL/MySQL/MariaDB `{ bigint: true }`; PostgreSQL decimal → `string`; SQLite `{ safeIntegers: true }`; MariaDB/SQLite JSON → text | integral `Number` rows reject; MySQL/MariaDB DECIMAL and binary share ambiguous bytes and reject; author `CAST(... AS CHAR)`/`HEX(...)`; SQLite native decimal is unsupported |
| Oracle Thin | `NUMBER` family → `string`; approximate binary → `number` | native JSON/temporal values are profile-specific convenience representations |
| SQL Server / Tedious | preserved exact integer → `string`; approximate binary → `number` | native DECIMAL/NUMERIC/MONEY exact output is unsupported; author text casts |

SQLite dynamic-typing columns follow the runtime storage class, not declared
INTEGER affinity. Arrays, domains, ranges, multiranges, composites, Oracle
objects/collections, SQL Server `sql_variant`, vectors, and other containers do
not inherit scalar guarantees: each is `unclassified` or `unsupported` until a
recursive transport test exists. JSON is handled separately below.

## JSON: parsed convenience versus lossless text

A parsed JavaScript JSON object is convenient, but ordinary `JSON.parse()` turns
every JSON number into a JavaScript `number`. Nested values such as
`9223372036854775807` or a high-precision decimal are therefore not a generic
lossless guarantee.

Profiles must distinguish:

- **lossless text** — serialized JSON reaches SQLBraid as text without JS Number
  parsing; the application chooses `JSON.parse`, a lossless parser, or a schema;
- **parsed** — the driver returns an object/value; nested numeric fidelity is
  not guaranteed.

Parsed JSON is not synonymous with an object. A root may be a string, number,
boolean, `null`, array, or object. Native profiles therefore use `unknown`
unless a driver-specific root contract and codegen mapping prove more. A schema
can narrow that value after it reaches the application boundary; it cannot
recover digits already converted to JavaScript `number`.

PostgreSQL uses a query-local raw-text profile where supported; the default
parsed compatibility path remains explicitly parsed. MySQL and MariaDB text
profiles use `jsonStrings: true` where their driver exposes it (`autoJsonMap:
false` for MariaDB Connector). SQLite/WASM/D1 and SQL Server are text-oriented
in their documented paths. Oracle may use a tested fetch handler or an
explicit user-authored `JSON_SERIALIZE(...)` expression. SQLBraid never mutates
a global parser and never rewrites a user's SQL.

This guarantee starts at the database result. MySQL native JSON storage can
round decimal tokens and canonicalize keys/whitespace before any driver reads
them. Use a text column when the original JSON digits must round-trip.

```text
lossless JSON text → Standard Schema → application-selected parser
parsed object      → Standard Schema → convenient, not automatically lossless
```

## Temporal values

A JavaScript `Date` cannot carry every SQL temporal semantic: date-only and
local-time meaning, fractional precision beyond milliseconds, offset, zone
identity, or values outside its range. Native `Date` is a convenience profile,
not a blanket lossless claim.

Where the driver/profile preserves it, prefer temporal text at the raw boundary
and transform with Standard Schema into `Date`, `Temporal.*`, Luxon, or an
application domain type. Temporal policy is per database type, not one broad
“Date” switch: PostgreSQL native `date`, `timestamp`, and `timestamptz` use
`Date`, while native `time` and `timetz` remain text and `interval` is
intentionally open. Use non-zero fractional fixtures such as
`2026-09-14 12:34:56.123456` when assessing fidelity. PostgreSQL `pg`, MySQL
`dateStrings`, MariaDB `dateStrings`, and explicit user SQL text conversions
are separate profiles; SQLite temporal values remain application/storage
conventions. For Oracle and SQL Server, use tested text formatting or an
explicit `TO_CHAR`/`CONVERT` expression when native `Date` loses precision,
offset, or session-zone semantics.

## Binds, `null`, and `undefined`

Exact input fidelity is a separate capability from exact output. When a profile
claims it, bind decimal text or an exact integer string through the documented
path and round-trip it through the database. Do not pass a precise value through
JavaScript `number` first. SQLBraid does not rewrite a cast for you:

```sql
CAST(@nvarchar_parameter AS decimal(38, 18))
```

is an authored SQL Server workaround, not a universal input codec. Oracle
string-to-number binds can depend on NLS settings; use an explicit controlled
conversion or classify the path as unsupported.

`null` means SQL `NULL`. Ordinary `undefined` is a programming/configuration
error (`BRAID_BIND_VALUE_UNSUPPORTED`) and is rejected before connection
acquisition in execute, prepared, bulk, stream, and routine IN paths. OUT
placeholder semantics remain driver-specific.

## Containers are a separate evidence boundary

Scalar fidelity does not recursively certify a container. PostgreSQL arrays,
domains, ranges/multiranges, and composites; Oracle objects/collections; SQL
Server `sql_variant`; vectors; and parsed JSON roots each need their own
transport and codegen evidence. Until then, classify the value as `unknown`,
`unclassified`, or `unsupported` rather than inheriting a scalar mapping.
PostgreSQL lossless array output may remain raw text; native array parsing is
not a promise of recursively exact nested values. A “supported container”
status means the tested container path works; it does not mean every nested
member is recursively guaranteed.

## Profiles, codegen, and transparency

Custom `pg` parsers, mysql2 `typeCast`, MariaDB JSON/temporal options, Oracle
fetch handlers, and equivalent overrides are separate profiles. They invalidate
the default evidence until tested and selected in both runtime and codegen.
The selected profile descriptor and its TypePolicy must be reused by codegen;
manually reconstructing a “matching” mapping is not evidence.
`db.environment()` returns a cached scope observation. Use
`db.environment({ refresh: true })` after changing session settings. A pooled
probe samples one lease; its observed guarantees remain guarded, not promises
about every future pool session.
Codegen emits output and input representations separately; a manual TypeScript
override cannot make lossy transport exact.

SQLBraid sends user-authored SQL without automatic casts, parser rewrites, or
query-builder translation. Native `RETURNING`, `OUTPUT`, `MERGE`, UPSERT,
`CAST`, `CONVERT`, `JSON_SERIALIZE`, and temporal formatting remain visible SQL.
A support capability names the statement actually executed: `merge-returning`
is native `MERGE`; `upsert-returning` is native UPSERT/REPLACE/ON CONFLICT/ON
DUPLICATE KEY. Similar outcomes do not imply interchangeable syntax.

See the driver setup pages and [runtime and driver support matrix](/SQLBraid/reference/support/)
for revision-specific evidence. Unknown evidence stays unknown; it is never
promoted to `lossless` by a type assertion or a green-looking matrix cell.
