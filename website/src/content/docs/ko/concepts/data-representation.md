---
title: 데이터 표현과 값 정확도
description: 드라이버 경계에서 데이터베이스 값의 의미를 유지합니다. 그 다음 Standard Schema로 애플리케이션 타입을 선택합니다.
---

SQLBraid는 선택한 드라이버/프로필이 실제로 전달할 수 있는 값을 유지합니다.
`sql.rows<T>`의 TypeScript 타입은 결과를 변환하지 않습니다. SQLBraid는 정확한
데이터베이스 값을 JavaScript `number`로 조용히 축소하지 않습니다.

## 값 파이프라인

```text
DB 타입과 표현식
  → 드라이버/프로필 raw 값
  → dialect TypePolicy 정규화
  → 일반(normalized) 행
  → query-bound Standard Schema (선택 사항)
  → 애플리케이션 값
```

`TypeMapping.numeric`은 서로 다른 세 가지 사실을 분리해 보여 줍니다.

```ts
interface NumericTypeContract {
  semantics: "exact-integer" | "exact-decimal" | "approximate-binary";
  representation: "string" | "number";
  fidelity: "lossless" | "guarded" | "lossy" | "unsupported";
  binaryPrecision?: 32 | 64;
}
```

- `semantics`는 데이터베이스 값 영역입니다.
- `representation`은 SQLBraid의 raw 애플리케이션 경계입니다.
- `fidelity`는 선택한 드라이버/프로필의 전송 상태입니다.

표현식에는 자체 결과 타입이 있습니다. 원본 열만 보고 추론하지 마세요. 집계,
cast, 산술식에는 그 표현식에 대한 metadata와 프로필 증거가 필요합니다.

## 표준 숫자 경계

이식 가능한 규칙은 다음과 같습니다.

```text
정확한 정수 또는 정확한 10진수 → string
IEEE-754 근사 이진수             → number
```

JavaScript 타입은 현재 값에 따라 바뀌지 않습니다. 정확한 `BIGINT`의 `42`도
`"42"`입니다. 큰 값일 때만 string이 되는 것이 아닙니다. 정수 별칭, `BIGINT`,
`DECIMAL`/`NUMERIC`, `MONEY` 계열, vendor 별칭은 드라이버가 정확하게 유지할 수
있을 때만 exact입니다. 정확한 타입이 손실이 있는 JavaScript `number`로
노출되면 그 상태는 `unsupported`(또는 명시적인 `guarded`)입니다. SQLBraid는
그 값을 string으로 바꾸어 exact라고 부르지 않습니다.

`decodeExactInteger`는 애플리케이션이 선택적으로 사용하는 helper입니다.

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(row.id, { min: 0n }); // 이 애플리케이션에서는 bigint
```

이 helper는 SQLBraid의 표준 행 타입을 바꾸지 않습니다. `decodeExactDecimal`은
정확한 10진 텍스트를 검증하고 string을 반환합니다. 애플리케이션이 선택한
Decimal, BigInt, Money, 도메인 변환은 행이 애플리케이션 경계에 도달한 뒤에만
사용하세요. 전역 `numericMode` 스위치는 없습니다.

## Standard Schema로 애플리케이션 타입 선택

도메인에서 정확한 값을 텍스트로 다뤄야 하면 텍스트로 유지하세요.

```ts
const Row = v.object({ id: v.string(), amount: v.string() });
```

BigInt 식별자를 사용하려면:

```ts
const Id = v.pipe(v.string(), v.transform(BigInt));
```

또는 애플리케이션 코드에서 임의 정밀도 10진 라이브러리를 선택하세요. 라이브러리는
예시일 뿐입니다. SQLBraid 의존성이 아닙니다.

```ts
import Decimal from "decimal.js";
const Amount = v.pipe(
  v.string(),
  v.transform((value) => new Decimal(value)),
);
```

드라이버가 이미 반올림한 숫자를 schema가 복구할 수는 없습니다.

## 근사 이진 값

`REAL`, `FLOAT`, `DOUBLE`, PostgreSQL `real`/`double precision`, Oracle
`BINARY_FLOAT`/`BINARY_DOUBLE`, SQL Server `real`/`float`은 근사 이진
영역입니다. SQLBraid는 검증된 binary32 또는 binary64 값을 `number`로
노출합니다. 이것은 정확한 10진수 보장이 아닙니다. 프로필은 DB가 `NaN`,
infinity, 음의 0을 정규화하는지 기록합니다. codegen 진단은 exact DB 타입의
손실/미지원 전송에 대해서만 맞습니다. 타입이 근사라는 이유만으로는 맞지 않습니다.

## 드라이버 프로필

이 절은 SQLBraid의 데이터 표현 규칙입니다. [지원 매트릭스](/SQLBraid/reference/support/)가
각 데이터베이스 및 런타임 revision의 증거 기준입니다. 드라이버 프로필은 결과
JavaScript 타입을 결정하는 완전한 드라이버 설정입니다. 나중에 붙이는 라벨이 아닙니다.

첫 번째 파티 프로필 helper는 runtime과 codegen이 같은 규칙을 사용하게 합니다.

```ts
const profile = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy: profile });
```

PostgreSQL은 `@sqlbraid/postgres`에서 `typePolicyForProfile`와
`representationProfiles`를 내보냅니다. mysql2와 MariaDB도 portable root에서
같은 형태를 제공합니다. 각 descriptor에는 안정적인 `id`, `json`, `temporal`,
`typePolicy`가 있습니다. 필요한 경우 정확한 `connectionOptions`도 있습니다.
기본값은 lossless text 프로필입니다. native/호환 프로필은 별도 descriptor입니다.
기본 정책의 다른 이름이 아닙니다.

현재 descriptor ID는 명시적입니다.

- PostgreSQL: `pg-lossless-text`, `pg-native`, `pg-json-native-temporal-text`,
  `pg-json-text-temporal-native`.
- mysql2: `mysql2-lossless-text`, `mysql2-native`, `mysql2-json-text`,
  `mysql2-date-text`.
- MariaDB: 이에 대응하는 `mariadb-lossless-text`, `mariadb-native`,
  `mariadb-json-text`, `mariadb-date-text`.

드라이버 경계에서 **raw**는 드라이버가 실제 반환한 값입니다. **canonical**은
`TypePolicy`를 적용한 SQLBraid 애플리케이션 값입니다. 둘은 서로 대체할 수
없습니다. 정확한 string ID와 DB가 생성한 ID는 정확한 DB 값입니다. canonical
decimal text를 사용합니다. `affectedRows`, `rowCount`, bulk input count는 운영
count입니다. safe-integer 검사를 하는 number로 남습니다.

| 대상                 | 정확도 우선 canonical 출력                                                                                                              | 호환 프로필 경계                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`    | exact numeric → `string`; JSON/temporal text → `string`; float → `number`                                                               | native JSON → `unknown`; native `date`/`timestamp`/`timestamptz` → `Date`; `time`/`timetz`는 `string`; `interval`은 `unknown`                                                    |
| MySQL / `mysql2`     | exact integer/`DECIMAL` → `string`; `jsonStrings`/`dateStrings` → `string`                                                              | native JSON/temporal은 별도 편의 프로필이며 exact 증거를 상속하지 않음                                                                                                           |
| MariaDB Connector    | exact integer/`DECIMAL` → `string`; `autoJsonMap:false`/`dateStrings:true` → `string`                                                   | native JSON/temporal은 별도 편의 프로필이며 exact 증거를 상속하지 않음                                                                                                           |
| Node SQLite / WASM   | INTEGER storage → `string`; REAL storage → `number`                                                                                     | native bigint는 transport 전용이며 D1은 safe-integer 범위 guarded                                                                                                                |
| Bun SQL 1.3.14       | PostgreSQL/MySQL/MariaDB `{ bigint: true }`; PostgreSQL decimal → `string`; SQLite `{ safeIntegers: true }`; MariaDB/SQLite JSON → text | integral `Number` row 거부; MySQL/MariaDB DECIMAL과 binary는 같은 모호한 byte carrier라 거부하며 `CAST(... AS CHAR)`/`HEX(...)`를 직접 작성; SQLite native decimal은 unsupported |
| Oracle Thin          | `NUMBER` 계열 → `string`; 근사 이진 → `number`                                                                                          | native JSON/temporal은 프로필별 편의 표현                                                                                                                                        |
| SQL Server / Tedious | 보존되는 exact integer → `string`; 근사 이진 → `number`                                                                                 | native DECIMAL/NUMERIC/MONEY exact 출력은 unsupported; SQL text cast 작성                                                                                                        |

SQLite 동적 타입 열은 runtime storage class를 따릅니다. 선언된 INTEGER
affinity를 따르지 않습니다. 배열, domain, range/multirange, composite, Oracle
object/collection, SQL Server `sql_variant`, vector, 기타 container는 scalar
보장을 상속하지 않습니다. 재귀 전송 테스트가 생기기 전까지 각각
`unclassified` 또는 `unsupported`입니다. JSON은 아래 절에서 따로 설명합니다.

## JSON: 파싱 편의성 또는 lossless text

파싱된 JavaScript JSON 객체는 편리합니다. 하지만 일반 `JSON.parse()`는 모든
JSON 숫자를 JavaScript `number`로 만듭니다. 따라서 `9223372036854775807`이나
고정밀 소수 같은 중첩 값에는 일반적인 lossless 보장이 없습니다.

프로필은 다음을 구분해야 합니다.

- **lossless text** — 직렬화된 JSON이 텍스트로 SQLBraid에 도달합니다. JS Number
  파싱이 없습니다. 애플리케이션이 `JSON.parse`, lossless parser, schema 중에서
  선택합니다.
- **parsed** — 드라이버가 object/value를 반환합니다. 중첩 숫자 정확도는
  보장되지 않습니다.

Parsed JSON이 항상 object는 아닙니다. root는 string, number, boolean, `null`,
array, object일 수 있습니다. 따라서 native 프로필은 `unknown`을 사용합니다.
드라이버별 root 선언과 codegen mapping이 더 많은 것을 증명할 때만 예외입니다.
schema는 애플리케이션 경계에서 값을 좁힐 수 있습니다. 이미 JavaScript
`number`로 변환된 숫자는 복구할 수 없습니다.

- PostgreSQL은 지원되는 경로에서 query-local raw-text 프로필을 사용합니다.
  기본 parsed 호환 경로는 명시적으로 parsed입니다.
- MySQL과 MariaDB text 프로필은 드라이버가 제공하는 `jsonStrings: true`를
  사용합니다 (MariaDB Connector는 `autoJsonMap: false`).
- SQLite/WASM/D1과 SQL Server는 문서화된 경로에서 text를 사용합니다.
- Oracle은 검증된 fetch handler나 SQL 안의 명시적 `JSON_SERIALIZE(...)`
  표현식을 사용할 수 있습니다.

SQLBraid는 전역 parser를 바꾸지 않습니다. 사용자 SQL을 다시 쓰지 않습니다.

이 보장은 DB 결과에서 시작합니다. MySQL native JSON 저장소는 드라이버가 읽기
전에 소수 토큰을 반올림하고 키와 공백을 정규화할 수 있습니다. 원본 JSON
숫자가 왕복 후에도 같아야 하면 text 열을 사용하세요.

```text
lossless JSON text → Standard Schema → 애플리케이션 선택 parser
parsed object      → Standard Schema → 편리하지만 자동 lossless 아님
```

## Temporal 값

JavaScript `Date`는 모든 SQL temporal 의미를 담지 못합니다. 다음 항목을 담을 수
없습니다.

- 날짜 전용 값과 로컬 시간 값의 의미
- 밀리초보다 작은 소수 정밀도
- offset이나 zone identity
- Date 범위 밖의 값

native `Date`는 편의 프로필입니다. 포괄적인 lossless 보장이 아닙니다.

드라이버/프로필이 유지할 수 있으면 raw 경계에서 temporal text를 사용하세요.
그 다음 Standard Schema로 `Date`, `Temporal.*`, Luxon, 애플리케이션 도메인
타입으로 변환하세요. Temporal 정책은 데이터베이스 타입별로 정합니다. 하나의
넓은 "Date" switch가 아닙니다.

- PostgreSQL native `date`, `timestamp`, `timestamptz`는 `Date`를 사용합니다.
- native `time`, `timetz`는 text로 남습니다.
- `interval`은 의도적으로 열어 둡니다.

정확도를 테스트할 때는 `2026-09-14 12:34:56.123456`처럼 소수부가 0이 아닌
fixture를 사용하세요. PostgreSQL `pg`, MySQL `dateStrings`, MariaDB
`dateStrings`, 사용자 SQL의 명시적 text 변환은 서로 다른 프로필입니다. SQLite
temporal 값은 애플리케이션과 저장소의 관례로 남습니다. Oracle과 SQL Server에서
native `Date`가 precision, offset, session-zone 의미를 잃으면 테스트된 text
format이나 명시적 `TO_CHAR`/`CONVERT` 표현식을 사용하세요.

## Bind, `null`, `undefined`

정확한 입력 정확도는 정확한 출력과 다른 capability입니다. 프로필이 이를
주장하면 decimal text나 정확한 정수 string을 문서화된 경로로 bind하세요. 그
다음 데이터베이스를 거쳐 왕복시키세요. 정밀한 값을 먼저 JavaScript `number`로
보내지 마세요. SQLBraid는 cast를 대신 넣지 않습니다.

```sql
CAST(@nvarchar_parameter AS decimal(38, 18))
```

이것은 SQL에 직접 작성하는 SQL Server 우회 경로입니다. 범용 input codec이
아닙니다. Oracle string-to-number bind는 NLS 설정에 의존할 수 있습니다. 명시적
제어 변환을 사용하거나 그 경로를 unsupported로 분류하세요.

`null`은 SQL `NULL`입니다. 일반 `undefined`는 프로그래밍/설정 오류
(`BRAID_BIND_VALUE_UNSUPPORTED`)입니다. execute, prepared, bulk, stream,
routine IN 경로에서 connection 획득 전에 거부됩니다. OUT placeholder 의미는
드라이버별로 다릅니다.

## Container는 별도의 증거 경계

Scalar fidelity는 container를 재귀적으로 인증하지 않습니다. 다음 값은 각각
별도의 transport와 codegen 증거가 필요합니다.

- PostgreSQL array, domain, range/multirange, composite
- Oracle object/collection
- SQL Server `sql_variant`
- vector
- parsed JSON root

그 증거가 생기기 전에는 값을 `unknown`, `unclassified`, `unsupported`로
분류하세요. scalar mapping을 상속하지 마세요. PostgreSQL lossless array 출력은
raw text로 남을 수 있습니다. native array 파싱은 중첩 값이 재귀적으로 정확하다는
약속이 아닙니다. "supported container" 상태는 테스트한 container 경로가
동작한다는 뜻입니다. 모든 중첩 member가 재귀적으로 보장된다는 뜻이 아닙니다.

## 프로필, codegen, 투명성

custom `pg` parser, mysql2 `typeCast`, MariaDB JSON/temporal option, Oracle
fetch handler 같은 override는 별도 프로필입니다. runtime과 codegen 모두에서
테스트하고 선택하기 전까지 기본 증거를 무효로 만듭니다.

- codegen은 선택한 profile descriptor와 그 TypePolicy를 사용해야 합니다.
  수동으로 만든 "맞아 보이는" mapping은 증거가 아닙니다.
- `db.environment()`는 scope의 캐시된 관측값을 반환합니다. 세션 설정을 바꾼
  뒤에는 `db.environment({ refresh: true })`를 사용하세요.
- 풀 probe는 lease 하나를 관측합니다. 관측된 보장은 guarded로 남습니다.
  이후 모든 풀 세션에 대한 약속이 아닙니다.
- codegen은 output 표현과 input 표현을 따로 생성합니다. 수동 TypeScript
  override는 손실 전송을 exact로 만들 수 없습니다.

SQLBraid는 사용자가 작성한 SQL을 자동 cast, parser rewrite, query-builder
translation 없이 보냅니다. native `RETURNING`, `OUTPUT`, `MERGE`, UPSERT,
`CAST`, `CONVERT`, `JSON_SERIALIZE`, temporal formatting은 SQL에 그대로
보입니다. 지원 capability는 실제로 실행된 문장의 이름을 사용합니다.

- `merge-returning`은 native `MERGE`입니다.
- `upsert-returning`은 native UPSERT/REPLACE/ON CONFLICT/ON DUPLICATE KEY입니다.

결과가 비슷해도 문법을 서로 바꿔 쓸 수 있다는 뜻은 아닙니다.

revision별 증거는 드라이버 설정 페이지와 [런타임 및 드라이버 지원
매트릭스](/SQLBraid/reference/support/)를 참고하세요. 알 수 없는 증거는
`unknown`으로 남습니다. TypeScript assertion이나 초록색으로 보이는 매트릭스
셀이 그것을 `lossless`로 승격하지 않습니다.
