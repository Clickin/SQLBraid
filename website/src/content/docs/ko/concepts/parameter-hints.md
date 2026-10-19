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
import { sql, oracleParameter } from "@sqlbraid/oracle";

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
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

사용할 수 있는 팩토리는 `tinyint()`, `smallint()`, `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `money()`, `smallmoney()`, `real()`, `float()`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()`, `datetimeoffset()`입니다.

`null`이나 애플리케이션 객체처럼 모호한 값에는 힌트를 명시하세요. 정밀도, 스케일, 길이, SQL Server 전용 타입을 JavaScript 런타임 타입에 맡기지 마세요.

## 힌트 타입은 어떻게 선언하나요

힌트의 `databaseType` 필드는 평범한 `string`입니다. 어떤 데이터베이스 타입을 바인딩할 수 있는지는 드라이버를 아는 어댑터가 정하므로, 코어 패키지는 타입 목록을 갖지 않습니다. 사용자 정의 어댑터는 자기만의 타입 이름을 정의할 수 있습니다.

힌트를 만드는 검사된 방법은 방언 루트의 팩토리입니다. 팩토리는 `databaseType`을 대신 설정하고, 받을 수 있는 값의 TypeScript 타입도 함께 기록합니다. TypeScript는 `sql.bind` 호출에서 값과 힌트를 비교합니다.

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const ok = sql.bind(accountId, mssqlParameter.int());
// @ts-expect-error A string is not a valid input for an `int` hint.
const wrong = sql.bind("42", mssqlParameter.int());
```

애플리케이션 코드에서는 팩토리를 쓰세요. 팩토리는 닫힌 이름 집합, 에디터 자동 완성, 값 검사를 제공합니다. 직접 쓴 힌트 객체에는 이 셋이 없습니다.

<!-- doc-snippet: skip -->

```ts
sql.bind(accountId, { databaseType: "int" }); // SQL Server 어댑터는 받아들이지만 TypeScript는 검사하지 않습니다
```

어댑터는 문장을 바인딩할 때, 문장을 실행하기 전에 이름을 검사합니다. 대소문자와 공백은 구분하지 않고, `int`에 대한 `integer`처럼 드라이버의 별칭을 받아들입니다. 어댑터가 모르는 이름이면 `BRAID_BIND_HINT_UNSUPPORTED`로 실패하며, 타입을 추측하지 않습니다.

## Oracle 힌트

Oracle 루트는 다음 팩토리를 내보냅니다.

| 팩토리                                   | Oracle 타입                                       |
| ---------------------------------------- | ------------------------------------------------- |
| `char`, `nchar`, `varchar2`, `nvarchar2` | `CHAR`, `NCHAR`, `VARCHAR2`, `NVARCHAR2`          |
| `number`                                 | `NUMBER`                                          |
| `binaryFloat`, `binaryDouble`            | `BINARY_FLOAT`, `BINARY_DOUBLE`                   |
| `date`, `timestamp`                      | `DATE`, `TIMESTAMP`                               |
| `timestampTz`, `timestampLtz`            | `TIMESTAMP WITH TIME ZONE`, `... LOCAL TIME ZONE` |
| `raw`                                    | `RAW`                                             |
| `rowid`, `urowid`                        | `ROWID`, `UROWID`                                 |
| `blob`, `clob`, `nclob`                  | `BLOB`, `CLOB`, `NCLOB`                           |
| `refCursor`                              | `REF CURSOR` (루틴 OUT 전용)                      |

IN 값에는 길이, 정밀도, 스케일 없이 팩토리를 호출하세요. node-oracledb는 이 속성을 IN 값에 적용할 수 없으므로 어댑터가 거부합니다.

```ts
import { oracleParameter, sql } from "@sqlbraid/oracle";

const query = sql.command`
  UPDATE accounts
  SET balance = ${sql.bind(balance, oracleParameter.number())}
  WHERE id = ${sql.bind(accountId, oracleParameter.number())}
`;
```

## PostgreSQL 힌트

PostgreSQL 힌트는 Parse 메시지에서 파라미터 하나의 타입 OID를 정합니다. postgres.js와 PGlite 어댑터가 적용하고, `pg`와 Neon 어댑터는 거부합니다. `pg`에는 파라미터 타입을 정하는 API가 없기 때문입니다.

```ts
import { postgresParameter, sql } from "@sqlbraid/postgres";

const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE id = ${sql.bind(userId, postgresParameter.int8())}
`;
```

| 팩토리                     | PostgreSQL 타입             | 받는 값                          |
| -------------------------- | --------------------------- | -------------------------------- |
| `boolean`                  | `boolean`                   | `boolean`                        |
| `int2`, `int4`             | `smallint`, `integer`       | `number`                         |
| `int8`                     | `bigint`                    | `bigint` 또는 정확한 정수 텍스트 |
| `float4`, `float8`         | `real`, `double precision`  | `number`                         |
| `numeric`                  | `numeric`                   | 정확한 십진수 텍스트             |
| `text`, `varchar`          | `text`, `character varying` | `string`                         |
| `uuid`                     | `uuid`                      | `string`                         |
| `bytea`                    | `bytea`                     | `Uint8Array`                     |
| `date`, `time`, `interval` | `date`, `time`, `interval`  | `2026-01-02` 같은 텍스트         |
| `timestamptz`              | `timestamp with time zone`  | `Date` 또는 ISO 텍스트           |

모든 팩토리가 `null`을 받습니다. 타입이 있는 `null`에는 `CAST`가 필요 없습니다.

힌트에는 길이, 정밀도, 스케일이 없습니다. 프로토콜이 타입 OID만 보내기 때문입니다. 이런 속성이 있는 힌트는 어댑터가 거부합니다. 같은 이유로 `numeric`과 `varchar` 팩토리는 인자를 받지 않습니다.

팩토리는 드라이버가 변환 없이 보내는 입력만 받습니다. SQLBraid는 값을 변환하지 않습니다. 그래서 `int8`과 `numeric`은 `number`를 받지 않고, `timestamp`(시간대 없음)에는 힌트가 없습니다.

`json`과 `jsonb`에는 힌트가 없습니다. postgres.js는 JSON 텍스트를 JSON 문자열 값으로 바꾸지만 PGlite는 바꾸지 않습니다. SQL에 `CAST(${text} AS jsonb)`를 쓰세요. enum, 복합 타입, 확장 타입에도 같은 규칙을 적용합니다.

## 힌트가 없는 타입

힌트는 어댑터가 바인딩할 수 있는 타입에만 있습니다. 그 밖의 타입은 SQL에 변환을 직접 쓰세요. 값은 계속 바인딩 파라미터로 남습니다.

```ts
const query = sql.rows<DocumentRow>`
  SELECT id FROM documents
  WHERE payload = CAST(${payloadText} AS jsonb)
`;
```

enum, 복합 타입, 사용자 정의 타입, `citext` 같은 확장 타입에 이 방식을 쓰세요. SQLBraid는 변환을 넣으려고 SQL을 다시 쓰지 않습니다.

## 렌더링 메타데이터와 준비된 쿼리의 형태

렌더링된 문장은 각 값, 보간 위치, 선택 사항인 힌트를 변경할 수 없는 `parameters` 레코드 하나에 담습니다. `segments.length === parameters.length + 1`입니다. 옵저버는 이 레코드에서 값, 힌트, 보간 위치 정보를 받습니다. 그렇다고 바인딩 값의 가림 정책이 바뀌지는 않습니다.

준비된 쿼리의 형태는 결과 종류, 정규화된 논리 세그먼트, 순서가 있는 힌트 시그니처로 정해집니다.

- 값만 바뀌는 것은 허용됩니다.
- 힌트, 길이, 정밀도, 스케일이 바뀌면 형태가 바뀐 것이므로 실패합니다. SQLBraid는 호환되지 않는 준비된 문장을 몰래 재사용하지 않습니다.
- 물리적인 표기 `$1`, `?`, `:1`, `@p1`은 형태에 포함되지 않습니다.

## 어댑터 지원

| 어댑터                                     | 파라미터 타입 힌트                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| SQL Server(Tedious), Oracle(node-oracledb) | 적용합니다. 위 절을 보세요.                                                      |
| PostgreSQL의 postgres.js, PGlite           | 적용합니다. [PostgreSQL 힌트](#postgresql-힌트)를 보세요.                        |
| PostgreSQL의 `pg`, Neon                    | `BRAID_BIND_HINT_UNSUPPORTED`로 거부합니다. 드라이버에 API가 없습니다.           |
| MySQL, MariaDB                             | `BRAID_BIND_HINT_UNSUPPORTED`로 거부합니다. 드라이버에 API가 없습니다.           |
| SQLite 어댑터                              | `BRAID_BIND_HINT_UNSUPPORTED`로 거부합니다. SQLite에는 파라미터 타입이 없습니다. |

힌트를 몰래 무시하는 어댑터는 없습니다. PostgreSQL의 `postgresParameter.refcursor()`는 별개입니다. 루틴 전용이며 OUT·INOUT 포털을 구분하는 데만 씁니다.

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
