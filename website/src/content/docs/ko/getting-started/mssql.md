---
title: SQL Server 빠른 시작
description: 결정적인 SQL Server 파라미터 힌트와 Tedious로 SQLBraid에 연결합니다.
---

SQLBraid SQL Server 패키지와 Tedious를 함께 설치합니다.

```bash
npm install sqlbraid tedious
```

이식 가능한 루트는 SQL Server dialect와 힌트 팩토리를 내보냅니다. Node 드라이버 어댑터는 `/tedious` 아래에 있습니다.

```ts
import { Connection } from "tedious";
import { createTediousDatabase, mssqlParameter, sql } from "sqlbraid/tedious";

interface UserRow {
  id: string;
  name: string;
}

const connection = new Connection({
  server: process.env.SQLSERVER_HOST ?? "localhost",
  authentication: {
    type: "default",
    options: {
      userName: process.env.SQLSERVER_USER ?? "sa",
      password: process.env.SQLSERVER_PASSWORD ?? "Password!123",
    },
  },
  options: {
    database: process.env.SQLSERVER_DATABASE ?? "app",
    encrypt: true,
    trustServerCertificate: process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE === "true",
  },
});
await new Promise<void>((resolve, reject) => {
  connection.once("connect", (error) => (error ? reject(error) : resolve()));
  connection.connect();
});
const db = createTediousDatabase(connection);

try {
  const name = "Ada";
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name
    FROM users
    WHERE name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
  `);
  console.log(users);
} finally {
  connection.close();
}
```

기본값은 TLS 암호화와 인증서 검증을 모두 사용합니다. 자체 서명 인증서를 쓰는
격리된 로컬 개발 서버에서만 `SQLSERVER_TRUST_SERVER_CERTIFICATE=true`를
명시적으로 설정하세요. 원격 또는 운영 서버에서는 이 우회 옵션을 사용하지 말고
신뢰할 수 있는 인증서를 구성하세요.

Tedious는 `@p1`, `@p2` 같은 결정적인 파라미터 이름을 받습니다. `sql.bind`는 데이터베이스 타입을 선택할 뿐 값을 SQL 텍스트로 바꾸지 않습니다. scalar OUTPUT/INOUT 루틴 파라미터에는 명시적인 hint가 필요합니다. T-SQL integer RETURN status에는 `sql.call` 계약의 `procedure: { name, parameterNames }` metadata가 필요하며 SQLBraid는 임의 `EXEC` 텍스트에서 identity를 추측하지 않습니다.

Tedious 바인딩 어댑터는 논리 문장을 typed request로 구체화합니다. 결정적인
`@p1`, `@p2`, … 이름, `TYPES.*` 매핑, 인코딩된 값과 facet을 구성합니다.
설명·힌트 검증·exactness 검사는 lease를 얻기 전에 수행됩니다. 유효 reuse는
Tedious가 소유하며, 이 단계의 실패는 드라이버 I/O 없이 `materialize` 오류가
됩니다.

## 기능 경계

- 문서화된 후보 조합은 Node 22.18.0/Linux x64의 Tedious 20.0.0입니다.
  지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)가
  기록한 정확한 database, driver, profile, runtime, capability tuple과
  revision별 실행 workflow에만 적용됩니다. package 설치나 인접한 버전·runtime은
  이 프로필을 인증하지 않습니다. 최종 exact-SHA Runtime, Docs, Release gate와
  명시적인 release 승인은 별도 요구사항입니다.
- 대상은 SQL Server 2022 CU18 Developer, Linux x64입니다.
  로컬 ARM 에뮬레이션은 이 문서의 검증 범위 밖입니다.
- 힌트가 없는 일반 값은 어댑터 로컬 Tedious 추론을 사용합니다. `null`, 사용자 정의 객체, 정밀도/스케일, 길이 또는 SQL Server 전용 타입에는 명시적인 힌트를 사용하세요.
- 여러 recordset을 하나의 가짜 단일 행 결과로 평탄화하지 않고 보존합니다.
- `CURSOR VARYING OUTPUT`은 애플리케이션 cursor 채널이 아니며 `BRAID_CALL_CURSOR_UNSUPPORTED`로 거부합니다. local cursor를 소비한 뒤 `SELECT` 행을 내보내는 batch는 일반 result set으로 반환됩니다.

Tedious는 `decimal`/`numeric`, `money`, `smallmoney`를 JavaScript
`number`로 노출하므로 SQLBraid는 손실된 exact 값을 string으로 바꾸지 않고
`BRAID_RESULT_EXACTNESS`로 fail closed합니다. Tedious의 `BIGINT` text는
canonical exact string으로 정규화됩니다. 정확한 decimal/money 결과에는
`CONVERT(varchar(...), exact_column)` 같은 사용자가 작성한 text 표현식을
선택하고 문자열 결과 계약을 선언하세요. 정확한 입력은
`mssqlParameter.nvarchar(...)` character hint로 bind한 뒤
`CAST(@nvarchar_parameter AS decimal(38, 18))`처럼 SQL에서 변환을 선택합니다.
native typed DECIMAL/NUMERIC/MONEY 편의 경로는 JavaScript `number` 범위에
묶이며 임의 정밀도를 보존하지 않습니다. Native temporal 값은 `Date`이므로 SQL Server의 100ns precision과
전체 offset 의미를 보존하지 않습니다. 필요하면
`CONVERT(varchar(...), datetime2_or_datetimeoffset, style)`로 text를
작성하세요.

증거 라벨과 현재 매트릭스는 [런타임 및 드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.

명시적 procedure metadata와 이질적인 `sql.call` result 계약은
[루틴 호출](/SQLBraid/concepts/routines/)을 참고하세요.

## Tedious 표현 프로필

문서의 free test target은 SQL Server 2022 CU18 Developer와 Node
22.18.0/Linux x64의 Tedious 20.0.0입니다. 증거 라벨은 이 페이지가
아니라 support manifest가 지정합니다. 다른 SQL Server edition이나 runtime은
별도의 프로필입니다.

| SQL Server 값                                  | Driver raw / SQLBraid canonical 표현 | 상태/주의                                                                                                       |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `tinyint` / `smallint` / `int` / `bigint`      | string                               | 정확한 정수 전송은 canonical text이며 `decodeExactInteger`는 애플리케이션 선택 사항입니다.                      |
| `decimal` / `numeric` / `money` / `smallmoney` | number → exact output unsupported    | character bind와 authored text `CAST`/`CONVERT`를 사용하며 손실된 Number를 stringify하지 않습니다.              |
| `real` / `float`                               | JavaScript `number`                  | 근사 binary32/binary64 값이며 SQL Server는 NaN/Infinity를 지원한다고 주장하지 않습니다.                         |
| `datetime2` / `datetimeoffset`                 | `Date`                               | Native 편의 프로필이며 100ns나 offset 정확도에는 ISO/text conversion을 작성합니다.                              |
| `uniqueidentifier`                             | string                               | 필요하면 애플리케이션 schema로 검증합니다.                                                                      |
| `varbinary`                                    | `Buffer`                             | byte로 유지하거나 명시적으로 encode합니다.                                                                      |
| JSON                                           | text                                 | SQL Server JSON은 character data이며 SQLBraid가 파싱하지 않으므로 중첩 숫자 lexeme을 text로 보존할 수 있습니다. |

바인드 전송은 deterministic `@p1`, `@p2`, … 이름과 `TYPES.*` metadata를
사용하는 typed Tedious request입니다. Native `OUTPUT` 행은 `sql.rows`로
materialize하고 output/return routine channel은 명시적 metadata를
사용합니다. Portable bulk 전략은 prepared-loop입니다. `affectedRows`와
procedure status는 safe-range 검사를 하는 운영 count이며 driver가 제공하는
DB 생성 ID는 exact text를 사용합니다. 일반 `undefined` IN 값은 acquisition
전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패하고 `null`은 SQL `NULL`입니다.
Native SQL은 투명하게 전달되지만 SQLBraid가 모든 T-SQL grammar를 파싱한다고
주장하지 않습니다.
