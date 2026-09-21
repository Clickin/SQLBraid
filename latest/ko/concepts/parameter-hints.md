# 파라미터 타입 힌트

> 드라이버 추론만으로 부족할 때 데이터베이스 파라미터 타입을 명시적으로 선택합니다.

SQLBraid는 JavaScript 값과 데이터베이스 파라미터 타입을 분리합니다. 일반 보간은 드라이버의 기본 추론을 사용합니다.

```ts
const id = 42;
const query = sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`;
```

데이터베이스 타입이 중요할 때는 `sql.bind(value, hint)`로 값을 감쌉니다.

```ts
import { sql, oracleParameter } from "sqlbraid/oracle";

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
`;
```

래퍼는 템플릿 안에서 값으로 남습니다. 구조적 SQL이 되거나 문장에 문자열로 삽입되지 않습니다.

## TypeScript 타입은 데이터베이스 타입의 기준이 아닙니다

SQLBraid는 TypeScript 타입에서 보편적인 데이터베이스 파라미터 타입을 추론하지 않습니다. `number`는 정수, 소수, 금액, 식별자 또는 데이터베이스별 숫자 타입일 수 있습니다. `string`은 텍스트, UUID, JSON 또는 길이가 제한된 문자 타입일 수 있습니다. `Date`도 데이터베이스의 date와 timestamp 변형 중 하나를 결정하지 않습니다.

이는 데이터베이스 파라미터 타입을 지정하는 설정이며, 애플리케이션 입력 검증이나 결과 매핑, 또는 codec 프레임워크의 역할이 아닙니다.

## SQL Server 힌트

SQL Server 루트는 Tedious 어댑터가 지원하는 타입 팩토리를 내보냅니다.

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
    AND account_id = ${sql.bind(accountId, mssqlParameter.int())}
`;
```

사용 가능한 팩토리에는 `int()`, `bigint()`, `decimal(precision, scale)`, `numeric(precision, scale)`, `nvarchar(lengthOrMax)`, `varchar(lengthOrMax)`, `varbinary(lengthOrMax)`, `bit()`, `uniqueidentifier()`, `date()`, `datetime2()`, `datetimeoffset()`이 있습니다.

`null`이나 애플리케이션 전용 객체처럼 모호한 값에는 명시적인 힌트를 사용하세요. JavaScript 런타임 타입만으로 정밀도, 스케일, 길이 또는 SQL Server 전용 타입을 선택하지 마세요.

## 렌더링 메타데이터와 prepared shape

렌더링된 문장은 값, 보간 인덱스, 선택적 힌트를 하나의 불변
`parameters` 레코드에 보관합니다. `segments.length === parameters.length + 1`이며,
observer는 바인드 값의 redaction 정책을 바꾸지 않고 이 레코드에서 값·힌트·
보간 맵을 파생합니다.

Prepared query의 shape는 결과 종류, 정규화된 논리 `segments`, 순서가 있는
힌트 시그니처로 정합니다. 값만 바꾸는 것은 허용되지만 힌트·길이·정밀도·
스케일을 바꾸면 호환되지 않는 statement를 조용히 재사용하지 않고 실패합니다.
물리적인 `$1`, `?`, `:1`, `@p1` 표기는 shape에 포함되지 않습니다.

## 어댑터 지원

PostgreSQL, MySQL, MariaDB, SQLite 어댑터는 일반 파라미터 힌트를
`BRAID_BIND_HINT_UNSUPPORTED`로 명시적으로 거부하며 힌트를 조용히 무시하지
않습니다. PostgreSQL의 루틴 전용 `postgresParameter.refcursor()`는
OUT/INOUT portal을 분류하는 좁은 예외입니다. 그 외에는 필요한 타입 API가
있는 어댑터가 준비될 때까지 힌트 없는 바인드를 사용하세요.

Oracle 및 SQL Server portable root는 힌트 디스크립터를 내보냅니다. 두 Node
어댑터는 지원되는 타입 매핑을 엄격히 검사합니다. 검증된 드라이버별 기능은
[런타임 및 드라이버 지원](/SQLBraid/latest/reference/support.md)에서 확인할 수 있습니다.
Oracle은 node-oracledb가 적용할 수 없는 IN 길이·precision·scale 속성을 거부합니다.
두 어댑터 모두 지원하지 않는 속성을 조용히 무시하지 않습니다.

## 루틴 방향

`sql.bind(value, hint)`는 IN 값입니다. 루틴 호출에는 다음 helper가 추가됩니다.

```ts
sql.out("name", hint?)              // OUT, 논리적 null placeholder
sql.inOut("name", value, hint?)     // INOUT, 초기값과 output
```

이 helper는 `sql.call` 템플릿에서만 사용할 수 있습니다. output 이름은
서로 달라야 합니다. Oracle OUT/INOUT에는 hint가 필요하고 SQL Server
OUTPUT/INOUT에는 Tedious hint가 필요합니다. PostgreSQL refcursor output은
`postgresParameter.refcursor()`로 분류해야 합니다. MySQL prepared CALL은
public mysql2 3.x API로 추가 carrier를 증명할 수 없으므로 OUT/INOUT을
거부합니다. result 순서, `output`에서 cursor 제거, 정리는
[루틴 호출](/SQLBraid/latest/concepts/routines.md)을 참고하세요.
