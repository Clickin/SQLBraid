---
title: 실행 observer
description: SQLBraid 수명 주기 이벤트를 관찰합니다. 런타임은 logger에 의존하지 않습니다.
---

직접 또는 풀 팩토리에 observer를 구성하세요.

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

이벤트는 `query:ready`, `query:result`, `query:mapped`, `query:error`, `bulk:ready`, `bulk:result`, `stream:start`, `stream:end`, `transaction`입니다. `query:ready`는 렌더링과 순수한 바인딩 설명 후, lease 획득 전에 발생합니다. 불변 실행 계획을 포함합니다.

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

이벤트에는 다음 항목도 있습니다: 파생된 읽기 전용 값, 힌트, 보간 맵, 선언/실제
결과 종류, 작업 ID, 소요 시간(`durationMs`), 행/command 메타데이터, 매핑 완료
여부, stream 상태, 트랜잭션/savepoint 단계.

call의 `query:result`는 `actualKind: "call"`, `resultSetCount`, 전체
`rowCount`, `outputKeys`, `hasReturnValue`를 보고합니다. 기본적으로 output 값,
cursor portal 이름, ResultSet 객체, protocol carrier 행을 기록하지 않습니다.
`event.sql`은 파생된 parameterized view입니다. native-value-template 전송에서는
없을 수 있습니다.

Observer는 등록 순서대로 하나씩 실행됩니다. 이벤트를 검사하거나, throw해서
작업을 거부할 수 있습니다.

- observer에서 SQL, 바인드, 결과를 바꾸지 마세요. observer 규칙 위반입니다.
- API는 retry, routing, rewriting을 제공하지 않습니다.
- DB 실행 전에 실패하면 실행이 막힙니다.
- 실행 후 실패는 루트 부작용을 되돌릴 수 없습니다. `db.tx` 안으로 전파되면
  일반 rollback이 적용됩니다.
- 오류 observer도 실패하면 `AggregateError`가 두 실패를 모두 유지합니다.

이벤트 컨테이너는 구조적으로 읽기 전용입니다. SQLBraid는 `Uint8Array` 같은
임의의 application/driver 값을 deep-copy하지 않습니다. observer는 참조된 값을
변경하면 안 됩니다. 이것은 API 경계입니다. security sandbox나 deep
immutability 보장이 아닙니다.

SQLBraid는 기본적으로 바인드 값을 기록하지 않습니다. 정제 및 보존 정책은 애플리케이션이 소유합니다.

`db.batch()`에서 `query:ready`를 발생시킨 모든 item은 정확히 하나의 terminal
`query:mapped` 또는 `query:error`를 받습니다. preflight, lease 획득, driver,
release, observer 실패 뒤에 버려진 item도 포함됩니다.

- 버려진 sibling은 기존 error payload에서 `BRAID_BATCH_ABORTED`를 사용합니다.
  자신의 physical 실행이 시작되고 완료되었는지 보고합니다.
- driver나 mapper로 보내지 않습니다.
- error observer가 throw해도 terminal error 전달은 계속됩니다.
- 이 synthetic sibling error의 `stage`는 그 sibling이 버려진 logical phase를
  가리킵니다. batch를 멈춘 작업의 native 또는 observer 실패 stage가 아닙니다.

stream의 `stream:end`는 두 조건 뒤에만 발생합니다: 어댑터가 드라이버 리소스를
close/drain/cancel했고, runtime이 물리적 lease를 반환하거나 폐기했습니다.
Observer는 정리 실패를 볼 수 있습니다. 안전하지 않은 lease를 재사용 가능하게
만들 수 없습니다.

등록된 모든 observer는 등록 순서대로 `stream:end`를 한 번씩 받습니다. 앞선
observer가 throw해도 마찬가지입니다.

- 전달이 끝난 뒤 observer 실패가 하나면 그 오류를 변경 없이 다시 throw합니다.
- 실패가 여러 개면 순서대로 집계합니다.
- Stream이나 cleanup이 이미 실패했다면 원래 오류가 cause이자 aggregate의 첫
  항목으로 남습니다. observer 실패가 그 뒤에 옵니다.
- I/O 전 알림은 계속 fail-fast입니다.

`event.literalizedSql(options?)`는 필요할 때 계산되고 캐시됩니다. 논리
segments와 parameters에서 진단용 텍스트를 직접 재구성합니다. 구체화된 SQL의
placeholder를 치환하지 않습니다. 실행 입력으로 사용하지 마세요.

- 기본은 redacted입니다.
- option은 inline/redacted 값, 최대 값 길이, binary summary/full 출력, 사용자
  redactor를 지원합니다.
- 결과는 `complete`, `redactedParameters`, `truncatedParameters`를 보고합니다.
- 지원하지 않는 사용자 객체는 안전한 marker를 받습니다. 실수로 `toString()`이
  실행되는 것을 막습니다.

MySQL/MariaDB의 inline string은 실행 불가능한 `[string <JSON>]` 진단 marker를
사용합니다. SQL literal을 사용하지 않습니다. backslash 해석이 session의 SQL
mode에 따라 달라지기 때문입니다. Bun.SQL adapter에도 같은 규칙이 적용됩니다.
bound execution은 바뀌지 않습니다. 진단 출력은 실행 가능한 SQL이 아닙니다.

바인딩이나 typed-request 구성 실패는 DB I/O 없이 `"materialize"` 단계를
가집니다. 드라이버·서버·네트워크 실패는 `"driver"` 단계를 유지합니다.
Observer는 observe 또는 fail만 할 수 있습니다. statement, 바인드, 결과, retry,
routing을 바꿀 수 없습니다.

## OpenTelemetry

선택적
[`@sqlbraid/opentelemetry`](https://www.npmjs.com/package/@sqlbraid/opentelemetry)

패키지를 설치하면 이 lifecycle event를 DB client span과 안정화된
`db.client.operation.duration` histogram으로 바꿀 수 있습니다. OpenTelemetry
SDK, provider, exporter, 보존 정책은 애플리케이션이 소유합니다.

```ts
import { createOpenTelemetryObserver } from "@sqlbraid/opentelemetry";

const db = createPgPoolDatabase(pool, {
  observers: [createOpenTelemetryObserver()],
});
```

query text privacy, traces-only/metrics-only 모드, slow-query 조사, driver
instrumentation 공존 방식은
[OpenTelemetry 통합 가이드](/SQLBraid/runtime/opentelemetry/)를 참고하세요.
