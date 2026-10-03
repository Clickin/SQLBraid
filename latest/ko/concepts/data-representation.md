# 데이터 표현과 값 정확도

> 드라이버 경계에서는 데이터베이스 값의 의미를 그대로 지키고, 애플리케이션 타입은 Standard Schema로 고릅니다.

SQLBraid는 선택한 드라이버와 프로필이 실제로 전달할 수 있는 값을 그대로 유지합니다. `sql.rows<T>`의 TypeScript 타입은 결과를 변환하지 않습니다. SQLBraid는 정확한 데이터베이스 값을 JavaScript `number`로 몰래 줄이지 않습니다.

## 값이 흐르는 경로

```text
DB type and expression
  → driver/profile raw value
  → dialect TypePolicy normalization
  → plain normalized row
  → query-bound Standard Schema (optional)
  → application value
```

`TypeMapping.numeric`은 서로 독립된 세 가지 사실을 함께 보여 줍니다.

```ts
interface NumericTypeContract {
  semantics: "exact-integer" | "exact-decimal" | "approximate-binary";
  representation: "string" | "number";
  fidelity: "lossless" | "guarded" | "lossy" | "unsupported";
  binaryPrecision?: 32 | 64;
}
```

- `semantics`는 데이터베이스 쪽 값의 의미입니다.
- `representation`은 SQLBraid가 애플리케이션에 넘기는 원시 값의 형태입니다.
- `fidelity`는 선택한 드라이버·프로필의 전송 정확도입니다.

데이터베이스 식에는 그 식만의 결과 타입이 있습니다. 원본 열만 보고 추론하지 마세요. 집계, 형 변환, 산술 연산에는 그 식에 대한 메타데이터와 프로필 근거가 필요합니다.

## 숫자 값의 정규 경계

어디서나 통하는 규칙은 다음과 같습니다.

```text
exact integer or exact decimal → string
IEEE-754 approximate binary    → number
```

JavaScript 타입은 현재 값에 따라 바뀌지 않습니다. 정확한 `BIGINT`에서 온 `42`도 `"42"`입니다. 큰 값만 "가끔 문자열"이 되는 일은 없습니다. 정확한 정수 별칭, `BIGINT`, `DECIMAL`/`NUMERIC`, `MONEY` 계열 타입, 벤더별 별칭은 드라이버가 정확하게 유지할 수 있을 때만 정확한 값입니다. 정확한 타입이 손실이 있는 JavaScript `number`로 노출되면 상태는 `unsupported`(또는 명시적인 `guarded`)입니다. SQLBraid는 그 값을 문자열로 바꾼 뒤 정확하다고 주장하지 않습니다.

`decodeExactInteger`는 애플리케이션이 선택해서 쓰는 헬퍼입니다.

```ts
import { decodeExactInteger } from "@sqlbraid/core";

const id = decodeExactInteger(row.id, { min: 0n }); // bigint in this app
```

이 헬퍼는 SQLBraid의 정규 행 타입을 바꾸지 않습니다. `decodeExactDecimal`은 정확한 소수 텍스트를 검증하고 문자열을 반환합니다. Decimal, BigInt, Money, 도메인 변환은 행이 애플리케이션 경계에 도착한 뒤에 애플리케이션이 골라서 쓰세요. 전역 `numericMode` 스위치는 없습니다.

## Standard Schema로 애플리케이션 타입 고르기

도메인에서 정확한 값을 텍스트로 다뤄야 한다면 텍스트 그대로 두세요.

```ts
const Row = v.object({ id: v.string(), amount: v.string() });
```

BigInt 식별자를 쓰려면 다음과 같이 합니다.

```ts
const Id = v.pipe(
  v.string(),
  v.transform((value) => BigInt(value)),
);
```

애플리케이션 코드에서 임의 정밀도 소수 라이브러리를 고를 수도 있습니다. 아래 라이브러리는 예시일 뿐이며 SQLBraid의 의존성이 아닙니다.

```ts
import Decimal from "decimal.js";
const Amount = v.pipe(
  v.string(),
  v.transform((value) => new Decimal(value)),
);
```

드라이버가 이미 반올림한 자릿수는 스키마로 되살릴 수 없습니다.

## 근사 이진 값

`REAL`, `FLOAT`, `DOUBLE`, PostgreSQL의 `real`/`double precision`, Oracle의 `BINARY_FLOAT`/`BINARY_DOUBLE`, SQL Server의 `real`/`float`는 근사 이진 값입니다. SQLBraid는 binary32나 binary64로 확인된 값을 `number`로 노출합니다. 정확한 소수를 보장한다는 뜻은 아닙니다. 데이터베이스가 `NaN`, 무한대, 음의 0을 정규화하는지는 프로필에 기록합니다. 코드 생성 진단은 정확한 DB 타입이 손실이 있거나 지원되지 않는 방식으로 전송될 때 나오는 것이 맞습니다. 타입이 근사값이라는 이유만으로 나오면 안 됩니다.

## 드라이버 프로필

이 절은 SQLBraid의 표현 규칙을 설명합니다. 데이터베이스·런타임의 정확한 리비전별 근거는 [지원 매트릭스](/SQLBraid/latest/reference/support.md)가 기준입니다. 프로필은 결과의 JavaScript 타입을 정하는 드라이버 설정 전체입니다. 나중에 덧붙이는 이름표가 아닙니다.

공식 프로필 헬퍼를 쓰면 런타임과 코드 생성이 같은 규칙을 따릅니다.

```ts
const profile = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy: profile });
```

PostgreSQL은 `@sqlbraid/postgres`에서 `typePolicyForProfile`과 `representationProfiles`를 export합니다. mysql2와 MariaDB도 각자의 방언 루트에서 같은 형태를 제공합니다. 각 설명 객체에는 고정된 `id`, `json`, `temporal`, `typePolicy`가 있고, 해당하는 경우 정확한 `connectionOptions`도 있습니다. 기본값은 무손실 텍스트 프로필입니다. 네이티브 프로필과 호환 프로필은 별도의 설명 객체입니다. 기본 정책의 다른 이름이 아닙니다.

현재 설명 객체 ID는 다음과 같습니다.

- PostgreSQL: `pg-lossless-text`, `pg-native`, `pg-json-native-temporal-text`, `pg-json-text-temporal-native`
- mysql2: `mysql2-lossless-text`, `mysql2-native`, `mysql2-json-text`, `mysql2-date-text`
- MariaDB: 위와 대응하는 `mariadb-lossless-text`, `mariadb-native`, `mariadb-json-text`, `mariadb-date-text`

드라이버 경계에서 **원시(raw)** 값은 드라이버가 실제로 반환한 값입니다. **정규(canonical)** 값은 `TypePolicy`를 거친 뒤 SQLBraid가 애플리케이션에 넘기는 값입니다. 둘은 서로 바꿔 쓸 수 없습니다. 정확한 문자열 ID와 데이터베이스가 생성한 ID는 정확한 데이터베이스 값이며, 정규 십진 텍스트를 씁니다. `affectedRows`, `rowCount`, 벌크 입력 개수는 작업 결과를 세는 값입니다. 안전한 정수 범위를 검사한 숫자로 남습니다.

| 대상                 | 정확도 우선 정규 출력                                                                                                                     | 호환성 경계                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`    | 정확한 숫자 → `string`, JSON·날짜·시간 텍스트 → `string`, 부동소수점 → `number`                                                           | 네이티브 JSON → `unknown`, 네이티브 `date`/`timestamp`/`timestamptz` → `Date`, `time`/`timetz`는 `string` 유지, `interval`은 `unknown`                                     |
| MySQL / `mysql2`     | 정확한 정수·`DECIMAL` → `string`, `jsonStrings`/`dateStrings` → `string`                                                                  | 네이티브 JSON·날짜·시간은 별도의 편의 프로필이며, 정확도 근거가 이어지지 않음                                                                                              |
| MariaDB Connector    | 정확한 정수·`DECIMAL` → `string`, `autoJsonMap:false`/`dateStrings:true` → `string`                                                       | 네이티브 JSON·날짜·시간은 별도의 편의 프로필이며, 정확도 근거가 이어지지 않음                                                                                              |
| Node SQLite / WASM   | INTEGER 저장 값 → `string`, REAL 저장 값 → `number`                                                                                       | 네이티브 bigint는 전송에만 쓰임, D1은 안전한 정수 범위로 제한                                                                                                              |
| Bun SQL 1.3.14       | PostgreSQL/MySQL/MariaDB `{ bigint: true }`, PostgreSQL decimal → `string`, SQLite `{ safeIntegers: true }`, MariaDB/SQLite JSON → 텍스트 | 정수 `Number` 행은 거부, MySQL/MariaDB DECIMAL과 바이너리는 바이트가 구분되지 않아 거부하므로 `CAST(... AS CHAR)`/`HEX(...)`를 직접 작성, SQLite 네이티브 decimal은 미지원 |
| Oracle Thin          | `NUMBER` 계열 → `string`, 근사 이진 값 → `number`                                                                                         | 네이티브 JSON·날짜·시간 값은 프로필별 편의 표현                                                                                                                            |
| SQL Server / Tedious | 보존된 정확한 정수 → `string`, 근사 이진 값 → `number`                                                                                    | 네이티브 DECIMAL/NUMERIC/MONEY의 정확한 출력은 미지원이므로 텍스트 변환을 직접 작성                                                                                        |

동적 타입을 쓰는 SQLite 열은 선언된 INTEGER 친화도가 아니라 런타임 저장 클래스를 따릅니다. 배열, 도메인, 범위, 다중 범위, 복합 타입, Oracle 객체·컬렉션, SQL Server `sql_variant`, 벡터 같은 컨테이너는 스칼라 값의 보장을 물려받지 않습니다. 재귀적 전송 테스트가 생기기 전까지는 각각 `unclassified`나 `unsupported`입니다. JSON은 아래 절에서 따로 설명합니다.

## JSON: 파싱된 편의 값과 무손실 텍스트

JavaScript 객체로 파싱된 JSON은 편리합니다. 하지만 일반 `JSON.parse()`는 JSON 숫자를 모두 JavaScript `number`로 바꿉니다. 그래서 `9223372036854775807`이나 정밀도가 높은 소수 같은 중첩 값은 일반적으로 무손실을 보장할 수 없습니다.

프로필은 다음 두 경우를 구분해야 합니다.

- **무손실 텍스트**: 직렬화된 JSON이 텍스트 그대로 SQLBraid에 도착합니다. JS Number로 파싱하지 않습니다. `JSON.parse`, 무손실 파서, 스키마 중 무엇을 쓸지는 애플리케이션이 고릅니다.
- **파싱된 값**: 드라이버가 객체나 값을 반환합니다. 중첩된 숫자의 정확도는 보장하지 않습니다.

파싱된 JSON이 항상 객체인 것은 아닙니다. 최상위 값은 문자열, 숫자, 불리언, `null`, 배열, 객체 중 무엇이든 될 수 있습니다. 그래서 드라이버의 최상위 값 선언과 코드 생성 매핑이 더 구체적인 근거를 주지 않는 한, 네이티브 프로필은 `unknown`을 씁니다. 값이 애플리케이션 경계에 도착한 뒤 스키마로 좁힐 수는 있습니다. 하지만 이미 JavaScript `number`로 바뀐 자릿수는 되살릴 수 없습니다.

- PostgreSQL은 지원하는 곳에서 쿼리 단위의 원시 텍스트 프로필을 씁니다. 기본 호환 경로는 명시적으로 파싱된 값을 씁니다.
- MySQL과 MariaDB의 텍스트 프로필은 드라이버가 제공하는 `jsonStrings: true`를 씁니다(MariaDB Connector는 `autoJsonMap: false`).
- SQLite, WASM, D1, SQL Server는 문서화된 경로에서 텍스트를 씁니다.
- Oracle은 검증된 fetch 핸들러를 쓰거나, SQL에 `JSON_SERIALIZE(...)`를 직접 쓸 수 있습니다.

SQLBraid는 전역 파서를 바꾸지 않습니다. 사용자의 SQL을 고쳐 쓰지도 않습니다.

이 보장은 데이터베이스 결과에서부터 시작합니다. MySQL의 네이티브 JSON 저장소는 드라이버가 읽기 전에 소수 토큰을 반올림하고 키와 공백을 정규화할 수 있습니다. 원래 JSON 자릿수를 저장 후에도 그대로 지켜야 한다면 텍스트 열을 쓰세요.

```text
lossless JSON text → Standard Schema → application-selected parser
parsed object      → Standard Schema → convenient, not automatically lossless
```

## 날짜·시간 값

JavaScript `Date`로는 SQL 날짜·시간의 의미를 모두 담을 수 없습니다. 다음 정보는 담지 못합니다.

- 날짜만 있는 값과 로컬 시간 값의 의미
- 밀리초보다 작은 소수 정밀도
- 오프셋이나 시간대 정보
- 표현 범위를 벗어난 값

네이티브 `Date`는 편의 프로필입니다. 일반적인 무손실을 주장하지 않습니다.

드라이버와 프로필이 지원하는 곳에서는 원시 경계에서 날짜·시간 텍스트를 쓰세요. 그런 다음 Standard Schema로 `Date`, `Temporal.*`, Luxon, 애플리케이션 도메인 타입으로 변환하세요. 날짜·시간 정책은 하나의 큰 "Date" 스위치가 아니라 데이터베이스 타입별로 정해집니다.

- PostgreSQL 네이티브 `date`, `timestamp`, `timestamptz`는 `Date`를 씁니다.
- 네이티브 `time`과 `timetz`는 텍스트로 남습니다.
- `interval`은 일부러 열어 두었습니다.

정확도를 확인하려면 `2026-09-14 12:34:56.123456`처럼 소수 부분이 0이 아닌 값으로 테스트하세요. PostgreSQL `pg`, MySQL `dateStrings`, MariaDB `dateStrings`, 사용자 SQL의 명시적인 텍스트 변환은 서로 다른 프로필입니다. SQLite의 날짜·시간 값은 애플리케이션과 저장 방식의 관례에 따릅니다. Oracle과 SQL Server에서 네이티브 `Date`가 정밀도, 오프셋, 세션 시간대 의미를 잃는다면 검증된 텍스트 포맷이나 명시적인 `TO_CHAR`/`CONVERT` 식을 쓰세요.

## 바인딩, `null`, `undefined`

정확한 입력은 정확한 출력과 별개의 기능입니다. 프로필이 정확한 입력을 지원한다고 하면, 문서에 나온 경로로 소수 텍스트나 정확한 정수 문자열을 바인딩하세요. 그리고 데이터베이스를 거쳐 다시 읽어 확인하세요. 정밀한 값을 먼저 JavaScript `number`로 거치게 하면 안 됩니다. SQLBraid가 형 변환을 대신 넣어 주지 않습니다.

```sql
CAST(@nvarchar_parameter AS decimal(38, 18))
```

이것은 SQL에 직접 쓰는 SQL Server용 우회 방법입니다. 범용 입력 코덱이 아닙니다. Oracle의 문자열→숫자 바인딩은 NLS 설정에 따라 달라질 수 있습니다. 통제된 명시적 변환을 쓰거나, 그 경로를 미지원으로 분류하세요.

`null`은 SQL `NULL`입니다. 일반 `undefined`는 프로그래밍·설정 오류(`BRAID_BIND_VALUE_UNSUPPORTED`)입니다. execute, 준비된 쿼리, 벌크, 스트림, 루틴 IN 경로에서 커넥션을 획득하기 전에 거부됩니다. OUT 플레이스홀더의 동작은 드라이버마다 다릅니다.

## 컨테이너는 근거를 따로 갖춰야 합니다

스칼라 값의 정확도가 컨테이너까지 재귀적으로 보장하지는 않습니다. 다음 값은 각각 고유한 전송·코드 생성 근거가 필요합니다.

- PostgreSQL 배열, 도메인, 범위, 다중 범위, 복합 타입
- Oracle 객체와 컬렉션
- SQL Server `sql_variant`
- 벡터
- 파싱된 JSON의 최상위 값

근거가 생기기 전까지는 `unknown`, `unclassified`, `unsupported`로 분류하세요. 스칼라 매핑을 물려받게 하지 마세요. PostgreSQL 무손실 배열 출력은 원시 텍스트로 남을 수 있습니다. 네이티브 배열 파싱이 중첩 값까지 재귀적으로 정확하다고 보장하지는 않습니다. "지원되는 컨테이너"라는 상태는 테스트한 컨테이너 경로가 동작한다는 뜻입니다. 안의 모든 멤버가 재귀적으로 보장된다는 뜻이 아닙니다.

## 프로필, 코드 생성, SQL 투명성

직접 만든 `pg` 파서, mysql2 `typeCast`, MariaDB JSON·날짜·시간 옵션, Oracle fetch 핸들러, 그리고 이와 같은 재정의는 모두 별도의 프로필입니다. 이런 설정을 쓰면 런타임과 코드 생성 양쪽에서 테스트하고 선택하기 전까지 기본 근거가 무효가 됩니다.

- 코드 생성은 선택한 프로필 설명 객체와 그 TypePolicy를 써야 합니다. 직접 만든 "같아 보이는" 매핑은 근거가 아닙니다.
- `db.environment()`는 범위에 대해 캐시된 관찰 결과를 반환합니다. 세션 설정을 바꾼 뒤에는 `db.environment({ refresh: true })`를 쓰세요.
- 풀에서 실행하는 점검은 리스 하나만 표본으로 봅니다. 관찰한 보장은 guarded로 남으며, 앞으로의 모든 풀 세션에 대한 약속이 아닙니다.
- 코드 생성은 출력 표현과 입력 표현을 따로 만듭니다. 손실이 있는 전송을 TypeScript 재정의로 정확하게 만들 수는 없습니다.

SQLBraid는 사용자가 쓴 SQL을 자동 형 변환, 파서 재작성, 쿼리 빌더 번역 없이 그대로 보냅니다. 네이티브 `RETURNING`, `OUTPUT`, `MERGE`, UPSERT, `CAST`, `CONVERT`, `JSON_SERIALIZE`, 날짜·시간 포맷은 모두 SQL에 그대로 보입니다. 지원 기능 이름은 실제로 실행한 문장을 가리킵니다.

- `merge-returning`은 네이티브 `MERGE`입니다.
- `upsert-returning`은 네이티브 UPSERT/REPLACE/ON CONFLICT/ON DUPLICATE KEY입니다.

결과가 비슷하다고 문법을 서로 바꿔 쓸 수 있다는 뜻은 아닙니다.

리비전별 근거는 드라이버 설정 문서와 [런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)를 보세요. 알 수 없는 근거는 알 수 없는 상태로 남습니다. 타입 단언이나 초록색으로 보이는 매트릭스 칸이 그것을 `lossless`로 올려 주지 않습니다.
