---
title: 진단 및 오류 코드
description: 안정적인 SQLBraid 코드와 각 코드가 보호하는 경계를 확인합니다.
---

SQLBraid 런타임/컴파일러 오류는 오류 타입에 따라 `code`를 노출합니다. 얇은 어댑터의 기능 경계 오류는 메시지에 `BRAID_*` 표식을 사용하므로 모든 어댑터 오류에 `code` 속성이 있다고 가정하지 마세요. 드라이버 오류는 원래 identity를 유지합니다.

바인딩 구성 실패(placeholder 생성, 힌트 매핑, typed request 구성 또는 지원하지
않는 전송 선택)는 `"materialize"` 오류 단계로 보고하며 lease 획득과 드라이버
I/O 전에 발생합니다. 드라이버·서버·네트워크 실패는 `"driver"` 단계입니다.
materialize 오류의 `executionStarted`와 `executionCompleted`는 모두
`false`입니다.

| Code | 의미 |
| --- | --- |
| `BRAID_RESULT_KIND` | 선언한 결과 종류와 실행 후 어댑터 결과가 다릅니다. |
| `BRAID_RESULT_SETS_UNSUPPORTED` | 일반 쿼리 또는 행 스트림이 추가 문장/result set을 반환했습니다. MySQL materialized 실행도 포함합니다. `db.all`, `db.one`, `db.maybeOne`, 일반 `db.execute`는 최대 하나의 행 result set만 허용하며, 순서가 있는 여러 루틴 result set에는 `db.call()`을 사용하세요. |
| `BRAID_RESULT_VALIDATION` | 쿼리 연결 또는 실행 수준 Standard Schema 검증에 실패했습니다. |
| `BRAID_TX_SCOPE` | 루트/부모/sibling 트랜잭션 핸들이 활성 범위를 벗어났습니다. |
| `BRAID_TX_CLOSED` | 콜백이 끝난 뒤 트랜잭션 핸들을 사용했습니다. |
| `BRAID_CONNECTION_POISONED` | 불확실한 트랜잭션 제어로 물리 리소스가 오염되었습니다. |
| `BRAID_STREAM_SCOPE` | 겹치거나 동일한 리소스에서 스트리밍을 시도했습니다. |
| `BRAID_REENTRY` | 직접 물리 리소스에 동시에 재진입했습니다. |
| `BRAID_RESULT_COLUMNS` | 어댑터가 중복 결과 label을 반환했습니다. |
| `BRAID_CALL_UNSUPPORTED` | 어댑터가 루틴 호출을 노출하지 않습니다. |
| `BRAID_STREAM_UNSUPPORTED` | 어댑터가 스트리밍 프로토콜을 노출하지 않습니다. |
| `BRAID_CALL_RESULT_SETS` | tuple 루틴 계약이 선언한 result set 개수와 드라이버가 반환한 개수가 다릅니다. |
| `BRAID_CALL_MAP` | 루틴 output, return value 또는 result-set 행의 query-bound Standard Schema 매핑이 실패했습니다. 위치를 확인하세요. |
| `BRAID_CALL_CURSOR_TX_REQUIRED` | PostgreSQL `refcursor` 호출에는 기존 transaction-scoped database가 필요합니다. |
| `BRAID_CALL_CURSOR` | PostgreSQL refcursor output이 사용할 수 있는 portal 이름을 제공하지 않았습니다. |
| `BRAID_CALL_CURSOR_UNSUPPORTED` | 어댑터가 요청한 cursor output을 애플리케이션 result set으로 노출할 수 없습니다. |
| `BRAID_CALL_RETURN_UNSUPPORTED` | return/status schema를 요청했지만 driver call이 return/status 채널을 노출하지 않았습니다. |
| `BRAID_RESOURCE_CLEANUP` | 드라이버 리소스 close, drain 또는 cancel이 실패했으며 물리적 lease를 안전하게 재사용할 수 없습니다. |
| `BRAID_INTEGER_MODE_UNSUPPORTED` | SQLite bigint mode에는 Node의 `setReadBigInts`, 또는 WASM의 초기화한 `sqlite3` module과 공식 OO1 statement가 필요합니다. |
| `BRAID_PREPARED_NAME` | 준비된 쿼리 이름이 비어 있거나 중복됩니다. |
| `BRAID_PREPARED_SHAPE` | 준비된 쿼리가 다른 구조를 렌더링했습니다. |
| `BRAID_BIND_HINT_CONTEXT` | boolean 식 대신 바인드 값 래퍼를 지시문 조건에 사용했습니다. |
| `BRAID_BIND_HINT_UNSUPPORTED` | 어댑터가 명시적인 타입 또는 속성을 적용할 수 없어 DB I/O 전에 거부했습니다. |
| `BRAID_BIND_TYPE_REQUIRED` | Oracle/SQL Server의 타입 없는 null 등 드라이버 추론이 모호합니다. |
| `BRAID_BIND_DECIMAL_EXACTNESS` | Tedious가 JavaScript 숫자를 통해 해당 소수 값을 안전하게 인코딩할 수 없습니다. |
| `BRAID_CALL_OUT_UNSUPPORTED` | 어댑터가 요청한 OUT/INOUT 채널을 표현하거나 안전하게 식별할 수 없습니다(예: 검증되지 않은 MySQL prepared-CALL carrier). |
| `BRAID_EMPTY_LIST` | 명시적 빈 전략 없이 `sql.list([])`를 사용했습니다. |
| `BRAID_EMPTY_SET` | `@braid set`에 할당이 렌더링되지 않았습니다. |
| `BRAID_DIALECT` | 조각이 다른 dialect에 속합니다. |
| `BRAID_ASYNC_CONTEXT` | 보호된 lowering이 최상위 await/yield 평가 컨텍스트를 바꾸게 됩니다. |
| `BRAID_DIRECTIVE_UNTERMINATED` | 지시문 주석에 닫는 `*/`가 없습니다. |
| `BRAID_DIRECTIVE` | `@braid` 지시문이 비어 있거나 알 수 없습니다. |
| `BRAID_CONDITION` | guard에 추가 텍스트 없이 정확히 하나의 보간이 들어 있지 않습니다. |
| `BRAID_ATTRIBUTES` | 지시문 속성이 지원되지 않거나 잘못되었거나 중복되었습니다. |
| `BRAID_STRUCTURE` | 지시문 중첩 또는 분기 구조가 잘못되었습니다. `@braid end` 누락도 포함합니다. |
| `BRAID_HOLE_CONTEXT` | SQL literal 또는 주석 안에 보간이 나타났습니다. |
| `BRAID_SQL_LEX` | SQL literal 또는 주석이 닫히지 않았습니다. |
| `BRAID_ESCAPE` | 템플릿에 잘못된 cooked JavaScript escape가 있습니다. |
| `BRAID_DEPTH` | 템플릿 또는 렌더링 조각 중첩이 구성된 한도를 초과했습니다. |
| `BRAID_STRUCTURE_LIMIT` | 렌더링된 구조 항목이 `maxStructuralItems`를 초과했습니다. |
| `BRAID_SQL_LIMIT` / `BRAID_BIND_LIMIT` | 렌더링된 출력이 구성된 제한을 초과했습니다. |

컴파일러 진단에는 소스 범위와 severity가 포함됩니다. CLI JSON은 1부터 시작하는 위치를 사용하고 LSP는 표준 0부터 시작하는 위치를 사용합니다. 누락된 메타데이터 증거를 잘못된 SQL 오류로 바꾸지 마세요. 메타데이터는 개방 세계입니다.

