---
title: Data representations and value fidelity
description: Keep the semantics of database values at the driver boundary. Then select application types with Standard Schema.
---

SQLBraid keeps the value that the selected driver and profile can actually
carry. A TypeScript type in `sql.rows<T>` does not convert a result. SQLBraid
does not silently narrow an exact database value to a JavaScript `number`.

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

- `semantics` describes the database domain.
- `representation` is the raw application boundary of SQLBraid.
- `fidelity` describes the transport of the selected driver and profile.

A database expression has its own result type. Do not infer it only from a
source column. Aggregates, casts and arithmetic need the metadata and profile
evidence for that expression.

## Canonical numeric boundary

The portable rule is:

```text
exact integer or exact decimal → string
IEEE-754 approximate binary    → number
```

The JavaScript type does not change with the current value. `42` from an exact
`BIGINT` is still `"42"`. A wide value is not "sometimes a string". Exact integer
aliases, `BIGINT`, `DECIMAL`/`NUMERIC`, `MONEY`-style types and vendor aliases
are exact only when the driver can keep them exact. If an exact type is exposed
as a lossy JavaScript `number`, its status is `unsupported` (or explicitly
`guarded`). SQLBraid does not convert it to a string and call it exact.

`decodeExactInteger` stays an optional helper for applications:

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(row.id, { min: 0n }); // bigint in this app
```

It does not change the canonical row type of SQLBraid. `decodeExactDecimal`
validates exact decimal text and returns a string. Use a Decimal, BigInt, Money
or domain transform that the application selects, only after the row gets to
the application boundary. There is no global `numericMode` switch.

## Standard Schema application choices

If the domain requires exact values as text, keep them as text:

```ts
const Row = v.object({ id: v.string(), amount: v.string() });
```

To use a BigInt identifier:

```ts
const Id = v.pipe(v.string(), v.transform(BigInt));
```

Or select an arbitrary-precision decimal library in application code. The
library is only an example. It is not an SQLBraid dependency:

```ts
import Decimal from "decimal.js";
const Amount = v.pipe(
  v.string(),
  v.transform((value) => new Decimal(value)),
);
```

A schema cannot recover digits that a driver already rounded.

## Approximate binary values

`REAL`, `FLOAT`, `DOUBLE`, PostgreSQL `real`/`double precision`, Oracle
`BINARY_FLOAT`/`BINARY_DOUBLE` and SQL Server `real`/`float` are approximate
binary domains. SQLBraid exposes a proven binary32 or binary64 value as
`number`. This is not an exact-decimal guarantee. Profiles record if the
database normalizes `NaN`, infinities or negative zero. A codegen diagnostic is
correct for an exact DB type with a lossy or unsupported transport. It is not
correct only because a type is approximate.

## Driver profiles

This section gives the representation rules of SQLBraid. The [support
matrix](/SQLBraid/reference/support/) stays the evidence authority for each exact
database and runtime revision. A profile is the complete driver configuration
that sets the JavaScript types of results. It is not a label that is added
afterwards.

The first-party profile helpers keep the runtime and codegen on the same rules:

```ts
const profile = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy: profile });
```

PostgreSQL exports `typePolicyForProfile` and `representationProfiles` from
`@sqlbraid/postgres`. mysql2 and MariaDB expose the same shape from their
portable roots. Each descriptor has a stable `id`, `json`, `temporal`,
`typePolicy` and, where it applies, the exact `connectionOptions`. The default
is the lossless text profile. Native and compatibility profiles are separate
descriptors. They are not a second name for the default policy.

The current descriptor IDs are explicit:

- PostgreSQL: `pg-lossless-text`, `pg-native`, `pg-json-native-temporal-text`
  and `pg-json-text-temporal-native`.
- mysql2: `mysql2-lossless-text`, `mysql2-native`, `mysql2-json-text` and
  `mysql2-date-text`.
- MariaDB: the corresponding `mariadb-lossless-text`, `mariadb-native`,
  `mariadb-json-text` and `mariadb-date-text`.

At the driver boundary, **raw** means the value that the driver actually
returned. **Canonical** means the application value of SQLBraid after
`TypePolicy`. They are not interchangeable. Exact string IDs and IDs that the
database generates are exact database values. They use canonical decimal text.
`affectedRows`, `rowCount` and bulk input counts are operational counts. They
stay numbers with a safe-integer guard.

| Target               | Fidelity-first canonical output                                                                                                         | Compatibility boundary                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`    | exact numerics → `string`; JSON/temporal text → `string`; floats → `number`                                                             | native JSON → `unknown`; native `date`/`timestamp`/`timestamptz` → `Date`; `time`/`timetz` remain `string`; `interval` is `unknown`                                           |
| MySQL / `mysql2`     | exact integer/`DECIMAL` → `string`; `jsonStrings`/`dateStrings` → `string`                                                              | native JSON/temporal are separate convenience profile; exact evidence does not transfer                                                                                       |
| MariaDB Connector    | exact integer/`DECIMAL` → `string`; `autoJsonMap:false`/`dateStrings:true` → `string`                                                   | native JSON/temporal are separate convenience profile; exact evidence does not transfer                                                                                       |
| Node SQLite / WASM   | INTEGER storage → `string`; REAL storage → `number`                                                                                     | native bigint is transport-only; D1 is guarded to the safe-integer range                                                                                                      |
| Bun SQL 1.3.14       | PostgreSQL/MySQL/MariaDB `{ bigint: true }`; PostgreSQL decimal → `string`; SQLite `{ safeIntegers: true }`; MariaDB/SQLite JSON → text | integral `Number` rows reject; MySQL/MariaDB DECIMAL and binary share ambiguous bytes and reject; author `CAST(... AS CHAR)`/`HEX(...)`; SQLite native decimal is unsupported |
| Oracle Thin          | `NUMBER` family → `string`; approximate binary → `number`                                                                               | native JSON/temporal values are profile-specific convenience representations                                                                                                  |
| SQL Server / Tedious | preserved exact integer → `string`; approximate binary → `number`                                                                       | native DECIMAL/NUMERIC/MONEY exact output is unsupported; author text casts                                                                                                   |

SQLite columns with dynamic typing follow the runtime storage class. They do not
follow the declared INTEGER affinity. Arrays, domains, ranges, multiranges,
composites, Oracle objects and collections, SQL Server `sql_variant`, vectors and
other containers do not inherit scalar guarantees. Each one is `unclassified` or
`unsupported` until a recursive transport test exists. The JSON section below
describes JSON separately.

## JSON: parsed convenience or lossless text

A parsed JavaScript JSON object is convenient. But ordinary `JSON.parse()` turns
each JSON number into a JavaScript `number`. Thus, nested values such as
`9223372036854775807` or a high-precision decimal have no generic lossless
guarantee.

Profiles must separate these two cases:

- **lossless text** — serialized JSON gets to SQLBraid as text. There is no JS
  Number parsing. The application selects `JSON.parse`, a lossless parser or a
  schema.
- **parsed** — the driver returns an object or a value. The fidelity of nested
  numbers is not guaranteed.

Parsed JSON is not always an object. A root can be a string, number, boolean,
`null`, array or object. Thus, native profiles use `unknown`, unless a root
declaration for the driver and a codegen mapping prove more. A schema can narrow
that value after it gets to the application boundary. It cannot recover digits
that are already converted to a JavaScript `number`.

- PostgreSQL uses a raw-text profile local to the query, where it is supported.
  The default parsed compatibility path stays explicitly parsed.
- The MySQL and MariaDB text profiles use `jsonStrings: true` where the driver
  exposes it (`autoJsonMap: false` for MariaDB Connector).
- SQLite, WASM, D1 and SQL Server use text in their documented paths.
- Oracle can use a tested fetch handler or an explicit `JSON_SERIALIZE(...)`
  expression in your SQL.

SQLBraid never changes a global parser. It never rewrites the SQL of a user.

This guarantee starts at the database result. MySQL native JSON storage can
round decimal tokens and canonicalize keys and whitespace before a driver reads
them. If the original JSON digits must survive a round trip, use a text column.

```text
lossless JSON text → Standard Schema → application-selected parser
parsed object      → Standard Schema → convenient, not automatically lossless
```

## Temporal values

A JavaScript `Date` cannot carry all SQL temporal semantics. It cannot carry
these items:

- the meaning of date-only and local-time values;
- fractional precision finer than milliseconds;
- an offset or a zone identity;
- values outside its range.

Native `Date` is a convenience profile. It is not a general lossless claim.

Where the driver and profile keep it, use temporal text at the raw boundary.
Then transform it with Standard Schema into `Date`, `Temporal.*`, Luxon or a
domain type of the application. The temporal policy is set for each database
type. It is not one broad "Date" switch:

- PostgreSQL native `date`, `timestamp` and `timestamptz` use `Date`.
- Native `time` and `timetz` stay text.
- `interval` stays open on purpose.

To test fidelity, use fixtures with a fractional part that is not zero, such as
`2026-09-14 12:34:56.123456`. PostgreSQL `pg`, MySQL `dateStrings`, MariaDB
`dateStrings` and explicit text conversions in user SQL are separate profiles.
SQLite temporal values stay conventions of the application and the storage. For
Oracle and SQL Server, when native `Date` loses precision, offset or session-zone
semantics, use tested text formatting or an explicit `TO_CHAR`/`CONVERT`
expression.

## Binds, `null` and `undefined`

Exact input fidelity is a different capability from exact output. When a
profile claims it, bind decimal text or an exact integer string through the
documented path. Then do a round trip through the database. Do not first pass a
precise value through a JavaScript `number`. SQLBraid does not rewrite a cast for
you:

```sql
CAST(@nvarchar_parameter AS decimal(38, 18))
```

This is a SQL Server workaround in your SQL. It is not a universal input codec.
Oracle string-to-number binds can depend on NLS settings. Use an explicit
controlled conversion, or classify the path as unsupported.

`null` means SQL `NULL`. Ordinary `undefined` is a programming or configuration
error (`BRAID_BIND_VALUE_UNSUPPORTED`). It is rejected before connection
acquisition in the execute, prepared, bulk, stream and routine IN paths. The
semantics of OUT placeholders stay specific to the driver.

## Containers are a separate evidence boundary

Scalar fidelity does not recursively certify a container. These values each
need their own transport and codegen evidence:

- PostgreSQL arrays, domains, ranges, multiranges and composites;
- Oracle objects and collections;
- SQL Server `sql_variant`;
- vectors;
- parsed JSON roots.

Until that evidence exists, classify the value as `unknown`, `unclassified` or
`unsupported`. Do not inherit a scalar mapping. PostgreSQL lossless array output
can stay raw text. Native array parsing does not promise recursively exact
nested values. The status "supported container" means that the tested container
path works. It does not mean that each nested member is recursively guaranteed.

## Profiles, codegen and transparency

Custom `pg` parsers, mysql2 `typeCast`, MariaDB JSON and temporal options, Oracle
fetch handlers and equivalent overrides are separate profiles. They make the
default evidence invalid until they are tested and selected in both the runtime
and codegen.

- Codegen must use the selected profile descriptor and its TypePolicy. A
  "matching" mapping that you build manually is not evidence.
- `db.environment()` returns a cached observation of the scope. After you change
  session settings, use `db.environment({ refresh: true })`.
- A pooled probe samples one lease. Its observed guarantees stay guarded. They
  are not promises about all future pool sessions.
- Codegen emits output and input representations separately. A manual
  TypeScript override cannot make a lossy transport exact.

SQLBraid sends the SQL that the user writes without automatic casts, parser
rewrites or query-builder translation. Native `RETURNING`, `OUTPUT`, `MERGE`,
UPSERT, `CAST`, `CONVERT`, `JSON_SERIALIZE` and temporal formatting stay visible
SQL. A support capability names the statement that actually executed:

- `merge-returning` is native `MERGE`.
- `upsert-returning` is native UPSERT/REPLACE/ON CONFLICT/ON DUPLICATE KEY.

Similar outcomes do not mean that the syntax is interchangeable.

For the evidence of each revision, read the driver setup pages and the
[runtime and driver support matrix](/SQLBraid/reference/support/). Unknown
evidence stays unknown. A type assertion or a matrix cell that looks green never
promotes it to `lossless`.
