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
          execution: event.execution,
          sql: event.sql,
          sqlWithLiterals: event.literalizedSql({ values: "redacted" }).text,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

이벤트에는 `query:ready`, `query:result`, `query:mapped`, `query:error`, `stream:start`, `stream:end`, `transaction`이 있습니다. `query:ready`는 렌더링과 순수한 바인딩 설명이 끝났지만 lease를 얻기 전 발생합니다. 다음 불변 실행 계획을 포함합니다.

```ts
const {
  adapterId,
  dialectId,
  transport, // native-value-template | text-positional | text-named | typed-request
  reuse: { requested, effective, owner, capacity },
} = event.execution;
```

이벤트에는 파생된 읽기 전용 값·힌트·보간 맵, 선언/실제 결과 종류, 작업 ID,
소요 시간(`durationMs`), 행/command 메타데이터, 매핑 완료 여부,
stream 상태, 트랜잭션/savepoint 단계도 유지됩니다. call의 `query:result`는
`actualKind: "call"`, `resultSetCount`, 전체 `rowCount`, `outputKeys`,
`hasReturnValue`를 보고합니다. output 값, cursor portal 이름, ResultSet 객체,
protocol carrier 행은 기본적으로 기록하지 않습니다.
`event.sql`은 파생된 parameterized view이며 native-value-template 전송에서는
없을 수 있습니다.

Observer는 등록 순서대로 순차 실행됩니다. 이벤트를 검사하거나 throw하여 작업을 거부할 수 있지만 SQL, 바인드, 결과를 변경하거나 retry, routing, rewriting을 구현할 수는 없습니다. DB 실행 전에 실패하면 실행이 방지됩니다. 실행 후 실패는 루트 부작용을 되돌릴 수 없지만 `db.tx` 내부로 전파되면 일반 rollback이 적용됩니다. 오류 observer도 실패하면 `AggregateError`가 두 실패를 모두 보존합니다.

SQLBraid는 기본적으로 바인드 값을 기록하지 않습니다. 정제 및 보존 정책은 애플리케이션이 소유합니다.

stream의 `stream:end`는 어댑터가 드라이버 리소스를 close/drain/cancel하고
runtime이 물리적 lease를 반환하거나 폐기한 뒤에만 발생합니다. Observer는
정리 실패를 관찰할 수 있지만 안전하지 않은 lease를 재사용 가능하게 만들 수
없습니다.

`event.literalizedSql(options?)`는 필요할 때 계산하고 캐시합니다. 논리
segments와 parameters에서 진단용 텍스트를 직접 재구성하며, 구체화된 SQL의
placeholder를 치환하지 않고 실행 입력으로도 사용할 수 없습니다. 기본은
redacted이며 inline/redacted 값, 최대 길이, binary summary/full, 사용자
redactor를 지원합니다. 결과는 `complete`, `redactedParameters`,
`truncatedParameters`를 보고합니다. 지원하지 않는 객체는 실수로
`toString()`을 호출하지 않고 안전한 marker로 표시합니다.

바인딩 또는 typed-request 구성 실패는 DB I/O 없이 `"materialize"` 단계로
보고합니다. 드라이버·서버·네트워크 실패는 `"driver"` 단계입니다. Observer는
계속 observe/fail 전용이며 statement, 바인드, 결과, retry, routing을 변경하지
못합니다.
