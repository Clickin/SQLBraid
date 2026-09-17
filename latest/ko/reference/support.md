# 런타임 및 드라이버 지원

> 정확한 증거, capability 경계와 revision별 지원 label을 설명합니다.

## 현재 상태

현재 지원 매트릭스는 지원 manifest에서 읽은 revision별 증거와 label을
표시합니다. 각 label과 증거는 매트릭스가 기록한 정확한 database, driver,
profile, runtime, capability tuple과 해당 revision의 실행 workflow에만
적용됩니다. 인접한 서버 버전·runtime·profile·로컬 binding 또는 package
설치로 인증을 추론하지 마세요. 정확한 tuple의 revision별 workflow evidence를
확인해야 합니다. 최종 exact-SHA Runtime, Documentation, Release gate와
명시적인 release 승인은 별도 요구사항입니다.

## 증거 label

- **Official** — 지정한 database, driver, profile, runtime, capability tuple을 정확한 실행 증거가 다룹니다.
- **Conditional** — 이름을 지정한 조건에서만 증거가 적용됩니다.
- **Pending** — 현재 구현 revision에 대한 새로운 성공 gate가 없습니다.
- **Historical** — 과거 exact revision이 조합을 실행했지만 현재 tree를 증명하지 않습니다.
- **Compatible** — public API가 동작할 수 있지만 정확한 인증 target을 주장하지 않습니다.
- **Custom** — 사용자가 제공한 `QueryExecutor` 또는 `ConnectionProvider`입니다.
- **Unsupported** — 필요한 SQLBraid capability가 의도적으로 없습니다.

## 현재 매트릭스

### 정적 지원 매트릭스



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
- Evidence: verified (5cfe3058959e8c6b458f81aa02a969b1f020cca9)
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
| `result.rows` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB의 빈 행과 영향받은 행이 0인 명령은 실행 후 구분 불가로 거부 |
| `result.command` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB의 빈 행과 영향받은 행이 0인 명령은 실행 후 구분 불가로 거부 |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: 큰 정수는 BigInt 전송 사용; 열 메타데이터 없는 정수 Number 거부; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=Uint8Array |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: 소수 Number 유지; 열 메타데이터 없는 정수 Number 거부; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | unsupported |
| `data.json-lossless-text` | guaranteed |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: 네이티브 Date 편의 변환은 소수초 정밀도나 시간대 식별을 보존하지 않음 |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
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
- Evidence: verified (5cfe3058959e8c6b458f81aa02a969b1f020cca9)
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
| `result.rows` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB의 빈 행과 영향받은 행이 0인 명령은 실행 후 구분 불가로 거부 |
| `result.command` | guarded; bun-sql.result-kind-metadata: Bun MySQL/MariaDB의 빈 행과 영향받은 행이 0인 명령은 실행 후 구분 불가로 거부 |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: 큰 정수는 BigInt 전송 사용; 열 메타데이터 없는 정수 Number 거부; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=Uint8Array |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: 소수 Number 유지; 열 메타데이터 없는 정수 Number 거부; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | guarded; bun-sql.json-parser-profile: 네이티브 JSON 파싱은 숫자 무손실 표현이 아님 |
| `data.json-lossless-text` | unsupported |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: 네이티브 Date 편의 변환은 소수초 정밀도나 시간대 식별을 보존하지 않음 |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | unsupported |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
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
- Evidence: verified (5cfe3058959e8c6b458f81aa02a969b1f020cca9)
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
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: 큰 정수는 BigInt 전송 사용; 열 메타데이터 없는 정수 Number 거부; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: 소수 Number 유지; 열 메타데이터 없는 정수 Number 거부; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
| `data.json-parsed` | guarded; bun-sql.json-parser-profile: 네이티브 JSON 파싱은 숫자 무손실 표현이 아님 |
| `data.json-lossless-text` | unsupported |
| `data.temporal-native` | guarded; bun-sql.temporal-profile: 네이티브 Date 편의 변환은 소수초 정밀도나 시간대 식별을 보존하지 않음 |
| `data.temporal-lossless` | unsupported |
| `session.pinned` | guaranteed |
| `statement.prepare` | guaranteed |
| `statement.bulk` | guaranteed |
| `statement.stream` | unsupported |
| `statement.cancel` | unsupported |
| `transaction` | guaranteed |
| `transaction.savepoint` | guaranteed |
| `transaction.read-only` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.read-uncommitted` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.read-committed` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.repeatable-read` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
| `transaction.isolation.serializable` | guarded; bun-sql.transaction-options: 이 백엔드에서 검증된 네이티브 격리 수준과 읽기 전용 매핑만 지원 |
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
- Evidence: verified (5cfe3058959e8c6b458f81aa02a969b1f020cca9)
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
| `result.rows` | guarded; bun-sql.sqlite-result-parser: Bun SQLite의 native SQL 분류는 혼합 따옴표 literal을 오인할 수 있음; JSON 값을 bind하고 결과 종류 실패를 보존 |
| `result.command` | guarded; bun-sql.sqlite-result-parser: Bun SQLite의 native SQL 분류는 혼합 따옴표 literal을 오인할 수 있음; JSON 값을 bind하고 결과 종류 실패를 보존 |
| `result.standard-schema` | guaranteed |
| `numeric.exact-integer` | guarded; bun-sql.integer-width-profile: 큰 정수는 BigInt 전송 사용; 열 메타데이터 없는 정수 Number 거부; exact-integer; string; guarded; raw=number, bigint, string |
| `numeric.exact-decimal` | unsupported; exact-decimal; string; unsupported; raw=string |
| `numeric.approximate-float` | guarded; bun-sql.float-profile: 소수 Number 유지; 열 메타데이터 없는 정수 Number 거부; approximate-binary; number; guarded; binaryPrecision=64; raw=number |
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
| `numeric.exact-integer` | guarded; cloudflare-d1.safe-integer: Cloudflare D1 안전한 정수 범위; exact-integer; string; guarded; raw=number |
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
| `session.pinned` | unsupported; libsql.client-no-session-pinning: libSQL 클라이언트 연결은 고정된 물리 세션을 보장하지 않음 |

### mariadb-connector-node-11-8-9

- Status: **official**
- Database: mariadb 11.8.9 community
- Driver: mariadb @3.5.4 mariadb-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `statement.cancel` | guarded; mariadb.connection-destroy: 취소 시 MariaDB 물리 연결 종료 및 폐기 |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guarded; mariadb.exact-numeric-profile: MariaDB 정확한 숫자 프로필; exact-integer; string; guarded; raw=number, bigint |
| `numeric.exact-decimal` | guarded; mariadb.exact-numeric-profile: MariaDB 정확한 숫자 프로필; exact-decimal; string; guarded; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mariadb.exact-numeric-profile: MariaDB 정확한 숫자 프로필 |
| `numeric.aggregate` | guarded; mariadb.exact-numeric-profile: MariaDB 정확한 숫자 프로필 |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `numeric.exact-decimal` | unsupported; mssql.exact-decimal-text-cast-required: SQL Server 정확한 십진수 텍스트 캐스트 경로; exact-decimal; string; unsupported |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mssql.character-cast-required: SQL Server 문자 정확값 경로 |
| `numeric.aggregate` | unsupported; mssql.exact-decimal-text-cast-required: SQL Server 정확한 십진수 텍스트 캐스트 경로 |
| `data.json-lossless-text` | guaranteed; raw=string |
| `data.temporal-native` | guarded; mssql.temporal-text-cast-required: SQL Server 시간 텍스트 캐스트 경로; raw=Date |
| `data.binary` | guaranteed; raw=Buffer, Uint8Array |
| `data.uuid` | guaranteed; raw=string |
| `result.rows` | guaranteed |
| `result.command` | guaranteed |
| `metadata.command-safe` | guarded; mssql.safe-count: SQL Server 안전한 명령 개수 |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `statement.cancel` | guarded; mysql2.physical-connection-destroy: 취소 시 mysql2 물리 연결 종료 및 폐기 |
| `routine.call` | guaranteed |
| `numeric.exact-integer` | guarded; mysql2.exact-numeric-profile: mysql2 정확한 숫자 프로필; exact-integer; string; guarded; raw=number, string |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `statement.cancel` | guarded; mysql2.physical-connection-destroy: 취소 시 mysql2 물리 연결 종료 및 폐기 |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guarded; mysql2.exact-numeric-profile: mysql2 정확한 숫자 프로필; exact-integer; string; guarded; raw=number, string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; mysql2.exact-numeric-profile: mysql2 정확한 숫자 프로필 |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `statement.cancel` | guarded; oracle.connection-break: Oracle break는 협력적 취소이며 드라이버 완료까지 연결을 유지 |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | unsupported; exact-integer; string; unsupported |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.approximate-special` | guaranteed; approximate-binary; number; lossless; raw=number |
| `numeric.bind-exact` | guarded; oracle.bind-nls-sensitive: Oracle NLS 의존 정확한 바인드 |
| `numeric.aggregate` | guaranteed |
| `data.json-parsed` | guaranteed; raw=object, array, string, number, boolean, null |
| `data.json-lossless-text` | guarded; oracle.json-serialize-required: Oracle JSON_SERIALIZE 텍스트 경로; raw=string |
| `data.temporal-native` | guarded; oracle.date-millisecond-precision: Oracle Date 밀리초 정밀도; raw=Date |
| `data.temporal-lossless` | guarded; oracle.temporal-text-cast-required: Oracle 시간 텍스트 캐스트 경로; raw=string |
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
| `metadata.command-safe` | guarded; oracle.count-safe-integer: Oracle 안전한 명령 개수 |

### postgres-current

- Status: **official**
- Database: postgres 18.6 alpine
- Driver: pg @8.23.0 pg-lossless-text
- Runtime: node @22.18.0
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `numeric.approximate-float` | guarded; pg.extra-float-digits: PostgreSQL extra_float_digits 프로필; approximate-binary; number; guarded; raw=number |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `transaction.isolation.read-uncommitted` | guarded; pg.read-uncommitted-maps-to-read-committed: PostgreSQL READ UNCOMMITTED는 READ COMMITTED 의미론 사용 |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; pg.physical-connection-destroy: 취소 시 pg 물리 연결 종료 및 폐기 |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
| `transaction.isolation.read-uncommitted` | guarded; pg.read-uncommitted-maps-to-read-committed: PostgreSQL READ UNCOMMITTED는 READ COMMITTED 의미론 사용 |
| `transaction.isolation.read-committed` | guaranteed |
| `transaction.isolation.repeatable-read` | guaranteed |
| `transaction.isolation.serializable` | guaranteed |
| `statement.cancel` | guarded; pg.physical-connection-destroy: 취소 시 pg 물리 연결 종료 및 폐기 |
| `routine.call` | guaranteed |
| `sql.native-transparency` | guaranteed |
| `sql.generated-structure` | guaranteed |
| `numeric.exact-integer` | guaranteed; exact-integer; string; lossless; raw=string |
| `numeric.exact-decimal` | guaranteed; exact-decimal; string; lossless; raw=string |
| `numeric.approximate-float` | guarded; pg.extra-float-digits: PostgreSQL extra_float_digits 프로필; approximate-binary; number; guarded; raw=number |
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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
- Evidence: verified (a636a0c031e9623dbc84af229bc839d83f5d6abf)
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

매트릭스는 기계 판독 support target과 capability 조건에서 생성됩니다. 모든
adapter가 모든 작업을 제공한다는 약속이 아니라 증거 표시입니다.

## Capability 어휘

Dialect, driver, runtime, host, database version, representation profile,
capability는 별도 축입니다. 정식 capability 식별자는 다음과 같습니다.

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

`execution.prepared`, `execution.stream`, `routine.resultsets`,
`routine.return-status` 같은 폐기된 alias를 추가하지 마세요.

`statementBinding.describe()`와 `describeBulk()`는 lease 획득 전에 논리
`RenderedStatement`/`RenderedBulk`를 검증합니다. Provider와 lease는 동일한
불변 binding adapter identity를 노출해야 합니다. Prepared shape는 논리
result kind, canonical segments, dialect, 순서 있는 hint/direction/output
metadata이며 물리 placeholder 표기는 shape를 바꾸지 않습니다.

`db.session(callback)`은 하나의 물리 provider lease를 고정하고 중첩 session은
재사용합니다. `db.tx(callback)`은 그 lease를 사용하거나 root lease를 얻으며,
중첩 transaction은 advertised savepoint를 사용합니다. 명시적 transaction
option은 고정된 `read-uncommitted`, `read-committed`, `repeatable-read`,
`serializable` isolation과 `readOnly`만 사용합니다. 잘못된 runtime option은
획득 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패하고, 유효하지만
지원하지 않는 option은 `UnsupportedFeatureError` /
`BRAID_TX_OPTION_UNSUPPORTED`를 사용하며, 중첩 명시 option은
`BRAID_TX_OPTIONS_NESTED`를 사용합니다.

이미 abort된 `AbortSignal`은 자신의 `reason`을 보존합니다. 활성 signal에는
실제 adapter cancellation 경로가 필요하며, 없으면 I/O 전에
`UnsupportedFeatureError`, feature `statement.cancel`,
`BRAID_CANCEL_UNSUPPORTED`로 실패합니다. 사용할 수 없는 session 또는
transaction primitive는 각각 `BRAID_SESSION_UNSUPPORTED` 또는
`BRAID_TX_UNSUPPORTED`를 사용합니다.
Oracle의 guarded `oracle.connection-break` 조건은 즉시 중단이나 timeout을
보장하지 않는 cooperative 동작입니다. 문서화된 `DBMS_SESSION.SLEEP` raw
probe는 sleep이 끝날 때만 `ORA-01013`으로 거부될 수 있으며, 어댑터는
settlement까지 물리 lease를 유지합니다.

## Driver/runtime 경계

First-party root는 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server입니다.
Driver subpath가 protocol과 cleanup을 소유합니다: `pg`, `mysql2`, MariaDB
Connector/Node.js, `node:sqlite`, SQLite WASM, D1, node-oracledb Thin,
Tedious. Bun은 명시적으로 사용자가 선택하는
`dialect: "postgres" | "mysql" | "mariadb" | "sqlite"` 하나의 SQL adapter
family를 사용하며 connection에서 SQL 의미를 추론하지 않습니다. Bun 1.3.14는
active cancellation을 지원하지 않아 `BRAID_CANCEL_UNSUPPORTED`를 사용하며
stream/routine carrier도 지원하지 않습니다. `result.rows`/`result.command`
metadata는 `bun-sql.result-kind-metadata` 조건에서만 guarded됩니다.
MySQL/MariaDB에서는 `command`가 null이고 `affectedRows`가 0이므로 빈
`SELECT`와 영향 행이 0인 DML/DDL은 실행 후에만
`BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있습니다. Deno는 public driver
API가 동작하는 기존 first-party adapter를 재사용하며 Deno 전용 dialect를
만들지 않습니다.

stream, routine, output, hint, bulk, transaction, cancellation 지원이 없으면
명시적인 `UnsupportedFeatureError`로 실패해야 합니다. SQLBraid는 streaming을
흉내 내려고 paginate하거나 routine carrier를 추측하거나 hint를 무시하거나
숨은 transaction을 만들거나 검증되지 않은 tuple을 승격하지 않습니다. D1의
managed SQLite version은 공개되지 않았으므로 local Worker binding 검사는
version 인증이 아닙니다.

정확한 숫자, JSON/temporal, container 동작은 별도 증거 경계입니다. 정확한
DB integer와 decimal은 canonical string이고 근사 IEEE 값은 number입니다.
Profile과 codegen descriptor는 일치해야 합니다. Metadata는 positive open-world
증거이므로 누락된 사실이 SQL invalid를 뜻하지 않습니다. Bun 1.3.14는
PostgreSQL/MySQL/MariaDB에 `{ bigint: true }`, SQLite에
`{ safeIntegers: true }`를 사용합니다. Column metadata가 없으므로
integral 및 integral-approximate `Number` row는 ambiguous로 거부되고,
PostgreSQL decimal은 string입니다. MySQL/MariaDB DECIMAL과 binary 출력은
타입 정보 없는 같은 byte carrier라 거부하며 `CAST(... AS CHAR)` 또는
`HEX(...)`를 직접 작성해야 합니다. SQLite native decimal은 지원하지 않습니다.
MariaDB/SQLite JSON은 text이며 PostgreSQL/MySQL native JSON은 중첩 숫자가
반올림될 수 있습니다. Bun SQLite의 결과 종류는 `bun-sql.sqlite-result-parser`
조건에서 guarded입니다. Bun이 서로 다른 따옴표가 섞인 SQL literal을 잘못
분류할 수 있으므로 JSON은 bind하세요. SQLBraid가 SQL을 재작성하지 않습니다.

## 증거 추가

지원 추가에는 정확한 version/profile tuple, 실제 engine 실행 범위, 기계 판독
target 조건, 새 clean revision이 필요합니다. Release 결정에는 translation
freshness, package/export 검사와 immutable release dry-run도 필요합니다.
과거 실행 링크나 설명글만으로는 라벨을 승격할 수 없습니다. 이 페이지는 npm/tag/Pages
발행을 의미하지 않습니다.
