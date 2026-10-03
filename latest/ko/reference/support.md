# 런타임·드라이버 지원

> 리비전별 정확한 근거, 기능 경계, 지원 등급을 정리합니다.

## 현재 상태

이 매트릭스가 기준 자료입니다. 각 지원 등급은 여기에 기록된 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합과 테스트한 버전에만 적용됩니다.

## 근거 등급

- **Official**: 정확한 실행 근거가 이름 붙은 데이터베이스·드라이버·프로필·런타임·기능 조합을 다룹니다.
- **Conditional**: 명시한 조건에서만 근거가 적용됩니다.
- **Pending**: 후보 조합에 현재 구현 리비전에 대한 새로 통과한 게이트가 없습니다.
- **Historical**: 예전의 정확한 리비전에서 조합을 테스트했습니다. 현재 소스 트리를 증명하지는 않습니다.
- **Compatible**: 공개 API로 동작할 수 있지만, 인증된 정확한 대상이라고 주장하지 않습니다.
- **Custom**: 사용자가 직접 제공한 `QueryExecutor`나 `ConnectionProvider`입니다.
- **Unsupported**: 필요한 SQLBraid 기능이 일부러 없습니다.

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

매트릭스는 기계가 읽을 수 있는 지원 대상과 기능 조건에서 생성됩니다. 근거를 보여 줄 뿐, 모든 어댑터가 모든 작업을 지원한다고 약속하지 않습니다.

## 기능 용어

방언, 드라이버, 런타임, 호스트, 데이터베이스 버전, 표현 방식 프로필, 기능은 서로 독립된 축입니다. 정규 기능 식별자는 다음과 같습니다.

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

`execution.prepared`, `execution.stream`, `routine.resultsets`, `routine.return-status` 같은 예전 별칭을 추가하지 마세요.

`statementBinding.describe()`와 `describeBulk()`는 리스를 획득하기 전에 논리적인 `RenderedStatement`나 `RenderedBulk`를 검증합니다. 프로바이더와 리스는 같은 불변 바인딩 어댑터 객체를 노출합니다. 준비된 쿼리의 형태는 논리적 결과 종류, 정규화된 세그먼트, 방언, 그리고 순서가 있는 힌트·방향·출력 메타데이터입니다. 물리 플레이스홀더 표기는 형태를 바꾸지 않습니다.

`db.session(callback)`은 물리 프로바이더 리스 하나를 고정합니다. 중첩 세션은 같은 리스를 씁니다. `db.tx(callback)`은 그 리스를 쓰거나, 루트 리스 하나를 획득합니다. 지원하는 경우 중첩 트랜잭션은 세이브포인트를 씁니다.

명시적인 트랜잭션 옵션에는 정해진 격리 수준 리터럴 `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable`과 `readOnly`만 쓸 수 있습니다.

- 형식이 잘못된 런타임 옵션은 획득 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패합니다.
- 올바르지만 지원하지 않는 옵션은 `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`를 씁니다.
- 중첩 트랜잭션에 옵션을 명시하면 `BRAID_TX_OPTIONS_NESTED`를 씁니다.

이미 중단된 `AbortSignal`은 원래 `reason`을 유지합니다. 활성 시그널을 쓰려면 어댑터에 실제 취소 경로가 있어야 합니다. 없으면 작업은 I/O 전에 `UnsupportedFeatureError`(기능 `statement.cancel`, 코드 `BRAID_CANCEL_UNSUPPORTED`)로 거부됩니다. 세션 기능이 없으면 `BRAID_SESSION_UNSUPPORTED`, 트랜잭션 기능이 없으면 `BRAID_TX_UNSUPPORTED`를 씁니다.

Oracle의 guarded 조건 `oracle.connection-break`는 협력적인 방식입니다. 즉시 멈추거나 시간 제한을 지킨다고 보장하지 않습니다. 문서화된 `DBMS_SESSION.SLEEP` 원시 점검은 sleep이 끝날 때만 `ORA-01013`으로 reject될 수 있습니다. 어댑터는 결과가 확정될 때까지 물리 리스를 붙잡고 있습니다.

## 드라이버·런타임 경계

공식 루트는 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server를 다룹니다. 프로토콜과 정리 동작은 드라이버 하위 경로가 맡습니다. `pg`, `mysql2`, MariaDB Connector/Node.js, `node:sqlite`, SQLite WASM, D1, node-oracledb Thin, Tedious가 있습니다.

Bun은 SQL 어댑터 계열 하나를 쓰며, 사용자가 `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`를 고릅니다. 커넥션에서 SQL 의미를 추론하지 않습니다.

- Bun 1.3.14에서는 활성 취소를 지원하지 않습니다(`BRAID_CANCEL_UNSUPPORTED`). 스트림과 루틴 출력 전달도 지원하지 않습니다.
- `result.rows`와 `result.command` 메타데이터는 `bun-sql.result-kind-metadata` 조건으로 guarded입니다. MySQL과 MariaDB에서는 결과가 빈 `SELECT`와, 0행에 영향을 준 DML·DDL이 실행 후에야 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패합니다. `command`가 null이고 `affectedRows`가 0이기 때문입니다.

Deno는 공개 드라이버 API가 호환되는 곳에서 기존 공식 어댑터를 씁니다.

스트림, 루틴, 출력, 힌트, 벌크, 트랜잭션, 취소 기능이 없으면 명시적인 `UnsupportedFeatureError`로 실패해야 합니다. SQLBraid는 다음을 하지 않습니다.

- 스트리밍을 흉내 내려고 페이지 단위로 나눠 읽기
- 루틴 출력 전달 방식 추측하기
- 힌트 무시하기
- 숨은 트랜잭션 만들기
- 검증되지 않은 조합의 등급 올리기

D1의 관리형 SQLite 버전은 보고되지 않습니다. 로컬 Worker 바인딩 점검은 버전 인증이 아닙니다.

각 드라이버 프로필이 숫자, JSON, 날짜·시간, 컨테이너 동작을 정합니다. 정확한 데이터베이스 정수와 소수는 정규 문자열이고, 근사 IEEE 값은 숫자입니다. 프로필과 코드 생성 설명 객체는 서로 맞아야 합니다.

데이터베이스 메타데이터는 긍정적 근거를 줍니다. 메타데이터에 항목이 없다고 해서 항상 SQL이 잘못되었다는 뜻은 아닙니다.

Bun 1.3.14는 PostgreSQL, MySQL, MariaDB에 `{ bigint: true }`를, SQLite에 `{ safeIntegers: true }`를 씁니다.

- Bun은 열 메타데이터를 제공하지 않습니다. 그래서 정수 값의 `Number` 행과 정수 값의 근사 `Number` 행은 모호하다는 이유로 거부합니다.
- PostgreSQL decimal은 문자열입니다.
- MySQL·MariaDB의 DECIMAL과 바이너리 출력은 타입 정보 없는 같은 바이트 형태로 전달되므로 거부합니다. SQL에 `CAST(... AS CHAR)`나 `HEX(...)`를 쓰세요.
- SQLite 네이티브 decimal은 지원하지 않습니다.
- MariaDB와 SQLite의 JSON은 텍스트입니다. PostgreSQL과 MySQL의 네이티브 JSON은 중첩된 숫자를 반올림할 수 있습니다.
- Bun SQLite의 결과 종류는 `bun-sql.sqlite-result-parser` 조건으로 guarded입니다. Bun은 서로 다른 따옴표가 섞인 SQL 리터럴을 잘못 분류할 수 있습니다. JSON 값은 바인딩으로 넘기세요. SQLBraid는 SQL을 고쳐 쓰지 않습니다.

## 근거 추가하기

지원을 추가하려면 정확한 버전·프로필 조합, 실제 엔진에서의 검증, 기계가 읽을 수 있는 대상 조건이 필요합니다. 과거 링크나 설명만으로는 현재 소스 트리를 증명할 수 없습니다.
