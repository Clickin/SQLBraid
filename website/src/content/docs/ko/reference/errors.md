---
title: 진단과 오류 코드
description: 안정적인 SQLBraid 오류 코드와 각 코드가 지키는 경계입니다.
---

SQLBraid의 런타임·컴파일러 오류는 오류 타입이 코드를 정의한 경우 `code`를 제공합니다. 얇은 어댑터의 기능 오류는 고정된 `BRAID_*` 코드를 가진 `UnsupportedFeatureError`를 씁니다. 드라이버 오류는 원래 오류 그대로 유지됩니다.

바인딩 구성 실패는 리스 획득이나 드라이버 I/O 전에 `materialize` 단계에서 일어납니다. 플레이스홀더 생성, 힌트 매핑, 타입 지정 요청 구성, 지원하지 않는 전송 방식 선택에서 생기는 실패입니다. 드라이버, 서버, 네트워크 실패는 계속 `driver` 단계입니다. 변환(materialize) 오류는 `executionStarted === false`, `executionCompleted === false`입니다.

이 문서의 기준은 export된 `PUBLIC_ERROR_DEFINITIONS` 레지스트리입니다.

- 런타임이 맡는 오류 클래스에는 `DatabaseScopeError`, `DatabaseResultKindError`, `DatabaseResultValidationError`, `ResultExactnessError`, `RoutineMappingError`가 있습니다.
- 어댑터 기능 실패는 `UnsupportedFeatureError`를 씁니다. `feature`가 기능을, `code`가 고정된 코드를 나타냅니다.
- 드라이버 오류는 감싸지 않습니다.
- 이미 중단된 `AbortSignal`은 원래 `reason`으로 reject됩니다.
- 어댑터의 입력·전송 실패가 고정된 코드를 가지면 `AdapterError`(`TypeError`) 클래스를 씁니다.
- 선택 패키지 `@sqlbraid/migrate`는 `MigrationError`와 `MigrationStartupError`를 export합니다. `MigrationStartupError`에는 마이그레이션 보고서가 포함됩니다.

| 코드                                   | 의미                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAID_RESULT_EXACTNESS`               | 결과 값을 손실 없이 표현할 수 없습니다.                                                                                                                                            |
| `BRAID_RESULT_KIND`                    | 실행 후 확인해 보니 선언한 결과 종류가 어댑터 결과와 다릅니다.                                                                                                                     |
| `BRAID_RESULT_SETS_UNSUPPORTED`        | 일반 쿼리나 스트림이 추가 문장·결과 집합을 반환했습니다. 순서가 있는 루틴 결과 집합에는 `db.call()`을 쓰세요.                                                                      |
| `BRAID_RESULT_VALIDATION`              | 쿼리나 실행 단계에 연결한 Standard Schema 검증이 실패했습니다.                                                                                                                     |
| `BRAID_BATCH_ABORTED`                  | 이미 `query:ready`를 알린 배치 항목이, 다른 작업이나 배치 공통 단계의 실패로 버려졌습니다. 그 항목이 실제로 실행되었는지는 `executionStarted`와 `executionCompleted`로 구분합니다. |
| `BRAID_CALL_UNSUPPORTED`               | 어댑터가 루틴 호출을 제공하지 않습니다.                                                                                                                                            |
| `BRAID_STREAM_UNSUPPORTED`             | 어댑터가 스트리밍 프로토콜을 제공하지 않습니다.                                                                                                                                    |
| `BRAID_CANCEL_UNSUPPORTED`             | 활성 시그널을 넘겼지만 어댑터가 물리 문장을 취소할 수 없습니다. I/O 전에 거부합니다.                                                                                               |
| `BRAID_SESSION_UNSUPPORTED`            | 어댑터·프로바이더가 세션 리스를 고정할 수 없습니다.                                                                                                                                |
| `BRAID_SESSION_SCOPE`                  | 루트 데이터베이스가 활성 세션 범위를 벗어났습니다.                                                                                                                                 |
| `BRAID_SESSION_CLOSED`                 | 세션 콜백이 끝난 뒤 그 핸들을 썼습니다.                                                                                                                                            |
| `BRAID_TX_UNSUPPORTED`                 | 어댑터가 트랜잭션을 시작할 수 없습니다.                                                                                                                                            |
| `BRAID_TX_OPTIONS_INVALID`             | 런타임 트랜잭션 옵션의 형식이 잘못되었습니다(`TypeError`). 리스 획득 전에 검증합니다.                                                                                              |
| `BRAID_TX_OPTIONS_NESTED`              | 활성 트랜잭션 안에서 트랜잭션 옵션을 명시했습니다.                                                                                                                                 |
| `BRAID_TX_OPTION_UNSUPPORTED`          | 올바른 격리 수준·읽기 전용 옵션이지만 지원한다고 밝히지 않았습니다. feature는 `transaction.isolation.<level>`이나 `transaction.read-only`입니다.                                   |
| `BRAID_TX_SCOPE`                       | 루트·상위·형제 트랜잭션 핸들이 활성 범위를 벗어났습니다.                                                                                                                           |
| `BRAID_TX_CLOSED`                      | 트랜잭션 콜백이 끝난 뒤 그 핸들을 썼습니다.                                                                                                                                        |
| `BRAID_CONNECTION_POISONED`            | 트랜잭션 제어 결과가 불확실해 물리 리소스를 사용 불가로 표시했습니다.                                                                                                              |
| `BRAID_STREAM_SCOPE`                   | 스트리밍 중에 겹치는 작업이나 같은 리소스를 쓰는 작업을 시도했습니다.                                                                                                              |
| `BRAID_REENTRY`                        | 직접 연결 물리 리소스에 동시에 다시 들어갔습니다.                                                                                                                                  |
| `BRAID_CALL_RESULT_SETS`               | 튜플로 선언한 루틴의 결과 집합 개수가 드라이버가 반환한 개수와 다릅니다.                                                                                                           |
| `BRAID_CALL_MAP`                       | 루틴의 출력, 반환 값, 결과 집합 행 매핑이 실패했습니다.                                                                                                                            |
| `BRAID_CALL_CURSOR_TX_REQUIRED`        | PostgreSQL refcursor 호출에는 기존 트랜잭션 범위의 데이터베이스가 필요합니다.                                                                                                      |
| `BRAID_CALL_CURSOR_UNSUPPORTED`        | 어댑터가 요청한 커서 출력을 애플리케이션 결과 집합으로 제공할 수 없습니다.                                                                                                         |
| `BRAID_CALL_RETURN_UNSUPPORTED`        | 반환·상태 스키마를 요청했지만 드라이버에 반환·상태 채널이 없습니다.                                                                                                                |
| `BRAID_CALL_PROCEDURE_INVALID`         | `AdapterError`. 네이티브 프로시저 템플릿에 SQL 텍스트가 있거나, 파라미터가 `parameterNames`와 맞지 않습니다. 어댑터가 I/O 전에 거부합니다.                                         |
| `BRAID_CALL_OUT_UNSUPPORTED`           | 어댑터가 요청한 OUT·INOUT 파라미터의 전달 방식을 제공할 수 없습니다.                                                                                                               |
| `BRAID_CALL_LOB_UNSUPPORTED`           | Oracle 출력이 문서화된 LOB 객체를 제공하지 않았습니다.                                                                                                                             |
| `BRAID_RESOURCE_CLEANUP`               | 드라이버의 닫기, 비우기, 취소가 실패했습니다. 물리 리스를 안전하게 재사용할 수 없습니다.                                                                                           |
| `BRAID_PREPARED_NAME`                  | 준비된 쿼리 이름이 비어 있거나 중복됩니다.                                                                                                                                         |
| `BRAID_PREPARED_SHAPE`                 | 준비된 쿼리가 다른 논리적 형태로 렌더링되었습니다.                                                                                                                                 |
| `BRAID_PREPARE_UNSUPPORTED`            | 어댑터가 필요한 준비된 문장 프로토콜을 제공할 수 없습니다.                                                                                                                         |
| `BRAID_BIND_HINT_UNSUPPORTED`          | 어댑터가 명시한 바인딩 타입·속성을 적용할 수 없습니다. I/O 전에 거부합니다.                                                                                                        |
| `BRAID_BIND_VALUE_UNSUPPORTED`         | 선택한 바인딩 전송 방식으로 표현할 수 없는 값입니다.                                                                                                                               |
| `BRAID_BIND_TYPE_REQUIRED`             | 드라이버 추론이 모호합니다. Oracle이나 SQL Server의 타입 없는 null도 여기에 해당합니다.                                                                                            |
| `BRAID_INTEGER_MODE_UNSUPPORTED`       | 어댑터가 프로필에 필요한 정확한 정수 읽기 모드를 켤 수 없습니다.                                                                                                                   |
| `BRAID_BULK_UNSUPPORTED`               | 어댑터가 필요한 네이티브 벌크 기능을 제공하지 않습니다.                                                                                                                            |
| `BRAID_DIALECT_MISMATCH`               | 렌더링된 문장이 선택한 어댑터와 다른 방언에 속합니다.                                                                                                                              |
| `BRAID_RESULT_KIND_AMBIGUOUS`          | 어댑터가 빈 행 결과와 명령 결과를 구분할 수 없습니다.                                                                                                                              |
| `BRAID_EMPTY_LIST`                     | 빈 목록 처리 방식을 정하지 않고 `sql.list([])`를 썼습니다.                                                                                                                         |
| `BRAID_EMPTY_SET`                      | `@braid set`이 대입을 하나도 렌더링하지 않았습니다.                                                                                                                                |
| `BRAID_DIALECT`                        | 조각이 다른 방언에 속합니다.                                                                                                                                                       |
| `BRAID_ASYNC_CONTEXT`                  | 조건부 변환이 최상위 await/yield의 평가 문맥을 바꾸게 됩니다.                                                                                                                      |
| `BRAID_DIRECTIVE_UNTERMINATED`         | 지시어 주석에 닫는 `*/`가 없습니다.                                                                                                                                                |
| `BRAID_DIRECTIVE`                      | `@braid` 지시어가 비어 있거나 알 수 없는 지시어입니다.                                                                                                                             |
| `BRAID_CONDITION`                      | 조건에 다른 텍스트 없이 보간 하나만 있어야 하는데 그렇지 않습니다.                                                                                                                 |
| `BRAID_ATTRIBUTES`                     | 지시어 속성이 지원되지 않거나, 형식이 잘못되었거나, 중복됩니다.                                                                                                                    |
| `BRAID_STRUCTURE`                      | 지시어의 중첩이나 분기 구조가 잘못되었습니다.                                                                                                                                      |
| `BRAID_HOLE_CONTEXT`                   | 보간이 SQL 리터럴이나 주석 안에 있습니다.                                                                                                                                          |
| `BRAID_SQL_LEX`                        | SQL 리터럴이나 주석이 닫히지 않았습니다.                                                                                                                                           |
| `BRAID_DEPTH`                          | 템플릿이나 렌더링된 조각의 중첩이 설정한 한도를 넘었습니다.                                                                                                                        |
| `BRAID_STRUCTURE_LIMIT`                | 렌더링된 구조 항목 수가 `maxStructuralItems`를 넘었습니다.                                                                                                                         |
| `BRAID_SQL_LIMIT` / `BRAID_BIND_LIMIT` | 렌더링 결과가 설정한 한도를 넘었습니다.                                                                                                                                            |
| `BRAID_MIGRATE_SOURCE`                 | 마이그레이션 소스·manifest·SQL 구분자가 잘못되었거나 필요한 방언 파일이 없습니다.                                                                                                  |
| `BRAID_MIGRATE_UNINITIALIZED`          | 마이그레이션 이력 테이블이 없습니다.                                                                                                                                               |
| `BRAID_MIGRATE_PENDING`                | 검증 중 미적용 버전이나 변경된 반복 마이그레이션을 발견했습니다.                                                                                                                   |
| `BRAID_MIGRATE_AHEAD`                  | 데이터베이스에 더 새로운 마이그레이션이 있고 시작 정책이 이를 거부합니다.                                                                                                          |
| `BRAID_MIGRATE_CHECKSUM`               | 적용한 버전의 소스 체크섬이 달라졌습니다.                                                                                                                                          |
| `BRAID_MIGRATE_ORDER`                  | 소스가 없거나 버전 순서가 잘못되었거나 baseline 대상 이력이 비어 있지 않거나 승인한 스키마 해시를 저장할 성공한 마이그레이션이 없습니다.                                           |
| `BRAID_MIGRATE_DIRTY`                  | 이력에 실패한 시도나 잘못된 상태가 있습니다. repair 전에 데이터베이스를 점검하세요.                                                                                                |
| `BRAID_MIGRATE_BUSY`                   | 검증 중 실행 중인 시도를 발견했거나 적용 중 잠금·실행 권한 대기 시간이 초과되었습니다.                                                                                             |
| `BRAID_MIGRATE_SCHEMA_DRIFT`           | 검사한 스키마 해시가 마이그레이션 이력에 저장된 해시와 다릅니다.                                                                                                                   |

`UnsupportedFeatureError`의 인자는 `(feature, code, message, options?)`이고, 코드는 `BRAID_${string}` 형식으로 제한됩니다. 이미 중단된 시그널은 `BRAID_CANCEL_UNSUPPORTED`가 아니라 원래 `reason`으로 reject됩니다. 지원하지 않는 기능 오류를 잡아서 버퍼링, 숨은 트랜잭션, 추측한 루틴 메타데이터, 힌트 무시로 대신하지 마세요.

컴파일러 진단에는 소스 범위와 심각도가 들어 있습니다. CLI JSON의 위치는 1부터, LSP는 표준대로 0부터 셉니다. 메타데이터에 정보가 없는 것은 열린 세계의 근거 부족일 뿐, 잘못된 SQL 오류가 아닙니다.
