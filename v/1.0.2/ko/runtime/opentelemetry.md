# OpenTelemetry 연동

> SQLBraid 데이터베이스 작업의 트레이스와 실행 시간 지표를 내보냅니다. 런타임은 SDK에 의존하지 않습니다.

`@sqlbraid/opentelemetry`는 선택 사항인 공식 옵저버 연동입니다. OpenTelemetry API와 함께 설치하세요.

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

OpenTelemetry SDK, 프로바이더, 익스포터, 리더는 애플리케이션에서 설정하세요. SQLBraid는 피어 의존성인 API만 씁니다.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";

const telemetry = createOpenTelemetryObserver({
  // traces and metrics default to true
  queryText: false,
  database: {
    namespace: "billing",
    serverAddress: "db.internal",
    serverPort: 5432,
  },
});

const db = createPgPoolDatabase(pool, { observers: [telemetry] });
```

## 신호와 수명 주기

옵저버는 다음 작업에 대해 OpenTelemetry DB 클라이언트 span을 만듭니다.

- 메모리로 읽는 행 쿼리
- 명령
- 루틴 호출
- 준비된 쿼리 실행
- `db.batch()` 안의 각 작업
- 논리적 작업 하나인 `db.bulk()`

span은 `query:ready`나 `bulk:ready`에서 시작해, 짝이 맞는 mapped, result, error 이벤트에서 끝납니다. 트랜잭션 안의 쿼리도 일반 쿼리 span을 그대로 씁니다. 1.0.0은 트랜잭션이나 세이브포인트 span을 만들지 않습니다.

안정 지표 `db.client.operation.duration` 히스토그램은 초 단위와 권장 명시 경계값 `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`을 씁니다.

- 속성에는 안정적인 데이터베이스 식별 필드만 들어갑니다.
- 실패한 샘플에는 범위가 제한된 `error.type`도 들어갑니다.
- 벌크의 `db.operation.batch.size`는 span에만 있습니다.
- 작업 ID, 지문(fingerprint), SQL 텍스트, 바인딩 값은 절대 지표 속성이 되지 않습니다.

SQLBraid 방언은 다음과 같이 `db.system.name`에 매핑됩니다.

| SQLBraid 방언 | `db.system.name`       |
| ------------- | ---------------------- |
| `postgres`    | `postgresql`           |
| `mysql`       | `mysql`                |
| `mariadb`     | `mariadb`              |
| `sqlite`      | `sqlite`               |
| `oracle`      | `oracle.db`            |
| `mssql`       | `microsoft.sql_server` |

알 수 없는 방언은 `database.systemName`을 지정하지 않으면 `other_sql`을 씁니다. span 이름은 설정한 `database.namespace`를 먼저 쓰고, 없으면 `database.serverAddress`, 그다음 이 시스템 이름을 씁니다. 옵저버는 작업 이름이나 대상을 지어내려고 SQL을 파싱하지 않습니다.

## 개인 정보와 오류

바인딩 값과 `literalizedSql()`은 절대 읽거나 내보내지 않습니다. 기본적으로 `db.query.text`는 생략됩니다. `queryText: true`로 설정하면 SQLBraid의 파생된 파라미터화 SQL만 내보냅니다. 플레이스홀더는 그대로 있고 값은 여전히 빠집니다. 다만 SQL에 직접 쓴 정적 리터럴은 민감할 수 있습니다. 그래서 보관 정책이 허용하지 않는 한 쿼리 텍스트는 끈 상태로 두세요.

실패한 작업은 span 상태를 `ERROR`로 설정하고, 범위가 좁은 `error.type`을 넣습니다. 옵저버는 예외 메시지나 스택을 내보내지 않으며, 데이터베이스 응답 상태 코드를 지어내지도 않습니다. 프로바이더 접근, span 메서드, 지표 기록의 실패는 옵저버 안에서 격리됩니다. SQLBraid의 쿼리, 트랜잭션, 리스, 결과 동작을 바꿀 수 없습니다.

## 모드와 드라이버 계측

각 모드는 따로 쓸 수 있습니다.

```ts
createOpenTelemetryObserver({ traces: true, metrics: false }); // traces only
createOpenTelemetryObserver({ traces: false, metrics: true }); // metrics only
createOpenTelemetryObserver({ traces: false, metrics: false }); // no-op
```

SQLBraid 수준의 span과 드라이버 자동 계측은 겹칠 수 있습니다. 중복 span을 원하지 않으면 논리 작업마다 트레이스 출처를 하나만 고르세요.

```text
SQLBraid logical tracing:
  traces: true, metrics: true
  driver DB auto-instrumentation disabled

Existing driver tracing:
  traces: false, metrics: true
  driver instrumentation remains enabled
```

SQLBraid는 실제 통합 테스트 없이 `pg`, `mysql2` 같은 드라이버와 부모·자식 관계를 이룬다고 주장하지 않습니다.

## 옵저버 순서와 배치

옵저버는 등록한 순서대로 하나씩 실행됩니다. 1.0.0에서 지원하는 구성은 OpenTelemetry를 마지막에 등록하는 것입니다.

```ts
const db = createPgPoolDatabase(pool, {
  observers: [auditObserver, slowQueryObserver, createOpenTelemetryObserver()],
});
```

OpenTelemetry 뒤에 등록한 옵저버는, 텔레메트리가 이미 성공 span을 끝낸 뒤에 `query:mapped`나 `bulk:result`를 거부할 수 있습니다. 이후의 오류 이벤트가 그 span을 다시 열 수는 없습니다. OpenTelemetry를 먼저 등록하는 구성은 지원하지 않습니다.

`db.batch()`의 각 종료 이벤트는 자기 작업만 닫습니다. 옵저버는 `batchId`로 다른 항목의 실패를 추론하지 않습니다. 벌크 작업에서 전송 방식이 방언 정보를 줄 수 없다면 `database.systemName`을 설정하세요. 설정하지 않으면 마지막 대체값은 `other_sql`이며, 이전 쿼리의 식별 정보를 가져다 쓰지 않습니다.

## 느린 쿼리 조사

지연 시간은 OTel 히스토그램으로 찾으세요. 물리 실행 시간은 일반 SQLBraid 옵저버로 기록하세요. `query:result.durationMs`는 드라이버 실행 구간입니다. 논리 span과 히스토그램의 구간과는 일부러 다르게 잡았습니다.

```ts
const slowQueries: ExecutionObserver = {
  onEvent(event) {
    if (event.type !== "query:result" || event.durationMs < 50) return;
    console.warn("slow database operation", {
      operationId: event.operationId,
      durationMs: event.durationMs,
    });
  },
};

const db = createPgPoolDatabase(pool, {
  observers: [slowQueries, createOpenTelemetryObserver()],
});
```

패키징된 [`examples/opentelemetry-slow-query`](https://github.com/Clickin/SQLBraid/tree/main/examples/opentelemetry-slow-query) 예제는 빠른 쿼리 하나와 결정적인 PostgreSQL `pg_sleep(...)`을 실행합니다. 그런 다음 경고와, SDK가 소유한 트레이스·지표 익스포터를 확인합니다.

## 1.0.0의 명시적 한계

이 연동은 스트림 span, 트랜잭션·세이브포인트 span, 풀 지표, OTel Logs를 만들지 않습니다. 스트림에는 소비자의 반복과 정리가 포함되므로, 올바른 span 경계를 정하려면 별도의 설계가 필요합니다. 풀 수준 지표와 Logs는 1.0.0 범위 밖입니다.
