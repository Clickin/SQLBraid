---
title: OpenTelemetry 통합
description: SDK를 런타임에 결합하지 않고 SQLBraid database operation trace와 duration metric을 내보냅니다.
---

`@sqlbraid/opentelemetry`는 선택적인 first-party observer 통합입니다.
OpenTelemetry API와 함께 설치하세요.

```sh
npm install @sqlbraid/opentelemetry @opentelemetry/api
```

OpenTelemetry SDK, provider, exporter, reader는 애플리케이션에서 구성합니다.
SQLBraid는 API peer만 사용합니다.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";

const telemetry = createOpenTelemetryObserver({
  // trace와 metric은 기본적으로 활성화됩니다.
  queryText: false,
  database: {
    namespace: "billing",
    serverAddress: "db.internal",
    serverPort: 5432,
  },
});

const db = createPgPoolDatabase(pool, { observers: [telemetry] });
```

## Signal과 lifecycle

observer는 materialized row query, command, routine call, prepared 실행,
`db.batch()`의 각 구성 operation, 하나의 논리적 `db.bulk()` operation에
OpenTelemetry DB client span을 생성합니다. span은 `query:ready` 또는
`bulk:ready`에서 시작해 대응하는 mapped/result 또는 error event에서
종료합니다. transaction 내부 query도 일반 query span을 유지하지만 이 RC는
transaction/savepoint span을 만들지 않습니다.

안정화된 `db.client.operation.duration` histogram은 초 단위를 사용하며
권장 explicit boundary
`0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`을 사용합니다. attribute는
안정적인 database identity 필드와 bulk의 `db.operation.batch.size`입니다.
operation ID, fingerprint, SQL text와 bind 값은 metric attribute가 아닙니다.

SQLBraid dialect는 다음처럼 `db.system.name`으로 매핑됩니다.

| SQLBraid dialect | `db.system.name` |
| --- | --- |
| `postgres` | `postgresql` |
| `mysql` | `mysql` |
| `mariadb` | `mariadb` |
| `sqlite` | `sqlite` |
| `oracle` | `oracle.db` |
| `mssql` | `microsoft.sql_server` |

알 수 없는 dialect는 `database.systemName`이 지정되지 않은 경우
`other_sql`을 사용합니다. span name은 같은 low-cardinality fallback을
따르며 SQL을 파싱해 operation name이나 target을 만들지 않습니다.

## Privacy와 error

bind 값과 `literalizedSql()`은 읽거나 export하지 않습니다. 기본적으로
`db.query.text`는 생략됩니다. `queryText: true`인 경우에도 SQLBraid의
parameterized SQL view만 export하며 placeholder와 값이 없는 상태를
유지합니다. SQL에 author가 직접 적은 static literal은 민감할 수 있으므로
보존 정책이 허용될 때만 query text를 켜세요.

실패한 operation은 span status를 `ERROR`로 설정하고 좁은 `error.type`을
포함합니다. exception message나 stack은 export하지 않으며 database response
status code도 만들지 않습니다. provider 접근, span method 또는 metric
recording 실패는 observer 내부에서 격리되어 SQLBraid query, transaction,
lease 또는 result 동작을 바꾸지 않습니다.

## 모드와 driver instrumentation

모드는 독립적으로 사용할 수 있습니다.

```ts
createOpenTelemetryObserver({ traces: true, metrics: false }); // trace만
createOpenTelemetryObserver({ traces: false, metrics: true }); // metric만
createOpenTelemetryObserver({ traces: false, metrics: false }); // no-op
```

SQLBraid span과 driver auto-instrumentation은 겹칠 수 있습니다. 중복 span이
필요하지 않다면 논리 operation에 하나의 trace source만 선택하세요.

```text
SQLBraid logical tracing:
  traces: true, metrics: true
  driver DB auto-instrumentation disabled

Existing driver tracing:
  traces: false, metrics: true
  driver instrumentation remains enabled
```

실제 통합 테스트가 없으면 `pg`, `mysql2` 또는 다른 driver auto-instrumentation과
parent/child 관계를 주장하지 않습니다.

## Slow-query 조사

OTel histogram으로 latency를 감지하고 일반 SQLBraid observer로 physical
execution duration을 기록하세요. `query:result.durationMs`는 driver 실행
구간이며 logical span 및 histogram 경계와 의도적으로 다릅니다.

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
  observers: [createOpenTelemetryObserver(), slowQueries],
});
```

packed
[`examples/opentelemetry-slow-query`](https://github.com/Clickin/SQLBraid/tree/main/examples/opentelemetry-slow-query)
example은 빠른 query와 결정적인 PostgreSQL `pg_sleep(...)`를 실행한 뒤
warning과 SDK가 소유한 trace/metric exporter를 함께 확인합니다.

## RC의 명시적 한계

이 통합은 stream span, transaction/savepoint span, pool metric 또는 OTel
Logs를 emit하지 않습니다. stream에는 consumer iteration과 cleanup이
포함되므로 올바른 span 경계는 별도 설계가 필요합니다. pool-level metric과
Logs도 이 release candidate 범위 밖입니다.
