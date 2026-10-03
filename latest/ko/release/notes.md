# 1.0.0 릴리스 노트

> SQLBraid 1.0.0 GA의 인터페이스와 기능·근거 경계입니다.

SQLBraid 1.0.0 GA 문서입니다. GA로 공개 인터페이스가 안정화되었습니다. 그렇다고 모든 드라이버에서 모든 기능을 쓸 수 있는 것은 아닙니다.

지원하는 데이터베이스, 드라이버, 프로필, 런타임, 기능 조합은 [런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)에 있습니다.

## 1.0.0에 포함된 것

- SQL 중심 템플릿, 안전한 값 바인딩, 명시적인 결과 종류 `rows`, `command`, `call`, `unknown`
- 범위가 제한된 `@braid` 지시어와 명시적인 구조 조각
- 쿼리에 연결하거나 실행마다 지정하는 Standard Schema 행 매핑
- 직접 연결 물리 실행기, 그리고 프로바이더·리스를 통한 명시적인 풀 소유권
- `db.session(callback)`의 리스 고정, 중첩 세션에서의 재사용, `db.tx`
- 정해진 트랜잭션 격리 수준 리터럴과 `readOnly`. 형식 오류, 미지원, 중첩 옵션은 각각 다른 오류를 씁니다
- 마지막 인자로 넘기는 실행·행·스트림 옵션, 그리고 기능 지원 여부에 따른 `AbortSignal` 취소
- 입력이 있는 준비된 쿼리 팩토리와 입력이 없는 팩토리. 한 번만 렌더링하며 논리적 형태를 고정합니다
- 리스 반환 전에 정리하는 네이티브 드라이버 스트림, 또는 명시적인 `BRAID_STREAM_UNSUPPORTED`
- 메모리로 읽는 루틴 `output`, 순서가 있는 서로 다른 `resultSets`, 선택 사항인 `returnValue`, OUT·INOUT·커서에 대한 명시적 경계
- 명령 전용의 같은 형태 벌크. I/O 전에 검증하고 실제 실행 방식을 보고합니다
- 관찰하거나 실패시키기만 하는 실행 옵저버, 필요할 때만 만드는 진단용 리터럴 SQL
- `@sqlbraid/opentelemetry`의 선택 사항 DB 클라이언트 span과 안정적인 실행 시간 지표. SDK와 익스포터는 애플리케이션이 맡습니다
- 드라이버 하위 경로를 갖춘 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server 방언 루트
- Bun SQL 어댑터 계열 하나. 사용자가 PostgreSQL, MySQL, MariaDB, SQLite 방언을 직접 골라야 하며, 커넥션에서 감지하지 않습니다
- 공개 API가 동작하는 곳에서 Deno용 기존 공식 드라이버 어댑터. Deno 전용 방언은 없습니다
- 메타데이터, 코드 생성, CLI JSON 검사, 표준 LSP, Vite 변환, 얇은 에디터 연동
- 정규 문자열로 다루는 정확한 데이터베이스 정수·소수, 숫자로 다루는 근사 IEEE 값, 그리고 서로 독립된 JSON·날짜·시간·컨테이너 프로필

## 명시적인 미지원 동작

`UnsupportedFeatureError(feature, code, message, options?)`는 고정된 `BRAID_*` 코드를 가집니다. 드라이버가 물리적 취소를 지원하지 않는데 활성 취소를 요청하면 `BRAID_CANCEL_UNSUPPORTED`를 씁니다. 이미 중단된 시그널은 원래 `reason`을 유지합니다. 스트림, 루틴, 출력, 힌트, 트랜잭션, 벌크 기능이 없으면 명시적으로 실패합니다. SQLBraid는 버퍼링하거나, 출력 전달 방식을 추측하거나, 힌트를 무시하거나, 숨은 트랜잭션을 만들지 않습니다.

- MySQL/mysql2는 `CALL`이 출력하는 서로 다른 결과 집합을 지원합니다. OUT·INOUT 설명은 전달 행을 확실히 식별할 수 없어 지원하지 않습니다.
- SQLite의 `db.call()` / `routine.call`은 지원하지 않습니다. 일반 SQLite SQL 함수나 확장을 제한하는 것은 아닙니다.
- `callStream()`은 이름만 예약되어 있고 구현되지 않았습니다. 1.0.0에서 호출할 수 있는 API가 아닙니다.

[기능 제한 사항](/SQLBraid/latest/release/limitations.md)을 보세요. 예를 들어 Bun 1.3.14의 MySQL과 MariaDB는 명시적인 `readOnly` 불리언 값을 둘 다 거부합니다. 옵션을 생략하면 네이티브 세션 기본값이 유지됩니다. Bun.SQL PostgreSQL은 다릅니다.

정규 기능 키는 다음과 같습니다.

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## 일부러 제공하지 않는 기능

SQLBraid는 다음과 같은 것이 아닙니다.

- ORM
- 완전한 SQL 의미 컴파일러
- 범용 입력 코덱
- SQL이나 결과를 고쳐 쓰는 인터셉터
- 자동 재시도·경로 지정 계층
- 감사 저장소
- 범용 네이티브 준비된 문장 캐시

임의의 SELECT·JOIN 문에서 결과 모델을 추론하지 않고, 객체 그래프를 채우지 않습니다. 선택한 어댑터의 정확한 근거가 달리 말하지 않는 한, DML `RETURNING`/`OUTPUT`은 메모리로 읽습니다. 메타데이터는 열린 세계의 긍정적 근거입니다.

지원 정보와 릴리스 결과물은 배포 전에 검증합니다.
