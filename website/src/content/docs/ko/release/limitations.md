---
title: 현재 제한 사항
description: 1.0.0 GA가 일부러 약속하지 않는 것들입니다.
---

- **지원은 특정 데이터베이스·드라이버·런타임 조합에만 적용됩니다.** 기준 자료는 [런타임·드라이버 지원 매트릭스](/SQLBraid/reference/support/)입니다. 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합과 테스트한 버전이 기록되어 있습니다.
- **`db.all()`은 결과를 메모리로 모두 읽습니다.** 읽기 전용 배열을 반환하며, 행 수에 비례해 애플리케이션 메모리를 씁니다. 메모리 사용량을 제한해야 한다면 `db.stream()`을 쓰세요.
- **루틴 스트리밍은 없습니다.** `callStream()`은 이름만 예약되어 있고 구현되지 않았습니다. 1.0.0에서 호출할 수 있는 API가 아닙니다. 메모리로 읽는 `db.call()`은 매핑 전에 루틴 리소스를 읽고 닫습니다. 원시 커서, 포털, 요청, 출력 전달 행은 밖으로 새어 나가지 않습니다.
- **MySQL·MariaDB의 준비된 문장으로 실행한 CALL의 OUT/INOUT 설명은 지원하지 않습니다.** `CALL`이 출력하는 서로 다른 결과 집합은 지원합니다. mysql2 3.x와 MariaDB Connector/Node.js 모두 준비된 문장 호출의 OUT 전달 행을 구분하는 검증된 공개 수단을 제공하지 않습니다. 그래서 SQLBraid는 전달 행을 추측하지 않습니다.
- **PostgreSQL refcursor 호출에는 기존 트랜잭션이 필요합니다.** refcursor는 트랜잭션에 속한 포털이며, 독립된 ResultSet이 아닙니다. SQLBraid는 숨은 트랜잭션을 만들지 않습니다.
- **SQL Server 커서 출력은 애플리케이션 커서가 아닙니다.** `CURSOR VARYING OUTPUT`은 바인딩할 수 있는 클라이언트 ResultSet으로 제공되지 않습니다. 출력된 `SELECT` 행은 일반 결과 집합으로 남습니다.
- **SQLite의 `db.call()` / `routine.call`은 지원하지 않습니다.** 이것은 어댑터 API의 경계이며 SQLite SQL에 대한 제한이 아닙니다. 스칼라·집계·윈도 함수와 가상 테이블 확장은 일반 SQL로 남습니다. D1에는 콜백 트랜잭션과 점진적 커서도 없습니다.
- **DML RETURNING은 메모리로 읽습니다.** `sql.rows`를 `db.execute`, `db.all`, `db.one`, `db.maybeOne`과 함께 쓰세요. `RETURNING`/`OUTPUT`이 모든 드라이버에서 스트리밍된다고 생각하지 마세요.
- **`db.bulk()`는 명령 전용입니다.** DML 형태 하나를 고정하고, I/O 전에 모든 입력을 검증하고, 리스 하나를 쓰고, 실제 실행 방식을 보고합니다. 루트 벌크에는 원자성이나 자동 분할에 대한 공통 보장이 없습니다. 원자성이 필요하면 `db.tx()`를 쓰세요.
- **세션과 트랜잭션은 물리 범위를 다루는 API입니다.** `db.session()`은 프로바이더 리스 하나를 고정합니다. 중첩 세션과 트랜잭션 작업은 같은 리스를 씁니다. 루트로 빠져나가는 호출과, 닫혔거나 형제인 핸들은 거부합니다. 기능이 없으면 `BRAID_SESSION_UNSUPPORTED`나 `BRAID_TX_UNSUPPORTED`를 씁니다.
- **트랜잭션 옵션은 정해져 있고, 기능 지원 여부에 따라 달라집니다.** 격리 수준은 `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable` 중 하나입니다. `readOnly`는 별도입니다. 형식이 잘못된 런타임 값은 획득 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패합니다. 올바르지만 지원하지 않는 값은 `BRAID_TX_OPTION_UNSUPPORTED`, 중첩 트랜잭션의 명시적 옵션은 `BRAID_TX_OPTIONS_NESTED`를 씁니다.
- **Bun.SQL MySQL/MariaDB에서는 접근 모드를 명시할 수 없습니다.** `readOnly: true`와 `readOnly: false` 모두 I/O 전에 `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다. 네이티브 Bun 1.3.14에서는 읽기 전용 문장 실패가 롤백 후에도 남을 수 있어서, 오염된 예약 커넥션은 폐기합니다. 옵션을 생략하면 세션 기본값이 유지되며, 읽기·쓰기 모드를 강제하지 않습니다. Bun.SQL PostgreSQL과 표현 방식 프로필 옵션은 바뀌지 않습니다.
- **취소는 기능 지원 여부에 따라 달라집니다.** 이미 중단된 시그널은 원래 `reason`을 유지합니다. 물리적 취소를 지원하지 않는데 활성 시그널을 넘기면 I/O 전에 `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`로 실패합니다. 반복만 멈추는 것은 취소가 아닙니다.
- **범용 입력 코덱은 없습니다.** 일반 보간은 드라이버가 바인딩합니다. JSON, 날짜·시간 값, 사용자 정의 클래스, 바이너리 값에 대한 애플리케이션 관례는 드라이버와 애플리케이션이 다룹니다.
- **숫자 정확도는 프로필마다 다릅니다.** 정확한 데이터베이스 정수와 소수는 정규 문자열이고, 근사 IEEE 값은 숫자입니다. `decodeExactInteger`는 선택 사항인 애플리케이션 변환입니다. Bun 1.3.14는 PostgreSQL, MySQL, MariaDB에 `{ bigint: true }`를, SQLite에 `{ safeIntegers: true }`를 씁니다. 정수 값의 `Number` 행은 거부합니다. PostgreSQL decimal은 텍스트입니다. MySQL·MariaDB의 DECIMAL과 바이너리 바이트는 SQL에서 텍스트나 16진수로 변환하지 않으면 거부합니다. SQLite 네이티브 decimal은 지원하지 않습니다. D1은 안전한 정수 범위로 제한된 guarded 상태입니다. 정확한 텍스트가 중요하면 SQL에 `CAST(... AS TEXT)`를 쓰세요.
- **JSON과 날짜·시간 정확도는 별도 프로필입니다.** 파싱된 JSON에는 반올림된 중첩 숫자가 있을 수 있습니다. 네이티브 `Date`는 소수 초 정밀도나 오프셋·시간대 의미를 잃을 수 있습니다. 검증된 텍스트 프로필을 쓰거나, SQL에 `JSON_SERIALIZE`, `TO_CHAR`, `CONVERT`를 쓰세요.
- **컨테이너는 스칼라 값의 보장을 받지 않습니다.** 배열, 도메인, 범위, 다중 범위, 복합 타입, Oracle 객체·컬렉션, SQL Server `sql_variant`, 벡터, 중첩 값은 테스트되기 전까지 분류되지 않았거나 지원되지 않는 상태로 남습니다.
- **프로필과 코드 생성은 일치해야 합니다.** 드라이버의 JSON, 날짜·시간, 숫자 옵션을 바꾸면 다른 근거 프로필이 됩니다. 런타임과 생성된 모델은 그 프로필의 TypePolicy를 써야 합니다.
- **Bun SQL 방언은 사용자가 고릅니다.** `createBunSqlDatabase`에는 `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`가 필요하며, 어댑터가 자동으로 감지하지 않습니다. Bun 1.3.14에서 활성 취소는 `BRAID_CANCEL_UNSUPPORTED`로 실패합니다. 스트림과 루틴 출력 전달은 `BRAID_STREAM_UNSUPPORTED`, `BRAID_CALL_UNSUPPORTED`로 명시적으로 실패합니다. `result.rows`와 `result.command` 메타데이터는 `bun-sql.result-kind-metadata` 조건으로 guarded입니다. MySQL과 MariaDB에서는 결과가 빈 `SELECT`와, 0행에 영향을 준 DML·DDL이 실행 후 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패합니다. 따라서 부수 효과는 이미 일어났을 수 있습니다.
- **Deno는 기존 어댑터를 씁니다.** Node 호환 공개 드라이버 경로는 Deno에서도 동작할 수 있습니다. 그렇다고 Deno 방언이 생기거나 지원 조합의 등급이 올라가지는 않습니다.
- **SQL에서 TypeScript 타입을 추론하지 않습니다.** SQLBraid는 임의의 SELECT·JOIN 결과를 추론하거나 관계 그래프를 채우지 않습니다.
- **옵저버는 변경, 재시도, 경로 지정을 할 수 없습니다.** 옵저버는 작업을 살펴보거나 실패시킬 수 있을 뿐입니다. SQL을 고쳐 쓰거나, 바인딩 값을 바꾸거나, 재시도하거나, 다른 곳으로 보낼 수 없습니다.
- **메타데이터는 근거일 뿐, 잘못되었다는 증거가 아닙니다.** 메타데이터에 없는 객체는 열린 세계로 다룹니다. 루틴 인자 목록은 불완전할 수 있습니다.
- **직접 만든 드라이버는 릴리스 지원 대상이 아닙니다.** `QueryExecutor`/`ConnectionProvider`를 구현하고, 독립된 정확한 근거를 직접 갖추세요.
- **도구는 Node 중심입니다.** 컴파일러, CLI, LSP, 메타데이터·코드 생성, Vite 연동은 빌드와 런타임의 관심사가 따로 있습니다. Node 전용 드라이버를 브라우저 번들에 넣지 마세요.

이 경계들은 의도한 것이며, 숨은 대체 동작이 아닙니다. [루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/), [트랜잭션](/SQLBraid/runtime/transactions/), [지원 매트릭스](/SQLBraid/reference/support/)를 보세요.
