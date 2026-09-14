---
title: 데이터 표현과 숫자 정확도
description: 정밀도를 잃지 않고 데이터베이스 값이 드라이버 경계에서 타입이 있는 애플리케이션 값으로 가는 과정을 이해합니다.
---

SQLBraid는 데이터베이스 표현 방식을 명시적으로 유지합니다. `sql.rows<T>`의
TypeScript 타입은 드라이버가 반환하는 값을 바꾸지 않으며, SQLBraid는 10진수나
64비트 정수를 JavaScript `number`로 조용히 변환하지 않습니다.

## 값의 파이프라인

매핑되는 모든 행은 다음 경계를 통과합니다.

```text
DB 타입
  → 드라이버 raw 값
  → dialect TypePolicy / Numeric Fidelity
  → 일반(normalized) 행
  → Standard Schema (선택 사항)
  → 애플리케이션 값
```

드라이버 프로필이 raw 값을 결정합니다. dialect의 `TypePolicy`는 정수, 10진수,
JSON, temporal, binary 규칙을 런타임과 코드 생성에 노출합니다. 그 다음
Standard Schema는 한 행을 검증하거나 변환할 수 있지만, 정밀도를 보존하는
드라이버 프로필을 대신하지는 않습니다.

```ts
interface AccountRow {
  id: bigint;
  balance: string;
}

const accounts = sql.rows<AccountRow>`
  SELECT id, balance FROM account
`;
```

`sql.rows<AccountRow>`는 컴파일 타임 선언일 뿐입니다. 결과를 검증하거나
파싱하거나 변환하지 않습니다. `sql.rows(AccountSchema)`는 런타임에
Standard Schema 프로토콜을 호출해 각 행을 검증하고 변환할 수 있습니다.

```ts
const accounts = sql.rows(AccountSchema)`
  SELECT id, balance FROM account
`;
```

선언과 런타임 mapper는 선택한 드라이버 프로필과 일치해야 합니다. 드라이버가
이미 잃은 숫자를 타입 assertion으로 복구할 수는 없습니다.

## 정확한 정수

JavaScript `number`는 모든 signed 64비트 정수를 표현할 수 없습니다. 정수를
`bigint` 또는 10진 텍스트로 반환하는 드라이버 프로필을 사용한 뒤 애플리케이션
표현을 선택하세요. SQLBraid의 정확한 정수 헬퍼는 정수 형태의 드라이버 값을
받아 `bigint`를 반환합니다.

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(rawId, { min: 0n });
```

선택 사항인 `min`, `max` 범위는 `bigint`로 검사합니다. 유효하지 않거나
범위를 벗어난 값은 `ResultExactnessError`를 발생시키며 코드는
`BRAID_RESULT_EXACTNESS`입니다. 값이 안전한 정수 범위에 있다는 것을 먼저
증명하지 않았다면 `Number(id)`를 사용하지 마세요.

SQLite는 하나의 규칙으로 통합할 수 없는 명시적 예외입니다. Node adapter의
`integerMode` 기본값은 `"number"`이고 정확한 int64 결과가 필요할 때
`"bigint"`로 설정합니다. 생성 모델에는 대응하는
`typePolicyForIntegerMode()`를 사용해야 합니다.

## 정확한 10진수

10진수는 부동소수점 숫자가 아닙니다. SQLBraid의 정확한 10진수 헬퍼는
보수적으로 canonical 10진 문자열을 반환하며, 기본 API는 문자열만 받습니다.

```ts
import { decodeExactDecimal } from "@sqlbraid/core";

const amount = decodeExactDecimal(rawAmount);
// amount: string
```

JavaScript `number`는 이 헬퍼에 도달하기 전에 이미 10진수를 반올림할 수
있으므로 정확한 값으로 제시하지 않고 거부합니다. `ResultExactnessError`의
코드는 `BRAID_RESULT_EXACTNESS`입니다. 문자열을 애플리케이션에 보관하거나
애플리케이션 경계에서 선택한 임의 정밀도 10진 라이브러리로 넘기세요.
SQLBraid는 10진 라이브러리를 추가하거나 반올림/scale 정책을 정하지 않습니다.

Oracle Thin의 `NUMBER` 결과는 문자열입니다. SQL Server Tedious의
`decimal`과 `numeric` 결과는 지원되는 기본 경로에서 JavaScript number이며,
따라서 **정확한 10진수 지원이 아닙니다**. Tedious에서 정밀도가 필요하면
SQL에서 명시적으로 텍스트로 변환하고 문자열 결과 계약을 선언하세요.
MySQL의 정확도는 테스트된 mysql2 프로필에 달려 있으며, 정확한 10진수
프로필에서는 `decimalNumbers`를 켜지 마세요.

## 근사 부동소수점

`REAL`, `FLOAT`, `BINARY_FLOAT`, `BINARY_DOUBLE`은 설계상 근사값입니다.
근사 연산이 목적이면 number로 유지하세요. 부동소수점 열에 정확한 정수나
정확한 10진수 선언을 재사용하지 마세요.

## JSON

JSON은 native object, 텍스트 문자열 또는 드라이버별 값으로 도착할 수
있습니다. 어떤 값을 기대하는지는 프로필에 기록해야 합니다.

- native JSON object는 Standard Schema object schema에 바로 전달할 수 있습니다.
- JSON 텍스트는 schema(`parseJson` 또는 동등한 transform)에서 파싱하고
  검증해야 합니다.
- 잘못된 JSON은 데이터/드라이버 오류이며 다른 표현을 지원한다는 증거가
  아닙니다.

`jsonStrings`와 custom parser/type-cast 옵션은 프로필 선택입니다. 이를
바꾸면서 TypePolicy와 schema 계약을 바꾸지 않으면 지원되지 않습니다.

## Temporal, binary, NULL 값

Temporal 값은 드라이버별입니다(`Date` 또는 명시적인 text/binary 프로필).
JavaScript `Date`는 원본 timezone 이름이나 sub-millisecond 세부 정보를 모두
보존하지 않습니다. 이 정보가 중요하면 문자열 계약을 사용하세요.

Binary 값은 Node adapter에서 보통 `Buffer`/`Uint8Array`입니다. 명시적인
encoding transform이 애플리케이션 계약에 포함되지 않는 한 binary 열을
text/JSON schema에 넣지 마세요.

`NULL`은 0, 빈 문자열, epoch, 빈 객체가 아닙니다. 결과 계약에서는 `null`로
보존하고, nullable 열에는 nullable Standard Schema를 사용하세요.

## Custom parser와 프로필

custom `pg` parser, mysql2 `typeCast`, Oracle fetch option 또는 동등한 설정은
raw-value 경계를 바꿉니다. 정확한 설정에 별도 증거가 없는 한 기본 표현
프로필은 무효가 됩니다. 안전한 순서는 다음과 같습니다.

1. 정확한 database, driver, runtime, parser/options를 기록합니다.
2. 영향을 받는 각 타입의 raw 값을 확인합니다.
3. 일치하는 TypePolicy를 선택하거나 정의합니다.
4. Standard Schema로 검증/변환합니다.
5. code generation에서도 같은 프로필을 사용합니다.

SQLBraid는 임의 parser 함수를 검사해 정확도를 추론하지 않습니다. 정확한
전송을 증명할 수 없는 프로필은 `guarded` 또는 `unsupported`이며, 조용히
exact가 되지 않습니다.

## Codegen과 런타임 검증

Codegen은 metadata와 선택한 TypePolicy에서 TypeScript 선언을 생성합니다.
실제 행을 검증하지는 않습니다. 런타임 검증에는
`sql.rows(StandardSchema)` 또는 실행 수준 schema가 필요합니다.

```ts
const row = sql.rows(AccountSchema)`SELECT id, balance FROM account`;
await db.one(row); // 실행 시 검증/변환
```

생성 모델에서는 output과 input 표현을 분리하세요. 수동 TypeScript override는
선언만 바꾸며 lossy한 드라이버 전송을 exact하게 만들지 않습니다.

## Native SQL 투명성은 grammar 지원이 아닙니다

SQLBraid는 사용자가 작성한 SQL의 데이터베이스별 문법을 다시 쓰지 않고
선택한 드라이버로 전달합니다. native `RETURNING`, `OUTPUT`, cast, function,
extension을 쿼리에 그대로 둘 수 있습니다. 이를 전달할 수 있다는 것은
투명성의 증거이지 SQLBraid가 모든 grammar 기능을 파싱하거나 의미론적으로
지원한다는 뜻이 아닙니다. 생성 structural helper에는 별도의 좁은 quoting과
shape 계약이 있으며, 지원하지 않는 분석은 unknown으로 남습니다.

정확한 프로필/options는 드라이버 설정 페이지와 [런타임 및 드라이버 지원
매트릭스](/SQLBraid/reference/support/)를 참고하세요.