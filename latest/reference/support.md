# Runtime and driver support

> Exact evidence, capability boundaries, and revision-specific support labels.

## Current status

This matrix is the authoritative source. Support labels are scoped to
the exact database/driver/profile/runtime/capability tuple recorded here,
including its tested versions.

## Evidence labels

- **Official** — exact executable evidence covers the named database, driver,
  profile, runtime, and capability tuple.
- **Conditional** — evidence applies only under the named condition.
- **Pending** — the candidate has no fresh successful gate for the current
  implementation revision.
- **Historical** — an older exact revision exercised the combination; it does
  not prove the current tree.
- **Compatible** — public APIs may work, but no exact certified target is
  claimed.
- **Custom** — user-provided `QueryExecutor` or `ConnectionProvider`.
- **Unsupported** — the required SQLBraid capability is intentionally absent.

## Current matrix

### Static support matrix



### better-sqlite3-node-22-18-0

- Status: **compatible**
- Database: sqlite better-sqlite3 bundled SQLite
- Driver: better-sqlite3 @13.0.3 better-sqlite3-exact-string
- Runtime: node @22.18.0
- Evidence: pending
- Transport: text-positional (?); stream: Statement.iterate; routine: unsupported by SQLite; bulk: prepared-loop
Exclusions: This compatible target covers better-sqlite3 13.0.3 only on Node 22.18.0. SQLite routine calls and active statement cancellation are unsupported.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | better-sqlite3-exact-string |
| exact-decimal | string | unsupported | better-sqlite3-exact-string |
| approximate-binary | number | lossless | better-sqlite3-exact-string |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `sql.native-transparency` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=bigint |
| `data.binary` | guaranteed; raw=Buffer |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `session.pinned` | guaranteed |

### bun-sql-mariadb

- Status: **official**
- Database: mariadb 11.8.9 community
- Driver: bun-sql @1.3.14 bun-sql-mariadb-1.3.14
- Runtime: bun @1.3.14
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: native-value-template; stream: unsupported; routine: unsupported; bulk: prepared-loop
Exclusions: Only the exact pinned Bun.SQL backend and configured representation profile are covered. Explicit transaction readOnly true/false is unsupported: Bun 1.3.14 retains a rejected READ ONLY statement shape on the same physical connection. Native A-G controls are retained in tests/scripts/bun-sql-readonly-repro.mjs; fresh connections recover, prepare:false is unsupported, and native begin does not repair reuse. Integral Number results without database type metadata reject rather than risk exact-numeric loss. Streaming, routine channels and active statement cancellation are unsupported. Empty SELECT and zero-affected commands are indistinguishable in Bun metadata and reject after execution; side effects may already have occurred. Use string input for wide integer binds where the pinned MySQL transport rejects BigInt. DECIMAL and binary outputs are indistinguishable Uint8Array carriers and reject; author explicit CAST AS CHAR or HEX SQL.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | bun-sql-mariadb-1.3.14 |
| exact-decimal | string | unsupported | bun-sql-mariadb-1.3.14 |
| approximate-binary | number | guarded | bun-sql-mariadb-1.3.14 |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `result.rows` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB cannot distinguish empty rows from zero-affected commands; ambiguity rejects after execution |
| `result.command` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB cannot distinguish empty rows from zero-affected commands; ambiguity rejects after execution |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: BigInt transport for wide integers; integral Numbers without column metadata reject; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=Uint8Array |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: Fractional Numbers are preserved; integral Numbers without column metadata reject; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | unsupported |
| `data.json-lossless-text` | guaranteed |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: Native Date convenience does not preserve fractional precision or zone identity |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `routine.call` | unsupported |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `data.binary` | unsupported |

### bun-sql-mysql

- Status: **official**
- Database: mysql 8.4.2 community
- Driver: bun-sql @1.3.14 bun-sql-mysql-1.3.14
- Runtime: bun @1.3.14
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: native-value-template; stream: unsupported; routine: unsupported; bulk: prepared-loop
Exclusions: Only the exact pinned Bun.SQL backend and configured representation profile are covered. Explicit transaction readOnly true/false is unsupported: Bun 1.3.14 retains a rejected READ ONLY statement shape on the same physical connection. Native A-G controls are retained in tests/scripts/bun-sql-readonly-repro.mjs; fresh connections recover, prepare:false is unsupported, and native begin does not repair reuse. Integral Number results without database type metadata reject rather than risk exact-numeric loss. Streaming, routine channels and active statement cancellation are unsupported. Empty SELECT and zero-affected commands are indistinguishable in Bun metadata and reject after execution; side effects may already have occurred. Use string input for wide integer binds where the pinned MySQL transport rejects BigInt. DECIMAL and binary outputs are indistinguishable Uint8Array carriers and reject; author explicit CAST AS CHAR or HEX SQL.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | bun-sql-mysql-1.3.14 |
| exact-decimal | string | unsupported | bun-sql-mysql-1.3.14 |
| approximate-binary | number | guarded | bun-sql-mysql-1.3.14 |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `result.rows` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB cannot distinguish empty rows from zero-affected commands; ambiguity rejects after execution |
| `result.command` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB cannot distinguish empty rows from zero-affected commands; ambiguity rejects after execution |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: BigInt transport for wide integers; integral Numbers without column metadata reject; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=Uint8Array |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: Fractional Numbers are preserved; integral Numbers without column metadata reject; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | guarded; bun-sql.json-parser-profile: Native parsed JSON is not a lossless numeric representation |
| `data.json-lossless-text` | unsupported |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: Native Date convenience does not preserve fractional precision or zone identity |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `routine.call` | unsupported |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `data.binary` | unsupported |

### bun-sql-postgres

- Status: **official**
- Database: postgres 16.4 alpine
- Driver: bun-sql @1.3.14 bun-sql-postgres-1.3.14
- Runtime: bun @1.3.14
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: native-value-template; stream: unsupported; routine: unsupported; bulk: prepared-loop
Exclusions: Only the exact pinned Bun.SQL backend and configured representation profile are covered. Integral Number results without database type metadata reject rather than risk exact-numeric loss. Streaming, routine channels and active statement cancellation are unsupported.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | bun-sql-postgres-1.3.14 |
| exact-decimal | string | lossless | bun-sql-postgres-1.3.14 |
| approximate-binary | number | guarded | bun-sql-postgres-1.3.14 |

| Container | Status |
| --- | --- |
| postgres-arrays | unclassified |
| postgres-domains | unclassified |
| postgres-ranges | unclassified |
| postgres-composites | unclassified |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: BigInt transport for wide integers; integral Numbers without column metadata reject; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: Fractional Numbers are preserved; integral Numbers without column metadata reject; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | guarded; bun-sql.json-parser-profile: Native parsed JSON is not a lossless numeric representation |
| `data.json-lossless-text` | unsupported |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: Native Date convenience does not preserve fractional precision or zone identity |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: Only native isolation and read-only mappings verified for this backend |
| `routine.call` | unsupported |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `data.binary` | guaranteed |

### bun-sql-sqlite

- Status: **official**
- Database: sqlite 3.53.0 bun-embedded
- Driver: bun-sql @1.3.14 bun-sql-sqlite-1.3.14
- Runtime: bun @1.3.14
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: native-value-template; stream: unsupported; routine: unsupported; bulk: prepared-loop
Exclusions: Only the exact pinned Bun.SQL backend and configured representation profile are covered. Integral Number results without database type metadata reject rather than risk exact-numeric loss. Streaming, routine channels and active statement cancellation are unsupported. Bun native SQL classification can misread mixed single/double-quote literals; inline JSON fails the row contract, while bound JSON text is verified.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | bun-sql-sqlite-1.3.14 |
| exact-decimal | string | unsupported | bun-sql-sqlite-1.3.14 |
| approximate-binary | number | guarded | bun-sql-sqlite-1.3.14 |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `result.rows` | guarded; bun-sql.sqlite-result-parser: Bun SQLite native SQL classification can misread mixed-quote literals; bind JSON values and preserve result-kind failures |
| `result.command` | guarded; bun-sql.sqlite-result-parser: Bun SQLite native SQL classification can misread mixed-quote literals; bind JSON values and preserve result-kind failures |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: BigInt transport for wide integers; integral Numbers without column metadata reject; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=string |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: Fractional Numbers are preserved; integral Numbers without column metadata reject; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | unsupported |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-native` | unsupported |
| `data.temporal-lossless` | guaranteed; raw=string |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | unsupported |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | guaranteed |
| `routine.call` | unsupported |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `data.binary` | guaranteed |

### d1-cloudflare-workerd-2026-07-30

- Status: **compatible**
- Database: sqlite Cloudflare D1 managed SQLite (version unreported)
- Driver: cloudflare-d1 @1.20260730.1 d1-guarded-safe-integer
- Runtime: workerd @1.20260730.1
- Evidence: pending (a636a0c031e9623dbc84af229bc839d83f5d6abf)
- Transport: ordered placeholders and D1 prepared binds; stream: unsupported by D1 API; routine: unsupported by D1 API; bulk: native D1 batch
Exclusions: D1 callback transactions are unsupported D1 streaming is unsupported without a bounded native primitive Remote production D1 evidence is not claimed The API denies sqlite_version(); the compatibility date is not a database version Integral REAL values outside the safe range are excluded by the untyped-number guard

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | d1-guarded-safe-integer |
| exact-decimal | string | unsupported | d1-guarded-safe-integer |
| approximate-binary | number | guarded | d1-guarded-safe-integer |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `session.pinned` | unsupported |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | unsupported |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | unsupported |
| `statement.cancel` | unsupported |
| `routine.call` | unsupported |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guarded; cloudflare-d1.safe-integer: Cloudflare D1 safe integer range; exact-integer; string; guarded; raw=number |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=number[] |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | unsupported |
| `result.standard-schema` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | unsupported |
| `transaction` | unsupported |
| `transaction.savepoint` | unsupported |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | unsupported |
| `metadata.generated` | unsupported |
| `metadata.routines` | unsupported |
| `metadata.types` | unsupported |
| `dml.insert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |

### libsql-local-node-22-18-0

- Status: **compatible**
- Database: sqlite libSQL local SQLite
- Driver: libsql @0.18.0 libsql-exact-string
- Runtime: node @22.18.0
- Evidence: pending
- Transport: text-positional (local file); stream: unsupported; materialized results; routine: unsupported by SQLite; bulk: local batch
Exclusions: This target covers @libsql/client 0.18.0 local file URLs only; remote HTTP and WebSocket transports are not certified. Physical session pinning and incremental streaming are unsupported.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | libsql-exact-string |
| exact-decimal | string | unsupported | libsql-exact-string |
| approximate-binary | number | lossless | libsql-exact-string |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `sql.native-transparency` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=string |
| `data.binary` | guaranteed; raw=Uint8Array |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `session.pinned` | unsupported; libsql.client-no-session-pinning: libSQL client connections do not provide a pinned physical session guarantee |

### mariadb-connector-node-11-8-9

- Status: **official**
- Database: mariadb 11.8.9 community
- Driver: mariadb @3.5.4 mariadb-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (?); stream: MariaDB Connector stream; routine: prepared CALL emitted result sets; no OUT/INOUT carrier; bulk: connector-native-batch
Exclusions: MariaDB evidence is separate from mysql2 compatibility Bun and Deno MariaDB subpaths are not certified by this target

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | mariadb-lossless-text |
| exact-decimal | string | guarded | mariadb-lossless-text |
| approximate-binary | number | lossless | mariadb-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | guaranteed |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; mariadb.connection-destroy: Cancellation destroys and discards the MariaDB connection |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guarded; mariadb.exact-numeric-profile: MariaDB exact numeric profile; exact-integer; string; guarded; raw=number, bigint |
| `numeric.exact-decimal` | guarded; mariadb.exact-numeric-profile: MariaDB exact numeric profile; exact-decimal; string; guarded; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mariadb.exact-numeric-profile: MariaDB exact numeric profile |
| `numeric.aggregate` | guarded; mariadb.exact-numeric-profile: MariaDB exact numeric profile |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `statement.prepare` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | guaranteed |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | guaranteed |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | guaranteed |
| `dml.update-returning` | unsupported |
| `dml.delete-returning` | guaranteed |
| `dml.upsert-returning` | guaranteed |

### mssql-tedious-developer-node-2022-cu18

- Status: **official**
- Database: mssql 2022-CU18 Developer
- Driver: tedious @20.0.0 mssql-tedious
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: typed request (@p1..@pN); stream: bounded row events; routine: Tedious callProcedure; OUTPUT, RETURN and emitted row events; bulk: prepared-loop
Exclusions: CURSOR VARYING OUTPUT is unsupported Decimal and Numeric input is restricted to values safely representable by Tedious Number conversion Bun and Deno Tedious subpaths are not certified by this target

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | mssql-tedious |
| exact-decimal | string | unsupported | mssql-tedious |
| approximate-binary | number | lossless | mssql-tedious |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unclassified |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | guaranteed |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guaranteed |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; guarded; raw=number, string |
| `numeric.exact-decimal` | unsupported; mssql.exact-decimal-text-cast-required: SQL Server exact decimal text cast path; exact-decimal; string; unsupported |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mssql.character-cast-required: SQL Server character exact-value path |
| `numeric.aggregate` | unsupported; mssql.exact-decimal-text-cast-required: SQL Server exact decimal text cast path |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-native` | guarded; mssql.temporal-text-cast-required: SQL Server temporal text cast path; raw=Date |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `metadata.command-safe` | guarded; mssql.safe-count: SQL Server safe command count |
| `result.multiple-sets` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | guaranteed |
| `routine.inout` | guaranteed |
| `routine.result-sets` | guaranteed |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | guaranteed |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | guaranteed |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |
| `dml.merge-returning` | guaranteed |

### mysql-mysql2-deno-2-9-3

- Status: **official**
- Database: mysql 8.4.2 community
- Driver: mysql2 @3.24.4 mysql2-lossless-text
- Runtime: deno @2.9.3
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (?); stream: mysql2 prepared Execute.stream; routine: prepared CALL emitted result sets; no OUT/INOUT carrier; bulk: prepared-loop
Exclusions: Only this exact Deno runtime, driver, database and representation profile tuple is covered. Capabilities omitted from this target are not certified by its packed fixture.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | mysql2-lossless-text |
| exact-decimal | string | lossless | mysql2-lossless-text |
| approximate-binary | number | lossless | mysql2-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | guaranteed |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; mysql2.physical-connection-destroy: Cancellation destroys and discards the mysql2 connection |
| `routine.call` | guaranteed |
| `numeric.exact-integer` | guarded; mysql2.exact-numeric-profile: mysql2 exact numeric profile; exact-integer; string; guarded; raw=number, string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.return-value` | unsupported |
| `routine.result-sets` | guaranteed |

### mysql-mysql2-node-8-4-2

- Status: **official**
- Database: mysql 8.4.2 community
- Driver: mysql2 @3.24.4 mysql2-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (?); stream: mysql2 prepared Execute.stream; routine: prepared CALL emitted result sets; no OUT/INOUT carrier; bulk: prepared-loop
Exclusions: MySQL has no generic DML RETURNING capability OUT and INOUT carriers are unsupported for ordinary mysql2 execution Bun and Deno mysql2 subpaths are not certified by this target

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | guarded | mysql2-lossless-text |
| exact-decimal | string | lossless | mysql2-lossless-text |
| approximate-binary | number | lossless | mysql2-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | guaranteed |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; mysql2.physical-connection-destroy: Cancellation destroys and discards the mysql2 connection |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guarded; mysql2.exact-numeric-profile: mysql2 exact numeric profile; exact-integer; string; guarded; raw=number, string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mysql2.exact-numeric-profile: mysql2 exact numeric profile |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.result-sets` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | guaranteed |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | unsupported |
| `dml.update-returning` | unsupported |
| `dml.delete-returning` | unsupported |

### oracle-oracledb-thin-node-23-9

- Status: **official**
- Database: oracle 23.9 Free
- Driver: node-oracledb @7.0.1 oracle-thin
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (:1..:N); stream: node-oracledb ResultSet; routine: PL/SQL OUT/INOUT binds; REF CURSOR and implicit ResultSet; bulk: executeMany
Exclusions: This is Oracle Free 23.9 evidence, not Oracle Database 19c evidence Oracle Thick mode is not covered Bun and Deno node-oracledb subpaths are not certified by this target

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | unsupported | oracle-thin |
| exact-decimal | string | lossless | oracle-thin |
| approximate-binary | number | lossless | oracle-thin |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unclassified |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; oracle.connection-break: Oracle break is cooperative; the lease stays held until driver settlement |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | unsupported; exact-integer; string; unsupported |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.approximate-special` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; oracle.bind-nls-sensitive: Oracle NLS-sensitive exact bind |
| `numeric.aggregate` | guaranteed |
| `data.json-parsed` | guaranteed; raw=object, array, string, number, boolean, null |
| `data.json-lossless-text` | guarded; oracle.json-serialize-required: Oracle JSON_SERIALIZE text path; raw=string |
| `data.temporal-native` | guarded; oracle.date-millisecond-precision: Oracle Date millisecond precision; raw=Date |
| `data.temporal-lossless` | guarded; oracle.temporal-text-cast-required: Oracle temporal text cast path; raw=string |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `statement.prepare` | guaranteed |
| `routine.out` | guaranteed |
| `routine.inout` | guaranteed |
| `routine.result-sets` | guaranteed |
| `routine.out-cursor` | guaranteed |
| `routine.return-value` | unsupported |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | guaranteed |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |
| `metadata.command-safe` | guarded; oracle.count-safe-integer: Oracle safe command count |

### postgres-current

- Status: **official**
- Database: postgres 18.6 alpine
- Driver: pg @8.23.0 pg-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional ($1..$N); stream: pg-cursor; routine: SQL CALL; OUT row and transaction-owned refcursor FETCH; bulk: prepared-loop
Exclusions: Only the PostgreSQL capability fixture is covered by this current target's gate

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | pg-lossless-text |
| exact-decimal | string | lossless | pg-lossless-text |
| approximate-binary | number | guarded | pg-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unclassified |
| postgres-domains | unclassified |
| postgres-ranges | unclassified |
| postgres-composites | unclassified |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guarded; pg.extra-float-digits: PostgreSQL extra_float_digits profile; approximate-binary; number; guarded; raw=number |
| `numeric.bind-exact` | guaranteed |
| `numeric.aggregate` | guaranteed |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=Buffer |
| `data.uuid` | guaranteed; raw=string |
| `dml.insert-returning` | guaranteed |
| `dml.upsert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |

### postgres-pg-deno-2-9-3

- Status: **official**
- Database: postgres 16.4 alpine
- Driver: pg @8.23.0 pg-lossless-text
- Runtime: deno @2.9.3
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional ($1..$N); stream: pg-cursor; routine: SQL CALL; OUT row and transaction-owned refcursor FETCH; bulk: prepared-loop
Exclusions: Only this exact Deno runtime, driver, database and representation profile tuple is covered. Capabilities omitted from this target are not certified by its packed fixture.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | pg-lossless-text |
| exact-decimal | string | lossless | pg-lossless-text |
| approximate-binary | number | guarded | pg-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unclassified |
| postgres-domains | unclassified |
| postgres-ranges | unclassified |
| postgres-composites | unclassified |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | guarded; pg.read-uncommitted-maps-to-read-committed: PostgreSQL READ UNCOMMITTED uses READ COMMITTED semantics |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; pg.physical-connection-destroy: Cancellation destroys and discards the pg connection |
| `routine.call` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | guaranteed |
| `routine.inout` | unsupported |
| `routine.return-value` | unsupported |

### postgres-pg-node-16-4

- Status: **official**
- Database: postgres 16.4 alpine
- Driver: pg @8.23.0 pg-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional ($1..$N); stream: pg-cursor; routine: SQL CALL; OUT row and transaction-owned refcursor FETCH; bulk: prepared-loop
Exclusions: PostgreSQL 18-only syntax is not covered by this 16.4 target Bun and Deno pg subpaths are not certified by this target

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | pg-lossless-text |
| exact-decimal | string | lossless | pg-lossless-text |
| approximate-binary | number | guarded | pg-lossless-text |

| Container | Status |
| --- | --- |
| postgres-arrays | unclassified |
| postgres-domains | unclassified |
| postgres-ranges | unclassified |
| postgres-composites | unclassified |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unclassified |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | guaranteed |
| `transaction.isolation.read-uncommitted` | guarded; pg.read-uncommitted-maps-to-read-committed: PostgreSQL READ UNCOMMITTED uses READ COMMITTED semantics |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; pg.physical-connection-destroy: Cancellation destroys and discards the pg connection |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guarded; pg.extra-float-digits: PostgreSQL extra_float_digits profile; approximate-binary; number; guarded; raw=number |
| `numeric.bind-exact` | guaranteed |
| `numeric.aggregate` | guaranteed |
| `numeric.scale-greater-than-precision` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.negative-scale` | guaranteed; exact-decimal; string; lossless; raw=string |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | guaranteed |
| `routine.result-sets` | guaranteed |
| `routine.out-cursor` | guaranteed |
| `routine.inout` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | guaranteed |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | guaranteed |
| `dml.upsert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |

### sqlite-node-sqlite-deno-2-9-3

- Status: **official**
- Database: sqlite 3.53.2 Deno bundled SQLite
- Driver: node-sqlite @2.9.3 sqlite-exact-string
- Runtime: deno @2.9.3
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (?NNN); stream: StatementSync iterate; routine: unsupported by SQLite; bulk: prepared-loop
Exclusions: Only this exact Deno runtime, driver, database and representation profile tuple is covered. Capabilities omitted from this target are not certified by its packed fixture.

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | sqlite-exact-string |
| exact-decimal | string | unsupported | sqlite-exact-string |
| approximate-binary | number | lossless | sqlite-exact-string |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | unsupported |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | unsupported |
| `routine.call` | unsupported |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | unsupported |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.return-value` | unsupported |

### sqlite-wasm-browser-3-53-4

- Status: **official**
- Database: sqlite 3.53.4 official SQLite WASM OO1
- Driver: sqlite-wasm @3.53.4-build1 sqlite-wasm-exact-string
- Runtime: browser @153.0.8010.12
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: OO1 prepare/bind/step; stream: OO1 step; routine: unsupported by SQLite; bulk: prepared-loop with stepReset
Exclusions: This browser target does not certify Node database drivers

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | sqlite-wasm-exact-string |
| exact-decimal | string | unsupported | sqlite-wasm-exact-string |
| approximate-binary | number | lossless | sqlite-wasm-exact-string |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | unsupported |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | unsupported |
| `routine.call` | unsupported |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=bigint |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported |
| `data.json-lossless-text` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | unsupported |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | unsupported |
| `metadata.generated` | unsupported |
| `metadata.routines` | unsupported |
| `metadata.types` | unsupported |
| `data.binary` | guaranteed; raw=Uint8Array |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.uuid` | guaranteed; raw=string |
| `dml.insert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |

### sqlite-node-sqlite-node-22-18-0

- Status: **official**
- Database: sqlite 3.50.2 Node bundled SQLite
- Driver: node-sqlite @22.18.0 sqlite-exact-string
- Runtime: node @22.18.0
- Evidence: verified (8a360e3147458d26704971b344c765dda7c98fec)
- Transport: text-positional (?NNN); stream: StatementSync iterate; routine: unsupported by SQLite; bulk: prepared-loop
Exclusions: SQLite call and routine APIs are unsupported Bun uses its earlier bun:sqlite API; this Node node:sqlite target does not apply to Bun

| Numeric contract | Representation | Fidelity | Profile |
| --- | --- | --- | --- |
| exact-integer | string | lossless | sqlite-exact-string |
| exact-decimal | string | unsupported | sqlite-exact-string |
| approximate-binary | number | lossless | sqlite-exact-string |

| Container | Status |
| --- | --- |
| postgres-arrays | unsupported |
| postgres-domains | unsupported |
| postgres-ranges | unsupported |
| postgres-composites | unsupported |
| oracle-objects | unsupported |
| sql-server-variant | unsupported |
| json-nested | unclassified |
| vector | unsupported |

| Capability | Claim |
| --- | --- |
| `session.pinned` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | unsupported |
| `transaction.isolation.read-committed` | unsupported |
| `transaction.isolation.repeatable-read` | unsupported |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | unsupported |
| `routine.call` | unsupported |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guaranteed |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-lossless` | guaranteed; raw=string |
| `data.binary` | guaranteed; raw=Uint8Array |
| `data.uuid` | unsupported |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `result.multiple-sets` | unsupported |
| `result.standard-schema` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.stream` | guaranteed |
| `statement.bulk` | guaranteed |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `routine.out` | unsupported |
| `routine.inout` | unsupported |
| `routine.result-sets` | unsupported |
| `routine.out-cursor` | unsupported |
| `routine.return-value` | unsupported |
| `metadata.identity` | guaranteed |
| `metadata.generated` | guaranteed |
| `metadata.routines` | unsupported |
| `metadata.types` | guaranteed |
| `dml.insert-returning` | guaranteed |
| `dml.upsert-returning` | guaranteed |
| `dml.update-returning` | guaranteed |
| `dml.delete-returning` | guaranteed |

The matrix is generated from machine-readable support targets and capability
conditions. It is the evidence rendering, not a promise that every adapter has
every operation.

## Capability vocabulary

Dialect, driver, runtime, host, database version, representation profile, and
capability are separate axes. The canonical capability identifiers are:

```text
sql.native-transparency           sql.generated-structure
result.rows                       result.command
result.multiple-sets              result.standard-schema
numeric.exact-integer             numeric.exact-decimal
numeric.approximate-float         numeric.approximate-special
numeric.bind-exact                numeric.aggregate
numeric.command-metadata          numeric.special-values
numeric.scale-greater-than-precision
numeric.negative-scale
data.json-parsed                  data.json-lossless-text
data.sql-variant                  data.oracle-object
data.oracle-collection            data.vector
data.binary                       data.uuid
data.temporal-native              data.temporal-lossless
data.timezone
metadata.command-safe
dml.insert-returning              dml.update-returning
dml.delete-returning              dml.merge-returning
dml.upsert-returning
session.pinned
statement.prepare                statement.cancel
statement.stream                 statement.bulk
execution.bulk-fidelity
transaction                      transaction.savepoint
transaction.read-only
transaction.isolation.read-uncommitted
transaction.isolation.read-committed
transaction.isolation.repeatable-read
transaction.isolation.serializable
routine.call                     routine.out
routine.inout                    routine.result-sets
routine.out-cursor               routine.return-value
metadata.identity                metadata.generated
metadata.routines                metadata.types
```

Do not add obsolete aliases such as `execution.prepared`, `execution.stream`,
`routine.resultsets`, or `routine.return-status`.

`statementBinding.describe()` and `describeBulk()` validate the logical
`RenderedStatement`/`RenderedBulk` before lease acquisition. Providers and
leases expose the same immutable binding adapter identity. Prepared shape means
logical result kind, canonical segments, dialect, and ordered hint/direction/
output metadata; physical placeholder spelling never changes shape.

`db.session(callback)` pins one physical provider lease and nested sessions reuse
it. `db.tx(callback)` uses that lease, or acquires one root lease; nested
transactions use savepoints when supported. Explicit transaction options use
only the fixed isolation literals `read-uncommitted`, `read-committed`,
`repeatable-read`, and `serializable`, plus `readOnly`. Malformed runtime options
fail before acquisition with `TypeError` / `BRAID_TX_OPTIONS_INVALID`; a valid
but unsupported option uses `UnsupportedFeatureError` /
`BRAID_TX_OPTION_UNSUPPORTED`; nested explicit options use
`BRAID_TX_OPTIONS_NESTED`.

An already-aborted `AbortSignal` preserves its `reason`. An active signal needs
a real adapter cancellation path; otherwise the operation rejects before I/O
with `UnsupportedFeatureError`, feature `statement.cancel`, and
`BRAID_CANCEL_UNSUPPORTED`. An unavailable session or transaction primitive
uses `BRAID_SESSION_UNSUPPORTED` or `BRAID_TX_UNSUPPORTED` respectively.
Oracle's guarded `oracle.connection-break` condition is cooperative rather than
a prompt or timeout guarantee: its documented `DBMS_SESSION.SLEEP` raw probe
can reject with `ORA-01013` only when the sleep completes, and the adapter holds
the physical lease through settlement.

## Driver/runtime boundaries

First-party roots cover PostgreSQL, MySQL, MariaDB, SQLite, Oracle, and SQL
Server. Driver subpaths own the protocol and cleanup behavior: `pg`, `mysql2`,
MariaDB Connector/Node.js, `node:sqlite`, SQLite WASM, D1, node-oracledb Thin,
and Tedious. Bun uses one SQL adapter family with a user-selected
`dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`; it does not infer
SQL semantics from the connection. Bun 1.3.14 has active cancellation
unsupported (`BRAID_CANCEL_UNSUPPORTED`) and stream/routine carriers
unsupported. Its `result.rows`/`result.command` metadata is guarded by
`bun-sql.result-kind-metadata`; for MySQL/MariaDB, empty `SELECT` and
zero-affected DML/DDL fail with `BRAID_RESULT_KIND_AMBIGUOUS` only after
execution, because `command` is null and `affectedRows` is zero. Deno reuses
existing first-party adapters where their public driver API is compatible.

Missing stream, routine, output, hint, bulk, transaction, or cancellation support
must be explicit `UnsupportedFeatureError` failures. SQLBraid does not paginate
to fake streaming, guess routine carriers, ignore hints, create hidden
transactions, or promote an unverified tuple. D1's managed SQLite version is
unreported; a local Worker binding check is not a version certification.

Numeric, JSON, temporal, and container behavior are defined per driver profile. Exact database integers and decimals are canonical strings; approximate IEEE values are numbers. Profile and codegen descriptors must match.
Database metadata provides positive evidence; a missing metadata entry does not necessarily mean the SQL is invalid.
Bun 1.3.14 uses `{ bigint: true }` for PostgreSQL/MySQL/MariaDB and
`{ safeIntegers: true }` for SQLite. Because it exposes no column metadata,
integral and integral-approximate `Number` rows are rejected as ambiguous;
PostgreSQL decimals are strings. MySQL/MariaDB DECIMAL and binary outputs share
an untyped byte carrier and reject; author `CAST(... AS CHAR)` or `HEX(...)`.
SQLite native decimal is unsupported. MariaDB/SQLite JSON is text, while
PostgreSQL/MySQL native JSON can round nested numbers. Bun SQLite's result kinds
are guarded by `bun-sql.sqlite-result-parser`: mixed-quote SQL literals can be
misclassified by Bun; bind JSON values instead. SQLBraid does not rewrite SQL.

## Adding evidence

A support addition requires an exact version/profile tuple, real-engine
coverage, and machine-readable target conditions. Historical links and prose
alone cannot prove the current tree.
