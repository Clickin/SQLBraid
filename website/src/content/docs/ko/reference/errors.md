---
title: 진단 및 오류 코드
description: 안정적인 SQLBraid 코드와 각 코드가 보호하는 경계를 확인합니다.
---

SQLBraid runtime/compiler 오류는 오류 타입이 정의한 경우 `code`를
노출합니다. Adapter capability 오류는 안정적인 `BRAID_*` code를 가진
`UnsupportedFeatureError`를 사용하고 driver 오류는 원래 identity를
유지합니다.

Placeholder 생성, hint 매핑, typed request 구성, 지원하지 않는 transport
선택 같은 binding 구성 실패는 lease 획득과 driver I/O 전 `materialize`
단계에서 발생합니다. Driver/server/network 실패는 `driver` 단계입니다.
Materialization 오류의 `executionStarted`와 `executionCompleted`는 모두
`false`입니다.

내보낸 `PUBLIC_ERROR_DEFINITIONS` registry가 이 reference의 source of truth입니다.
Runtime 소유 class에는 `DatabaseScopeError`, `DatabaseResultKindError`,
`DatabaseResultValidationError`, `ResultExactnessError`, `RoutineMappingError`가
있습니다. Adapter capability 실패는 `UnsupportedFeatureError`를 사용하며,
`feature`는 capability를, `code`는 안정적인 오류 코드를 나타냅니다. Driver 오류는
래핑하지 않고, 이미 abort된 `AbortSignal`은 원래 `reason`으로 거부합니다.
안정적인 bind code를 노출하는 Adapter 입력/transport 실패는 `AdapterError`
(`TypeError`) class를 사용합니다.

| Code                                   | 의미                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAID_RESULT_EXACTNESS`               | 결과 값을 손실 없이 표현할 수 없습니다.                                                                                                                                                 |
| `BRAID_RESULT_KIND`                    | 선언한 result kind와 실행 후 adapter 결과가 다릅니다.                                                                                                                                   |
| `BRAID_RESULT_SETS_UNSUPPORTED`        | 일반 query/stream이 추가 statement/result set을 반환했습니다. 순서 있는 routine set에는 `db.call()`을 사용하세요.                                                                       |
| `BRAID_RESULT_VALIDATION`              | Query-bound 또는 execution-level Standard Schema 검증에 실패했습니다.                                                                                                                   |
| `BRAID_BATCH_ABORTED`                  | 이미 `query:ready`를 알린 batch item이 다른 operation 또는 공유 batch phase 실패로 중단되었습니다. `executionStarted`와 `executionCompleted`가 해당 item 자체의 실행 여부를 구분합니다. |
| `BRAID_CALL_UNSUPPORTED`               | Adapter가 routine call을 제공하지 않습니다.                                                                                                                                             |
| `BRAID_STREAM_UNSUPPORTED`             | Adapter가 streaming protocol을 제공하지 않습니다.                                                                                                                                       |
| `BRAID_CANCEL_UNSUPPORTED`             | 활성 signal이 전달되었지만 adapter가 물리 statement를 취소할 수 없습니다. I/O 전에 거부합니다.                                                                                          |
| `BRAID_SESSION_UNSUPPORTED`            | Adapter/provider가 session lease를 고정할 수 없습니다.                                                                                                                                  |
| `BRAID_SESSION_SCOPE`                  | 활성 session scope에서 root database를 사용했습니다.                                                                                                                                    |
| `BRAID_SESSION_CLOSED`                 | Callback 종료 뒤 session callback handle을 사용했습니다.                                                                                                                                |
| `BRAID_TX_UNSUPPORTED`                 | Adapter가 transaction을 시작할 수 없습니다.                                                                                                                                             |
| `BRAID_TX_OPTIONS_INVALID`             | Runtime transaction option이 malformed입니다(`TypeError`). lease 획득 전에 검증합니다.                                                                                                  |
| `BRAID_TX_OPTIONS_NESTED`              | 활성 transaction 내부에서 명시적 transaction option을 전달했습니다.                                                                                                                     |
| `BRAID_TX_OPTION_UNSUPPORTED`          | 유효한 isolation/read-only option이 advertised되지 않았습니다. feature는 `transaction.isolation.<level>` 또는 `transaction.read-only`입니다.                                            |
| `BRAID_TX_SCOPE`                       | root/parent/sibling transaction handle이 활성 범위를 벗어났습니다.                                                                                                                      |
| `BRAID_TX_CLOSED`                      | callback 종료 뒤 scoped transaction handle을 사용했습니다.                                                                                                                              |
| `BRAID_CONNECTION_POISONED`            | 불확실한 transaction control로 물리 resource가 오염되었습니다.                                                                                                                          |
| `BRAID_STREAM_SCOPE`                   | 겹치거나 동일한 resource에서 streaming을 시도했습니다.                                                                                                                                  |
| `BRAID_REENTRY`                        | direct physical resource에 동시에 재진입했습니다.                                                                                                                                       |
| `BRAID_CALL_RESULT_SETS`               | tuple routine의 result-set 개수와 driver 반환 개수가 다릅니다.                                                                                                                          |
| `BRAID_CALL_MAP`                       | routine output, return value 또는 result-set row 매핑에 실패했습니다.                                                                                                                   |
| `BRAID_CALL_CURSOR_TX_REQUIRED`        | PostgreSQL refcursor call에는 기존 transaction-scoped database가 필요합니다.                                                                                                            |
| `BRAID_CALL_CURSOR_UNSUPPORTED`        | 요청한 cursor output을 application result set으로 노출할 수 없습니다.                                                                                                                   |
| `BRAID_CALL_RETURN_UNSUPPORTED`        | return/status schema를 요청했지만 driver channel이 없습니다.                                                                                                                            |
| `BRAID_CALL_OUT_UNSUPPORTED`           | 요청한 OUT 또는 INOUT parameter carrier를 노출할 수 없습니다.                                                                                                                           |
| `BRAID_CALL_LOB_UNSUPPORTED`           | Oracle output이 문서화된 LOB carrier를 제공하지 않습니다.                                                                                                                               |
| `BRAID_RESOURCE_CLEANUP`               | Driver close, drain 또는 cancel이 실패해 lease를 안전하게 재사용할 수 없습니다.                                                                                                         |
| `BRAID_PREPARED_NAME`                  | Prepared query 이름이 비어 있거나 중복됩니다.                                                                                                                                           |
| `BRAID_PREPARED_SHAPE`                 | Prepared query가 다른 logical shape를 렌더링했습니다.                                                                                                                                   |
| `BRAID_PREPARE_UNSUPPORTED`            | Adapter가 필요한 prepared-statement protocol을 제공하지 않습니다.                                                                                                                       |
| `BRAID_BIND_HINT_UNSUPPORTED`          | Adapter가 명시적 bind type/facet을 적용할 수 없습니다. I/O 전에 거부합니다.                                                                                                             |
| `BRAID_BIND_VALUE_UNSUPPORTED`         | 선택한 binding transport로 값을 표현할 수 없습니다.                                                                                                                                     |
| `BRAID_BIND_TYPE_REQUIRED`             | Driver inference가 모호합니다(Oracle/SQL Server untyped null 포함).                                                                                                                     |
`BRAID_INTEGER_MODE_UNSUPPORTED`       | Adapter가 명세에 필요한 exact integer read mode를 켤 수 없습니다.
| `BRAID_BULK_UNSUPPORTED`               | Adapter가 필요한 native bulk capability를 제공하지 않습니다.                                                                                                                            |
| `BRAID_DIALECT_MISMATCH`               | Rendered statement가 선택한 adapter dialect와 다릅니다.                                                                                                                                 |
| `BRAID_RESULT_KIND_AMBIGUOUS`          | Adapter가 빈 row result와 command result를 구분할 수 없습니다.                                                                                                                          |
| `BRAID_EMPTY_LIST`                     | 명시적 empty strategy 없이 `sql.list([])`를 사용했습니다.                                                                                                                               |
| `BRAID_EMPTY_SET`                      | `@braid set`에 assignment가 없습니다.                                                                                                                                                   |
| `BRAID_DIALECT`                        | Fragment가 다른 dialect에 속합니다.                                                                                                                                                     |
| `BRAID_ASYNC_CONTEXT`                  | Guarded lowering이 top-level await/yield 평가 context를 바꿉니다.                                                                                                                       |
| `BRAID_DIRECTIVE_UNTERMINATED`         | Directive comment의 닫는 `*/`가 없습니다.                                                                                                                                               |
| `BRAID_DIRECTIVE`                      | 비어 있거나 알 수 없는 `@braid` directive입니다.                                                                                                                                        |
| `BRAID_CONDITION`                      | Guard가 추가 text 없이 정확히 하나의 interpolation을 갖지 않습니다.                                                                                                                     |
| `BRAID_ATTRIBUTES`                     | Directive attribute가 지원되지 않거나 잘못되었거나 중복되었습니다.                                                                                                                      |
| `BRAID_STRUCTURE`                      | Directive nesting/branch 구조가 잘못되었습니다.                                                                                                                                         |
| `BRAID_HOLE_CONTEXT`                   | SQL literal/comment 내부에 interpolation이 있습니다.                                                                                                                                    |
| `BRAID_SQL_LEX`                        | SQL literal/comment가 닫히지 않았습니다.                                                                                                                                                |
| `BRAID_DEPTH`                          | Template/rendered fragment nesting이 설정 한도를 초과했습니다.                                                                                                                          |
| `BRAID_STRUCTURE_LIMIT`                | Rendered structural item이 `maxStructuralItems`를 초과했습니다.                                                                                                                         |
| `BRAID_SQL_LIMIT` / `BRAID_BIND_LIMIT` | Rendered output이 설정 한도를 초과했습니다.                                                                                                                                             |

`UnsupportedFeatureError` constructor는 `(feature, code, message, options?)`이고
code는 `BRAID_${string}` 형태입니다. 이미 abort된 signal은
`BRAID_CANCEL_UNSUPPORTED`가 아니라 자신의 `reason`으로 거부됩니다.
지원되지 않는 capability를 buffering, 숨은 transaction, 추측한 routine
metadata, 무시한 hint로 바꾸지 마세요.

Compiler diagnostic에는 source range와 severity가 있습니다. CLI JSON은
1-based 위치이고 LSP는 표준 0-based 위치입니다. 누락 metadata는 open-world
증거이지 invalid SQL 오류가 아닙니다.
