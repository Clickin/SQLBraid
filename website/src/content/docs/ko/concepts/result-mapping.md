---
title: Standard Schema 결과 매핑
description: SQLBraid를 특정 스키마 라이브러리에 결합하지 않고 행을 검증하고 변환합니다.
---

SQLBraid는 특정 validator가 아니라 Standard Schema 프로토콜에 의존합니다. 스키마를 쿼리에 연결할 수 있습니다.

```ts
import * as v from "valibot";
import { sql } from "@sqlbraid/postgres";

const EventSchema = v.object({
  id: v.number(),
  payload: v.string(),
});

const events = sql.rows(EventSchema)`
  SELECT id, payload FROM events
`;
const rows = await db.all(events);
```

스키마 출력이 쿼리 행 타입이 됩니다. 매핑은 `all`, `one`, `maybeOne`, `batch`, 준비된 쿼리, 스트림, 트랜잭션 범위 작업에 일관되게 적용됩니다. 실행 수준 스키마를 추가할 수도 있습니다.

```ts
await db.all(events, { schema: ExtraSchema });
```

파이프라인은 다음과 같습니다.

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError`는 `BRAID_RESULT_VALIDATION` 코드를 사용하고 쿼리 또는 실행 단계를 행 인덱스와 함께 보고하며 원시 행이나 바인드를 덤프하지 않습니다. 매핑은 한 행을 한 행으로 변환합니다. SQLBraid는 관계를 hydrate하거나 identity map을 유지하거나 객체 그래프를 조립하지 않습니다.

입력 측은 0.1.0에서 의도적으로 더 작습니다. 일반 값 보간은 계속 드라이버 바인드 값이며, 아직 범용 애플리케이션 입력 codec 프레임워크는 없습니다. 드라이버별 JSON, temporal, binary 규칙은 계속 드라이버의 책임입니다.
