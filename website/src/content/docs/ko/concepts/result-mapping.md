---
title: Standard Schema 결과 매핑
description: SQLBraid를 특정 스키마 라이브러리에 결합하지 않고 행을 검증하고 변환합니다.
---

SQLBraid는 Standard Schema 프로토콜에 의존합니다. 특정 validator에 의존하지 않습니다. 스키마를 쿼리에 연결할 수 있습니다.

```ts
import * as v from "valibot";
import { sql } from "sqlbraid/postgres";

const EventSchema = v.object({
  id: v.pipe(v.string(), v.transform(Number)),
  payload: v.string(),
});

const events = sql.rows(EventSchema)`
  SELECT id, payload FROM events
`;
const rows = await db.all(events);
```

스키마 출력이 쿼리 행 타입이 됩니다. 매핑은 `all`, `one`, `maybeOne`, `batch`, 준비된 쿼리, 스트림, 트랜잭션 범위 작업에 똑같이 적용됩니다. 실행 수준 스키마는 추가로 적용됩니다.

```ts
await db.all(events, { schema: ExtraSchema });
```

정확한 데이터베이스 숫자는 string으로 도착합니다. 근사 IEEE 값은 number로 도착합니다.
애플리케이션 의미는 schema에서 선택하세요. 드라이버 프로필을 바꾸지 마세요.

```ts
const Account = v.object({
  id: v.pipe(v.string(), v.transform(BigInt)),
  amount: v.string(), // 또는 v.transform(value => new Decimal(value))
});
```

`Decimal`/Money 객체는 애플리케이션의 선택입니다. SQLBraid 의존성이 아닙니다.
parsed JSON number나 native temporal `Date`가 이미 잃은 정밀도는 schema가
복구할 수 없습니다.

- JSON 안의 숫자에는 lossless-text 프로필과 애플리케이션이 선택한 parser를
  사용하세요.
- fractional/offset temporal 정확도에는 테스트된 text 프로필이나 SQL 안의
  변환을 사용하세요.

루틴 선언은 각 채널을 독립적으로 매핑합니다.
`sql.call({ output, resultSets: [UserSchema, PaymentSchema] as const, returnValue })`는
다음과 같이 적용합니다.

- output schema → scalar 객체
- 각 tuple schema → 대응하는 result set의 행
- return schema → 실제 return/status 값

`returnValue` schema를 선언하면 성공한 `db.call()` 결과에는 그 schema의 출력
타입을 가진 필수 `returnValue` 속성이 있습니다. driver 채널이 없으면
`BRAID_CALL_RETURN_UNSUPPORTED`로 실패합니다. 선택한 target이
`routine.return-value`를 명시적으로 미지원으로 표시하면 같은 오류가 lease
획득 전에 발생합니다. bare 선언과 return schema가 없는 선언에서는 이 속성이
선택적입니다.

Cursor output은 scalar `output`에서 제거됩니다. 어댑터는 async 매핑이 시작되기
전에 리소스를 읽고 닫습니다. result-set 개수가 다르면
`BRAID_CALL_RESULT_SETS`입니다. `BRAID_CALL_MAP`은 실패한 루틴 매핑의 위치를
보고합니다.

파이프라인은 다음과 같습니다.

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError`는 `BRAID_RESULT_VALIDATION` 코드를 사용합니다. 단계(쿼리 또는 실행)와 행 인덱스를 보고합니다. 원시 행이나 바인드를 덤프하지 않습니다. 매핑은 한 행을 한 행으로 변환합니다. SQLBraid는 관계를 hydrate하지 않습니다. identity map을 유지하지 않습니다. 객체 그래프를 조립하지 않습니다.

입력 측은 1.0.0에서 의도적으로 더 작습니다.

- 일반 값 보간은 계속 드라이버가 바인드하는 값입니다. 범용 애플리케이션
  입력 codec 프레임워크는 아직 없습니다.
- 정확한 numeric bind fidelity는 별도의 driver capability입니다.
- 일반 `undefined` IN 값은 acquisition 전에 실패합니다. `null`은 SQL `NULL`입니다.
- 드라이버별 JSON, temporal, binary 규칙은 계속 드라이버의 책임입니다.
