---
title: 데이터 표현과 값 정확도
description: 드라이버 경계에서 데이터베이스 값 의미를 보존하고 Standard Schema로 애플리케이션 타입을 선택합니다.
---

SQLBraid는 선택한 드라이버/프로필이 실제로 전달할 수 있는 값을 보존합니다.
`sql.rows<T>`의 TypeScript 타입은 결과를 변환하지 않으며 SQLBraid는 정확한
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

`semantics`는 데이터베이스 값 영역이고, `representation`은 SQLBraid의 raw
애플리케이션 경계이며, `fidelity`는 선택한 드라이버/프로필의 전송 상태입니다.
표현식에는 자체 결과 타입이 있으므로 원본 열만 보고 추론하지 마세요. 집계,
cast, 산술식은 그 표현식에 대한 metadata와 프로필 증거가 필요합니다.

## 표준 숫자 경계

이식 가능한 규칙은 간단합니다.

```text
정확한 정수 또는 정확한 10진수 → string
IEEE-754 근사 이진수             → number
```

현재 값에 따라 JavaScript 타입을 바꾸지 않습니다. 정확한 `BIGINT`의 `42`도
`"42"`이며, 큰 값일 때만 string이 되지 않습니다. 정수 별칭, `BIGINT`,
`DECIMAL`/`NUMERIC`, `MONEY` 계열 및 vendor 별칭은 드라이버가 보존할 수 있을
때만 exact입니다. 정확한 타입을 손실이 있는 JavaScript `number`로 받은 경로는
string으로 다시 바꾼 exact 결과가 아니라 `unsupported`(또는 명시적인
`guarded`)입니다.

`decodeExactInteger`는 애플리케이션이 선택적으로 사용하는 helper입니다.

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(row.id, { min: 0n }); // 이 애플리케이션에서는 bigint
```

이 helper는 SQLBraid의 표준 행 타입을 바꾸지 않습니다. `decodeExactDecimal`은
정확한 10진 텍스트를 검증하고 string을 반환합니다. 행이 애플리케이션 경계에
도달한 뒤에만 애플리케이션이 선택한 Decimal, BigInt, Money 또는 도메인 변환을
사용하세요. 전역 `numericMode` 스위치는 없습니다.

## Standard Schema로 애플리케이션 타입 선택

도메인 계약이 텍스트라면 그대로 유지하세요.

```ts
const Row = v.object({ id: v.string(), amount: v.string() });
```

BigInt 식별자를 선택적으로 사용합니다.

```ts
const Id = v.pipe(v.string(), v.transform(BigInt));
```

또는 애플리케이션 코드에서 임의 정밀도 10진 라이브러리를 선택할 수 있습니다
(문서 예일 뿐 SQLBraid 의존성이 아닙니다).

```ts
import Decimal from "decimal.js";
const Amount = v.pipe(v.string(), v.transform(value => new Decimal(value)));
```

드라이버가 이미 반올림한 숫자를 schema가 복구할 수는 없습니다.

## 근사 이진 값

`REAL`, `FLOAT`, `DOUBLE`, PostgreSQL `real`/`double precision`, Oracle
`BINARY_FLOAT`/`BINARY_DOUBLE`, SQL Server `real`/`float`은 본래 근사 이진
영역입니다. 근사 연산을 원할 때 SQLBraid는 검증된 binary32 또는 binary64
값을 `number`로 노출합니다. 이것은 정확한 10진수 보장이 아닙니다. 프로필은
DB가 `NaN`, infinity, 음의 0을 정규화하는지 기록합니다. codegen 진단은 근사
타입 자체가 아니라 exact DB 타입의 손실/미지원 전송에만 발생해야 합니다.

## 드라이버 프로필

아래는 SQLBraid의 데이터 표현 계약입니다. [지원 매트릭스](/SQLBraid/reference/support/)가
각 데이터베이스 및 런타임의 인증 기준입니다. 드라이버 프로필은 결과 JavaScript 타입을
결정하는 완전한 드라이버 설정이며, 사후에 붙이는 단순 설명용 라벨이 아닙니다.

첫 번째 파티 프로필 helper는 runtime과 codegen이 같은 계약을 사용하게 합니다.

```ts
const profile = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy: profile });
```

PostgreSQL은 `@sqlbraid/postgres` portable root에서
`typePolicyForProfile`와 `representationProfiles`를 내보내며 mysql2와
MariaDB도 같은 형태를 제공합니다. 각 descriptor에는 안정적인 `id`,
`json`, `temporal`, `typePolicy`와 필요한 경우 정확한
`connectionOptions`가 있습니다. 기본값은 lossless text 프로필입니다.
native/호환 프로필은 기본 정책의 다른 이름이 아니라 별도 descriptor입니다.

현재 descriptor ID는 명시적입니다. PostgreSQL은
`pg-lossless-text`, `pg-native`, `pg-json-native-temporal-text`,
`pg-json-text-temporal-native`를 사용하고, mysql2는
`mysql2-lossless-text`, `mysql2-native`, `mysql2-json-text`,
`mysql2-date-text`를 사용합니다. MariaDB는 이에 대응하는
`mariadb-lossless-text`, `mariadb-native`, `mariadb-json-text`,
`mariadb-date-text`를 사용합니다.

드라이버 경계에서 **raw**는 드라이버가 실제 반환한 값이고 **canonical**은
`TypePolicy`를 적용한 SQLBraid 애플리케이션 값입니다. 둘을 섞지 마세요.
정확한 string ID와 DB가 생성한 ID는 정확한 DB 값이므로 canonical decimal
text를 사용합니다. `affectedRows`, `rowCount`, bulk input count는 운영
count이므로 safe-integer 검사를 하는 number로 남습니다.

| 대상 | 정확도 우선 canonical 출력 | 호환 프로필 경계 |
| --- | --- | --- |
| PostgreSQL / `pg` | exact numeric → `string`; JSON/temporal text → `string`; float → `number` | native JSON → `unknown`; native `date`/`timestamp`/`timestamptz` → `Date`; `time`/`timetz`는 `string`; `interval`은 `unknown` |
| MySQL / `mysql2` | exact integer/`DECIMAL` → `string`; `jsonStrings`/`dateStrings` → `string` | native JSON/temporal은 별도 편의 프로필이며 exact 증거를 상속하지 않음 |
| MariaDB Connector | exact integer/`DECIMAL` → `string`; `autoJsonMap:false`/`dateStrings:true` → `string` | native JSON/temporal은 별도 편의 프로필이며 exact 증거를 상속하지 않음 |
| Node SQLite / WASM | INTEGER storage → `string`; REAL storage → `number` | native bigint는 transport 전용이며 D1은 safe-integer 범위 guarded |
| Bun SQL 1.3.14 | PostgreSQL/MySQL/MariaDB `{ bigint: true }`; PostgreSQL decimal → `string`; SQLite `{ safeIntegers: true }`; MariaDB/SQLite JSON → text | integral `Number` row 거부; MySQL/MariaDB DECIMAL과 binary는 같은 모호한 byte carrier라 거부하며 `CAST(... AS CHAR)`/`HEX(...)`를 직접 작성; SQLite native decimal은 unsupported |
| Oracle Thin | `NUMBER` 계열 → `string`; 근사 이진 → `number` | native JSON/temporal은 프로필별 편의 표현 |
| SQL Server / Tedious | 보존되는 exact integer → `string`; 근사 이진 → `number` | native DECIMAL/NUMERIC/MONEY exact 출력은 unsupported; SQL text cast 작성 |

SQLite 동적 타입 열은 선언된 INTEGER affinity가 아니라 runtime storage class를
따릅니다. 배열, domain, range/multirange, composite, Oracle object/collection,
SQL Server `sql_variant`, vector 및 기타 container는 scalar 보장을 상속하지
않습니다. 재귀 전송 테스트가 없으면 `unclassified` 또는 `unsupported`로
남깁니다. JSON은 아래에서 별도로 다룹니다.

## JSON: 파싱 편의성과 lossless text

파싱된 JavaScript JSON 객체는 편리하지만 일반 `JSON.parse()`는 모든 JSON
숫자를 JavaScript `number`로 만듭니다. 따라서 `9223372036854775807`이나 고정밀
소수 같은 중첩 값은 일반적인 lossless 보장이 아닙니다.

프로필은 다음을 구분해야 합니다.

- **lossless text** — JS Number 파싱 없이 직렬화된 JSON이 텍스트로 SQLBraid에
  도달하며, 애플리케이션이 `JSON.parse`, lossless parser 또는 schema를 선택함;
- **parsed** — 드라이버가 object/value를 반환하며 중첩 숫자 정확도는 보장되지 않음.

Parsed JSON은 object만을 뜻하지 않습니다. root는 string, number, boolean,
`null`, array 또는 object일 수 있습니다. 따라서 native 프로필은 driver별
root 계약과 codegen mapping이 증명되지 않는 한 `unknown`을 사용합니다.
schema는 애플리케이션 경계에서 값을 좁힐 수 있지만 JavaScript `number`로
이미 변환된 숫자를 복구할 수는 없습니다.

PostgreSQL은 가능한 경로에서 query-local raw-text 프로필을 사용하고 기본
parsed 호환 경로는 parsed라고 명시합니다. MySQL과 MariaDB text 프로필은
드라이버가 제공하는 `jsonStrings: true` (`MariaDB Connector`는
`autoJsonMap: false`)를 사용합니다. SQLite/WASM/D1과 SQL Server는 문서화된
경로에서 text 중심입니다. Oracle은 검증된 fetch handler 또는 사용자가 작성한
`JSON_SERIALIZE(...)` 표현식을 사용할 수 있습니다. SQLBraid는 전역 parser를
바꾸거나 사용자 SQL을 다시 쓰지 않습니다.

이 보장은 DB 결과에서 시작합니다. MySQL native JSON 저장소는 드라이버가
읽기 전에 소수 토큰을 반올림하고 키/공백을 정규화할 수 있습니다. 원본 JSON
숫자를 그대로 왕복해야 하면 text 열을 사용하세요.

```text
lossless JSON text → Standard Schema → 애플리케이션 선택 parser
parsed object      → Standard Schema → 편리하지만 자동 lossless 아님
```

## Temporal 값

JavaScript `Date`는 모든 SQL temporal 의미를 담지 못합니다. 날짜 전용/로컬
시간 의미, 밀리초를 넘는 소수 정밀도, offset, zone identity, Date 범위 밖 값이
손실될 수 있습니다. native `Date`는 편의 프로필이지 포괄적인 lossless 보장이
아닙니다.

드라이버/프로필이 보존할 수 있다면 raw 경계에서는 temporal text를 우선하고
Standard Schema로 `Date`, `Temporal.*`, Luxon 또는 도메인 타입으로 변환하세요.
Temporal 정책은 모든 타입에 적용하는 하나의 “Date” switch가 아니라 타입별입니다.
PostgreSQL native `date`, `timestamp`, `timestamptz`는 `Date`이고 native
`time`, `timetz`는 text로 남으며 `interval`은 의도적으로 열어 둡니다.
정확도를 평가할 때 `2026-09-14 12:34:56.123456`처럼 0이 아닌 소수를 사용합니다.
PostgreSQL `pg`, MySQL `dateStrings`, MariaDB `dateStrings`, 명시적 SQL text
conversion은 서로 다른 프로필입니다. SQLite temporal 값은 저장 관례입니다.
Oracle과 SQL Server에서 native `Date`가 precision/offset/session-zone 의미를
잃으면 테스트된 text format 또는 사용자가 작성한 `TO_CHAR`/`CONVERT` 표현식을
사용하세요.

## Bind, `null`, `undefined`

정확한 입력 전송은 정확한 출력과 별도의 capability입니다. 프로필이 이를
주장한다면 정밀한 decimal text 또는 정수 string을 문서화된 경로로 bind하여
DB에 저장하고 lossless 출력 경로로 왕복시키세요. 먼저 JavaScript `number`를
거치지 않습니다. SQLBraid는 cast를 대신 삽입하지 않습니다.

```sql
CAST(@nvarchar_parameter AS decimal(38, 18))
```

이는 SQL Server에서 사용자가 작성하는 우회 경로이지 범용 input codec이
아닙니다. Oracle string-to-number bind는 NLS 설정에 의존할 수 있으므로 명시적
제어 변환을 사용하거나 unsupported로 분류합니다.

`null`은 SQL `NULL`입니다. 일반 `undefined`는 프로그래밍/설정 오류
(`BRAID_BIND_VALUE_UNSUPPORTED`)이며 execute, prepared, bulk, stream, routine의
일반 IN 경로에서 connection을 얻기 전에 거부됩니다. OUT placeholder 의미는
드라이버별입니다.

## Container는 별도의 증거 경계

Scalar fidelity는 container에 재귀적으로 적용되지 않습니다. PostgreSQL
array, domain, range/multirange, composite, Oracle object/collection,
SQL Server `sql_variant`, vector 및 parsed JSON root는 각각 별도의 transport와
codegen 증거가 필요합니다. 그 전에는 scalar mapping을 상속하지 말고
`unknown`, `unclassified`, `unsupported`로 분류하세요. PostgreSQL lossless
array 결과가 raw text일 수 있어도 native array parser가 중첩 값을 재귀적으로
정확하다는 뜻은 아닙니다. “supported container”는 테스트한 container 경로만
의미하며 모든 중첩 member를 보장하지 않습니다.

## 프로필, codegen, 투명성

custom `pg` parser, mysql2 `typeCast`, MariaDB JSON/temporal option, Oracle
fetch handler와 같은 override는 별도 프로필입니다. 테스트하여 runtime과
codegen에서 선택하기 전에는 기본 증거를 무효화합니다. 선택한 profile
descriptor와 TypePolicy를 codegen에서 재사용해야 하며, “맞아 보이는” mapping을
수동으로 다시 만드는 것은 증거가 아닙니다.
`db.environment()`는 scope별 캐시된 관측값입니다. 세션 설정을 바꾼 뒤에는
`db.environment({ refresh: true })`로 갱신하세요. 풀 probe는 lease 하나를
관측하므로 해당 보장은 guarded이며 이후 모든 풀 세션을 보장하지 않습니다.
Codegen은 output/input
표현을 분리하며, 수동 TypeScript override가 손실 전송을 exact로 바꾸지는
않습니다.

SQLBraid는 자동 cast, parser rewrite, query-builder translation 없이 사용자가
작성한 SQL을 드라이버로 전달합니다. native `RETURNING`, `OUTPUT`, `MERGE`,
UPSERT, `CAST`, `CONVERT`, `JSON_SERIALIZE`, temporal formatting은 SQL에 그대로
남습니다. 지원 capability도 실제 실행한 문장을 이름으로 구분합니다.
`merge-returning`은 native `MERGE`, `upsert-returning`은 native
UPSERT/REPLACE/ON CONFLICT/ON DUPLICATE KEY입니다. 결과가 비슷해도 문법은
서로 대체되지 않습니다.

정확한 프로필/options는 드라이버 설정 페이지와 [런타임 및 드라이버 지원
매트릭스](/SQLBraid/reference/support/)를 참고하세요. 증거를 알 수 없으면
`unknown`으로 남기며 TypeScript assertion이나 보기 좋은 매트릭스 셀만으로
`lossless`로 승격하지 않습니다.
