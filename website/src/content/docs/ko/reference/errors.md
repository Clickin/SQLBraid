---
title: 진단 및 오류 코드
description: 안정적인 SQLBraid 코드와 각 코드가 보호하는 경계를 확인합니다.
---

SQLBraid 런타임/컴파일러 오류는 오류 타입에 따라 `code`를 노출합니다. 얇은 어댑터의 기능 경계 오류는 메시지에 `BRAID_*` 표식을 사용하므로 모든 어댑터 오류에 `code` 속성이 있다고 가정하지 마세요. 드라이버 오류는 원래 identity를 유지합니다.

| Code | 의미 |
| --- | --- |
| `BRAID_RESULT_KIND` | 선언한 결과 종류와 실행 후 어댑터 결과가 다릅니다. |
| `BRAID_RESULT_VALIDATION` | 쿼리 연결 또는 실행 수준 Standard Schema 검증에 실패했습니다. |
| `BRAID_TX_SCOPE` | 루트/부모/sibling 트랜잭션 핸들이 활성 범위를 벗어났습니다. |
| `BRAID_TX_CLOSED` | 콜백이 끝난 뒤 트랜잭션 핸들을 사용했습니다. |
| `BRAID_CONNECTION_POISONED` | 불확실한 트랜잭션 제어로 물리 리소스가 오염되었습니다. |
| `BRAID_STREAM_SCOPE` | 겹치거나 동일한 리소스에서 스트리밍을 시도했습니다. |
| `BRAID_REENTRY` | 직접 물리 리소스에 동시에 재진입했습니다. |
| `BRAID_RESULT_COLUMNS` | 어댑터가 중복 결과 label을 반환했습니다. |
| `BRAID_CALL_UNSUPPORTED` | 어댑터가 루틴 호출을 노출하지 않습니다. |
| `BRAID_STREAM_UNSUPPORTED` | 어댑터가 스트리밍 프로토콜을 노출하지 않습니다. |
| `BRAID_PREPARED_NAME` | 준비된 쿼리 이름이 비어 있거나 중복됩니다. |
| `BRAID_PREPARED_SHAPE` | 준비된 쿼리가 다른 구조를 렌더링했습니다. |
| `BRAID_BIND_HINT_CONTEXT` | boolean 식 대신 바인드 값 래퍼를 지시문 조건에 사용했습니다. |
| `BRAID_BIND_HINT_UNSUPPORTED` | 어댑터가 명시적인 타입 또는 속성을 적용할 수 없어 DB I/O 전에 거부했습니다. |
| `BRAID_BIND_TYPE_REQUIRED` | Oracle/SQL Server의 타입 없는 null 등 드라이버 추론이 모호합니다. |
| `BRAID_BIND_DECIMAL_EXACTNESS` | Tedious가 JavaScript 숫자를 통해 해당 소수 값을 안전하게 인코딩할 수 없습니다. |
| `BRAID_CALL_OUT_UNSUPPORTED` | 실제 SQL Server 출력 파라미터를 현재 호출 계약으로 표현할 수 없습니다. |
| `BRAID_RESULT_SETS_UNSUPPORTED` | 행 쿼리/스트림에 추가 문장 또는 결과 집합이 있습니다. 지원되는 경우 `call()`을 사용하세요. |
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
