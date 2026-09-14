---
title: Data representations and numeric fidelity
description: Follow a database value from the driver boundary to a typed application value without losing precision.
---

SQLBraid keeps database representation decisions explicit. A TypeScript type in
`sql.rows<T>` does not change the value returned by a driver, and SQLBraid does
not silently turn a decimal or 64-bit integer into a JavaScript `number`.

## The value pipeline

Every mapped row follows this boundary:

```text
DB type
  → driver raw value
  → dialect TypePolicy / Numeric Fidelity
  → plain normalized row
  → Standard Schema (optional)
  → application value
```

The driver profile determines the raw value. The dialect `TypePolicy` makes the
profile's integer, decimal, JSON, temporal, and binary rules visible to runtime
and code generation. A Standard Schema can then validate or transform one row;
it is not a replacement for a fidelity-preserving driver profile.

```ts
interface AccountRow {
  id: bigint;
  balance: string;
}

const accounts = sql.rows<AccountRow>`
  SELECT id, balance FROM account
`;
```

`sql.rows<AccountRow>` is a compile-time declaration only. It does not validate,
parse, or convert a result. `sql.rows(AccountSchema)` invokes the Standard
Schema protocol at runtime and may validate or transform each row:

```ts
const accounts = sql.rows(AccountSchema)`
  SELECT id, balance FROM account
`;
```

The declaration and the runtime mapper must agree with the selected driver
profile. A type assertion cannot recover digits already lost by a driver.

## Exact integers

JavaScript `number` cannot represent every signed 64-bit integer. Use a driver
profile that returns an integer as `bigint` or decimal text, then choose the
application representation deliberately. SQLBraid's exact integer helper
accepts an integer-shaped driver value and returns a `bigint`:

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(rawId, { min: 0n });
```

The optional `min` and `max` bounds are checked as `bigint`; an invalid or
out-of-range value throws `ResultExactnessError` with code
`BRAID_RESULT_EXACTNESS`. Do not use `Number(id)` unless the application has
first proved that the value is inside the safe integer range.

SQLite is the explicit exception to a one-size-fits-all rule: the Node adapter's
`integerMode` is `"number"` by default and `"bigint"` when exact int64 results
are required. Generated models must use the matching
`typePolicyForIntegerMode()`.

## Exact decimals

A decimal is not a floating-point number. SQLBraid's exact decimal helper is
conservative and returns a canonical decimal string; the default API accepts a
string only:

```ts
import { decodeExactDecimal } from "@sqlbraid/core";

const amount = decodeExactDecimal(rawAmount);
// amount: string
```

A JavaScript `number` has already rounded a decimal before this helper sees it,
so it is rejected rather than presented as exact. `ResultExactnessError` uses
`BRAID_RESULT_EXACTNESS`. Keep the string in the application or pass it to an
explicit decimal library (for example, a project-selected arbitrary-precision
package) at the application boundary. SQLBraid does not add a decimal library
or choose rounding/scale policy.

Oracle Thin `NUMBER` results are strings. SQL Server Tedious `decimal` and
`numeric` results are JavaScript numbers in the supported default path and are
therefore **not exact decimal support**. For Tedious, select an explicit SQL
conversion to text when decimal fidelity matters and declare a string result
contract. MySQL exactness depends on the tested mysql2 profile; do not enable
`decimalNumbers` in an exact-decimal profile.

## Approximate floats

`REAL`, `FLOAT`, `BINARY_FLOAT`, and `BINARY_DOUBLE` are approximate by design.
Keep them as numbers when approximate arithmetic is intended. Do not reuse an
exact-integer or exact-decimal declaration for a floating-point column.

## JSON

JSON may arrive as a native object, a text string, or a driver-specific value.
The profile must document which one is expected:

- native JSON objects can be sent directly to a Standard Schema object schema;
- JSON text should be parsed and validated by the schema (`parseJson`, or an
  equivalent transform);
- malformed JSON is a data/driver error, not evidence that SQLBraid supports a
  different representation.

`jsonStrings` and custom parser/type-cast options are profile choices. Changing
them without changing the TypePolicy and schema contract is unsupported.

## Temporal, binary, and NULL values

Temporal values are driver-specific (`Date` or an explicit text/binary profile).
A JavaScript `Date` does not preserve every source timezone name or sub-
millisecond detail. Use a string contract when those details are significant.

Binary values are usually `Buffer`/`Uint8Array` on Node adapters. Keep binary
columns out of text/JSON schemas unless an explicit encoding transform is part
of the application contract.

`NULL` is not a zero, empty string, epoch, or empty object. Preserve it as
`null` in the result contract, and make the Standard Schema nullable when the
column is nullable.

## Custom parsers and profiles

A custom `pg` parser, mysql2 `typeCast`, Oracle fetch option, or equivalent
changes the raw-value boundary. It invalidates the default representation
profile unless the exact configuration has its own evidence. The safe sequence
is:

1. record the exact database, driver, runtime, and parser/options;
2. verify the raw value for every affected type;
3. select or define the matching TypePolicy;
4. validate/transform with Standard Schema;
5. use the same profile in code generation.

SQLBraid does not inspect arbitrary parser functions to infer fidelity. A
profile that cannot prove exact transport is `guarded` or `unsupported`, not
silently exact.

## Code generation versus runtime validation

Code generation emits TypeScript declarations from metadata and the selected
TypePolicy. It does not validate a live row. Runtime validation requires
`sql.rows(StandardSchema)` or an execution-level schema:

```ts
const row = sql.rows(AccountSchema)`SELECT id, balance FROM account`;
await db.one(row); // validates/transforms at execution time
```

Keep output and input representations separate in generated models. A manual
TypeScript override changes declarations only; it does not make a lossy driver
transport exact.

## Native SQL transparency is not grammar support

SQLBraid sends user-authored SQL through the selected driver without rewriting
its database-specific syntax. A native `RETURNING`, `OUTPUT`, cast, function,
or extension can remain visible in the query. Passing it through proves
transparency, not that SQLBraid parses or semantically supports every grammar
feature. Generated structural helpers have their own narrow quoting and shape
contracts; unsupported analysis remains unknown.

See the driver setup pages for exact profile/options and the [runtime and driver
support matrix](/SQLBraid/reference/support/).