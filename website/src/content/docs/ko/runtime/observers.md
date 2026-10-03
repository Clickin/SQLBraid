---
title: 실행 옵저버
description: SQLBraid 수명 주기 이벤트를 관찰합니다. 런타임은 로거에 의존하지 않습니다.
---

직접 연결 팩토리나 풀 팩토리에 옵저버를 설정하세요.

```ts
const db = createPgPoolDatabase(pool, {
  observers: [
    {
      onEvent(event) {
        if (event.type === "query:ready") {
          logger.debug({
            execution: event.execution,
            sql: event.sql,
            sqlWithLiterals: event.literalizedSql({ values: "redacted" }).text,
            binds: event.values.map(() => "[REDACTED]"),
          });
        }
      },
    },
  ],
});
```

이벤트는 `query:ready`, `query:result`, `query:mapped`, `query:error`, `bulk:ready`, `bulk:result`, `stream:start`, `stream:end`, `transaction`입니다. `query:ready`는 렌더링과 순수한 바인딩 설명이 끝난 뒤, 리스를 획득하기 전에 발생합니다. 실제로 적용될 변경 불가능한 실행 계획을 담고 있습니다.

```ts
const planObserver: ExecutionObserver = {
  onEvent(event) {
    if (event.type !== "query:ready") return;
    const {
      adapterId,
      dialectId,
      transport, // native-value-template | text-positional | text-named | typed-request
      reuse: { requested, effective, owner, capacity },
    } = event.execution;
  },
};
```

이벤트에는 다음 정보도 들어 있습니다. 파생된 읽기 전용 값, 힌트, 보간 위치 정보, 선언한 결과 종류와 실제 결과 종류, 작업 ID, 실행 시간(`durationMs`), 행·명령 메타데이터, 매핑 완료 여부, 스트림 상태, 트랜잭션·세이브포인트 단계입니다.

호출의 경우 `query:result`는 `actualKind: "call"`, `resultSetCount`, 전체 `rowCount`, `outputKeys`, `hasReturnValue`를 보고합니다. 기본적으로 출력 값, 커서 포털 이름, ResultSet 객체, 프로토콜 전달 행은 기록하지 않습니다. `event.sql`은 파생된 파라미터화 SQL입니다. 네이티브 값 템플릿 전송에서는 없을 수 있습니다.

옵저버는 등록한 순서대로 하나씩 실행됩니다. 이벤트를 살펴보거나, 예외를 던져 작업을 거부할 수 있습니다.

- 옵저버에서 SQL, 바인딩 값, 결과를 바꾸지 마세요. 옵저버 규칙을 깨는 일입니다.
- API는 재시도, 경로 지정, 재작성 기능을 제공하지 않습니다.
- DB 실행 전에 실패하면 실행되지 않습니다.
- 실행 후 실패는 루트 작업의 부수 효과를 되돌릴 수 없습니다. `db.tx` 안에서 실패가 전파되면 일반적인 롤백이 적용됩니다.
- 오류 옵저버도 실패하면 `AggregateError`가 두 실패를 모두 담습니다.

이벤트 컨테이너는 구조상 읽기 전용입니다. SQLBraid는 `Uint8Array` 같은 임의의 애플리케이션·드라이버 값을 깊은 복사하지 않습니다. 옵저버는 참조한 값을 바꾸면 안 됩니다. 이것은 API 경계이며, 보안 샌드박스나 깊은 불변성 보장이 아닙니다.

SQLBraid는 기본적으로 바인딩 값을 기록하지 않습니다. 가림 처리와 보관 정책은 애플리케이션이 정합니다.

`db.batch()`에서는 `query:ready`를 낸 항목마다 종료 이벤트 `query:mapped`나 `query:error`가 정확히 한 번 발생합니다. 사전 점검, 획득, 드라이버, 반환, 옵저버 실패 때문에 버려진 항목도 마찬가지입니다.

- 버려진 다른 항목은 기존 오류 정보에 `BRAID_BATCH_ABORTED`를 씁니다. 자신의 물리 실행이 시작되었는지, 끝났는지도 보고합니다.
- 이 항목들은 드라이버나 매퍼로 보내지 않습니다.
- 오류 옵저버가 예외를 던져도 종료 오류 전달은 계속됩니다.
- 이렇게 만들어진 오류의 `stage`는 그 항목이 버려진 논리 단계를 나타냅니다. 배치를 멈춘 작업의 네이티브 실패 단계나 옵저버 실패 단계가 아닙니다.

스트림의 `stream:end`는 두 가지가 끝난 뒤에만 발생합니다. 어댑터가 드라이버 리소스를 닫거나, 비우거나, 취소해야 하고, 런타임이 물리 리스를 반환하거나 폐기해야 합니다. 옵저버는 정리 실패를 볼 수 있지만, 안전하지 않은 리스를 재사용 가능하게 만들 수는 없습니다.

등록된 옵저버는 모두 `stream:end`를 등록 순서대로 한 번씩 받습니다. 앞의 옵저버가 예외를 던져도 마찬가지입니다.

- 모든 옵저버에 전달한 뒤, 옵저버 실패가 하나면 그대로 다시 던집니다.
- 실패가 여러 개면 순서대로 모읍니다.
- 스트림이나 정리가 이미 실패했다면 그 원래 오류가 원인이자 첫 번째 항목으로 남고, 옵저버 실패가 뒤따릅니다.
- I/O 전의 알림은 계속 첫 실패에서 즉시 멈춥니다.

`event.literalizedSql(options?)`는 필요할 때만 만들어지고 캐시됩니다. 논리 세그먼트와 파라미터에서 진단용 텍스트를 직접 재구성합니다. 실제 요청 SQL의 플레이스홀더를 치환하는 방식이 아닙니다. 절대 실행 입력으로 쓰지 마세요.

- 기본값은 가림 처리입니다.
- 옵션으로 값 인라인 또는 가림, 값 최대 길이, 바이너리 요약 또는 전체 출력, 사용자 정의 가림 함수를 고를 수 있습니다.
- 결과는 `complete`, `redactedParameters`, `truncatedParameters`를 보고합니다.
- 지원하지 않는 사용자 정의 객체에는 안전한 표시를 씁니다. 실수로 `toString()`이 실행되는 것을 막기 위해서입니다.

MySQL과 MariaDB에서는 인라인 문자열에 실행할 수 없는 `[string <JSON>]` 진단 표시를 씁니다. 백슬래시 해석이 세션의 SQL 모드에 따라 달라지므로 SQL 리터럴을 쓰지 않습니다. Bun.SQL 어댑터도 마찬가지입니다. 바인딩 실행에는 영향이 없습니다. 진단 출력은 절대 실행 가능한 SQL이 아닙니다.

바인딩이나 타입 지정 요청 구성의 실패는 드라이버 I/O 없이 `"materialize"` 단계로 기록됩니다. 드라이버, 서버, 네트워크 실패는 `"driver"` 단계입니다. 옵저버는 관찰하거나 실패시킬 수만 있습니다. 문장, 바인딩 값, 결과, 재시도 정책, 경로를 고쳐 쓸 수 없습니다.

## OpenTelemetry

선택 사항인 [`@sqlbraid/opentelemetry`](https://www.npmjs.com/package/@sqlbraid/opentelemetry) 패키지를 설치하면 이 수명 주기 이벤트를 DB 클라이언트 span과 안정 지표 `db.client.operation.duration` 히스토그램으로 바꿀 수 있습니다. OpenTelemetry SDK, 프로바이더, 익스포터, 보관 정책은 애플리케이션이 맡습니다.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";

const db = createPgPoolDatabase(pool, {
  observers: [createOpenTelemetryObserver()],
});
```

쿼리 텍스트 보호, 트레이스 전용·지표 전용 모드, 느린 쿼리 조사, 드라이버 계측과의 공존은 [OpenTelemetry 연동 가이드](/SQLBraid/runtime/opentelemetry/)를 보세요.
