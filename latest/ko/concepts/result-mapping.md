# Standard Schema 결과 매핑

> 특정 스키마 라이브러리에 묶이지 않고 행을 검증하고 변환합니다.

SQLBraid는 특정 검증 라이브러리가 아니라 Standard Schema 프로토콜에 의존합니다. 쿼리에 스키마를 연결할 수 있습니다.

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

스키마의 출력 타입이 쿼리의 행 타입이 됩니다. 매핑은 `all`, `one`, `maybeOne`, `batch`, 준비된 쿼리, 스트림, 트랜잭션 범위 안의 작업에 똑같이 적용됩니다. 실행 단계에서 지정한 스키마는 그 위에 추가로 적용됩니다.

```ts
await db.all(events, { schema: ExtraSchema });
```

정확한 데이터베이스 숫자는 문자열로, 근사 IEEE 값은 숫자로 도착합니다. 애플리케이션에서 쓸 의미는 드라이버 프로필을 바꾸지 말고 스키마에서 고르세요.

```ts
const Account = v.object({
  id: v.pipe(
    v.string(),
    v.transform((value) => BigInt(value)),
  ),
  amount: v.string(), // or v.transform(value => new Decimal(value))
});
```

`Decimal`과 Money 객체는 애플리케이션이 고르는 것이며 SQLBraid의 의존성이 아닙니다. 파싱된 JSON 숫자나 네이티브 날짜·시간 `Date`가 이미 잃어버린 정밀도는 스키마로 되살릴 수 없습니다.

- JSON 안에 중첩된 숫자에는 무손실 텍스트 프로필과 애플리케이션이 고른 파서를 쓰세요.
- 소수 초나 오프셋까지 정확해야 하는 날짜·시간에는 검증된 텍스트 프로필이나 SQL 안의 변환을 쓰세요.

루틴 선언은 채널마다 따로 매핑합니다. `sql.call({ output, resultSets: [UserSchema, PaymentSchema] as const, returnValue })`는 다음과 같이 적용됩니다.

- 출력 스키마는 스칼라 객체에 적용됩니다.
- 튜플의 각 스키마는 같은 위치의 결과 집합 행에 적용됩니다.
- 반환 스키마는 실제 반환 값이나 상태 값에 적용됩니다.

`returnValue` 스키마를 선언하면, 성공한 `db.call()` 결과에는 그 스키마의 출력 타입을 가진 `returnValue` 속성이 반드시 있습니다. 드라이버에 반환 채널이 없으면 호출은 `BRAID_CALL_RETURN_UNSUPPORTED`로 실패합니다. 선택한 대상이 `routine.return-value`를 명시적으로 미지원으로 표시하면, 같은 오류가 리스를 획득하기 전에 발생합니다. 선언 없이 쓰거나 반환 스키마 없이 선언하면 이 속성은 선택 사항으로 남습니다.

커서 출력은 스칼라 `output`에서 빠집니다. 어댑터는 비동기 매핑이 시작되기 전에 리소스를 읽고 닫습니다. 결과 집합 개수가 맞지 않으면 `BRAID_CALL_RESULT_SETS`입니다. 루틴 매핑이 실패하면 `BRAID_CALL_MAP`이 실패 위치를 알려 줍니다.

전체 흐름은 다음과 같습니다.

```text
driver row -> dialect TypePolicy normalization -> plain row -> query schema -> execution schema -> application model
```

`DatabaseResultValidationError`는 `BRAID_RESULT_VALIDATION` 코드를 씁니다. 실패한 단계(쿼리 또는 실행)와 행 번호를 알려 줍니다. 메시지에는 원시 행이나 바인딩 값이 들어가지 않습니다. `issues` 속성에는 스키마 라이브러리가 만든 issue가 그대로 들어 있습니다. 일부 라이브러리는 각 issue에 입력 값을 넣습니다. 행에 개인 정보가 있을 수 있으면 `issues`나 오류 객체 전체를 가리지 않고 로그에 남기지 마세요. 매핑은 행 하나를 행 하나로 바꿉니다. SQLBraid는 관계를 채우거나, 식별자 맵을 유지하거나, 객체 그래프를 조립하지 않습니다.

1.0.0에서 입력 쪽 기능은 일부러 작게 두었습니다.

- 일반 값 보간은 드라이버가 바인딩하는 값입니다. 애플리케이션용 범용 입력 코덱 프레임워크는 아직 없습니다.
- 정확한 숫자 바인딩의 정확도는 드라이버별 기능입니다.
- 일반 IN 값이 `undefined`이면 리스를 획득하기 전에 실패합니다. `null`은 SQL `NULL`입니다.
- JSON, 날짜·시간, 바이너리 값의 관례는 계속 드라이버가 책임집니다.
