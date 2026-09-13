---
title: 실행 observer
description: 런타임을 logger에 결합하지 않고 SQLBraid 수명 주기 이벤트를 관찰합니다.
---

직접 또는 풀 팩토리에 observer를 구성하세요.

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    onEvent(event) {
      if (event.type === "query:ready") {
        logger.debug({
          sql: event.sql,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

이벤트에는 `query:ready`, `query:result`, `query:mapped`, `query:error`, `stream:start`, `stream:end`, `transaction`이 있습니다. 이벤트는 선언/실제 결과 종류, 작업 ID, SQL, 읽기 전용 바인드 메타데이터, 소요 시간(`durationMs`), 행/command 메타데이터, 매핑 완료 여부, stream 상태, 트랜잭션/savepoint 단계를 포함합니다.

Observer는 등록 순서대로 순차 실행됩니다. 이벤트를 검사하거나 throw하여 작업을 거부할 수 있지만 SQL, 바인드, 결과를 변경하거나 retry, routing, rewriting을 구현할 수는 없습니다. DB 실행 전에 실패하면 실행이 방지됩니다. 실행 후 실패는 루트 부작용을 되돌릴 수 없지만 `db.tx` 내부로 전파되면 일반 rollback이 적용됩니다. 오류 observer도 실패하면 `AggregateError`가 두 실패를 모두 보존합니다.

SQLBraid는 기본적으로 바인드 값을 기록하지 않습니다. 정제 및 보존 정책은 애플리케이션이 소유합니다.
