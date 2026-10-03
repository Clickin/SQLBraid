---
title: 파라미터 타입 힌트
description: 드라이버의 타입 추론만으로 부족할 때 데이터베이스 파라미터 타입을 명시합니다.
---

SQLBraid는 JavaScript 값과 데이터베이스 파라미터 타입을 구분합니다. 일반 보간에는 드라이버의 기본 추론이 그대로 적용됩니다.

```ts
const id = 42;
const query = sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

데이터베이스 타입이 중요하다면 값을 `sql.bind(value, hint)`로 감싸세요.

```ts
import { sql, oracleParameter } from "sqlbraid/oracle";

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
`;
```

감싼 값도 템플릿 안에서는 여전히 값입니다. SQL 구조가 되지 않으며, 문장 안에 문자열로 들어가지도 않습니다.

## TypeScript 타입은 데이터베이스 근거가 아닙니다

SQLBraid는 TypeScript 타입에서 데이터베이스 파라미터 타입을 일괄적으로 추론하지 않습니다.

- `number`는 정수, 소수, 금액, 식별자, 특정 데이터베이스의 숫자 타입 중 무엇이든 될 수 있습니다.
- `string`은 텍스트, UUID, JSON, 제약이 있는 문자 타입일 수 있습니다.
- `Date`만으로는 데이터베이스의 여러 날짜·타임스탬프 타입 중 하나를 고를 수 없습니다.

힌트가 없으면 어댑터는 문서에 나온 드라이버 추론을 씁니다. 힌트가 있으면 어댑터는 그 설명을 따르거나 명시적으로 실패해야 합니다. 이것은 데이터베이스 파라미터 타입 지정입니다. 애플리케이션 입력 검증, 결과 매핑, 코덱 프레임워크가 아닙니다.

## SQL Server 힌트

SQL Server 루트는 Tedious 어댑터가 지원하는 타입의 팩토리를 export합니다.

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

사용할 수 있는 팩토리는 `tinyint()`, `smallint()`, `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `money()`, `smallmoney()`, `real()`, `float()`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()`, `datetimeoffset()`입니다.

`null`이나 애플리케이션 객체처럼 모호한 값에는 힌트를 명시하세요. 정밀도, 스케일, 길이, SQL Server 전용 타입을 JavaScript 런타임 타입에 맡기지 마세요.

## 렌더링 메타데이터와 준비된 쿼리의 형태

렌더링된 문장은 각 값, 보간 위치, 선택 사항인 힌트를 변경할 수 없는 `parameters` 레코드 하나에 담습니다. `segments.length === parameters.length + 1`입니다. 옵저버는 이 레코드에서 값, 힌트, 보간 위치 정보를 받습니다. 그렇다고 바인딩 값의 가림 정책이 바뀌지는 않습니다.

준비된 쿼리의 형태는 결과 종류, 정규화된 논리 세그먼트, 순서가 있는 힌트 시그니처로 정해집니다.

- 값만 바뀌는 것은 허용됩니다.
- 힌트, 길이, 정밀도, 스케일이 바뀌면 형태가 바뀐 것이므로 실패합니다. SQLBraid는 호환되지 않는 준비된 문장을 몰래 재사용하지 않습니다.
- 물리적인 표기 `$1`, `?`, `:1`, `@p1`은 형태에 포함되지 않습니다.

## 어댑터 지원

PostgreSQL, MySQL, MariaDB, SQLite 어댑터는 일반 파라미터 힌트를 `BRAID_BIND_HINT_UNSUPPORTED`로 명시적으로 거부합니다. 힌트를 몰래 무시하지 않습니다. PostgreSQL의 `postgresParameter.refcursor()`는 좁은 예외입니다. 루틴 전용이며 OUT·INOUT 포털을 구분하는 데만 씁니다. 필요한 타입 API를 갖춘 어댑터가 나오기 전까지, 다른 파라미터에는 힌트 없는 일반 바인딩을 쓰세요.

Oracle과 SQL Server의 방언 루트는 힌트 설명 객체를 제공합니다. 각 Node 어댑터는 자체적으로 기능을 검사합니다. 검증된 드라이버 기능은 [런타임·드라이버 지원](/SQLBraid/reference/support/)을 보세요. Oracle은 node-oracledb가 적용할 수 없는 IN 길이, 정밀도, 스케일 속성을 거부합니다. 두 어댑터 모두 지원하지 않는 속성을 몰래 무시하지 않습니다.

## 루틴 파라미터의 방향

`sql.bind(value, hint)`는 IN 값입니다. 루틴 호출에서는 다음도 쓸 수 있습니다.

<!-- doc-snippet: skip -->

```ts
sql.out("name", hint?)              // OUT, logical null placeholder
sql.inOut("name", value, hint?)     // INOUT, initial value plus output
```

이 헬퍼는 `sql.call` 템플릿에서만 쓸 수 있습니다. 출력 이름은 서로 달라야 합니다.

- Oracle의 OUT·INOUT 값에는 힌트가 필요합니다.
- SQL Server의 OUTPUT·INOUT 값에는 Tedious 힌트가 필요합니다.
- PostgreSQL에서 refcursor 출력을 구분하려면 `postgresParameter.refcursor()`가 필요합니다.
- MySQL에서 준비된 문장으로 실행하는 CALL 경로는 OUT·INOUT을 거부합니다. mysql2 3.x 공개 API로는 어느 추가 결과가 출력 값을 담고 있는지 확인할 수 없기 때문입니다.

결과 순서, `output`에서 커서를 빼는 규칙, 정리 과정은 [루틴 호출](/SQLBraid/concepts/routines/)을 보세요.
