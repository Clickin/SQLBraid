# Standard Schema 결과 매핑

> SQLBraid를 특정 스키마 라이브러리에 결합하지 않고 행을 검증하고 변환합니다.

SQLBraid는 특정 validator가 아니라 Standard Schema 프로토콜에 의존합니다. 스키마를 쿼리에 연결할 수 있습니다.

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

스키마 출력이 쿼리 행 타입이 됩니다. 매핑은 `all`, `one`, `maybeOne`, `batch`, 준비된 쿼리, 스트림, 트랜잭션 범위 작업에 일관되게 적용됩니다. 실행 수준 스키마를 추가할 수도 있습니다.

```ts
await db.all(events, { schema: ExtraSchema });
```

정확한 데이터베이스 숫자는 string으로, 근사 IEEE 값은 number로 도착합니다.
드라이버 프로필을 바꾸지 말고 schema에서 애플리케이션 의미를 선택하세요.

```ts
const Account = v.object({
  id: v.pipe(v.string(), v.transform(BigInt)),
  amount: v.string(), // 또는 v.transform(value => new Decimal(value))
});
```

`Decimal`/Money 객체는 애플리케이션 선택이며 SQLBraid 의존성이 아닙니다.
이미 parsed JSON number나 native temporal `Date`에서 잃은 정밀도를 schema가
복구할 수는 없습니다. JSON 중첩 숫자에는 lossless-text 프로필과 애플리케이션
선택 parser를 사용하고, fractional/offset temporal 정확도에는 테스트된 text
프로필이나 사용자가 작성한 SQL 변환을 사용하세요.

루틴 계약은 각 채널을 독립적으로 매핑합니다. `sql.call({ output,
resultSets: [UserSchema, PaymentSchema] as const, returnValue })`는 scalar
객체에 output schema를, 각 tuple schema를 대응하는 result set의 행에,
return schema를 실제 return/status 값에 적용합니다. `returnValue` schema를
선언하면 성공한 `db.call()` 결과의 `returnValue`는 해당 schema의 출력 타입인
필수 속성입니다. driver 채널이 없으면 `BRAID_CALL_RETURN_UNSUPPORTED`로
실패합니다. bare 및 return schema가 없는 계약은 선택적 속성을 유지합니다. Cursor output은 scalar
`output`에서 제거되며 어댑터는 async 매핑 전에 리소스를 소비하고 닫습니다.
result-set 개수가 다르면 `BRAID_CALL_RESULT_SETS`, 특정 루틴 위치의 매핑
실패는 `BRAID_CALL_MAP`으로 보고됩니다.

파이프라인은 다음과 같습니다.

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError`는 `BRAID_RESULT_VALIDATION` 코드를 사용하고 쿼리 또는 실행 단계를 행 인덱스와 함께 보고하며 원시 행이나 바인드를 덤프하지 않습니다. 매핑은 한 행을 한 행으로 변환합니다. SQLBraid는 관계를 hydrate하거나 identity map을 유지하거나 객체 그래프를 조립하지 않습니다.

입력 측은 0.1.0에서 의도적으로 더 작습니다. 일반 값 보간은 계속 드라이버
바인드 값이며, 아직 범용 애플리케이션 입력 codec 프레임워크는 없습니다.
정확한 numeric bind fidelity는 별도 driver capability이고, 일반 `undefined`
IN 값은 acquisition 전에 실패하며 `null`은 SQL `NULL`입니다. 드라이버별
JSON, temporal, binary 규칙은 계속 드라이버의 책임입니다.
